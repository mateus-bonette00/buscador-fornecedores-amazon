"""Private dashboard and background jobs for Amazon US product sourcing."""

import argparse
import csv
import fcntl
import io
import json
import re
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from vpn import proton_connection
from sheets import Sheets, sold_for
from suppliers import DRIVERS, Page, Pending, contains_part, normalized, offer, request

ROOT = Path(__file__).resolve().parent
SETTINGS_DIR = Path.home() / '.config' / 'buscador-fornecedores-amazon'
STATE_DIR = Path.home() / '.local' / 'state' / 'buscador-fornecedores-amazon'
DEFAULTS = {
    'spreadsheet_id': '',
    'sheet_id': 0,
    'keepa_key_file': str(SETTINGS_DIR / 'keepa.key'),
    'google_credentials': str(SETTINGS_DIR / 'google-sheets.json'),
    'smc_proxy': '',
    'smc_proton_manual': False,
    'supplier_chrome': False,
    'suppliers': {
        'motion': {'name': 'Motion', 'driver': 'motion', 'handling': 5, 'shipping': 40, 'minimum': 11},
        'smc': {'name': 'SMC Pneumatics', 'driver': 'smc', 'handling': 6, 'tomorrow': 7,
                'shipping': 70, 'minimum': 11},
    },
}
ASIN = re.compile(r'[A-Z0-9]{10}\Z')
AMAZON_PATH = re.compile(r'/(?:dp|gp/product)/([A-Z0-9]{10})(?:/|$)', re.I)
PART = re.compile(r'(?<![A-Z0-9./-])[A-Z0-9]+(?:[-./][A-Z0-9]+)*(?![A-Z0-9]|[./-][A-Z0-9])')
CSV_LIMIT = 120_000


def asin_from(raw):
    value = raw.strip().upper()
    if ASIN.fullmatch(value):
        return value
    url = urllib.parse.urlsplit(raw.strip())
    if url.scheme == 'https' and url.hostname in ('amazon.com', 'www.amazon.com'):
        match = AMAZON_PATH.search(url.path)
        if match:
            return match[1].upper()
    raise Pending('Use um ASIN ou link de produto da Amazon dos EUA.')


def parse_input(raw):
    if len(raw) > CSV_LIMIT:
        raise Pending('A entrada excede 120 kB. Divida o lote.')
    raw = raw.strip().lstrip('\ufeff')
    first = raw.partition('\n')[0]
    separator = ';' if ';' in first else ','
    columns = [key.strip().casefold() for key in next(csv.reader([first], delimiter=separator), [])]
    if 'asin' in columns:
        reader = csv.DictReader(io.StringIO(raw), delimiter=separator)
        batch = []
        for row in reader:
            values = {key.strip().casefold(): val for key, val in row.items() if key and val is not None}
            if values.get('asin', '').strip():
                batch.append({'asin': asin_from(values['asin']),
                              'title': values.get('title') or values.get('product title') or ''})
    else:
        batch = [{'asin': asin_from(line), 'title': ''} for line in raw.splitlines() if line.strip()]
    return list({item['asin']: item for item in batch}.values())


def extract(title, part_hint=''):
    raw = normalized(title)
    quantities = set(int(match) for group in re.findall(
        r'\bPACK\s+OF\s+(\d+)\b|\b(\d+)\s*-?\s*PACK\b', raw) for match in group if match)
    if len(quantities) > 1 or (quantities and min(quantities) < 1):
        raise Pending('O título tem quantidades de pack conflitantes ou inválidas.')
    pack = next(iter(quantities), 1)
    if part_hint and PART.fullmatch(normalized(part_hint)) and contains_part(title, part_hint):
        return normalized(part_hint), pack
    codes = {token for token in PART.findall(raw) if len(token) >= 3
             and any(c.isalpha() for c in token) and any(c.isdigit() for c in token)
             and not re.fullmatch(r'\d+-?(?:MM|CM|IN|PSI|VDC|VAC|V|A|PCS|PACK)', token)}
    if len(codes) != 1:
        raise Pending('Não há um único part number inequívoco no título da Amazon.')
    return codes.pop(), pack


def choose(offers, minimums, pack):
    eligible = [(key, item) for key, item in offers.items() if item is not None
                and item.user_stock >= max(pack, minimums[key])]
    if not eligible:
        return None
    variants = dict(eligible)
    if 'motion' in variants and 'smc' in variants:
        motion, smc = variants['motion'], variants['smc']
        switch = smc.user_stock * 5 >= motion.user_stock * 12
        if (switch and motion.at_least) or (not switch and smc.at_least):
            raise Pending('O saldo com sinal de + não permite confirmar a relação de 2,4×.')
        preferred = smc if switch else motion
        return preferred
    return max((item for _, item in eligible), key=lambda item: (item.user_stock, -item.price))


def keepa_api(config, operation, params):
    try:
        key = Path(config['keepa_key_file']).read_text().strip()
    except OSError:
        raise Pending('Configure a chave da API do Keepa no servidor.') from None
    if not key:
        raise Pending('A chave da API do Keepa está vazia.')
    query = urllib.parse.urlencode({'key': key, **params})
    try:
        result = json.loads(request('https://api.keepa.com/' + operation + '?' + query))
    except urllib.error.HTTPError:
        raise Pending('A API do Keepa rejeitou a consulta.') from None
    if result.get('error'):
        raise Pending('A API do Keepa retornou um erro de consulta ou cota.')
    return result


def catalog(config, brand, finder, limit):
    selected = {**finder, 'brand': finder.get('brand') or [brand], 'perPage': 100, 'page': 0}
    found = []
    while len(found) < limit:
        result = keepa_api(config, 'query', {'domain': 1, 'selection': json.dumps(selected)})
        items = result.get('asinList')
        if not isinstance(items, list):
            raise Pending('A consulta do Keepa não retornou uma lista de ASINs.')
        found.extend({'asin': asin_from(item), 'title': ''} for item in items)
        if len(items) < 100:
            break
        selected['page'] += 1
    return list({item['asin']: item for item in found[:limit]}.values())


def enrich(config, batch):
    pending = [item for item in batch if not item['title']]
    if not pending or not Path(config['keepa_key_file']).is_file():
        return
    for start in range(0, len(pending), 100):
        chunk = pending[start:start + 100]
        result = keepa_api(config, 'product', {'domain': 1, 'asin': ','.join(item['asin'] for item in chunk)})
        source = {item['asin']: item for item in result.get('products', []) if item.get('asin')}
        for item in chunk:
            data = source.get(item['asin'], {})
            item.update(title=data.get('title') or '', part_hint=data.get('partNumber') or '')


def amazon_title(asin):
    raw = request('https://www.amazon.com/dp/' + asin)
    page = Page(raw)
    match = re.search(r'<span[^>]*\bid=["\']productTitle["\'][^>]*>(.*?)</span>', raw, re.I | re.S)
    if not match or not page.text:
        raise Pending('O título da Amazon não pôde ser confirmado.')
    return Page(match[1]).text


def job_outcome(job):
    if job['status'] != 'done' or job['mode'] == 'demo':
        return None
    statuses = {item['status'] for item in job['items']}
    if 'written' not in statuses:
        return 'no_writes'
    if 'pending' in statuses:
        return 'partial_write'
    return None


class Jobs:
    def __init__(self, config, state, worker_host=None):
        self.config = config
        self.state = state
        self.worker_host = worker_host
        state.mkdir(mode=0o700, exist_ok=True, parents=True)
        self.lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='buscador-fornecedores-amazon-jobs')
        with sqlite3.connect(state / 'jobs.sqlite') as db:
            db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
            for job_id, raw in db.execute('SELECT id,data FROM jobs').fetchall():
                data = json.loads(raw)
                if data['status'] in ('queued', 'running'):
                    data.update(status='error', message='Execução interrompida. Envie o lote novamente.')
                    db.execute('UPDATE jobs SET data=? WHERE id=?', (json.dumps(data), job_id))

    def save(self, data):
        with self.lock, sqlite3.connect(self.state / 'jobs.sqlite') as db:
            db.execute('INSERT OR REPLACE INTO jobs (id,data) VALUES (?,?)',
                       (data['id'], json.dumps(data, ensure_ascii=False)))

    def load(self, job_id=None):
        with self.lock, sqlite3.connect(self.state / 'jobs.sqlite') as db:
            if job_id is not None:
                record = db.execute('SELECT data FROM jobs WHERE id=?', (job_id,)).fetchone()
                return json.loads(record[0]) if record else None
            return [json.loads(row[0]) for row in db.execute('SELECT data FROM jobs ORDER BY rowid DESC LIMIT 12')]

    def prepare(self, options):
        brand = str(options.get('brand', '')).strip()
        chosen = options.get('suppliers', [])
        mode = options.get('mode', '')
        limit = options.get('limit', 8)
        if not brand or len(brand) > 80:
            raise Pending('Informe uma marca de até 80 caracteres.')
        if type(limit) is not int or not 1 <= limit <= 500:
            raise Pending('O limite do lote deve ficar entre 1 e 500.')
        if not isinstance(chosen, list) or not chosen or any(
                not isinstance(key, str) or key not in self.config['suppliers'] for key in chosen):
            raise Pending('Selecione pelo menos um fornecedor cadastrado.')
        if mode not in ('demo', 'keepa', 'input'):
            raise Pending('Selecione uma fonte para o lote.')
        source = options.get('input', '')
        if not isinstance(source, str):
            raise Pending('A entrada precisa estar em texto.')
        if mode == 'input':
            batch = parse_input(source)[:limit]
            if not batch:
                raise Pending('Inclua um CSV, ASIN ou link da Amazon dos EUA.')
        elif mode == 'keepa':
            try:
                batch = json.loads(source) if source.strip() else {}
            except json.JSONDecodeError:
                raise Pending('Cole o JSON de Show API query do Keepa.') from None
            if not isinstance(batch, dict):
                raise Pending('A consulta do Keepa deve ser um objeto JSON.')
        else:
            if any(key not in ('motion', 'smc') for key in chosen):
                raise Pending('A simulação contém somente Motion e SMC Pneumatics.')
            batch = [{'asin': 'B00000000' + str(n), 'title': title} for n, title in enumerate([
                'SMC NCQ2B63-25DZ cyl, compact, npt', 'SMC Y-G04 - Pack Of 6 - Piston Rod Clevis',
                'SMC Inch One-touch Pipe Fittings, Pack of 10 KQ2F11-35A',
            ], 1)][:limit]
        data = {'id': uuid.uuid4().hex, 'status': 'queued', 'brand': brand, 'created': time.time(),
                'mode': mode, 'items': [], 'total': 0, 'message': ''}
        return data, list(dict.fromkeys(chosen)), batch, limit

    def submit(self, options):
        data, chosen, batch, limit = self.prepare(options)
        self.save(data)
        if self.worker_host and data['mode'] != 'demo':
            self.executor.submit(self.run_remote, data, options)
        else:
            self.executor.submit(self.run, data, chosen, batch, limit)
        return data

    def run_remote(self, job, options):
        job.update(status='running', message='Enviando o lote ao servidor.')
        self.save(job)
        command = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
                   '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
                   '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes',
                   '--', self.worker_host,
                   'cd "$HOME/.local/share/buscador-fornecedores-amazon" && exec /usr/bin/python3 -B app.py --run-job']
        try:
            with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, encoding='utf-8') as process:
                with process.stdin:
                    process.stdin.write(json.dumps(options))
                for line in process.stdout:
                    update = json.loads(line)
                    job.update({key: update[key] for key in ('status', 'items', 'total', 'message')})
                    self.save(job)
                if process.wait() or job['status'] not in ('done', 'error'):
                    raise OSError('Lote remoto sem resultado final')
        except (OSError, ValueError, KeyError, TypeError):
            job.update(status='error', message='A conexão com o servidor falhou ou o lote foi interrompido.')
            self.save(job)

    def run(self, job, chosen, batch, limit, publish=None):
        save = self.save if publish is None else publish
        demo = job['mode'] == 'demo'
        try:
            job['status'] = 'running'
            save(job)
            if job['mode'] == 'keepa':
                batch = catalog(self.config, job['brand'], batch, limit)
            if not demo:
                try:
                    enrich(self.config, batch)
                except Pending:
                    job['message'] = 'O Keepa não forneceu todos os títulos. Consulta direta à Amazon em andamento.'
            job['total'] = len(batch)
            manual_vpn = self.config['smc_proton_manual']
            use_proton = (not demo and batch and manual_vpn
                          and any(self.config['suppliers'][key]['driver'] == 'smc' for key in chosen))
            vpn_session = proton_connection() if use_proton else nullcontext()
            if use_proton:
                job['message'] = 'Verificando o Proton VPN no servidor.'
                save(job)
            with vpn_session as vpn:
                if vpn is not None:
                    job['message'] = 'Proton VPN conectado nos Estados Unidos.'
                    save(job)
                with ThreadPoolExecutor(max_workers=3, thread_name_prefix='buscador-fornecedores-amazon-products') as pool:
                    for item in pool.map(lambda row: self.product(row, job['brand'], chosen, demo, vpn), batch):
                        job['items'].append(item)
                        save(job)
            ready = [item for item in job['items'] if item['status'] == 'ready']
            if ready and not demo:
                self.commit(ready)
            job['status'] = 'done'
            job['message'] = ''
            if not job['items']:
                job['message'] = 'Nenhum ASIN encontrado para essa consulta.'
            elif job_outcome(job) == 'no_writes':
                job['message'] = 'Nenhum produto foi gravado. Confira o motivo em cada produto pendente.'
        except (Pending, OSError, ValueError, KeyError) as exc:
            job.update(status='error', message=str(exc) if isinstance(exc, Pending)
                       else 'A fonte de dados retornou um erro inesperado.')
        save(job)

    def product(self, item, brand, chosen, demo, vpn=None):
        part_hint = item.get('part_hint', '')
        item = {'asin': item['asin'], 'title': item['title'], 'brand': brand, 'offers': {}}
        try:
            item['title'] = item['title'] or amazon_title(item['asin'])
            item['part'], item['pack'] = extract(item['title'], part_hint)
            offers = {}
            minimums = {}
            unconfirmed = []
            for key in chosen:
                config = self.config['suppliers'][key]
                minimums[key] = config['minimum']
                try:
                    part, pack = item['part'], item['pack']
                    if demo:
                        check = {'NCQ2B63-25DZ': (0, 0), 'Y-G04': (12, 29), 'KQ2F11-35A': (25, 30)}
                        qty = check[part][key == 'smc']
                        domain = 'www.motion.com' if key == 'motion' else 'www.smcpneumatics.com'
                        timing = 'Tomorrow' if key == 'smc' and part == 'Y-G04' else 'Today' if key == 'smc' else 'Estoque'
                        result = offer(config, Decimal('17.85'), qty, 'https://' + domain, timing) if qty else None
                    else:
                        proxy = self.config['smc_proxy']
                        if self.config.get('supplier_chrome') and config['driver'] in ('motion', 'smc'):
                            config = {**config, 'browser': True}
                        if vpn is not None and config['driver'] == 'smc':
                            vpn.require_us()
                            config = {**config, 'host_vpn': True}
                            proxy = None
                        result = DRIVERS[config['driver']](config, part, pack, proxy)
                except (Pending, OSError, ValueError, KeyError, InvalidOperation) as exc:
                    item['offers'][config['name']] = {'detail': str(exc) if isinstance(exc, Pending)
                                                     else 'Resposta do fornecedor não reconhecida.'}
                    unconfirmed.append(config['name'])
                    continue
                offers[key] = result
                item['offers'][config['name']] = ({'stock': result.user_stock, 'floor': result.at_least,
                                                    'price': str(result.price), 'timing': result.timing}
                                                   if result else {'detail': 'Sem estoque elegível confirmado.'})
            if unconfirmed:
                raise Pending(f'Oferta sem confirmação em {", ".join(unconfirmed)}. Confira o motivo em Fornecedor e estoque.')
            selected = choose(offers, minimums, item['pack'])
            if selected is None:
                raise Pending('Nenhum fornecedor tem saldo suficiente para este anúncio.')
            item.update(status='demo' if demo else 'ready', supplier=selected.supplier,
                        stock=selected.user_stock, price=str(selected.price), link=selected.link,
                        handling=selected.handling, shipping=str(selected.shipping), timing=selected.timing,
                        sold_for=str(sold_for(selected.price, Decimal(7), selected.shipping)))
        except (Pending, OSError, ValueError) as exc:
            item.update(status='pending', detail=str(exc) if isinstance(exc, Pending)
                        else 'Dados da Amazon indisponíveis.')
        return item

    def commit(self, ready):
        auth_path = self.config['google_credentials']
        try:
            if not self.config['spreadsheet_id']:
                raise Pending('Configure spreadsheet_id e sheet_id em settings.json.')
            if not Path(auth_path).is_file():
                raise Pending('A credencial de gravação do Google Sheets ainda não foi configurada.')
            sheet = Sheets(auth_path, self.config['spreadsheet_id'], int(self.config['sheet_id']))
            written, rejected = sheet.commit(ready)
            for item, _, _ in written:
                item['status'] = 'written'
            for item, detail in rejected:
                item.update(status='pending', detail=detail)
        except (Pending, OSError, ValueError, KeyError) as exc:
            for item in ready:
                item.update(status='pending', detail=str(exc) if isinstance(exc, Pending)
                            else 'Gravação não confirmada pelo Google Sheets. Reenvie para conferir pelo ASIN.')


class Dashboard(BaseHTTPRequestHandler):
    def respond(self, status, payload, media='application/json; charset=utf-8'):
        if not isinstance(payload, bytes):
            payload = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', media)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy',
                         "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(payload)

    def trusted_host(self):
        host = self.headers.get('Host', '')
        origin = self.headers.get('Origin')
        return bool(re.fullmatch(r'(?:localhost|127\.0\.0\.1)(?::\d+)?', host)
                    and (origin is None or origin == 'http://' + host))

    def do_GET(self):
        if not self.trusted_host():
            return self.respond(403, {'error': 'Use http://127.0.0.1 para abrir o painel local.'})
        path = urllib.parse.urlsplit(self.path).path
        jobs = self.server.jobs
        assets = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'),
                  '/style.css': ('style.css', 'text/css')}
        if path in assets:
            name, content_type = assets[path]
            return self.respond(200, (ROOT / 'web' / name).read_bytes(), content_type + '; charset=utf-8')
        if path == '/api/setup':
            config = jobs.config
            return self.respond(200, {
                'suppliers': [{'id': key, 'name': rules['name']} for key, rules in config['suppliers'].items()],
                'remote_worker': bool(jobs.worker_host),
                'keepa': Path(config['keepa_key_file']).is_file(),
                'sheets': Path(config['google_credentials']).is_file(),
                'smc': bool(config['smc_proxy'] or config['smc_proton_manual']),
            })
        if path == '/api/jobs':
            return self.respond(200, [
                {**{key: job[key] for key in ('id', 'brand', 'status', 'mode', 'created')},
                 'outcome': job_outcome(job)} for job in jobs.load()
            ])
        match = re.fullmatch(r'/api/jobs/([a-f0-9]{32})', path)
        if match:
            data = jobs.load(match[1])
            if data:
                return self.respond(200, {**data, 'outcome': job_outcome(data)})
        self.respond(404, {'error': 'Página ou lote não encontrado.'})

    def do_POST(self):
        if not self.trusted_host():
            return self.respond(403, {'error': 'Use http://127.0.0.1 para abrir o painel local.'})
        if self.path != '/api/jobs':
            return self.respond(404, {'error': 'Operação não encontrada.'})
        if self.headers.get_content_type() != 'application/json':
            return self.respond(415, {'error': 'Envie os dados em JSON.'})
        try:
            size = int(self.headers.get('Content-Length', 0))
            if not 0 < size <= 2 * CSV_LIMIT:
                raise Pending('Tamanho da requisição inválido.')
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise Pending('Envie os dados do lote em um objeto JSON.')
            self.respond(202, self.server.jobs.submit(payload))
        except Pending as exc:
            self.respond(400, {'error': str(exc)})
        except (ValueError, UnicodeError):
            self.respond(400, {'error': 'Dados do lote inválidos.'})


def load_config(path):
    if not path.exists():
        return DEFAULTS
    overrides = json.loads(path.read_text())
    return {**DEFAULTS, **overrides, 'suppliers': {**DEFAULTS['suppliers'], **overrides.get('suppliers', {})}}


def run_job(config, state):
    def send(data):
        print(json.dumps(data, ensure_ascii=True), flush=True)

    try:
        options = json.load(sys.stdin)
        if not isinstance(options, dict):
            raise Pending('Dados do lote inválidos.')
        state.mkdir(mode=0o700, exist_ok=True, parents=True)
        with (state / 'worker.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Pending('O servidor já está executando outro lote. Tente novamente ao terminar.') from None
            jobs = Jobs(config, state)
            job, chosen, batch, limit = jobs.prepare(options)

            def publish(data):
                jobs.save(data)
                send(data)

            jobs.run(job, chosen, batch, limit, publish)
    except (Pending, ValueError) as exc:
        send({'status': 'error', 'items': [], 'total': 0,
              'message': str(exc) if isinstance(exc, Pending) else 'Dados do lote inválidos.'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8746)
    parser.add_argument('--config', type=Path, default=SETTINGS_DIR / 'settings.json')
    parser.add_argument('--state', type=Path, default=STATE_DIR)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--worker-host')
    mode.add_argument('--run-job', action='store_true')
    args = parser.parse_args()
    signal.signal(signal.SIGHUP, signal.default_int_handler)
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    config = load_config(args.config)
    if args.run_job:
        run_job(config, args.state)
        return
    with ThreadingHTTPServer(('127.0.0.1', args.port), Dashboard) as server:
        server.jobs = Jobs(config, args.state, args.worker_host)
        print(f'Painel local do Buscador em http://127.0.0.1:{server.server_port}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
