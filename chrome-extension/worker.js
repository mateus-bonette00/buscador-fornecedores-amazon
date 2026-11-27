const HOST = 'com.buscador_fornecedores.suppliers';
const RECONNECT = 'buscador-fornecedores-amazon-reconnect';
const MAX_JOBS = 3;
const JOB_TIMEOUT_MS = 22000;
const PAGE_WAIT_MS = 8000;
const MAX_HTML_BYTES = 250000;
const jobs = new Map();
let channel;

class SupplierError extends Error {}

function supplierUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
    if (url.hostname === 'www.motion.com' && /^\/products\/(?:search(?:;|\/|$)|sku\/)/.test(url.pathname)) return url;
    if (url.hostname === 'www.smcpneumatics.com' && /^\/[a-z\d](?:[a-z\d.-]|%2f)*\.html$/i.test(url.pathname)) return url;
  } catch {
    return null;
  }
  return null;
}

// This function runs in an isolated world on a supplier tab created by the app.
function productData(expectedOrigin, expectedPath, kind, searchPart) {
  if (location.origin !== expectedOrigin || location.pathname !== expectedPath) return { changed: true };
  const visible = (document.body?.innerText || '').slice(0, 400000);
  const heading = document.querySelector('h1')?.innerText || '';
  const blocked = /^(?:access denied|just a moment|verify (?:that )?you are human|robot check|request blocked|checking your browser)/i;
  if (blocked.test(document.title.trim()) || blocked.test(heading.trim()) || blocked.test(visible.trim())) {
    return { blocked: true };
  }

  let text = visible.replace(/\s+/g, ' ');
  const fields = [];
  const links = [];
  const add = (pattern) => {
    const match = text.match(pattern)?.[0];
    if (match) fields.push(match);
    return Boolean(match);
  };

  // Send only fields the Python parsers use, never a DOM snapshot or form values.
  if (kind === 'smc') {
    text = text.split(/close match in stock items/i, 1)[0];
    const part = add(/Part Number\s*:\s*[A-Z\d./-]{1,100}/i);
    const today = add(/Available to Ship Today\s*\*?\s*:?\s*[\d,]{1,14}\s*\+?/i);
    const tomorrow = add(/Available to Ship Tomorrow\s*\*?\s*:?\s*[\d,]{1,14}\s*\+?/i);
    const price = add(/Your Price\s*:\s*\$\s*[\d,]{1,14}\.\d{2}/i);
    const unavailable = add(/weeks for delivery|out of stock/i);
    return { fields, links, ready: part && (unavailable || ((today || tomorrow) && price)) };
  }

  if (kind === 'search') {
    const noResults = add(/\b(?:0 results|no results|no products found)\b/i);
    const part = searchPart.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exact = new RegExp(`(?<![A-Z0-9./-])${part}(?![A-Z0-9]|[./-][A-Z0-9])`);
    for (const link of document.querySelectorAll('a[href]')) {
      if (links.length === 240) break;
      const label = link.innerText?.trim().slice(0, 350);
      if (!label || !exact.test(label.toUpperCase().replace(/[‐‑–−]/g, '-')) || !link.getClientRects().length) continue;
      let url;
      try { url = new URL(link.href, location.href); } catch { continue; }
      if (url.origin !== expectedOrigin || url.username || url.password || !url.pathname.startsWith('/products/sku/')) continue;
      // Product URLs only. Leave query strings and fragments on the page.
      links.push([url.origin + url.pathname, label]);
    }
    return { fields, links, ready: noResults || links.length > 0 };
  }

  const part = add(/MFR\s*#\s*:?\s*[A-Z\d./-]{1,100}/i);
  const unavailable = add(/\b(?:Factory Order|Out of Stock)\b/i);
  const labeled = add(/(?:Quantity Available|Available Quantity|In Stock\s*:|Stock Availability)\s*\*?\s*:?\s*[\d,]{1,14}\s*\+?/i);
  const qty = add(/\b[\d,]{1,14}\s*\+?\s+(?:available|in stock)\b/i);
  const price = add(/\$\s*[\d,]{1,14}\.\d{2}\s*\/\s*each\b/i);
  return { fields, links, ready: part && (unavailable || ((labeled || qty) && price)) };
}

function htmlFor({ fields, links }) {
  const escape = (value) => value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  let html = `<p>${fields.map(escape).join(' ')}</p>`;
  for (const [url, label] of links) html += `<a href="${escape(url)}">${escape(label)}</a>`;
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
    throw new SupplierError('O resultado do fornecedor excedeu o limite de leitura do Buscador.');
  }
  return html;
}

async function closeTab(job) {
  if (job.tab === undefined) return;
  const tab = job.tab;
  job.tab = undefined;
  await chrome.tabs.remove(tab).catch(() => {});
}

async function readPage(job, url) {
  const stop = Date.now() + JOB_TIMEOUT_MS;
  const kind = url.hostname === 'www.smcpneumatics.com' ? 'smc'
    : url.pathname.startsWith('/products/sku/') ? 'product' : 'search';
  const searchPart = kind === 'search' ? decodeURIComponent(url.pathname.match(/;q=([^;]+)/)?.[1] || '') : '';
  if (kind === 'search' && !searchPart) throw new SupplierError('A consulta da Motion precisa de um part number.');
  const { id } = await chrome.tabs.create({ active: false, url: 'about:blank' });
  job.tab = id;
  if (job.cancelled) throw new SupplierError('O Buscador perdeu a conexão com o Chrome.');
  await chrome.tabs.update(id, { url: url.href });
  let renderDeadline;
  while (!job.cancelled && Date.now() < stop) {
    if (job.networkError) throw new SupplierError('O Chrome não conseguiu abrir a página do fornecedor.');
    const status = job.status;
    if ([401, 403, 429, 503].includes(status)) {
      throw new SupplierError(`O fornecedor recusou a consulta do Chrome (HTTP ${status}).`);
    }
    if (status >= 400) return { html: '', status };
    const tab = await chrome.tabs.get(id);
    if (tab.status === 'complete' && tab.url && tab.url !== 'about:blank') {
      const final = supplierUrl(tab.url);
      if (final?.origin !== url.origin) {
        throw new SupplierError('O fornecedor redirecionou a página. Confirme a sessão no Chrome do servidor.');
      }
      renderDeadline ??= Date.now() + PAGE_WAIT_MS;
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId: id }, func: productData, args: [url.origin, final.pathname, kind, searchPart],
      });
      const data = frame?.result;
      if (data?.changed) throw new SupplierError('A página do fornecedor mudou de endereço durante a consulta.');
      if (data?.blocked) throw new SupplierError('O fornecedor apresentou uma página de verificação ou acesso negado no Chrome.');
      if (data && (data.ready || Date.now() >= renderDeadline)) return { html: htmlFor(data), status: status || 200 };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new SupplierError('O Chrome não concluiu a leitura da página do fornecedor a tempo.');
}

async function handleRequest(port, message) {
  const id = message?.id;
  if (!(typeof id === 'string' && id.length > 0 && id.length <= 128) && !Number.isSafeInteger(id)) return;
  const url = typeof message.url === 'string' && message.url.length <= 2000 ? supplierUrl(message.url) : null;
  if (!url || jobs.size >= MAX_JOBS || jobs.has(id)) {
    port.postMessage({ id, error: 'Solicitação inválida ou limite de abas do Buscador atingido.' });
    return;
  }
  const job = { cancelled: false };
  jobs.set(id, job);
  let result;
  try {
    result = await readPage(job, url);
  } catch (error) {
    result = { error: error instanceof SupplierError ? error.message : 'A aba do fornecedor foi fechada ou ficou inacessível no Chrome.' };
  } finally {
    await closeTab(job);
    jobs.delete(id);
  }
  if (channel === port) port.postMessage({ id, ...result });
}

const supplierPages = {
  urls: ['https://www.motion.com/*', 'https://www.smcpneumatics.com/*'],
  types: ['main_frame'],
};
chrome.webRequest.onCompleted.addListener(({ tabId, statusCode }) => {
  for (const job of jobs.values()) if (job.tab === tabId) job.status = statusCode;
}, supplierPages);
chrome.webRequest.onErrorOccurred.addListener(({ tabId, error }) => {
  if (error === 'net::ERR_ABORTED') return;
  for (const job of jobs.values()) if (job.tab === tabId) job.networkError = true;
}, supplierPages);

function connect() {
  if (channel) return;
  const port = chrome.runtime.connectNative(HOST);
  channel = port;
  port.onMessage.addListener((message) => void handleRequest(port, message));
  port.onDisconnect.addListener(() => {
    // Read lastError to acknowledge a missing or stopped native host.
    void chrome.runtime.lastError;
    if (channel === port) channel = undefined;
    for (const job of jobs.values()) {
      job.cancelled = true;
      void closeTab(job);
    }
    void chrome.alarms.create(RECONNECT, { delayInMinutes: 0.5 });
  });
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT) connect();
});
