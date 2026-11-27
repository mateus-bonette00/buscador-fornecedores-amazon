const byId = (id) => document.getElementById(id);
const form = byId('job-form');
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });
const dates = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const states = { queued: 'Na fila', running: 'Pesquisando', done: 'Concluído', error: 'Interrompido' };
const jobOutcomes = { no_writes: 'Sem gravações', partial_write: 'Gravado com pendências' };
const outcomes = { written: 'Gravado', pending: 'Pendente', demo: 'Simulado', ready: 'Pronto para gravar' };
let currentJob = '';
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

async function setup() {
  const data = await api('/api/setup');
  const connections = data.remote_worker
    ? [element('li', 'Lotes reais processados no servidor', 'pill')]
    : [
      ['Keepa API', data.keepa], ['Google Sheets', data.sheets], ['VPN SMC EUA', data.smc],
    ].map(([label, ready]) => element('li', `${label} ${ready ? 'configurado' : 'pendente'}`,
      `pill ${ready ? 'ready' : 'pending'}`));
  byId('connections').replaceChildren(...connections);
  byId('suppliers').replaceChildren(...data.suppliers.map(({ id, name }) => {
    const label = element('label');
    const input = element('input');
    input.type = 'checkbox';
    input.name = 'suppliers';
    input.value = id;
    input.checked = id === 'motion' || id === 'smc';
    label.append(input, document.createTextNode(name));
    return label;
  }));
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
byId('file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  if (file && file.size <= 120000) form.elements.input.value = await file.text();
  else if (file) showError('O CSV excede 120 kB. Divida o lote.');
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  refreshSource();
  const fields = new FormData(form);
  byId('run').disabled = true;
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: fields.get('brand'), limit: Number(fields.get('limit')),
        mode: fields.get('mode'), input: fields.get('input'), suppliers: fields.getAll('suppliers') }),
    });
    await selectJob(job.id);
  } catch (error) {
    showError(error.message);
  } finally {
    byId('run').disabled = false;
  }
});
Promise.all([setup(), refreshHistory()]).catch((error) => showError(error.message));
