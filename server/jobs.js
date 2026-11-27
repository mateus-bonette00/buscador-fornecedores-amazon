/**
 * Job orchestration, SQLite persistence, business rules, Keepa integration, and SSH homelab runner.
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_PREP, Sheets, soldFor } from './sheets.js';
import {
  DRIVERS,
  HttpError,
  Page,
  Pending,
  containsPart,
  normalized,
  offer,
  publicLink,
  supplierDeps,
} from './suppliers.js';
import { protonConnection } from './vpn.js';

export const SETTINGS_DIR = path.join(os.homedir(), '.config', 'buscador-fornecedores-amazon');
export const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'buscador-fornecedores-amazon');

export const DEFAULTS = {
  spreadsheet_id: '',
  sheet_id: 0,
  keepa_key_file: path.join(SETTINGS_DIR, 'keepa.key'),
  google_credentials: path.join(SETTINGS_DIR, 'google-sheets.json'),
  smc_proxy: '',
  smc_proton_manual: false,
  supplier_chrome: false,
  suppliers: {
    motion: { name: 'Motion', driver: 'motion', handling: 5, shipping: 40, minimum: 11 },
    smc: { name: 'SMC Pneumatics', driver: 'smc', handling: 6, tomorrow: 7, shipping: 70, minimum: 11 },
  },
};

export const CSV_LIMIT = 120_000;
export const KNOWN_DOMAINS = { 'motion.com': 'motion', 'smcpneumatics.com': 'smc' };

const ASIN_RE = /^[A-Z0-9]{10}$/;
const AMAZON_PATH_RE = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i;
const PART_RE = /(?<![A-Z0-9./-])[A-Z0-9]+(?:[-./][A-Z0-9]+)*(?![A-Z0-9]|[./-][A-Z0-9])/g;
const PART_FULL_RE = /^[A-Z0-9]+(?:[-./][A-Z0-9]+)*$/;

export const jobsDeps = {
  execFileSync,
  spawn,
};

export function supplierRules(config, specs) {
  if (!Array.isArray(specs) || specs.length < 1 || specs.length > 8) {
    throw new Pending('Adicione de 1 a 8 fornecedores pelos links.');
  }
  const result = {};
  for (const spec of specs) {
    const linksRaw = spec && typeof spec === 'object' ? spec.links : null;
    if (!Array.isArray(linksRaw) || linksRaw.length < 1 || linksRaw.length > 10) {
      throw new Pending('Cada fornecedor precisa ter de 1 a 10 links.');
    }
    const links = linksRaw.map((link) => String(link).trim());
    const domains = new Set(links.map((link) => publicLink(link)[1]));
    if (domains.size !== 1) {
      throw new Pending('Os links de um fornecedor precisam ser do mesmo site.');
    }
    const [domain] = domains;
    const key = KNOWN_DOMAINS[domain] || domain;
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new Pending(`O site ${domain} apareceu em dois fornecedores.`);
    }
    const base = (domain in KNOWN_DOMAINS ? config.suppliers[key] : null) || {
      name: domain,
      driver: 'site',
      handling: 5,
      shipping: 40,
      minimum: 11,
    };
    const shipping = spec.shipping !== undefined ? spec.shipping : base.shipping;
    const handling = spec.handling !== undefined ? spec.handling : base.handling;
    if (typeof shipping !== 'number' || Number.isNaN(shipping) || shipping < 0 || shipping > 10000) {
      throw new Pending(`Informe o frete de ${base.name} em dólar.`);
    }
    if (!Number.isInteger(handling) || handling < 0 || handling > 365) {
      throw new Pending(`Informe o prazo de ${base.name} em dias.`);
    }
    const rules = {
      ...base,
      links: [...new Set(links)],
      shipping,
      handling,
    };
    if (base.tomorrow !== undefined) {
      rules.tomorrow = handling + base.tomorrow - base.handling;
    }
    result[key] = rules;
  }
  return result;
}

export async function lookup(config, rules, part, pack, vpn = null) {
  let proxy = config.smc_proxy;
  let effective = rules;
  if (config.supplier_chrome && (rules.driver === 'motion' || rules.driver === 'smc')) {
    effective = { ...effective, browser: true };
  }
  if (vpn !== null && rules.driver === 'smc') {
    vpn.requireUs();
    effective = { ...effective, hostVpn: true };
    proxy = null;
  }
  return DRIVERS[effective.driver](effective, part, pack, proxy);
}

export async function testSupplier(config, options) {
  const part = normalized(String(options?.part ?? ''));
  if (part.length < 3 || part.length > 80 || !PART_FULL_RE.test(part)) {
    throw new Pending('Informe um part number que o fornecedor venda.');
  }
  const [rules] = Object.values(supplierRules(config, [options?.supplier]));
  const useProton = rules.driver === 'smc' && config.smc_proton_manual;
  let result;
  try {
    const vpn = useProton ? protonConnection() : null;
    result = await lookup(config, rules, part, 1, vpn);
  } catch (err) {
    if (err instanceof Pending) throw err;
    throw new Pending('Resposta do fornecedor não reconhecida.');
  }
  if (result === null) return { found: false };
  return {
    found: true,
    price: result.price,
    stock: result.userStock,
    floor: result.atLeast,
    link: result.link,
    minimum: rules.minimum,
  };
}

export function asinFrom(raw) {
  const value = String(raw).trim().toUpperCase();
  if (ASIN_RE.test(value)) return value;
  try {
    const url = new URL(String(raw).trim());
    if (url.protocol === 'https:' && (url.hostname === 'amazon.com' || url.hostname === 'www.amazon.com')) {
      const match = AMAZON_PATH_RE.exec(url.pathname);
      if (match) return match[1].toUpperCase();
    }
  } catch {
    // Fall through to Pending.
  }
  throw new Pending('Use um ASIN ou link de produto da Amazon dos EUA.');
}

function parseCsvRows(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function parseInput(rawInput) {
  if (rawInput.length > CSV_LIMIT) {
    throw new Pending('A entrada excede 120 kB. Divida o lote.');
  }
  const raw = rawInput.trim().replace(/^\ufeff/, '');
  if (!raw) return [];
  const firstLine = raw.split(/\r?\n/, 1)[0];
  const separator = firstLine.includes(';') ? ';' : ',';
  const headerCells = (parseCsvRows(firstLine, separator)[0] || []).map((k) => k.trim().toLowerCase());
  const batch = [];

  if (headerCells.includes('asin')) {
    const rows = parseCsvRows(raw, separator);
    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      const values = {};
      for (let c = 0; c < headerCells.length; c += 1) {
        if (headerCells[c] && row[c] !== undefined) values[headerCells[c]] = row[c];
      }
      if ((values.asin || '').trim()) {
        batch.push({
          asin: asinFrom(values.asin),
          title: values.title || values['product title'] || '',
        });
      }
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim()) batch.push({ asin: asinFrom(line), title: '' });
    }
  }

  const dedup = new Map();
  for (const item of batch) dedup.set(item.asin, item);
  return [...dedup.values()];
}

export function extract(title, partHint = '') {
  const raw = normalized(title);
  const quantities = new Set();
  for (const match of raw.matchAll(/\bPACK\s+OF\s+(\d+)\b|\b(\d+)\s*-?\s*PACK\b/g)) {
    const val = match[1] || match[2];
    if (val) quantities.add(Number.parseInt(val, 10));
  }
  if (quantities.size > 1 || (quantities.size === 1 && Math.min(...quantities) < 1)) {
    throw new Pending('O título tem quantidades de pack conflitantes ou inválidas.');
  }
  const pack = quantities.size === 1 ? [...quantities][0] : 1;
  if (partHint && PART_FULL_RE.test(normalized(partHint)) && containsPart(title, partHint)) {
    return [normalized(partHint), pack];
  }
  const codes = new Set();
  for (const token of raw.match(PART_RE) || []) {
    if (
      token.length >= 3
      && /[A-Z]/.test(token)
      && /\d/.test(token)
      && !/^\d+-?(?:MM|CM|IN|PSI|VDC|VAC|V|A|PCS|PACK)$/.test(token)
    ) {
      codes.add(token);
    }
  }
  if (codes.size !== 1) {
    throw new Pending('Não há um único part number inequívoco no título da Amazon.');
  }
  return [[...codes][0], pack];
}

export function choose(offers, minimums, pack) {
  const eligible = {};
  for (const [key, item] of Object.entries(offers)) {
    if (item !== null && item !== undefined && item.userStock >= Math.max(pack, minimums[key])) {
      eligible[key] = item;
    }
  }
  if (eligible.motion && eligible.smc) {
    const { motion: m, smc: s } = eligible;
    const switchToSmc = s.userStock * 5 >= m.userStock * 12;
    if ((switchToSmc && m.atLeast) || (!switchToSmc && s.atLeast)) {
      throw new Pending('O saldo com sinal de + não permite confirmar a relação de 2,4×.');
    }
    delete eligible[switchToSmc ? 'motion' : 'smc'];
  }
  const remaining = Object.values(eligible);
  if (!remaining.length) return null;
  remaining.sort((a, b) => (b.userStock - a.userStock) || (a.priceCents - b.priceCents));
  return remaining[0];
}

export async function keepaApi(config, operation, params) {
  let key;
  try {
    key = fs.readFileSync(config.keepa_key_file, 'utf-8').trim();
  } catch {
    throw new Pending('Configure a chave da API do Keepa no servidor.');
  }
  if (!key) throw new Pending('A chave da API do Keepa está vazia.');
  const query = new URLSearchParams({ key, ...params }).toString();
  let result;
  try {
    result = JSON.parse(await supplierDeps.request(`https://api.keepa.com/${operation}?${query}`));
  } catch (err) {
    if (err instanceof HttpError) throw new Pending('A API do Keepa rejeitou a consulta.');
    throw err;
  }
  if (result.error) {
    throw new Pending('A API do Keepa retornou um erro de consulta ou cota.');
  }
  return result;
}

export async function catalog(config, brand, finder, limit) {
  const selected = { ...finder, brand: finder.brand || [brand], perPage: 100, page: 0 };
  const found = [];
  while (found.length < limit) {
    const result = await keepaApi(config, 'query', { domain: '1', selection: JSON.stringify(selected) });
    const items = result.asinList;
    if (!Array.isArray(items)) {
      throw new Pending('A consulta do Keepa não retornou uma lista de ASINs.');
    }
    for (const item of items) found.push({ asin: asinFrom(item), title: '' });
    if (items.length < 100) break;
    selected.page += 1;
  }
  const dedup = new Map();
  for (const item of found.slice(0, limit)) dedup.set(item.asin, item);
  return [...dedup.values()];
}

export async function enrich(config, batch) {
  const pending = batch.filter((item) => !item.title);
  if (!pending.length || !fs.existsSync(config.keepa_key_file)) return;
  for (let start = 0; start < pending.length; start += 100) {
    const chunk = pending.slice(start, start + 100);
    const result = await keepaApi(config, 'product', {
      domain: '1',
      asin: chunk.map((item) => item.asin).join(','),
    });
    const source = new Map((result.products || []).filter((p) => p.asin).map((p) => [p.asin, p]));
    for (const item of chunk) {
      const data = source.get(item.asin) || {};
      item.title = data.title || '';
      item.part_hint = data.partNumber || '';
    }
  }
}

export async function amazonTitle(asin) {
  const raw = await supplierDeps.request(`https://www.amazon.com/dp/${asin}`);
  const page = new Page(raw);
  const match = /<span[^>]*\bid=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i.exec(raw);
  if (!match || !page.text) {
    throw new Pending('O título da Amazon não pôde ser confirmado.');
  }
  return new Page(match[1]).text;
}

export function jobOutcome(job) {
  if (job.status !== 'done' || job.mode === 'demo') return null;
  const statuses = new Set(job.items.map((item) => item.status));
  if (!statuses.has('written')) return 'no_writes';
  if (statuses.has('pending')) return 'partial_write';
  return null;
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx], idx);
    }
  }
  const count = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: count }, () => next()));
  return results;
}

export class Jobs {
  constructor(config, stateDir, workerHost = null) {
    this.config = config;
    this.stateDir = stateDir;
    this.workerHost = workerHost;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(stateDir, 'jobs.sqlite'));
    this.db.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    this.queue = Promise.resolve();

    const rows = this.db.prepare('SELECT id, data FROM jobs').all();
    const updateStmt = this.db.prepare('UPDATE jobs SET data = ? WHERE id = ?');
    for (const row of rows) {
      const data = JSON.parse(row.data);
      if (data.status === 'queued' || data.status === 'running') {
        data.status = 'error';
        data.message = 'Execução interrompida. Envie o lote novamente.';
        updateStmt.run(JSON.stringify(data), row.id);
      }
    }
  }

  close() {
    this.db.close();
  }

  save(data) {
    this.db.prepare('INSERT OR REPLACE INTO jobs (id, data) VALUES (?, ?)').run(data.id, JSON.stringify(data));
  }

  load(jobId = null) {
    if (jobId !== null) {
      const record = this.db.prepare('SELECT data FROM jobs WHERE id = ?').get(jobId);
      return record ? JSON.parse(record.data) : null;
    }
    return this.db.prepare('SELECT data FROM jobs ORDER BY rowid DESC LIMIT 12').all().map((row) => JSON.parse(row.data));
  }

  prepare(options) {
    const brand = String(options.brand ?? '').trim();
    const mode = options.mode ?? '';
    const limit = options.limit !== undefined ? options.limit : 8;
    if (!brand || brand.length > 80) {
      throw new Pending('Informe uma marca de até 80 caracteres.');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Pending('O limite do lote deve ficar entre 1 e 500.');
    }
    if (!['demo', 'keepa', 'input'].includes(mode)) {
      throw new Pending('Selecione uma fonte para o lote.');
    }
    const suppliers = mode === 'demo'
      ? { motion: this.config.suppliers.motion, smc: this.config.suppliers.smc }
      : supplierRules(this.config, options.suppliers);

    const source = options.input !== undefined ? options.input : '';
    if (typeof source !== 'string') {
      throw new Pending('A entrada precisa estar em texto.');
    }

    let batch;
    if (mode === 'input') {
      batch = parseInput(source).slice(0, limit);
      if (!batch.length) throw new Pending('Inclua um CSV, ASIN ou link da Amazon dos EUA.');
    } else if (mode === 'keepa') {
      try {
        batch = source.trim() ? JSON.parse(source) : {};
      } catch {
        throw new Pending('Cole o JSON de Show API query do Keepa.');
      }
      if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
        throw new Pending('A consulta do Keepa deve ser um objeto JSON.');
      }
    } else {
      batch = [
        'SMC NCQ2B63-25DZ cyl, compact, npt',
        'SMC Y-G04 - Pack Of 6 - Piston Rod Clevis',
        'SMC Inch One-touch Pipe Fittings, Pack of 10 KQ2F11-35A',
      ].slice(0, limit).map((title, i) => ({ asin: `B00000000${i + 1}`, title }));
    }

    const data = {
      id: crypto.randomBytes(16).toString('hex'),
      status: 'queued',
      brand,
      created: Date.now() / 1000,
      mode,
      items: [],
      total: Array.isArray(batch) ? batch.length : 0,
      message: '',
    };
    return [data, suppliers, batch, limit];
  }

  submit(options) {
    const [data, suppliers, batch, limit] = this.prepare(options);
    this.save(data);
    const task = this.workerHost && data.mode !== 'demo'
      ? () => this.runRemote(data, options)
      : () => this.run(data, suppliers, batch, limit);
    this.queue = this.queue.then(task, task);
    return data;
  }

  remoteCommand() {
    return [
      'ssh', '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      '-o', 'ServerAliveInterval=10',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ClearAllForwardings=yes',
      '--', this.workerHost,
      'cd "$HOME/.local/share/buscador-fornecedores-amazon" && exec node server/index.js --run-job',
    ];
  }

  async test(options) {
    if (!this.workerHost) {
      return testSupplier(this.config, options);
    }
    let failed = 'A conexão com o servidor falhou durante o teste.';
    try {
      const [cmd, ...args] = this.remoteCommand();
      const stdout = jobsDeps.execFileSync(cmd, args, {
        input: JSON.stringify({ test: options }),
        encoding: 'utf-8',
        timeout: 180_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
      const reply = JSON.parse(lines[lines.length - 1]);
      if (!('error' in reply)) return reply.result;
      failed = String(reply.error);
    } catch {
      // Keep default failure message unless remote returned an explicit error.
    }
    throw new Pending(failed);
  }

  async runRemote(job, options) {
    job.status = 'running';
    job.message = 'Enviando o lote ao servidor.';
    this.save(job);
    const [cmd, ...args] = this.remoteCommand();
    try {
      await new Promise((resolve, reject) => {
        const child = jobsDeps.spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
        let leftover = '';
        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (chunk) => {
          leftover += chunk;
          const lines = leftover.split('\n');
          leftover = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const update = JSON.parse(line);
            for (const key of ['status', 'items', 'total', 'message']) {
              job[key] = update[key];
            }
            this.save(job);
          }
        });
        child.once('error', reject);
        child.once('close', (code) => {
          if (leftover.trim()) {
            try {
              const update = JSON.parse(leftover);
              for (const key of ['status', 'items', 'total', 'message']) job[key] = update[key];
              this.save(job);
            } catch {
              // Handled below if status is not final.
            }
          }
          if (code !== 0 || (job.status !== 'done' && job.status !== 'error')) {
            reject(new Error('Lote remoto sem resultado final'));
          } else {
            resolve();
          }
        });
        child.stdin.end(JSON.stringify(options));
      });
    } catch {
      job.status = 'error';
      job.message = 'A conexão com o servidor falhou ou o lote foi interrompido.';
      this.save(job);
    }
  }

  async run(job, suppliers, initialBatch, limit, publish = null) {
    const save = publish || ((data) => this.save(data));
    const demo = job.mode === 'demo';
    let batch = initialBatch;
    try {
      job.status = 'running';
      save(job);
      if (job.mode === 'keepa') {
        batch = await catalog(this.config, job.brand, batch, limit);
      }
      if (!demo) {
        try {
          await enrich(this.config, batch);
        } catch (err) {
          if (err instanceof Pending) {
            job.message = 'O Keepa não forneceu todos os títulos. Consulta direta à Amazon em andamento.';
          } else {
            throw err;
          }
        }
      }
      job.total = batch.length;
      const useProton = !demo && batch.length > 0 && this.config.smc_proton_manual
        && Object.values(suppliers).some((rules) => rules.driver === 'smc');

      let vpn = null;
      if (useProton) {
        job.message = 'Verificando o Proton VPN no servidor.';
        save(job);
        vpn = protonConnection();
        job.message = 'Proton VPN conectado nos Estados Unidos.';
        save(job);
      }

      await runPool(batch, 3, async (row) => {
        const result = await this.product(row, job.brand, suppliers, demo, vpn);
        job.items.push(result);
        save(job);
      });

      const ready = job.items.filter((item) => item.status === 'ready');
      if (ready.length && !demo) {
        await this.commit(ready);
      }
      job.status = 'done';
      job.message = '';
      if (!job.items.length) {
        job.message = 'Nenhum ASIN encontrado para essa consulta.';
      } else if (jobOutcome(job) === 'no_writes') {
        job.message = 'Nenhum produto foi gravado. Confira o motivo em cada produto pendente.';
      }
    } catch (err) {
      job.status = 'error';
      job.message = err instanceof Pending ? err.message : 'A fonte de dados retornou um erro inesperado.';
    }
    save(job);
  }

  async product(rawItem, brand, suppliers, demo, vpn = null) {
    const partHint = rawItem.part_hint || '';
    const item = { asin: rawItem.asin, title: rawItem.title, brand, offers: {} };
    try {
      item.title = item.title || await amazonTitle(item.asin);
      const [part, pack] = extract(item.title, partHint);
      item.part = part;
      item.pack = pack;
      const offers = {};
      const minimums = {};
      const unconfirmed = [];

      for (const [key, config] of Object.entries(suppliers)) {
        minimums[key] = config.minimum;
        let result;
        try {
          if (demo) {
            const check = { 'NCQ2B63-25DZ': [0, 0], 'Y-G04': [12, 29], 'KQ2F11-35A': [25, 30] };
            const qty = check[part][key === 'smc' ? 1 : 0];
            const domain = key === 'motion' ? 'www.motion.com' : 'www.smcpneumatics.com';
            const timing = key === 'smc' && part === 'Y-G04' ? 'Tomorrow' : key === 'smc' ? 'Today' : 'Estoque';
            result = qty ? offer(config, '17.85', qty, `https://${domain}`, timing) : null;
          } else {
            result = await lookup(this.config, config, part, pack, vpn);
          }
        } catch (err) {
          item.offers[config.name] = {
            detail: err instanceof Pending ? err.message : 'Resposta do fornecedor não reconhecida.',
          };
          unconfirmed.push(config.name);
          continue;
        }
        offers[key] = result;
        item.offers[config.name] = result
          ? { stock: result.userStock, floor: result.atLeast, price: result.price, timing: result.timing }
          : {
            detail: config.driver === 'site'
              ? 'Código não encontrado nos links.'
              : 'Sem estoque elegível confirmado.',
          };
      }

      if (unconfirmed.length) {
        throw new Pending(`Oferta sem confirmação em ${unconfirmed.join(', ')}. Confira o motivo em Fornecedores e estoque.`);
      }
      const selected = choose(offers, minimums, item.pack);
      if (!selected) {
        throw new Pending('Nenhum fornecedor tem saldo suficiente para este anúncio.');
      }
      Object.assign(item, {
        status: demo ? 'demo' : 'ready',
        supplier: selected.supplier,
        stock: selected.userStock,
        price: selected.price,
        link: selected.link,
        handling: selected.handling,
        shipping: selected.shipping,
        timing: selected.timing,
        sold_for: soldFor(selected.price, DEFAULT_PREP, selected.shipping),
      });
    } catch (err) {
      item.status = 'pending';
      item.detail = err instanceof Pending ? err.message : 'Dados da Amazon indisponíveis.';
    }
    return item;
  }

  async commit(ready) {
    const authPath = this.config.google_credentials;
    try {
      if (!this.config.spreadsheet_id) {
        throw new Pending('Configure spreadsheet_id e sheet_id em settings.json.');
      }
      if (!fs.existsSync(authPath)) {
        throw new Pending('A credencial de gravação do Google Sheets ainda não foi configurada.');
      }
      const sheet = new Sheets(authPath, this.config.spreadsheet_id, Number.parseInt(String(this.config.sheet_id), 10));
      const [written, rejected] = await sheet.commit(ready);
      for (const [item] of written) item.status = 'written';
      for (const [item, detail] of rejected) {
        item.status = 'pending';
        item.detail = detail;
      }
    } catch (err) {
      const detail = err instanceof Pending
        ? err.message
        : 'Gravação não confirmada pelo Google Sheets. Reenvie para conferir pelo ASIN.';
      for (const item of ready) {
        item.status = 'pending';
        item.detail = detail;
      }
    }
  }
}

export function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) return DEFAULTS;
  const overrides = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return {
    ...DEFAULTS,
    ...overrides,
    suppliers: { ...DEFAULTS.suppliers, ...(overrides.suppliers || {}) },
  };
}
