const byId = (id) => document.getElementById(id);
const form = byId('job-form');
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });
const percent = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dates = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const states = { queued: 'Na fila', running: 'Pesquisando', done: 'Concluído', error: 'Interrompido' };
const jobOutcomes = { no_writes: 'Sem gravações', partial_write: 'Gravado com pendências' };
const outcomes = { written: 'Gravado', pending: 'Pendente', demo: 'Simulado', ready: 'Pronto para gravar' };
const timings = { Today: 'Envio hoje', Tomorrow: 'Dia seguinte', Estoque: 'Em estoque' };
const DEFAULT_PREP = 7;
const DEFAULT_FBA_FEE = 6;
const AMAZON_FEE_RATE = 0.15;
const SAVED = 'fornecedores';
const THEME_KEY = 'tema';

let currentJob = '';
let currentFilter = 'all';
let lastJob = null;
let known = {};
// ponytail: the supplier list lives in this browser; move it to SQLite if it must follow the user.
let suppliers = [];
try {
  suppliers = JSON.parse(localStorage.getItem(SAVED)) || [];
} catch {
  suppliers = [];
}
let timer;

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function emptyDash() {
  const node = element('span', '-', 'empty-cell');
  node.setAttribute('aria-label', 'Sem valor');
  return node;
}

function activeTheme() {
  const saved = document.documentElement.dataset.theme;
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function syncThemeToggle() {
  const dark = activeTheme() === 'dark';
  const toggle = byId('theme-toggle');
  toggle.setAttribute('aria-pressed', String(dark));
  toggle.textContent = dark ? 'Tema claro' : 'Tema escuro';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0d1317' : '#f3f5f7');
}

function initTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
  } catch {
    // Private mode: keep system theme.
  }
  syncThemeToggle();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeToggle);
  byId('theme-toggle').addEventListener('click', () => {
    const next = activeTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode: applies only for this session.
    }
    syncThemeToggle();
  });
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Falha de conexão com o painel.');
  return data;
}

function resetFormNote() {
  const mode = form.elements.mode.value;
  const note = byId('form-note');
  note.classList.remove('error');
  note.textContent = mode === 'demo'
    ? 'A simulação usa dados de exemplo e não altera a planilha.'
    : 'Os produtos confirmados são gravados na planilha com lucro FBM e FBA.';
}

function refreshSource() {
  const mode = form.elements.mode.value;
  byId('source').hidden = mode === 'demo';
  byId('file-label').hidden = mode !== 'input';
  byId('source-label').textContent = mode === 'keepa' ? 'Filtros do Product Finder (JSON)' : 'CSV, ASINs ou links';
  byId('source-hint').textContent = mode === 'keepa'
    ? 'Cole o JSON de Show API query. Se ficar em branco, busca pela marca informada.'
    : 'Cole o CSV exportado do Keepa ou insira um ASIN ou link amazon.com por linha.';
  byId('supplier-fields').hidden = mode === 'demo';
  byId('supplier-fields').disabled = mode === 'demo';
  byId('run').textContent = mode === 'demo' ? 'Iniciar simulação' : 'Pesquisar e gravar';
  resetFormNote();
}

function showError(message) {
  const note = byId('form-note');
  note.classList.add('error');
  note.textContent = message;
}

function save() {
  try {
    localStorage.setItem(SAVED, JSON.stringify(suppliers));
  } catch {
    // Private mode: the list still works until the page closes.
  }
}

function domainOf(link) {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && url.hostname.includes('.') ? url.hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

function addLinks() {
  const field = byId('new-link');
  const rejected = [];
  let added = 0;
  for (const text of field.value.split(/\s+/).filter(Boolean)) {
    const link = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;
    const domain = domainOf(link);
    let supplier = suppliers.find((item) => item.domain === domain);
    if (!domain || (!supplier && suppliers.length === 8) || supplier?.links.length === 10) {
      rejected.push(text);
      continue;
    }
    if (!supplier) {
      const { shipping = 40, handling = 5 } = known[domain] || {};
      supplier = { domain, links: [], shipping, handling };
      suppliers.push(supplier);
    }
    if (!supplier.links.includes(link)) {
      supplier.links.push(link);
      added += 1;
    }
  }
  field.value = rejected.join('\n');
  const error = byId('link-error');
  error.hidden = !rejected.length;
  field.setAttribute('aria-invalid', String(rejected.length > 0));
  error.textContent = rejected.length
    ? 'Não foi possível adicionar o que ficou no campo. Use links https de um site válido (até 8 sites e 10 links por site).' : '';
  if (added) resetFormNote();
  save();
  renderSuppliers();
}

function numberField(supplier, key, label, step, max) {
  const wrapper = element('label', label);
  const input = element('input');
  Object.assign(input, { type: 'number', min: 0, max, step, required: true, value: supplier[key] });
  input.addEventListener('input', () => {
    supplier[key] = input.value === '' ? null : Number(input.value);
    save();
  });
  wrapper.append(input);
  return wrapper;
}

// A search URL copied from the site becomes a pattern: the searched code turns into {part}.
function asPattern(link, part) {
  const cut = link.search(/\?|;q=/);
  if (cut < 0) return link;
  const escaped = encodeURIComponent(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return link.slice(0, cut) + link.slice(cut).replace(new RegExp(`(=)${escaped}(?=$|[&;#])`, 'gi'), '$1{part}');
}

async function testSupplier(supplier, card, input, button, output) {
  const part = input.value.trim();
  if (!part) {
    output.className = 'test-result error';
    output.textContent = 'Digite um part number que este site venda.';
    input.focus();
    return;
  }
  supplier.links = [...new Set(supplier.links.map((link) => asPattern(link, part)))];
  supplier.sample = part;
  save();
  button.disabled = true;
  button.textContent = 'Testando...';
  output.className = 'test-result';
  output.textContent = 'Lendo o site do fornecedor. Pode levar até um minuto.';
  try {
    const result = await api('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ part, supplier: payloadFor(supplier) }),
    });
    if (!result.found) {
      supplier.check = { ok: false, text: 'Nada encontrado para esse código ou sem estoque. Cole o link da página do produto ou de uma busca feita no site.' };
    } else {
      const enough = result.stock >= result.minimum;
      supplier.check = {
        ok: enough,
        link: result.link,
        text: `Leu ${currency.format(result.price)} e ${result.stock}${result.floor ? '+' : ''} peças.`
          + (enough ? '' : ` Abaixo do mínimo de ${result.minimum}.`),
      };
    }
  } catch (error) {
    supplier.check = { ok: false, text: error.message };
  }
  if (!suppliers.includes(supplier)) return;
  save();
  if (card.isConnected) card.replaceWith(supplierCard(supplier));
  else renderSuppliers();
}

function payloadFor({ links, shipping, handling }) {
  return { links, shipping, handling };
}

function supplierCard(supplier) {
  const card = element('li', undefined, 'supplier');
  const dedicated = known[supplier.domain];
  const head = element('div', undefined, 'supplier-head');
  head.append(
    element('strong', dedicated?.name || supplier.domain),
    element('span', dedicated ? 'Leitor dedicado' : 'Leitor genérico', 'status-tag'),
  );

  const links = element('ul', undefined, 'link-list');
  for (const link of supplier.links) {
    const row = element('li');
    const remove = element('button', 'Remover', 'quiet');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remover ${link}`);
    remove.addEventListener('click', () => {
      const linkIndex = supplier.links.indexOf(link);
      if (linkIndex >= 0) supplier.links.splice(linkIndex, 1);
      if (!supplier.links.length) {
        const supplierIndex = suppliers.indexOf(supplier);
        if (supplierIndex >= 0) suppliers.splice(supplierIndex, 1);
      }
      delete supplier.check;
      save();
      renderSuppliers();
      byId('new-link').focus();
    });
    row.append(element('span', link), remove);
    links.append(row);
  }
  card.append(head, links);
  if (dedicated) card.append(element('small', 'Este site tem leitor próprio: o robô monta a busca pelo código da peça.'));

  const terms = element('div', undefined, 'terms');
  terms.append(
    numberField(supplier, 'shipping', 'Frete (US$)', '0.01', 10000),
    numberField(supplier, 'handling', 'Prazo (dias)', '1', 365),
  );

  const test = element('div', undefined, 'test-row');
  const label = element('label', 'Testar com um part number');
  const input = element('input');
  Object.assign(input, { type: 'text', maxLength: 80, value: supplier.sample || '', autocomplete: 'off' });
  input.addEventListener('input', () => {
    supplier.sample = input.value;
    save();
  });
  label.append(input);
  const button = element('button', 'Testar', 'secondary');
  button.type = 'button';
  const output = element('p', undefined, 'test-result');
  output.setAttribute('role', 'status');
  if (supplier.check) {
    output.classList.add(supplier.check.ok ? 'ok' : 'error');
    output.textContent = `${supplier.check.text} `;
    if (supplier.check.link) {
      const found = element('a', 'Abrir produto lido');
      Object.assign(found, { href: supplier.check.link, target: '_blank', rel: 'noopener noreferrer' });
      output.append(found);
    }
  }
  const run = () => testSupplier(supplier, card, input, button, output);
  button.addEventListener('click', run);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    run();
  });
  test.append(label, button);
  card.append(terms, test, output);
  return card;
}

function renderSuppliers() {
  byId('supplier-empty').hidden = suppliers.length > 0;
  byId('suppliers').replaceChildren(...suppliers.map(supplierCard));
}

function profitBreakdown(item) {
  const sale = Number(item.sold_for);
  const cost = Number(item.price);
  if (!sale || Number.isNaN(cost)) return null;
  const shipping = Number(item.shipping || 0);
  const verified = item.margin !== undefined && item.fba_margin !== undefined;
  const fbmMargin = verified ? item.margin : (sale - cost - DEFAULT_PREP - shipping - sale * AMAZON_FEE_RATE) / sale;
  const fbaMargin = verified ? item.fba_margin : (sale - cost - DEFAULT_PREP - shipping - sale * AMAZON_FEE_RATE - DEFAULT_FBA_FEE) / sale;
  return {
    verified,
    fbmProfit: sale * fbmMargin,
    fbmMargin,
    fbaProfit: sale * fbaMargin,
    fbaMargin,
  };
}

function profitLine(label, value, margin) {
  const row = element('div', undefined, 'profit-line');
  const cls = value > 0 ? 'profit-value positive' : value < 0 ? 'profit-value negative' : 'profit-value';
  row.append(
    element('span', label, 'profit-model'),
    element('span', currency.format(value), cls),
    element('span', `${percent.format(margin * 100)}%`, 'profit-pct'),
  );
  return row;
}

function productRow(item) {
  const row = element('tr');

  const product = element('td');
  const codeLine = element('div');
  codeLine.append(element('span', item.part || item.asin, 'part-code'));
  if (item.part && item.asin) codeLine.append(element('span', item.asin, 'asin-code'));
  product.append(codeLine);
  if (item.title) product.append(element('p', item.title, 'item-title'));

  const packCell = element('td', undefined, 'num');
  if (item.pack) packCell.textContent = String(item.pack);
  else packCell.append(emptyDash());

  const supply = element('td');
  if (item.supplier) {
    const supplyName = element('a', item.supplier, 'winner-link');
    supplyName.href = item.link;
    supplyName.target = '_blank';
    supplyName.rel = 'noopener noreferrer';
    supply.append(supplyName);
  }
  const comparisons = element('ul', undefined, 'offer-grid');
  for (const [name, offer] of Object.entries(item.offers || {})) {
    const li = element('li');
    const detail = offer.stock === undefined
      ? offer.detail
      : `${offer.stock}${offer.floor ? '+' : ''} un, ${currency.format(offer.price)}, ${timings[offer.timing] || offer.timing}`;
    li.append(element('span', name, 'offer-name'), element('span', detail, 'offer-detail'));
    comparisons.append(li);
  }
  if (comparisons.childElementCount) supply.append(comparisons);
  else supply.append(emptyDash());

  const costCell = element('td', undefined, 'num');
  if (item.price) {
    costCell.textContent = currency.format(item.price);
    if (item.shipping) costCell.append(element('span', `Frete ${currency.format(item.shipping)}`, 'cost-sub'));
  } else {
    costCell.append(emptyDash());
  }

  const saleCell = element('td', undefined, 'num');
  if (item.sold_for) saleCell.append(element('span', currency.format(item.sold_for), 'sale-price'));
  else saleCell.append(emptyDash());

  const profitCell = element('td');
  const calc = profitBreakdown(item);
  if (calc) {
    const box = element('div', undefined, 'profit-compare');
    box.append(
      profitLine('FBM', calc.fbmProfit, calc.fbmMargin),
      profitLine('FBA', calc.fbaProfit, calc.fbaMargin),
      element('span', calc.verified ? 'Confirmado na planilha' : 'Estimativa padrão', 'profit-basis'),
    );
    profitCell.append(box);
  } else {
    profitCell.append(emptyDash());
  }

  const state = element('td', undefined, 'state-cell');
  state.append(element('span', outcomes[item.status], `status-tag ${item.status === 'pending' ? 'pending' : 'ready'}`));
  if (item.sheet_row) state.append(element('small', `Gravado na linha ${item.sheet_row}`));
  if (item.detail) state.append(element('small', item.detail));

  row.append(product, packCell, supply, costCell, saleCell, profitCell, state);
  return row;
}

function updateFilterButtons() {
  for (const button of document.querySelectorAll('.filter-btn')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === currentFilter));
  }
}

function renderRows(job) {
  const items = job.items.filter((item) => {
    if (currentFilter === 'ok') return item.status !== 'pending';
    if (currentFilter === 'pending') return item.status === 'pending';
    return true;
  });
  if (!items.length) {
    const row = element('tr');
    let message = 'Nenhum produto neste filtro.';
    if (!job.items.length) {
      if (job.status === 'queued' || job.status === 'running') message = 'Pesquisando produtos...';
      else if (job.status === 'error') message = 'Nenhum produto foi pesquisado.';
      else message = 'Nenhum produto encontrado neste lote.';
    }
    const cell = element('td', message, 'empty-cell');
    cell.colSpan = 7;
    row.append(cell);
    byId('product-list').replaceChildren(row);
    return;
  }
  byId('product-list').replaceChildren(...items.map(productRow));
}

function render(job) {
  lastJob = job;
  const isDemo = job.mode === 'demo';
  byId('results').hidden = false;
  byId('results-heading').textContent = isDemo ? 'Resultado da simulação' : `Lote ${job.brand}`;
  byId('job-progress').textContent = `${job.items.length} de ${job.total} produtos pesquisados`;
  const status = byId('job-status');
  status.textContent = jobOutcomes[job.outcome] || states[job.status];
  status.className = 'status-tag';
  if (job.status === 'error') status.classList.add('error');
  else if (job.outcome) status.classList.add('pending');
  else if (job.status === 'done') status.classList.add('ready');

  const confirmed = job.items.filter((item) => item.status !== 'pending').length;
  const pending = job.items.filter((item) => item.status === 'pending').length;
  byId('count-all').textContent = String(job.items.length);
  byId('count-ok').textContent = String(confirmed);
  byId('count-pending').textContent = String(pending);
  updateFilterButtons();

  byId('job-message').hidden = !job.message;
  byId('job-message').textContent = job.message || '';
  renderRows(job);
}

function updateUrl(id, push) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('job', id);
  else url.searchParams.delete('job');
  const next = url.pathname + url.search;
  if (push) window.history.pushState({ job: id }, '', next);
  else window.history.replaceState({ job: id }, '', next);
}

async function refreshHistory() {
  const jobs = await api('/api/jobs');
  byId('history-count').textContent = jobs.length ? `${jobs.length}` : '';
  const rows = jobs.map((job) => {
    const row = element('li');
    const button = element('button');
    button.type = 'button';
    if (currentJob === job.id) button.setAttribute('aria-current', 'true');
    const top = element('span', undefined, 'history-row-top');
    top.append(
      element('strong', job.brand),
      element('span', job.mode === 'demo' ? 'Simulação' : 'Real', 'history-mode'),
    );
    const meta = element('span', undefined, 'history-meta');
    meta.append(
      element('span', dates.format(job.created * 1000)),
      element('span', jobOutcomes[job.outcome] || states[job.status]),
    );
    button.append(top, meta);
    button.addEventListener('click', () => selectJob(job.id, { push: true }));
    row.append(button);
    return row;
  });
  byId('history').replaceChildren(
    ...(rows.length ? rows : [element('li', 'Nenhum lote executado ainda. Inicie uma simulação ou um lote real ao lado.', 'empty-inline')]),
  );
}

async function selectJob(id, { push = false } = {}) {
  currentJob = id;
  clearTimeout(timer);
  updateUrl(id, push);
  try {
    const job = await api(`/api/jobs/${id}`);
    if (id !== currentJob) return;
    render(job);
    await refreshHistory();
    if (id === currentJob && (job.status === 'running' || job.status === 'queued')) {
      timer = setTimeout(() => selectJob(id), 1500);
    }
  } catch (error) {
    showError(error.message);
  }
}

async function setup() {
  const banner = byId('setup-error');
  banner.hidden = true;
  try {
    const data = await api('/api/setup');
    const connections = data.remote_worker
      ? [element('li', 'Servidor homelab ativo', 'status-tag ready')]
      : [
        ['Keepa API', data.keepa],
        ['Google Sheets', data.sheets],
        ['VPN SMC EUA', data.smc],
      ].map(([label, ready]) => element(
        'li',
        `${label}: ${ready ? 'configurado' : 'pendente'}`,
        `status-tag ${ready ? 'ready' : 'pending'}`,
      ));
    byId('connections').replaceChildren(...connections);
    known = data.known;
    renderSuppliers();
    form.elements.mode.value = data.remote_worker ? 'input' : data.keepa ? 'keepa' : data.sheets ? 'input' : 'demo';
    byId('run').disabled = false;
    refreshSource();
    await refreshHistory();
    const initialJob = new URLSearchParams(window.location.search).get('job');
    if (initialJob) await selectJob(initialJob);
  } catch (error) {
    banner.hidden = false;
    byId('setup-error-text').textContent = `${error.message} Verifique se o servidor local está em execução e tente novamente.`;
    byId('run').disabled = true;
  }
}

byId('mode').addEventListener('change', refreshSource);
byId('add-link').addEventListener('click', addLinks);
byId('retry-setup').addEventListener('click', setup);
byId('new-link').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  addLinks();
});
byId('file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  if (file && file.size <= 120000) {
    form.elements.input.value = await file.text();
    resetFormNote();
  } else if (file) {
    event.target.value = '';
    showError('O CSV excede 120 kB. Divida o arquivo em lotes menores.');
  }
});
for (const button of document.querySelectorAll('.filter-btn')) {
  button.addEventListener('click', () => {
    currentFilter = button.dataset.filter;
    if (lastJob) {
      updateFilterButtons();
      renderRows(lastJob);
    }
  });
}
window.addEventListener('popstate', () => {
  const id = new URLSearchParams(window.location.search).get('job');
  if (id) {
    selectJob(id);
  } else {
    currentJob = '';
    lastJob = null;
    clearTimeout(timer);
    byId('results').hidden = true;
    refreshHistory().catch(() => {});
  }
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  refreshSource();
  const fields = new FormData(form);
  if (fields.get('mode') !== 'demo' && !suppliers.length) {
    showError('Adicione pelo menos um link de fornecedor antes de pesquisar.');
    byId('new-link').focus();
    return;
  }
  byId('run').disabled = true;
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brand: fields.get('brand'),
        limit: Number(fields.get('limit')),
        mode: fields.get('mode'),
        input: fields.get('input'),
        suppliers: suppliers.map(payloadFor),
      }),
    });
    currentFilter = 'all';
    await selectJob(job.id, { push: true });
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    byId('results').scrollIntoView({ behavior, block: 'nearest' });
  } catch (error) {
    showError(error.message);
  } finally {
    byId('run').disabled = false;
  }
});

initTheme();
setup();
