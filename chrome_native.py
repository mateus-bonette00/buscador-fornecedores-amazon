#!/usr/bin/python3 -B
"""Relay the app's supplier page requests to its Chrome extension."""

import fcntl
import json
import os
import queue
import signal
import socket
import socketserver
import stat
import struct
import sys
import threading
import time
import urllib.parse
import uuid
from pathlib import Path


SOCKET_PATH = Path(f'/run/user/{os.getuid()}/buscador-fornecedores-amazon-chrome.sock')
SOCKET_TIMEOUT = 35
MAX_RESPONSE_BYTES = 2_000_000
MAX_REQUEST_BYTES = 4096
HOSTS = {'www.motion.com', 'www.smcpneumatics.com'}
FRAME = struct.Struct('=I')
CLOSED = {'error': 'A extensão do Buscador encerrou a conexão com o Chrome.'}


def encode(message):
    return json.dumps(message, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def valid_url(url):
    if not isinstance(url, str) or any(ch.isspace() or ord(ch) < 32 for ch in url):
        return False
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return parts.scheme == 'https' and parts.netloc in HOSTS and not parts.fragment


class ChromeBridge:
    def __init__(self, output):
        self.output = output
        self.pending = {}
        self.lock = threading.Lock()
        self.output_lock = threading.Lock()
        self.closed = False

    def request(self, url, deadline):
        request_id = uuid.uuid4().hex
        result = queue.Queue(maxsize=1)
        with self.lock:
            if self.closed:
                return CLOSED
            self.pending[request_id] = result
        try:
            raw = encode({'id': request_id, 'url': url})
            with self.output_lock:
                self.output.write(FRAME.pack(len(raw)) + raw)
                self.output.flush()
            return result.get(timeout=max(0, deadline - time.monotonic()))
        except queue.Empty:
            return {'error': 'O Chrome demorou a carregar a página do fornecedor.'}
        except OSError:
            return CLOSED
        finally:
            with self.lock:
                self.pending.pop(request_id, None)

    def deliver(self, message):
        if not isinstance(message, dict) or not isinstance(message.get('id'), str):
            return
        with self.lock:
            result = self.pending.pop(message['id'], None)
        if result is None:
            return
        error, status, html = (message.get(key) for key in ('error', 'status', 'html'))
        if isinstance(error, str) and error.strip():
            result.put_nowait({'error': error[:512]})
        elif type(status) is int and 100 <= status <= 599 and isinstance(html, str):
            result.put_nowait({'status': status, 'html': html})
        else:
            result.put_nowait({'error': 'A extensão do Buscador enviou uma resposta inválida.'})

    def close(self):
        with self.lock:
            self.closed = True
            for result in self.pending.values():
                result.put_nowait(CLOSED)
            self.pending.clear()


def send_reply(client, response):
    try:
        raw = encode(response)
        if len(raw) > MAX_RESPONSE_BYTES:
            raw = encode({'error': 'A página do fornecedor excedeu o tamanho aceito pelo Buscador.'})
    except UnicodeError:
        raw = encode({'error': 'A página do fornecedor contém texto inválido.'})
    try:
        client.sendall(raw + b'\n')
    except OSError:
        pass


class BridgeRequest(socketserver.BaseRequestHandler):
    def handle(self):
        deadline = time.monotonic() + SOCKET_TIMEOUT
        data = bytearray()
        try:
            while not data.endswith(b'\n') and len(data) < MAX_REQUEST_BYTES:
                self.request.settimeout(max(0, deadline - time.monotonic()))
                chunk = self.request.recv(MAX_REQUEST_BYTES - len(data))
                if not chunk:
                    break
                data.extend(chunk)
            options = json.loads(data.decode('utf-8')) if data.endswith(b'\n') else None
            url = options.get('url') if isinstance(options, dict) else None
            if not valid_url(url):
                raise ValueError('invalid supplier URL')
            response = self.server.bridge.request(url, deadline)
        except (TimeoutError, BlockingIOError):
            response = {'error': 'O Chrome demorou a processar o pedido do Buscador.'}
        except (OSError, ValueError):
            response = {'error': 'O Buscador enviou um pedido inválido ao Chrome.'}
        self.request.settimeout(max(0.25, deadline - time.monotonic()))
        send_reply(self.request, response)


class BridgeSocket(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, address, bridge):
        self.bridge = bridge
        self.slots = threading.BoundedSemaphore(3)
        super().__init__(str(address), BridgeRequest)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.settimeout(0.25)
            send_reply(request, {'error': 'O Chrome já está carregando três páginas para o Buscador.'})
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def serve(path, browser_input, browser_output):
    directory = path.parent.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or directory.st_mode & 0o077:
        raise OSError('O diretório do socket do Buscador precisa pertencer apenas ao usuário do Chrome.')
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if path.exists():
            if not stat.S_ISSOCK(path.lstat().st_mode):
                raise OSError('O caminho reservado ao socket do Buscador não é um socket.')
            with socket.socket(socket.AF_UNIX) as active:
                active.settimeout(1)
                try:
                    active.connect(str(path))
                except ConnectionRefusedError:
                    path.unlink()
                else:
                    raise OSError('Outra extensão do Buscador já está conectada.')
        bridge = ChromeBridge(browser_output)
        with BridgeSocket(path, bridge) as server:
            try:
                path.chmod(0o600)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    while header := browser_input.read(FRAME.size):
                        length, = FRAME.unpack(header)
                        if not 0 < length <= MAX_RESPONSE_BYTES:
                            raise ValueError('Resposta do Chrome excede o tamanho aceito.')
                        message = browser_input.read(length)
                        if len(message) != length:
                            raise ValueError('Resposta incompleta do Chrome.')
                        bridge.deliver(json.loads(message.decode('utf-8')))
                finally:
                    bridge.close()
                    server.shutdown()
            finally:
                path.unlink(missing_ok=True)


def main():
    os.umask(0o077)
    signal.signal(signal.SIGHUP, signal.default_int_handler)
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    try:
        serve(SOCKET_PATH, sys.stdin.buffer, sys.stdout.buffer)
    except KeyboardInterrupt:
        return 0
    except BlockingIOError:
        print('Outra extensão do Buscador já está conectada.', file=sys.stderr)
        return 1
    except (OSError, ValueError, struct.error) as error:
        print(f'Buscador (Chrome): {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
