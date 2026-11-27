const byId = (id) => document.getElementById(id);
const form = byId('job-form');
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });
const dates = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const states = { queued: 'Na fila', running: 'Pesquisando', done: 'Concluído', error: 'Interrompido' };
const jobOutcomes = { no_writes: 'Sem gravações', partial_write: 'Gravado com pendências' };
const outcomes = { written: 'Gravado', pending: 'Pendente', demo: 'Simulado', ready: 'Pronto para gravar' };
const SAVED = 'fornecedores';
let currentJob = '';
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

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Falha de conexão com o painel.');
  return data;
}

function refreshSource() {
  const mode = form.elements.mode.value;
  byId('source').hidden = mode === 'demo';
  byId('file-label').hidden = mode !== 'input';
  byId('source-label').textContent = mode === 'keepa' ? 'Filtros do Product Finder (JSON)' : 'CSV, ASINs ou links';
  byId('source-hint').textContent = mode === 'keepa'
    ? 'Cole o JSON de Show API query. Se ficar em branco, busca pela marca informada.'
    : 'Cole o CSV exportado ou insira um ASIN ou link amazon.com por linha.';
  byId('supplier-fields').hidden = mode === 'demo';
  byId('supplier-fields').disabled = mode === 'demo';
  byId('run').textContent = mode === 'demo' ? 'Iniciar simulação' : 'Pesquisar e gravar';
  byId('form-note').classList.remove('error');
  byId('form-note').textContent = mode === 'demo'
    ? 'A simulação usa dados de exemplo.'
    : 'Os produtos confirmados são gravados automaticamente na planilha.';
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
    if (!supplier.links.includes(link)) supplier.links.push(link);
  }
  field.value = rejected.join('\n');
  const error = byId('link-error');
  error.hidden = !rejected.length;
  field.setAttribute('aria-invalid', String(rejected.length > 0));
  error.textContent = rejected.length
    ? 'Não adicionei o que ficou no campo. Use links https de um site (até 8 sites e 10 links por site).' : '';
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

async function testSupplier(supplier, input, button, output) {
  const part = input.value.trim();
  if (!part) {
    output.className = 'test-result error';
    output.textContent = 'Digite um part number que este site venda.';
    input.focus();
    return;
  }
  supplier.links = supplier.links.map((link) => asPattern(link, part));
  supplier.sample = part;
  save();
  button.disabled = true;
  button.textContent = 'Testando…';
  output.className = 'test-result';
  output.textContent = 'O robô está lendo o site. Pode levar até um minuto.';
  try {
    const result = await api('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ part, supplier: payloadFor(supplier) }),
    });
    if (!result.found) {
      supplier.check = { ok: false, text: 'Nada encontrado para esse código (ou sem estoque). Cole o link da página do produto ou de uma busca feita no site.' };
    } else {
      const enough = result.stock >= result.minimum;
      supplier.check = { ok: enough, link: result.link,
        text: `Leu ${currency.format(result.price)} e ${result.stock}${result.floor ? '+' : ''} peças.`
          + (enough ? '' : ` Abaixo do mínimo de ${result.minimum}.`) };
    }
  } catch (error) {
    supplier.check = { ok: false, text: error.message };
  }
  save();
  renderSuppliers();
}

function payloadFor({ links, shipping, handling }) {
  return { links, shipping, handling };
}

function supplierCard(supplier, index) {
  const card = element('li', undefined, 'supplier');
  const dedicated = known[supplier.domain];
  const head = element('div', undefined, 'supplier-head');
  head.append(element('strong', dedicated?.name || supplier.domain),
    element('span', dedicated ? 'Leitor dedicado' : 'Leitor genérico', 'pill'));

  const links = element('ul', undefined, 'link-list');
  for (const link of supplier.links) {
    const row = element('li');
    const remove = element('button', 'Remover', 'quiet');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remover ${link}`);
    remove.addEventListener('click', () => {
      supplier.links.splice(supplier.links.indexOf(link), 1);
      if (!supplier.links.length) suppliers.splice(index, 1);
      delete supplier.check;
      save();
      renderSuppliers();
      byId('new-link').focus();
    });
    row.append(element('span', link), remove);
    links.append(row);
  }
  card.append(head, links);
  if (dedicated) card.append(element('small', 'Este site já tem leitor próprio: o robô monta a busca pelo código.'));

  const terms = element('div', undefined, 'terms');
  terms.append(numberField(supplier, 'shipping', 'Frete (US$)', '0.01', 10000),
    numberField(supplier, 'handling', 'Prazo (dias)', '1', 365));

  const test = element('div', undefined, 'test-row');
  const label = element('label', 'Testar com um part number');
  const input = element('input');
  Object.assign(input, { type: 'text', maxLength: 80, value: supplier.sample || '', autocomplete: 'off' });
  label.append(input);
  const button = element('button', 'Testar', 'secondary');
  button.type = 'button';
  const output = element('p', undefined, 'test-result');
  output.setAttribute('role', 'status');
  if (supplier.check) {
    output.classList.add(supplier.check.ok ? 'ok' : 'error');
    output.textContent = `${supplier.check.text} `;
    if (supplier.check.link) {
      const found = element('a', 'Abrir o produto lido');
      Object.assign(found, { href: supplier.check.link, target: '_blank', rel: 'noopener noreferrer' });
      output.append(found);
    }
  }
  const run = () => testSupplier(supplier, input, button, output);
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

async function setup() {
  const data = await api('/api/setup');
  const connections = data.remote_worker
    ? [element('li', 'Lotes reais processados no servidor', 'pill')]
    : [
      ['Keepa API', data.keepa], ['Google Sheets', data.sheets], ['VPN SMC EUA', data.smc],
    ].map(([label, ready]) => element('li', `${label} ${ready ? 'configurado' : 'pendente'}`,
      `pill ${ready ? 'ready' : 'pending'}`));
  byId('connections').replaceChildren(...connections);
  known = data.known;
  renderSuppliers();
  form.elements.mode.value = data.remote_worker ? 'input' : data.keepa ? 'keepa' : data.sheets ? 'input' : 'demo';
  byId('run').disabled = false;
  refreshSource();
}

async function refreshHistory() {
  const jobs = await api('/api/jobs');
  const rows = jobs.map((job) => {
    const row = element('li');
    const button = element('button');
    button.type = 'button';
    if (currentJob === job.id) button.setAttribute('aria-current', 'true');
    button.append(element('strong', job.mode === 'demo' ? `${job.brand} · Simulação` : job.brand),
      element('small', `${dates.format(job.created * 1000)} · ${jobOutcomes[job.outcome] || states[job.status]}`));
    button.addEventListener('click', () => selectJob(job.id));
    row.append(button);
    return row;
  });
  byId('history').replaceChildren(...(rows.length ? rows : [element('li', 'Nenhum lote por aqui.', 'muted')]));
}

function productRow(item) {
  const row = element('tr');
  const product = element('td');
  product.append(element('strong', item.part || item.asin));
  product.append(element('small', [item.title, item.asin].filter(Boolean).join(' · ')));
  const supply = element('td');
  if (item.supplier) {
    const supplyName = element('a', item.supplier);
    supplyName.href = item.link;
    supplyName.target = '_blank';
    supplyName.rel = 'noopener noreferrer';
    supply.append(supplyName);
  }
  const comparisons = element('ul', undefined, 'offer-list');
  for (const [name, offer] of Object.entries(item.offers || {})) {
    const balance = offer.stock === undefined ? offer.detail
      : `${offer.stock}${offer.floor ? '+' : ''} peças · ${currency.format(offer.price)} · ${offer.timing}`;
    comparisons.append(element('li', `${name} — ${balance}`));
  }
  if (comparisons.childElementCount) supply.append(comparisons);
  else supply.append(document.createTextNode('—'));
  const state = element('td');
  state.append(element('span', outcomes[item.status], `pill ${item.status === 'pending' ? 'pending' : 'ready'}`));
  if (item.detail) state.append(element('small', item.detail));
  if (item.sheet_row) state.append(element('small', `Linha ${item.sheet_row}`));
  if (item.margin !== undefined) state.append(element('small', `Margem ${(item.margin * 100).toFixed(2).replace('.', ',')}%`));
  row.append(product, element('td', item.pack || '—'), supply,
    element('td', item.price ? currency.format(item.price) : '—'),
    element('td', item.sold_for ? currency.format(item.sold_for) : '—'), state);
  return row;
}

function render(job) {
  const isDemo = job.mode === 'demo';
  byId('results').hidden = false;
  byId('results-heading').textContent = isDemo ? 'Resultado da simulação' : 'Resultado do lote';
  byId('job-progress').textContent = `${job.items.length} de ${job.total} produtos pesquisados`;
  const status = byId('job-status');
  status.textContent = jobOutcomes[job.outcome] || states[job.status];
  status.classList.toggle('pending', Boolean(job.outcome) || job.status === 'error');
  const written = job.items.filter((item) => item.status === (isDemo ? 'demo' : 'written')).length;
  const pending = job.items.filter((item) => item.status === 'pending').length;
  byId('summary').textContent = `${written} ${isDemo ? 'simulados' : 'gravados'} · ${pending} pendentes`;
  byId('job-message').hidden = !job.message;
  byId('job-message').textContent = job.message;
  byId('product-list').replaceChildren(...job.items.map(productRow));
}

async function selectJob(id) {
  currentJob = id;
  clearTimeout(timer);
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

byId('mode').addEventListener('change', refreshSource);
byId('add-link').addEventListener('click', addLinks);
byId('new-link').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  addLinks();
});
byId('file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  if (file && file.size <= 120000) form.elements.input.value = await file.text();
  else if (file) showError('O CSV excede 120 kB. Divida o lote.');
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  refreshSource();
  const fields = new FormData(form);
  if (fields.get('mode') !== 'demo' && !suppliers.length) {
    showError('Adicione pelo menos um link de fornecedor.');
    byId('new-link').focus();
    return;
  }
  byId('run').disabled = true;
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: fields.get('brand'), limit: Number(fields.get('limit')),
        mode: fields.get('mode'), input: fields.get('input'), suppliers: suppliers.map(payloadFor) }),
    });
    await selectJob(job.id);
  } catch (error) {
    showError(error.message);
  } finally {
    byId('run').disabled = false;
  }
});
Promise.all([setup(), refreshHistory()]).catch((error) => showError(error.message));
