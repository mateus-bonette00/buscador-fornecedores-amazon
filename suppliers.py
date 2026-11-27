"""Exact product matching and supplier availability."""

import html
import ipaddress
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
        self.data = []
        self.json_ld = None
        self.feed(source)
        self.text = ' '.join(' '.join(self.lines).split())
        if re.search(r'just a moment|access denied|verify you are human|robot check',
                     self.text[:2400], re.I):
            raise Pending('O site apresentou verificação de acesso.')

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.ignored += 1
        if tag == 'script' and dict(attrs).get('type') == 'application/ld+json':
            self.json_ld = []
        if tag == 'a':
            self.anchor = (dict(attrs).get('href', ''), [])

    def handle_endtag(self, tag):
        if tag == 'script' and self.json_ld is not None:
            try:
                self.data.append(json.loads(''.join(self.json_ld)))
            except ValueError:
                pass
            self.json_ld = None
        if tag in ('script', 'style') and self.ignored:
            self.ignored -= 1
        if tag == 'a' and self.anchor:
            url, parts = self.anchor
            self.links.append((url, ' '.join(parts)))
            self.anchor = None

    def handle_data(self, data):
        if self.json_ld is not None:
            self.json_ld.append(data)
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


def public_link(value):
    """Validate a user-supplied supplier link and return its parts and bare domain."""
    try:
        url = urllib.parse.urlsplit(value)
        port = url.port
    except (ValueError, TypeError, AttributeError):
        raise Pending('Link inválido.') from None
    host = (url.hostname or '').lower()
    try:
        ipaddress.ip_address(host)
        numeric = True
    except ValueError:
        numeric = False
    if (url.scheme != 'https' or url.username or url.password or port not in (None, 443)
            or numeric or '.' not in host or len(value) > 2000
            or host.endswith(('.local', '.internal', '.localhost'))):
        raise Pending('Use um link completo de um site público, começando com https://.')
    return url, host.removeprefix('www.')


def open_public(url):
    parts, _ = public_link(url)
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(parts.hostname, 443)}
    except OSError:
        raise Pending('O endereço do fornecedor não foi encontrado.') from None
    if not all(ipaddress.ip_address(address).is_global for address in addresses):
        raise Pending('O link aponta para um endereço de rede interna.')
    return Page(request(url))


def nodes(value):
    if isinstance(value, dict):
        yield value
        value = list(value.values())
    if isinstance(value, list):
        for child in value:
            yield from nodes(child)


def products_in(page):
    return [node for node in nodes(page.data) if 'Product' in str(node.get('@type', ''))]


def structured_product(page, part):
    return next((node for node in products_in(page) if any(
        normalized(str(node.get(key, ''))) == part for key in ('mpn', 'sku', 'model'))), None)


def labeled_product(page, part):
    """Text fallback, used only when the page publishes no structured product."""
    label = (r"(?:MFR\s*(?:#|PART\s*(?:NUMBER|NO\.?|#)?)|MPN|MANUFACTURER(?:'S)?\s*PART\s*(?:NUMBER|NO\.?|#)"
             r'|PART\s*(?:NUMBER|NO\.?|#)|SKU|MODEL\s*(?:NUMBER|NO\.?|#)?)\s*[:#]?\s*')
    found = re.search(label + re.escape(part) + r'(?![A-Z0-9]|[./-][A-Z0-9])', normalized(page.text))
    return {} if found and not products_in(page) else None


def only(values, problem):
    if len(values) > 1:
        raise Pending(problem)
    return next(iter(values), None)


def read_product(config, page, node, link):
    entries = list(nodes(node.get('offers', [])))
    availability = ' '.join(str(entry.get('availability', '')) for entry in entries)
    if re.search(r'OutOfStock|SoldOut|Discontinued|BackOrder', availability) and 'InStock' not in availability:
        return None
    if any(str(entry.get(low)) != str(entry.get(high)) for entry in entries
           for low, high in (('lowPrice', 'highPrice'), ('minPrice', 'maxPrice'))):
        raise Pending('O preço muda conforme a variação. Use o link de um item específico.')
    priced = [entry for entry in entries if entry.get('price') not in (None, '')]
    if any(entry.get('priceCurrency', 'USD') != 'USD' for entry in priced):
        raise Pending('O preço do produto não está em dólar.')
    amounts = {Decimal(str(entry['price']).replace(',', '')) for entry in priced}
    if not amounts:
        amounts = {Decimal((first or second).replace(',', '')) for first, second in re.findall(
            r'(?:Your Price|Our Price|Price)\s*:?\s*\$\s*([\d,]+\.\d{2})'
            r'|\$\s*([\d,]+\.\d{2})\s*(?:/\s*|per )(?:each|ea)\b', page.text, re.I)}
    amount = only(amounts, 'A página mostra mais de um preço para o produto.')
    if amount is None:
        raise Pending('Produto encontrado, mas sem preço em dólar identificável.')
    stocks = {(int(level['value']), False) for entry in entries
              for level in nodes(entry.get('inventoryLevel', [])) if str(level.get('value', '')).isdigit()}
    if not stocks:
        found = re.findall(r'(?:Quantity Available|Available Quantity|Qty\.? Available|In Stock\s*:|Stock\s*:)'
                           r'\s*(\d[\d,]*)(?![\d.])\s*(\+?)', page.text, re.I)
        # "12 in stock" only counts as a whole text block. Inside running text the number
        # can be cents or a model name ("$552.46 In stock", "Mega 2560 In stock").
        found += [match.groups() for line in page.lines if (match := re.fullmatch(
            r'\s*(\d[\d,]*)\s*(\+?)\s+(?:in stock|available)\.?\s*', line, re.I))]
        stocks = {(int(number.replace(',', '')), bool(plus)) for number, plus in found}
    stock = only(stocks, 'A página mostra quantidades diferentes de estoque.')
    if stock is None:
        if not availability and re.search(r'\bout of stock\b', page.text, re.I):
            return None
        raise Pending('Produto encontrado, mas o site não informa a quantidade em estoque.')
    return offer(config, amount, stock[0], link, at_least=stock[1])


def search_link(config, link, part, discover=True):
    """Return (found, offer) for one link: product page, search, listing or home page."""
    url = link.replace('{part}', urllib.parse.quote(part, safe=''))
    page = open_public(url)
    node = structured_product(page, part)
    if node is not None:
        return True, read_product(config, page, node, url)
    here, domain = public_link(url)
    candidates = {}
    for href, label in page.links:
        target = urllib.parse.urljoin(url, href).split('#')[0]
        parsed = urllib.parse.urlsplit(target)
        slug = urllib.parse.unquote(parsed.path).rstrip('/').rpartition('/')[2]
        if (parsed.scheme == 'https' and (parsed.hostname or '').removeprefix('www.') == domain
                and parsed.path != here.path
                and (contains_part(label, part) or normalized(slug).removesuffix('.HTML') == part)):
            candidates[target] = None
    confirmed = []
    for target in list(candidates)[:5]:
        product = open_public(target)
        node = structured_product(product, part)
        if node is None:
            node = labeled_product(product, part)
        if node is not None:
            confirmed.append((product, node, target))
    if len(confirmed) > 1:
        raise Pending('O site tem mais de um produto com o código pesquisado.')
    if confirmed:
        return True, read_product(config, *confirmed[0])
    node = labeled_product(page, part)
    if node is not None:
        return True, read_product(config, page, node, url)
    if discover and '{part}' not in link:
        for action in nodes(page.data):
            if action.get('@type') != 'SearchAction':
                continue
            target = action.get('target')
            template = target.get('urlTemplate') if isinstance(target, dict) else target
            if isinstance(template, str):
                template = re.sub(r'\{(?:search_term_string|search_term|query|q)\}', '{part}', template)
                if '{part}' in template and (urllib.parse.urlsplit(template).hostname or '').removeprefix('www.') == domain:
                    return search_link(config, template, part, discover=False)
    return False, None


def site(config, part, pack, proxy=None):
    """Generic reader. Links are tried in the order given; the first one with the part wins."""
    failure = None
    for link in config['links']:
        try:
            found, result = search_link(config, link, part)
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                failure = failure or Pending(f'O site respondeu HTTP {exc.code}.')
            continue
        except Pending as exc:
            failure = failure or exc
            continue
        if found:
            return result
    if failure:
        raise failure
    return None


DRIVERS = {'motion': motion, 'smc': smc, 'site': site}
