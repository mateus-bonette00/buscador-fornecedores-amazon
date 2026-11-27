"""Exact product matching and supplier availability."""

import html
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from decimal import Decimal
from html.parser import HTMLParser


class Pending(Exception):
    """A product lacks data required for an automatic decision."""


class SameSiteRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old = urllib.parse.urlsplit(req.full_url)
        new = urllib.parse.urlsplit(newurl)
        if (new.scheme != 'https' or not new.hostname or new.username or new.password
                or old.hostname.removeprefix('www.') != new.hostname.removeprefix('www.')):
            raise Pending('O site redirecionou para outro domínio.')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def normalized(value):
    return value.strip().upper().translate(str.maketrans('‐‑–−', '----'))


def contains_part(text, part):
    return bool(re.search(r'(?<![A-Z0-9./-])' + re.escape(normalized(part))
                          + r'(?![A-Z0-9]|[./-][A-Z0-9])', normalized(text)))


def request(url, *, proxy=None, headers=None, data=None, method=None):
    if proxy and (urllib.parse.urlsplit(proxy).scheme not in ('http', 'https')
                  or urllib.request.proxy_bypass(urllib.parse.urlsplit(url).hostname)):
        raise Pending('O proxy SMC precisa encaminhar HTTPS sem exceção para o domínio.')
    opener = urllib.request.build_opener(SameSiteRedirect(), urllib.request.ProxyHandler(
        {'http': proxy, 'https': proxy} if proxy else {}))
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={'User-Agent': 'BuscadorFornecedores/1.0', **(headers or {})})
    try:
        with opener.open(req, timeout=18) as response:
            return response.read(6_000_000).decode('utf-8', errors='replace')
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403, 429, 503):
            raise Pending(f'Acesso negado ou limitado pelo site (HTTP {exc.code}).') from None
        raise
    except urllib.error.URLError:
        raise Pending('Falha de conexão com a fonte.') from None


def supplier_page(config, url, proxy=None):
    if not config.get('browser'):
        return Page(request(url, proxy=proxy) if proxy else request(url))

    from chrome_native import MAX_RESPONSE_BYTES, SOCKET_PATH, SOCKET_TIMEOUT

    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(SOCKET_TIMEOUT + 5)
            connection.connect(str(SOCKET_PATH))
            connection.sendall(json.dumps({'url': url}).encode('utf-8') + b'\n')
            with connection.makefile('rb') as stream:
                reply = json.loads(stream.readline(MAX_RESPONSE_BYTES))
    except (FileNotFoundError, ConnectionRefusedError):
        raise Pending('Abra o Chrome no servidor com a extensão do Buscador ativada.') from None
    except TimeoutError:
        raise Pending('O Chrome no servidor demorou para responder.') from None
    except (OSError, ValueError):
        raise Pending('A extensão do Buscador perdeu a conexão com o Chrome no servidor.') from None

    if not isinstance(reply, dict):
        raise Pending('A extensão do Buscador não retornou uma página válida.')
    if isinstance(reply.get('error'), str) and reply['error']:
        raise Pending(reply['error'][:500])
    status = reply.get('status')
    if status == 404:
        raise urllib.error.HTTPError(url, status, 'Produto não encontrado', None, None)
    if type(status) is int and status >= 400:
        raise Pending(f'O fornecedor recusou a consulta no Chrome (HTTP {status}).')
    if not isinstance(reply.get('html'), str) or not reply['html']:
        raise Pending('O Chrome não encontrou conteúdo do fornecedor.')
    return Page(reply['html'])


class Page(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.lines = []
        self.links = []
        self.anchor = None
        self.ignored = 0
        self.feed(source)
        self.text = ' '.join(' '.join(self.lines).split())
        if re.search(r'just a moment|access denied|verify you are human|robot check',
                     self.text[:2400], re.I):
            raise Pending('O site apresentou verificação de acesso.')

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.ignored += 1
        if tag == 'a':
            self.anchor = (dict(attrs).get('href', ''), [])

    def handle_endtag(self, tag):
        if tag in ('script', 'style') and self.ignored:
            self.ignored -= 1
        if tag == 'a' and self.anchor:
            url, parts = self.anchor
            self.links.append((url, ' '.join(parts)))
            self.anchor = None

    def handle_data(self, data):
        if not self.ignored:
            self.lines.append(data)
            if self.anchor:
                self.anchor[1].append(data)


def quantity(text, label):
    match = re.search(label + r'\s*\*?\s*:?\s*([\d,]+)\s*(\+?)', text, re.I)
    if match:
        return int(match[1].replace(',', '')), bool(match[2])
    return None


def price(text, label):
    match = re.search(label + r'\s*\$\s*([\d,]+\.\d{2})', text, re.I)
    if not match:
        raise Pending('Preço em dólar não identificado no produto.')
    return Decimal(match[1].replace(',', ''))


@dataclass(frozen=True)
class Offer:
    supplier: str
    price: Decimal
    quantity: int
    user_stock: int
    handling: int
    shipping: Decimal
    link: str
    timing: str
    at_least: bool = False


def offer(config, amount, qty, link, timing='Estoque', units=1, at_least=False):
    if qty < 0 or units < 1 or not amount.is_finite() or amount <= 0:
        raise Pending('Preço ou unidade de estoque inválidos.')
    handling = config['tomorrow'] if timing == 'Tomorrow' else config['handling']
    return Offer(config['name'], amount, qty, qty * units, handling,
                 Decimal(str(config['shipping'])), link, timing, at_least)


def smc(config, part, pack, proxy):
    if not proxy and not config.get('host_vpn'):
        raise Pending('Conexão Proton VPN dos EUA ainda não configurada.')
    link = 'https://www.smcpneumatics.com/' + urllib.parse.quote(part, safe='-') + '.html'
    try:
        page = supplier_page(config, link, proxy)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    main = re.split(r'close match in stock items', page.text, maxsplit=1, flags=re.I)[0]
    match = re.search(r'Part Number\s*:\s*([A-Z0-9./-]+)', main, re.I)
    if not match or normalized(match[1]) != normalized(part):
        raise Pending('O código exato não foi confirmado na página SMC.')
    today = quantity(main, r'Available to Ship Today')
    tomorrow = quantity(main, r'Available to Ship Tomorrow')
    minimum = max(pack, config['minimum'])
    if today and today[0] >= minimum:
        qty, floor = today
        timing = 'Today'
    elif tomorrow and tomorrow[0] >= minimum:
        qty, floor = tomorrow
        timing = 'Tomorrow'
    elif (today and today[1]) or (tomorrow and tomorrow[1]):
        raise Pending('O estoque mínimo exibido não comprova a quantidade necessária.')
    elif today or tomorrow or re.search(r'weeks for delivery|out of stock', main, re.I):
        return None
    else:
        raise Pending('Disponibilidade Today/Tomorrow não encontrada.')
    return offer(config, price(main, r'Your Price\s*:'), qty, link, timing,
                 at_least=floor)


def motion(config, part, pack, proxy=None):
    base = 'https://www.motion.com'
    search = base + '/products/search;q=' + urllib.parse.quote(part, safe='-') + ';origin=search'
    page = supplier_page(config, search)
    links = set()
    for href, label in page.links:
        absolute = urllib.parse.urljoin(base, html.unescape(href))
        url = urllib.parse.urlsplit(absolute)
        if (url.scheme == 'https' and url.netloc == 'www.motion.com'
                and url.path.startswith('/products/sku/') and contains_part(label, part)):
            links.add(url._replace(query='', fragment='').geturl())
    if len(links) > 1:
        raise Pending('Mais de um produto Motion com o código pesquisado.')
    if not links:
        if re.search(r'\b(?:0 results|no results|no products found)\b', page.text, re.I):
            return None
        raise Pending('O resultado exato da Motion não pôde ser identificado.')
    link = links.pop()
    product = supplier_page(config, link).text
    match = re.search(r'MFR\s*#\s*:?\s*([A-Z0-9./-]+)', product, re.I)
    if not match or normalized(match[1]) != normalized(part):
        raise Pending('O código MFR exato não foi confirmado na página Motion.')
    if re.search(r'\b(?:Factory Order|Out of Stock)\b', product, re.I):
        return None
    stock = quantity(product, r'(?:Quantity Available|Available Quantity|In Stock\s*:|Stock Availability)')
    if stock is None:
        match = re.search(r'\b([\d,]+)\s*(\+?)\s+(?:available|in stock)\b', product, re.I)
        if match:
            stock = int(match[1].replace(',', '')), bool(match[2])
    if stock is None:
        if config.get('browser') and re.search(r'\b(?:sign in|log in|login)\b.{0,90}\b(?:availability|stock|pricing)\b', product, re.I):
            raise Pending('Entre na conta da Motion no Chrome do servidor para consultar o estoque.')
        raise Pending('A Motion não informou saldo numérico confirmado.')
    match = re.search(r'\$\s*([\d,]+\.\d{2})\s*/\s*each\b', product, re.I)
    if not match:
        raise Pending('Preço e unidade de venda da Motion não identificados.')
    amount = Decimal(match[1].replace(',', ''))
    return offer(config, amount, stock[0], link, at_least=stock[1])


def supplier_api(config, part, pack, proxy=None):
    """Contract for a configured catalog feed with explicit sell-unit size."""
    link = config['endpoint'].replace('{part}', urllib.parse.quote(part, safe=''))
    source = urllib.parse.urlsplit(link)
    if source.scheme != 'https' or source.username or source.password:
        raise Pending('O endereço do catálogo precisa usar HTTPS.')
    try:
        data = json.loads(request(link))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    if not isinstance(data, dict):
        raise Pending('Catálogo respondeu com formato inesperado.')
    if normalized(data.get('partNumber', '')) != normalized(part) or data.get('currency') != 'USD':
        raise Pending('Código exato ou moeda não confirmados no catálogo.')
    product_url = urllib.parse.urlsplit(data.get('url', ''))
    if (product_url.scheme != 'https' or product_url.hostname != config['product_host']
            or product_url.username or product_url.password):
        raise Pending('Link de produto fora do domínio cadastrado.')
    if any(type(data.get(key)) is not int for key in ('quantity', 'unitsPerSale')):
        raise Pending('O catálogo precisa informar saldo e peças por unidade de venda.')
    return offer(config, Decimal(str(data['price'])), data['quantity'], product_url.geturl(),
                 units=data['unitsPerSale'])


DRIVERS = {'motion': motion, 'smc': smc, 'json': supplier_api}
