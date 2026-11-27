#!/usr/bin/env node
/**
 * CLI entrypoint for the Express dashboard server and SSH homelab worker (--run-job).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { Jobs, SETTINGS_DIR, STATE_DIR, loadConfig, testSupplier } from './jobs.js';
import { Pending } from './suppliers.js';

function parseArgs(argv) {
  const args = {
    port: 8746,
    config: path.join(SETTINGS_DIR, 'settings.json'),
    state: STATE_DIR,
    workerHost: null,
    runJob: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--port') args.port = Number.parseInt(argv[++i], 10);
    else if (flag === '--config') args.config = argv[++i];
    else if (flag === '--state') args.state = argv[++i];
    else if (flag === '--worker-host') args.workerHost = argv[++i];
    else if (flag === '--run-job') args.runJob = true;
    else {
      process.stderr.write(`Argumento desconhecido: ${flag}\n`);
      process.exit(2);
    }
  }
  if (args.workerHost && args.runJob) {
    process.stderr.write('Use --worker-host ou --run-job, não os dois juntos.\n');
    process.exit(2);
  }
  return args;
}

function acquireWorkerLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Already removed.
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const pid = Number.parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
        if (pid > 0) process.kill(pid, 0);
        throw new Pending('O servidor já está executando outro lote. Tente novamente ao terminar.');
      } catch (probeErr) {
        if (probeErr instanceof Pending) throw probeErr;
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Race condition on stale lock cleanup.
        }
      }
    }
  }
  throw new Pending('O servidor já está executando outro lote. Tente novamente ao terminar.');
}

async function runJob(config, stateDir) {
  const send = (data) => {
    process.stdout.write(`${JSON.stringify(data)}\n`);
  };

  let releaseLock = null;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const options = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Pending('Dados do lote inválidos.');
    }
    if ('test' in options) {
      try {
        send({ result: await testSupplier(config, options.test) });
      } catch (err) {
        send({ error: err instanceof Pending ? err.message : 'Dados do lote inválidos.' });
      }
      return;
    }

    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    releaseLock = acquireWorkerLock(path.join(stateDir, 'worker.lock'));
    const jobs = new Jobs(config, stateDir);
    try {
      const [job, suppliers, batch, limit] = jobs.prepare(options);
      await jobs.run(job, suppliers, batch, limit, (data) => {
        jobs.save(data);
        send(data);
      });
    } finally {
      jobs.close();
    }
  } catch (err) {
    send({
      status: 'error',
      items: [],
      total: 0,
      message: err instanceof Pending ? err.message : 'Dados do lote inválidos.',
    });
  } finally {
    if (releaseLock) releaseLock();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);

  if (args.runJob) {
    await runJob(config, args.state);
    return;
  }

  const jobs = new Jobs(config, args.state, args.workerHost);
  const app = createApp(jobs);
  const server = app.listen(args.port, '127.0.0.1', () => {
    const addr = server.address();
    process.stdout.write(`Painel local do Buscador em http://127.0.0.1:${addr.port}\n`);
  });

  const shutdown = () => {
    server.close(() => {
      jobs.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
