/**
 * Exact product matching, supplier availability, SSRF protection, and Chrome bridge client.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Parser } from 'htmlparser2';
import { MAX_RESPONSE_BYTES, SOCKET_PATH, SOCKET_TIMEOUT_MS } from './chrome-native.js';

export class Pending extends Error {
  constructor(message) {
    super(message);
    this.name = 'Pending';
  }
}

export class HttpError extends Error {
  constructor(code, url, message = `HTTP ${code}`) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.url = url;
  }
}

export function normalized(value) {
  return String(value).trim().toUpperCase().replace(/[‐‑–−]/g, '-');
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function containsPart(text, part) {
  const re = new RegExp(`(?<![A-Z0-9./-])${escapeRegex(normalized(part))}(?![A-Z0-9]|[./-][A-Z0-9])`);
  return re.test(normalized(text));
}

export function toCents(value) {
  const raw = String(value).trim().replace(/,/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw new Pending('Preço ou unidade de estoque inválidos.');
  const neg = raw.startsWith('-');
  const [whole, frac = ''] = (neg ? raw.slice(1) : raw).split('.');
  const padded = (frac + '00').slice(0, 2);
  const extra = frac.length > 2 && Number(frac[2]) >= 5 ? 1 : 0;
  const total = Number(whole) * 100 + Number(padded) + extra;
  return neg ? -total : total;
}

export function formatCents(cents) {
  const neg = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${neg}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function stripWww(host) {
  return (host || '').toLowerCase().replace(/^www\./, '');
}

function openProxyTunnel(proxyUrl, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const mod = p.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: p.hostname,
      port: p.port || (p.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      timeout: timeoutMs,
      headers: p.username || p.password
        ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64') }
        : {},
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Pending('Falha de conexão com a fonte.'));
        return;
      }
      resolve(socket);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Pending('Falha de conexão com a fonte.'));
    });
    req.on('error', () => reject(new Pending('Falha de conexão com a fonte.')));
    req.end();
  });
}

async function singleRequest(urlString, { proxy = null, headers = {}, data = null, method = null } = {}) {
  const parsed = new URL(urlString);
  const timeoutMs = 18_000;
  const reqHeaders = { 'User-Agent': 'BuscadorFornecedores/1.0', ...headers };
  const payload = data == null ? null : (Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8'));
  if (payload && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
    reqHeaders['Content-Length'] = String(payload.length);
  }
  const effectiveMethod = method || (payload ? 'POST' : 'GET');

  let tunnelSocket = null;
  if (proxy) {
    let p;
    try {
      p = new URL(proxy);
    } catch {
      throw new Pending('O proxy SMC precisa encaminhar HTTPS sem exceção para o domínio.');
    }
    if (p.protocol !== 'http:' && p.protocol !== 'https:') {
      throw new Pending('O proxy SMC precisa encaminhar HTTPS sem exceção para o domínio.');
    }
    if (parsed.protocol === 'https:') {
      tunnelSocket = await openProxyTunnel(proxy, parsed.hostname, parsed.port || 443, timeoutMs);
    }
  }

  return new Promise((resolve, reject) => {
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;
    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: effectiveMethod,
      headers: reqHeaders,
      timeout: timeoutMs,
    };
    if (tunnelSocket) {
      options.socket = tunnelSocket;
      options.servername = parsed.hostname;
      options.agent = false;
    }

    const req = mod.request(options, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        resolve({ status, location: res.headers.location, body: '' });
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        if (total < 6_000_000) {
          const remaining = 6_000_000 - total;
          chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
          total += chunk.length;
        }
      });
      res.on('end', () => {
        resolve({ status, location: null, body: Buffer.concat(chunks).toString('utf-8') });
      });
      res.on('error', () => reject(new Pending('Falha de conexão com a fonte.')));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Pending('Falha de conexão com a fonte.'));
    });
    req.on('error', () => reject(new Pending('Falha de conexão com a fonte.')));
    if (payload) req.write(payload);
    req.end();
  });
}

export async function request(url, opts = {}) {
  let currentUrl = url;
  for (let hops = 0; hops < 6; hops += 1) {
    const res = await singleRequest(currentUrl, opts);
    if (res.location) {
      const oldParsed = new URL(currentUrl);
      let nextParsed;
      try {
        nextParsed = new URL(res.location, currentUrl);
      } catch {
        throw new Pending('O site redirecionou para outro domínio.');
      }
      if (
        nextParsed.protocol !== 'https:'
        || !nextParsed.hostname
        || nextParsed.username
        || nextParsed.password
        || stripWww(oldParsed.hostname) !== stripWww(nextParsed.hostname)
      ) {
        throw new Pending('O site redirecionou para outro domínio.');
      }
      currentUrl = nextParsed.toString();
      continue;
    }
    if ([401, 403, 429, 503].includes(res.status)) {
      throw new Pending(`Acesso negado ou limitado pelo site (HTTP ${res.status}).`);
    }
    if (res.status >= 400) {
      throw new HttpError(res.status, currentUrl);
    }
    return res.body;
  }
  throw new Pending('Falha de conexão com a fonte.');
}

export const supplierDeps = {
  request,
  lookupDns: (hostname) => dns.promises.lookup(hostname, { all: true }),
};

export async function supplierPage(config, url, proxy = null) {
  if (!config.browser) {
    const html = proxy ? await supplierDeps.request(url, { proxy }) : await supplierDeps.request(url);
    return new Page(html);
  }

  let reply;
  try {
    reply = await new Promise((resolve, reject) => {
      const socket = net.createConnection(SOCKET_PATH);
      socket.setTimeout(SOCKET_TIMEOUT_MS + 5000);
      let buffer = Buffer.alloc(0);

      socket.once('connect', () => {
        socket.write(JSON.stringify({ url }) + '\n');
      });
      socket.on('data', (chunk) => {
        if (buffer.length + chunk.length > MAX_RESPONSE_BYTES) {
          socket.destroy();
          reject(new Error('overflow'));
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        const nl = buffer.indexOf(0x0a);
        if (nl >= 0) {
          socket.destroy();
          try {
            resolve(JSON.parse(buffer.subarray(0, nl).toString('utf-8')));
          } catch (err) {
            reject(err);
          }
        }
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
      });
      socket.once('error', reject);
      socket.once('end', () => {
        if (buffer.length) {
          try {
            resolve(JSON.parse(buffer.toString('utf-8').trim()));
          } catch (err) {
            reject(err);
          }
        }
      });
    });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) {
      throw new Pending('Abra o Chrome no servidor com a extensão do Buscador ativada.');
    }
    if (err && err.code === 'ETIMEDOUT') {
      throw new Pending('O Chrome no servidor demorou para responder.');
    }
    throw new Pending('A extensão do Buscador perdeu a conexão com o Chrome no servidor.');
  }

  if (!reply || typeof reply !== 'object') {
    throw new Pending('A extensão do Buscador não retornou uma página válida.');
  }
  if (typeof reply.error === 'string' && reply.error) {
    throw new Pending(reply.error.slice(0, 500));
  }
  if (reply.status === 404) {
    throw new HttpError(404, url, 'Produto não encontrado');
  }
  if (Number.isInteger(reply.status) && reply.status >= 400) {
    throw new Pending(`O fornecedor recusou a consulta no Chrome (HTTP ${reply.status}).`);
  }
  if (typeof reply.html !== 'string' || !reply.html) {
    throw new Pending('O Chrome não encontrou conteúdo do fornecedor.');
  }
  return new Page(reply.html);
}

export class Page {
  constructor(source) {
    this.lines = [];
    this.links = [];
    this.data = [];
    let ignored = 0;
    let jsonLd = null;
    let anchor = null;

    const parser = new Parser({
      onopentag: (name, attrs) => {
        const tag = name.toLowerCase();
        if (tag === 'script' || tag === 'style') ignored += 1;
        if (tag === 'script' && (attrs.type || '').toLowerCase() === 'application/ld+json') {
          jsonLd = [];
        }
        if (tag === 'a') {
          anchor = { href: attrs.href || '', parts: [] };
        }
      },
      ontext: (text) => {
        if (jsonLd !== null) jsonLd.push(text);
        if (!ignored) {
          this.lines.push(text);
          if (anchor) anchor.parts.push(text);
        }
      },
      onclosetag: (name) => {
        const tag = name.toLowerCase();
        if (tag === 'script' && jsonLd !== null) {
          try {
            this.data.push(JSON.parse(jsonLd.join('')));
          } catch {
            // Ignore malformed JSON-LD blocks.
          }
          jsonLd = null;
        }
        if ((tag === 'script' || tag === 'style') && ignored > 0) ignored -= 1;
        if (tag === 'a' && anchor) {
          this.links.push([anchor.href, anchor.parts.join(' ')]);
          anchor = null;
        }
      },
    }, { decodeEntities: true });

    parser.write(String(source || ''));
    parser.end();

    this.text = this.lines.join(' ').replace(/\s+/g, ' ').trim();
    if (/just a moment|access denied|verify you are human|robot check/i.test(this.text.slice(0, 2400))) {
      throw new Pending('O site apresentou verificação de acesso.');
    }
  }
}

export function quantity(text, labelPattern) {
  const re = new RegExp(`${labelPattern}\\s*\\*?\\s*:?\\s*([\\d,]+)\\s*(\\+?)`, 'i');
  const match = re.exec(text);
  if (!match) return null;
  return [Number.parseInt(match[1].replace(/,/g, ''), 10), Boolean(match[2])];
}

export function price(text, labelPattern) {
  const re = new RegExp(`${labelPattern}\\s*\\$\\s*([\\d,]+\\.\\d{2})`, 'i');
  const match = re.exec(text);
  if (!match) throw new Pending('Preço em dólar não identificado no produto.');
  return formatCents(toCents(match[1]));
}

export function offer(config, amount, qty, link, timing = 'Estoque', units = 1, atLeast = false) {
  const cents = toCents(amount);
  if (!Number.isInteger(qty) || qty < 0 || !Number.isInteger(units) || units < 1 || !Number.isFinite(cents) || cents <= 0) {
    throw new Pending('Preço ou unidade de estoque inválidos.');
  }
  const handling = timing === 'Tomorrow' ? config.tomorrow : config.handling;
  const shippingCents = toCents(config.shipping);
  return Object.freeze({
    supplier: config.name,
    price: formatCents(cents),
    priceCents: cents,
    quantity: qty,
    userStock: qty * units,
    handling,
    shipping: formatCents(shippingCents),
    shippingCents,
    link,
    timing,
    atLeast,
  });
}

export async function smc(config, part, pack, proxy) {
  if (!proxy && !config.hostVpn) {
    throw new Pending('Conexão Proton VPN dos EUA ainda não configurada.');
  }
  const encoded = encodeURIComponent(part).replace(/%2D/gi, '-');
  const link = `https://www.smcpneumatics.com/${encoded}.html`;
  let page;
  try {
    page = await supplierPage(config, link, proxy);
  } catch (err) {
    if (err instanceof HttpError && err.code === 404) return null;
    throw err;
  }
  const main = page.text.split(/close match in stock items/i)[0];
  const match = /Part Number\s*:\s*([A-Z0-9./-]+)/i.exec(main);
  if (!match || normalized(match[1]) !== normalized(part)) {
    throw new Pending('O código exato não foi confirmado na página SMC.');
  }
  const today = quantity(main, 'Available to Ship Today');
  const tomorrow = quantity(main, 'Available to Ship Tomorrow');
  const minimum = Math.max(pack, config.minimum);
  let qty;
  let floor;
  let timing;
  if (today && today[0] >= minimum) {
    [qty, floor] = today;
    timing = 'Today';
  } else if (tomorrow && tomorrow[0] >= minimum) {
    [qty, floor] = tomorrow;
    timing = 'Tomorrow';
  } else if ((today && today[1]) || (tomorrow && tomorrow[1])) {
    throw new Pending('O estoque mínimo exibido não comprova a quantidade necessária.');
  } else if (today || tomorrow || /weeks for delivery|out of stock/i.test(main)) {
    return null;
  } else {
    throw new Pending('Disponibilidade Today/Tomorrow não encontrada.');
  }
  return offer(config, price(main, 'Your Price\\s*:'), qty, link, timing, 1, floor);
}

export async function motion(config, part, _pack, _proxy = null) {
  const base = 'https://www.motion.com';
  const encoded = encodeURIComponent(part).replace(/%2D/gi, '-');
  const search = `${base}/products/search;q=${encoded};origin=search`;
  const page = await supplierPage(config, search);
  const links = new Set();
  for (const [href, label] of page.links) {
    let url;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol === 'https:' && url.host === 'www.motion.com' && url.pathname.startsWith('/products/sku/') && containsPart(label, part)) {
      url.search = '';
      url.hash = '';
      links.add(url.toString());
    }
  }
  if (links.size > 1) {
    throw new Pending('Mais de um produto Motion com o código pesquisado.');
  }
  if (links.size === 0) {
    if (/\b(?:0 results|no results|no products found)\b/i.test(page.text)) return null;
    throw new Pending('O resultado exato da Motion não pôde ser identificado.');
  }
  const [link] = links;
  const product = (await supplierPage(config, link)).text;
  const mfr = /MFR\s*#\s*:?\s*([A-Z0-9./-]+)/i.exec(product);
  if (!mfr || normalized(mfr[1]) !== normalized(part)) {
    throw new Pending('O código MFR exato não foi confirmado na página Motion.');
  }
  if (/\b(?:Factory Order|Out of Stock)\b/i.test(product)) return null;

  let stock = quantity(product, '(?:Quantity Available|Available Quantity|In Stock\\s*:|Stock Availability)');
  if (!stock) {
    const match = /\b([\d,]+)\s*(\+?)\s+(?:available|in stock)\b/i.exec(product);
    if (match) stock = [Number.parseInt(match[1].replace(/,/g, ''), 10), Boolean(match[2])];
  }
  if (!stock) {
    if (config.browser && /\b(?:sign in|log in|login)\b.{0,90}\b(?:availability|stock|pricing)\b/i.test(product)) {
      throw new Pending('Entre na conta da Motion no Chrome do servidor para consultar o estoque.');
    }
    throw new Pending('A Motion não informou saldo numérico confirmado.');
  }
  const amountMatch = /\$\s*([\d,]+\.\d{2})\s*\/\s*each\b/i.exec(product);
  if (!amountMatch) {
    throw new Pending('Preço e unidade de venda da Motion não identificados.');
  }
  return offer(config, amountMatch[1], stock[0], link, 'Estoque', 1, stock[1]);
}

function isGlobalIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

export function isGlobalIp(address) {
  const ip = String(address || '').toLowerCase();
  if (net.isIPv4(ip)) return isGlobalIpv4(ip);
  if (!net.isIPv6(ip)) return false;
  if (ip === '::' || ip === '::1') return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isGlobalIpv4(mapped[1]);
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb') || ip.startsWith('ff')) {
    return false;
  }
  if (ip.startsWith('2001:db8:')) return false;
  return true;
}

export function publicLink(value) {
  if (typeof value !== 'string') throw new Pending('Link inválido.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Pending('Link inválido.');
  }
  const host = url.hostname.toLowerCase();
  const bareHost = host.replace(/^\[|\]$/g, '');
  const isNumericIp = net.isIP(bareHost) !== 0;
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || (url.port !== '' && url.port !== '443')
    || isNumericIp
    || !host.includes('.')
    || value.length > 2000
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.localhost')
  ) {
    throw new Pending('Use um link completo de um site público, começando com https://.');
  }
  return [url, stripWww(host)];
}

export async function openPublic(url) {
  const [parts] = publicLink(url);
  let records;
  try {
    records = await supplierDeps.lookupDns(parts.hostname);
  } catch {
    throw new Pending('O endereço do fornecedor não foi encontrado.');
  }
  if (!records.length || !records.every((entry) => isGlobalIp(entry.address))) {
    throw new Pending('O link aponta para um endereço de rede interna.');
  }
  return new Page(await supplierDeps.request(url));
}

function* nodes(value) {
  if (Array.isArray(value)) {
    for (const child of value) yield* nodes(child);
  } else if (value && typeof value === 'object') {
    yield value;
    for (const child of Object.values(value)) yield* nodes(child);
  }
}

function productsIn(page) {
  return [...nodes(page.data)].filter((node) => String(node['@type'] || '').includes('Product'));
}

function structuredProduct(page, part) {
  return productsIn(page).find((node) =>
    ['mpn', 'sku', 'model'].some((key) => normalized(node[key] || '') === part),
  ) || null;
}

function labeledProduct(page, part) {
  const label = "(?:MFR\\s*(?:#|PART\\s*(?:NUMBER|NO\\.?|#)?)|MPN|MANUFACTURER(?:'S)?\\s*PART\\s*(?:NUMBER|NO\\.?|#)|PART\\s*(?:NUMBER|NO\\.?|#)|SKU|MODEL\\s*(?:NUMBER|NO\\.?|#)?)[\\s:#]*";
  const re = new RegExp(`${label}${escapeRegex(part)}(?![A-Z0-9]|[./-][A-Z0-9])`);
  return re.test(normalized(page.text)) && productsIn(page).length === 0 ? {} : null;
}

function only(values, problem) {
  if (values.size > 1) throw new Pending(problem);
  return values.values().next().value ?? null;
}

export function readProduct(config, page, node, link) {
  const entries = [...nodes(node.offers || [])];
  const availability = entries.map((entry) => String(entry.availability || '')).join(' ');
  if (/OutOfStock|SoldOut|Discontinued|BackOrder/.test(availability) && !availability.includes('InStock')) {
    return null;
  }
  for (const entry of entries) {
    for (const [low, high] of [['lowPrice', 'highPrice'], ['minPrice', 'maxPrice']]) {
      if (String(entry[low]) !== String(entry[high])) {
        throw new Pending('O preço muda conforme a variação. Use o link de um item específico.');
      }
    }
  }
  const priced = entries.filter((entry) => entry.price !== undefined && entry.price !== null && entry.price !== '');
  if (priced.some((entry) => (entry.priceCurrency || 'USD') !== 'USD')) {
    throw new Pending('O preço do produto não está em dólar.');
  }
  const amounts = new Set(priced.map((entry) => formatCents(toCents(entry.price))));
  if (amounts.size === 0) {
    const priceRe = /(?:Your Price|Our Price|Price)\s*:?\s*\$\s*([\d,]+\.\d{2})|\$\s*([\d,]+\.\d{2})\s*(?:\/\s*|per )(?:each|ea)\b/gi;
    for (const match of page.text.matchAll(priceRe)) {
      amounts.add(formatCents(toCents(match[1] || match[2])));
    }
  }
  const amount = only(amounts, 'A página mostra mais de um preço para o produto.');
  if (amount === null) {
    throw new Pending('Produto encontrado, mas sem preço em dólar identificável.');
  }

  const stocks = new Set();
  for (const entry of entries) {
    for (const level of nodes(entry.inventoryLevel || [])) {
      if (/^\d+$/.test(String(level.value ?? ''))) {
        stocks.add(`${Number.parseInt(String(level.value), 10)}:0`);
      }
    }
  }
  if (stocks.size === 0) {
    const labeledRe = /(?:Quantity Available|Available Quantity|Qty\.? Available|In Stock\s*:|Stock\s*:)\s*(\d[\d,]*)(?![\d.])\s*(\+?)/gi;
    for (const match of page.text.matchAll(labeledRe)) {
      stocks.add(`${Number.parseInt(match[1].replace(/,/g, ''), 10)}:${match[2] ? 1 : 0}`);
    }
    // "12 in stock" only counts as an isolated text block to avoid reading prices/models as stock.
    const blockRe = /^\s*(\d[\d,]*)\s*(\+?)\s+(?:in stock|available)\.?\s*$/i;
    for (const line of page.lines) {
      const match = blockRe.exec(line);
      if (match) stocks.add(`${Number.parseInt(match[1].replace(/,/g, ''), 10)}:${match[2] ? 1 : 0}`);
    }
  }
  const rawStock = only(stocks, 'A página mostra quantidades diferentes de estoque.');
  if (rawStock === null) {
    if (!availability && /\bout of stock\b/i.test(page.text)) return null;
    throw new Pending('Produto encontrado, mas o site não informa a quantidade em estoque.');
  }
  const [qtyStr, plusStr] = rawStock.split(':');
  return offer(config, amount, Number.parseInt(qtyStr, 10), link, 'Estoque', 1, plusStr === '1');
}

export async function searchLink(config, link, part, discover = true) {
  const url = link.replaceAll('{part}', encodeURIComponent(part));
  const page = await openPublic(url);
  let node = structuredProduct(page, part);
  if (node !== null) return [true, readProduct(config, page, node, url)];

  const [here, domain] = publicLink(url);
  const candidates = new Set();
  for (const [href, label] of page.links) {
    let parsed;
    try {
      parsed = new URL(href, url);
    } catch {
      continue;
    }
    parsed.hash = '';
    const target = parsed.toString();
    const slug = decodeURIComponent(parsed.pathname).replace(/\/+$/, '').split('/').pop() || '';
    if (
      parsed.protocol === 'https:'
      && stripWww(parsed.hostname) === domain
      && parsed.pathname !== here.pathname
      && (containsPart(label, part) || normalized(slug).replace(/\.HTML$/, '') === part)
    ) {
      candidates.add(target);
    }
  }

  const confirmed = [];
  for (const target of [...candidates].slice(0, 5)) {
    const product = await openPublic(target);
    const foundNode = structuredProduct(product, part) || labeledProduct(product, part);
    if (foundNode !== null) confirmed.push([product, foundNode, target]);
  }
  if (confirmed.length > 1) {
    throw new Pending('O site tem mais de um produto com o código pesquisado.');
  }
  if (confirmed.length === 1) {
    return [true, readProduct(config, ...confirmed[0])];
  }

  node = labeledProduct(page, part);
  if (node !== null) return [true, readProduct(config, page, node, url)];

  if (discover && !link.includes('{part}')) {
    for (const action of nodes(page.data)) {
      if (action['@type'] !== 'SearchAction') continue;
      const target = action.target;
      let template = target && typeof target === 'object' ? target.urlTemplate : target;
      if (typeof template === 'string') {
        template = template.replace(/\{(?:search_term_string|search_term|query|q)\}/g, '{part}');
        try {
          if (template.includes('{part}') && stripWww(new URL(template).hostname) === domain) {
            return searchLink(config, template, part, false);
          }
        } catch {
          // Ignore malformed SearchAction URLs.
        }
      }
    }
  }
  return [false, null];
}

export async function site(config, part, _pack, _proxy = null) {
  let failure = null;
  for (const link of config.links) {
    let found;
    let result;
    try {
      [found, result] = await searchLink(config, link, part);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.code !== 404) failure = failure || new Pending(`O site respondeu HTTP ${err.code}.`);
        continue;
      }
      if (err instanceof Pending) {
        failure = failure || err;
        continue;
      }
      throw err;
    }
    if (found) return result;
  }
  if (failure) throw failure;
  return null;
}

export const DRIVERS = { motion, smc, site };
