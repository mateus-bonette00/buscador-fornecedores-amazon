/**
 * Express HTTP server for the local React dashboard and REST API.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CSV_LIMIT, KNOWN_DOMAINS, jobOutcome } from './jobs.js';
import { Pending } from './suppliers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIST = path.join(ROOT, 'dist');
const TRUSTED_HOST_RE = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
const JOB_ID_RE = /^[a-f0-9]{32}$/;

function isTrustedHost(req) {
  const host = req.headers.host || '';
  const origin = req.headers.origin;
  return TRUSTED_HOST_RE.test(host) && (!origin || origin === `http://${host}`);
}

export function createApp(jobs, { distDir = DEFAULT_DIST } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (!isTrustedHost(req)) {
      res.status(403).json({ error: 'Use http://127.0.0.1 para abrir o painel local.' });
      return;
    }
    next();
  });

  app.get('/favicon.ico', (_req, res) => {
    res.status(204).type('image/x-icon').end();
  });

  app.get('/favicon.svg', (_req, res) => {
    const built = path.join(distDir, 'favicon.svg');
    const source = path.join(ROOT, 'web', 'public', 'favicon.svg');
    const target = fs.existsSync(built) ? built : source;
    if (fs.existsSync(target)) {
      res.type('image/svg+xml; charset=utf-8').sendFile(target);
      return;
    }
    res.status(404).json({ error: 'Arquivo não encontrado.' });
  });

  app.get('/api/setup', (_req, res) => {
    const { config } = jobs;
    const known = {};
    for (const [domain, name] of Object.entries(KNOWN_DOMAINS)) {
      const sup = config.suppliers[name];
      known[domain] = { name: sup.name, shipping: sup.shipping, handling: sup.handling };
    }
    res.json({
      known,
      remote_worker: Boolean(jobs.workerHost),
      keepa: fs.existsSync(config.keepa_key_file),
      sheets: fs.existsSync(config.google_credentials),
      smc: Boolean(config.smc_proxy || config.smc_proton_manual),
    });
  });

  app.get('/api/jobs', (_req, res) => {
    const list = jobs.load().map((job) => ({
      id: job.id,
      brand: job.brand,
      status: job.status,
      mode: job.mode,
      created: job.created,
      outcome: jobOutcome(job),
    }));
    res.json(list);
  });

  app.get('/api/jobs/:id', (req, res) => {
    if (!JOB_ID_RE.test(req.params.id)) {
      res.status(404).json({ error: 'Página ou lote não encontrado.' });
      return;
    }
    const data = jobs.load(req.params.id);
    if (!data) {
      res.status(404).json({ error: 'Página ou lote não encontrado.' });
      return;
    }
    res.json({ ...data, outcome: jobOutcome(data) });
  });

  const requireJson = (req, res, next) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Envie os dados em JSON.' });
      return;
    }
    next();
  };

  const jsonParser = express.json({ limit: 2 * CSV_LIMIT, strict: true });

  app.post('/api/test', requireJson, jsonParser, async (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new Pending('Envie os dados do lote em um objeto JSON.');
      }
      const result = await jobs.test(req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/jobs', requireJson, jsonParser, (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new Pending('Envie os dados do lote em um objeto JSON.');
      }
      const created = jobs.submit(req.body);
      res.status(202).json(created);
    } catch (err) {
      next(err);
    }
  });

  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false }));
    app.get('/', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.status(503).json({ error: 'Build do painel React não encontrado. Execute npm run build.' });
    });
  }

  app.use((req, res) => {
    if (req.method === 'POST') {
      res.status(404).json({ error: 'Operação não encontrada.' });
      return;
    }
    res.status(404).json({ error: 'Página ou lote não encontrado.' });
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof Pending) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err && (err.type === 'entity.too.large')) {
      res.status(400).json({ error: 'Tamanho da requisição inválido.' });
      return;
    }
    if (err instanceof SyntaxError && err.status === 400) {
      res.status(400).json({ error: 'Dados do lote inválidos.' });
      return;
    }
    res.status(500).json({ error: 'Erro interno do servidor local.' });
  });

  return app;
}
