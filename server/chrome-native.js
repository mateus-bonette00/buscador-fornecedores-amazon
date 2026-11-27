#!/usr/bin/env node
/**
 * Relay supplier page requests from the Express backend to the Chrome extension
 * via Native Messaging (stdin/stdout length-prefixed JSON) and a Unix socket.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOCKET_PATH = `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}/buscador-fornecedores-amazon-chrome.sock`;
export const SOCKET_TIMEOUT_MS = 35_000;
export const MAX_RESPONSE_BYTES = 2_000_000;
export const MAX_REQUEST_BYTES = 4096;
const HOSTS = new Set(['www.motion.com', 'www.smcpneumatics.com']);
const CLOSED = { error: 'A extensão do Buscador encerrou a conexão com o Chrome.' };

export function validUrl(raw) {
  if (typeof raw !== 'string' || /[\s\x00-\x1f]/.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && HOSTS.has(parsed.host) && !parsed.hash;
  } catch {
    return false;
  }
}

class ChromeBridge {
  constructor(output) {
    this.output = output;
    this.pending = new Map();
    this.closed = false;
  }

  request(url, timeoutMs) {
    if (this.closed) return Promise.resolve(CLOSED);
    const id = crypto.randomBytes(16).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: 'O Chrome demorou a carregar a página do fornecedor.' });
      }, Math.max(0, timeoutMs));

      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });

      try {
        const raw = Buffer.from(JSON.stringify({ id, url }), 'utf-8');
        const header = Buffer.alloc(4);
        header.writeUInt32LE(raw.length, 0);
        this.output.write(Buffer.concat([header, raw]));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(CLOSED);
      }
    });
  }

  deliver(message) {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') return;
    const handler = this.pending.get(message.id);
    if (!handler) return;
    this.pending.delete(message.id);

    const { error, status, html } = message;
    if (typeof error === 'string' && error.trim()) {
      handler({ error: error.slice(0, 512) });
    } else if (Number.isInteger(status) && status >= 100 && status <= 599 && typeof html === 'string') {
      handler({ status, html });
    } else {
      handler({ error: 'A extensão do Buscador enviou uma resposta inválida.' });
    }
  }

  close() {
    this.closed = true;
    for (const handler of this.pending.values()) {
      handler(CLOSED);
    }
    this.pending.clear();
  }
}

function sendReply(socket, response) {
  let raw;
  try {
    raw = Buffer.from(JSON.stringify(response), 'utf-8');
    if (raw.length > MAX_RESPONSE_BYTES) {
      raw = Buffer.from(JSON.stringify({ error: 'A página do fornecedor excedeu o tamanho aceito pelo Buscador.' }), 'utf-8');
    }
  } catch {
    raw = Buffer.from(JSON.stringify({ error: 'A página do fornecedor contém texto inválido.' }), 'utf-8');
  }
  try {
    socket.end(Buffer.concat([raw, Buffer.from('\n')]));
  } catch {
    // Client already disconnected.
  }
}

async function checkSocketPath(socketPath) {
  const dirStat = fs.lstatSync(path.dirname(socketPath));
  if (!dirStat.isDirectory() || (typeof process.getuid === 'function' && dirStat.uid !== process.getuid()) || (dirStat.mode & 0o077)) {
    throw new Error('O diretório do socket do Buscador precisa pertencer apenas ao usuário do Chrome.');
  }
  if (!fs.existsSync(socketPath)) return;
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket()) {
    throw new Error('O caminho reservado ao socket do Buscador não é um socket.');
  }
  await new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.setTimeout(1000);
    probe.once('connect', () => {
      probe.destroy();
      reject(new Error('Outra extensão do Buscador já está conectada.'));
    });
    probe.once('error', () => {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Ignore race condition.
      }
      resolve();
    });
    probe.once('timeout', () => {
      probe.destroy();
      reject(new Error('Outra extensão do Buscador já está conectada.'));
    });
  });
}

async function main() {
  process.umask(0o077);
  await checkSocketPath(SOCKET_PATH);

  const bridge = new ChromeBridge(process.stdout);
  let activeSlots = 0;

  const server = net.createServer((client) => {
    if (activeSlots >= 3) {
      sendReply(client, { error: 'O Chrome já está carregando três páginas para o Buscador.' });
      return;
    }
    activeSlots += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeSlots -= 1;
      }
    };
    client.once('close', release);
    client.once('error', release);

    const deadline = Date.now() + SOCKET_TIMEOUT_MS;
    client.setTimeout(SOCKET_TIMEOUT_MS);
    let buffer = Buffer.alloc(0);
    let handled = false;

    const finish = async (rawLine) => {
      if (handled) return;
      handled = true;
      let response;
      try {
        const parsed = JSON.parse(rawLine.toString('utf-8'));
        const url = parsed && typeof parsed === 'object' ? parsed.url : null;
        if (!validUrl(url)) throw new Error('invalid supplier URL');
        response = await bridge.request(url, deadline - Date.now());
      } catch {
        response = { error: 'O Buscador enviou um pedido inválido ao Chrome.' };
      }
      sendReply(client, response);
    };

    client.on('data', (chunk) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline >= 0) {
        finish(buffer.subarray(0, newline));
      } else if (buffer.length >= MAX_REQUEST_BYTES) {
        handled = true;
        sendReply(client, { error: 'O Buscador enviou um pedido inválido ao Chrome.' });
      }
    });

    client.on('timeout', () => {
      if (handled) return;
      handled = true;
      sendReply(client, { error: 'O Chrome demorou a processar o pedido do Buscador.' });
    });
  });

  const cleanup = () => {
    bridge.close();
    server.close();
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // Already removed.
    }
  };

  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGHUP', () => { cleanup(); process.exit(0); });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SOCKET_PATH, () => {
      fs.chmodSync(SOCKET_PATH, 0o600);
      resolve();
    });
  });

  // Read Native Messaging frames from stdin.
  let inbox = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    inbox = Buffer.concat([inbox, chunk]);
    while (inbox.length >= 4) {
      const len = inbox.readUInt32LE(0);
      if (len <= 0 || len > MAX_RESPONSE_BYTES) {
        process.stderr.write('Buscador (Chrome): Resposta do Chrome excede o tamanho aceito.\n');
        cleanup();
        process.exit(1);
      }
      if (inbox.length < 4 + len) break;
      const body = inbox.subarray(4, 4 + len);
      inbox = inbox.subarray(4 + len);
      try {
        bridge.deliver(JSON.parse(body.toString('utf-8')));
      } catch {
        process.stderr.write('Buscador (Chrome): Resposta JSON inválida do Chrome.\n');
      }
    }
  });

  process.stdin.on('end', () => {
    cleanup();
    process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`Buscador (Chrome): ${err.message}\n`);
    process.exit(1);
  });
}
