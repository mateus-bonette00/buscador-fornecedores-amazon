import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createApp } from '../server/app.js';
import {
  DEFAULTS,
  Jobs,
  choose,
  extract,
  jobsDeps,
  parseInput,
  supplierRules,
} from '../server/jobs.js';
import { HEADERS, Sheets, formulas, planRows, sheetsDeps, soldFor } from '../server/sheets.js';
import {
  Pending,
  containsPart,
  motion,
  offer,
  openPublic,
  publicLink,
  site,
  smc,
  supplierDeps,
} from '../server/suppliers.js';
import { protonConnection, vpnDeps } from '../server/vpn.js';

const origVpnExec = vpnDeps.execFileSync;
const origSupplierRequest = supplierDeps.request;
const origLookupDns = supplierDeps.lookupDns;
const origSheetsRequest = sheetsDeps.request;
const origJobsExec = jobsDeps.execFileSync;

afterEach(() => {
  vpnDeps.execFileSync = origVpnExec;
  supplierDeps.request = origSupplierRequest;
  supplierDeps.lookupDns = origLookupDns;
  sheetsDeps.request = origSheetsRequest;
  jobsDeps.execFileSync = origJobsExec;
});

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buscador-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function productPage(mpn = 'KQ2H06-01AS', stock = 40, price = '3.10') {
  const level = stock !== null ? `,"inventoryLevel":{"value":${stock}}` : '';
  return `<script type="application/ld+json">{"@type":"Product","mpn":"${mpn}","offers":{"price":"${price}","priceCurrency":"USD","availability":"https://schema.org/InStock"${level}}}</script>`;
}

describe('ProtonLifecycle', () => {
  it('only checks active US profile', () => {
    const calls = [];
    vpnDeps.execFileSync = (cmd, args) => {
      calls.push([cmd, args]);
      return 'wireguard:activated:ProtonVPN US-FREE#12\n';
    };
    const conn = protonConnection();
    conn.requireUs();
    assert.ok(calls.length >= 2);
    for (const [, args] of calls) {
      assert.deepEqual(args.slice(-3), ['connection', 'show', '--active']);
    }
  });

  it('rejects unconnected or non-US profiles', () => {
    for (const [profile, reason] of [
      ['vpn:activating:ProtonVPN US-FREE#12', /manualmente/],
      ['vpn:activated:ProtonVPN NL-FREE#7', /Estados Unidos/],
    ]) {
      vpnDeps.execFileSync = () => profile;
      assert.throws(() => protonConnection(), (err) => err instanceof Pending && reason.test(err.message));
    }
  });
});

describe('BusinessRules', () => {
  it('extracts pack variants and exact part', () => {
    assert.deepEqual(extract('SMC Y-G04 Pack Of 6, fits 40Mm. Y-G04 Pack Of 6'), ['Y-G04', 6]);
    assert.deepEqual(extract('SMC Sy5000-27-1N (6Pack)'), ['SY5000-27-1N', 6]);
    assert.deepEqual(extract('SMC NCQ2B63-25DZ cylinder'), ['NCQ2B63-25DZ', 1]);
    assert.deepEqual(extract('Cylinder NCQ2B63-25DZ.'), ['NCQ2B63-25DZ', 1]);
    assert.equal(containsPart('NCQ2B63-25DZ-XC8', 'NCQ2B63-25DZ'), false);
    assert.throws(() => extract('SMC Y-G04 KQ2F11-35A'), Pending);
  });

  it('keeps original price and uses 24 percent target', () => {
    assert.equal(soldFor('80.49', '7', '40'), '209.00');
    assert.equal(soldFor('17.85', '7', '40'), '106.31');
    assert.equal(soldFor('17.85', '7', '70'), '155.49');
  });

  it('applies 2.4x preference and stock for pack', () => {
    const rules = DEFAULTS.suppliers;
    const motionOffer = offer(rules.motion, '2', 15, 'https://www.motion.com');
    const picks = (smcQty, pack = 1) => {
      const smcOffer = offer(rules.smc, '2', smcQty, 'https://www.smcpneumatics.com');
      return choose({ motion: motionOffer, smc: smcOffer }, { motion: 11, smc: 11 }, pack);
    };
    assert.equal(picks(35).supplier, 'Motion');
    assert.equal(picks(36).supplier, 'SMC Pneumatics');
    assert.equal(picks(20, 16).supplier, 'SMC Pneumatics');
    assert.equal(picks(20, 21), null);
    assert.equal(
      choose({ smc: offer(rules.smc, '2', 10, 'https://www.smcpneumatics.com') }, { smc: 11 }, 1),
      null,
    );
  });

  it('checks SMC today then tomorrow without using similar items', async () => {
    const part = 'NCQ2B63-25DZ';
    const text = 'Part Number: NCQ2B63-25DZ Your Price: $75.90 '
      + 'Available to Ship Today*: 10 qty Available to Ship Tomorrow*: 12 qty '
      + 'Close match in stock items 50+ NCQ2B63-15DM';
    const urls = [];
    supplierDeps.request = async (url) => {
      urls.push(url);
      return text;
    };
    let stock = await smc(DEFAULTS.suppliers.smc, part, 1, 'http://127.0.0.1:3128');
    assert.deepEqual([stock.timing, stock.handling, stock.userStock], ['Tomorrow', 7, 12]);
    assert.ok(urls[0].includes('/NCQ2B63-25DZ.html'));

    supplierDeps.request = async () => text.replace('10 qty', '11 qty');
    stock = await smc(DEFAULTS.suppliers.smc, part, 10, 'http://127.0.0.1:3128');
    assert.deepEqual([stock.timing, stock.handling], ['Today', 6]);
  });

  it('matches Motion MFR and does not count order quantity', async () => {
    const search = '<a href="/products/sku/05154238">NCQ2B63-25DZ</a>'
      + '<a href="/products/sku/13866782">NCQ2B63-25DZ-XC8</a>';
    const product = 'MFR # NCQ2B63-25DZ $80.49 /each Factory Order QTY 99';

    let queue = [search, product];
    supplierDeps.request = async () => queue.shift();
    assert.equal(await motion(DEFAULTS.suppliers.motion, 'NCQ2B63-25DZ', 1), null);

    queue = [search, product.replace('Factory Order QTY 99', '18 in stock')];
    const stock = await motion(DEFAULTS.suppliers.motion, 'NCQ2B63-25DZ', 1);
    assert.deepEqual([stock.userStock, stock.price], [18, '80.49']);
  });

  it('deduplicates CSV input', () => {
    const ids = parseInput('ASIN;Title\nB000000001;SMC Y-G04\nB000000001;SMC Y-G04 Pack Of 6');
    assert.deepEqual(ids, [{ asin: 'B000000001', title: 'SMC Y-G04 Pack Of 6' }]);
  });
});

describe('SupplierLinks', () => {
  const makeRules = (...links) =>
    supplierRules(DEFAULTS, [{ links, shipping: 25, handling: 3 }])['loja.com'];

  const read = async (pages, ...links) => {
    supplierDeps.lookupDns = async () => [{ address: '93.184.216.34', family: 4 }];
    supplierDeps.request = async (url) => pages[url];
    return site(makeRules(...links), 'KQ2H06-01AS', 1);
  };

  it('reads product, search template, and discovered SearchAction', async () => {
    const item = 'https://loja.com/p/1';
    const found = await read({ [item]: productPage() }, item);
    assert.deepEqual([found.price, found.userStock, found.shipping, found.handling], ['3.10', 40, '25.00', 3]);

    const pages = {
      'https://loja.com/s?q=KQ2H06-01AS':
        '<a href="/p/1">Fitting KQ2H06-01AS</a><a href="/p/2">KQ2H06-01AS-X</a><a href="https://outra.com/p/3">KQ2H06-01AS</a>',
      [item]: productPage(),
    };
    assert.equal((await read(pages, 'https://loja.com/s?q={part}')).link, item);

    pages['https://loja.com/'] =
      '<script type="application/ld+json">{"@type":"WebSite","potentialAction":{"@type":"SearchAction","target":"https://loja.com/s?q={search_term_string}"}}</script>';
    assert.equal((await read(pages, 'https://loja.com/')).link, item);
  });

  it('tries next link and reads labeled text fallback', async () => {
    const pages = {
      'https://loja.com/a': productPage('OUTRO-1'),
      'https://loja.com/b': '<p>Part Number: KQ2H06-01AS</p><p>Your Price: $4.00</p><span>18 in stock</span>',
    };
    const found = await read(pages, ...Object.keys(pages));
    assert.deepEqual([found.price, found.userStock], ['4.00', 18]);
    assert.equal(await read(pages, 'https://loja.com/a'), null);
  });

  it('refuses what it cannot confirm', async () => {
    const link = 'https://loja.com/p/1';
    for (const [page, reason] of [
      [productPage('KQ2H06-01AS', null), /quantidade/],
      [productPage().replace('USD', 'BRL'), /dólar/],
    ]) {
      await assert.rejects(() => read({ [link]: page }, link), (err) => err instanceof Pending && reason.test(err.message));
    }
  });

  it('does not guess stock from prices or model names', async () => {
    const link = 'https://loja.com/p/1';
    for (const noise of ['<p>$552.46 In stock</p>', '<p>Arduino Mega 2560 In stock</p>']) {
      await assert.rejects(
        () => read({ [link]: productPage('KQ2H06-01AS', null) + noise }, link),
        (err) => err instanceof Pending && /quantidade/.test(err.message),
      );
    }
    const ok = await read({ [link]: productPage('KQ2H06-01AS', null) + '<span> 18 in stock </span>' }, link);
    assert.equal(ok.userStock, 18);
  });

  it('groups links and blocks internal addresses', async () => {
    const rules = supplierRules(DEFAULTS, [
      { links: ['https://www.motion.com/a', 'https://motion.com/b'], shipping: 12.5, handling: 2 },
    ]);
    assert.deepEqual([rules.motion.driver, rules.motion.shipping], ['motion', 12.5]);

    for (const link of [
      'http://loja.com',
      'https://127.0.0.1/',
      'https://localhost/',
      'https://u:p@loja.com/',
      'https://loja.com:8080/',
    ]) {
      assert.throws(() => publicLink(link), Pending);
    }

    assert.throws(
      () => supplierRules(DEFAULTS, [{ links: ['https://loja.com', 'https://outra.com'] }]),
      (err) => err instanceof Pending && /mesmo site/.test(err.message),
    );

    supplierDeps.lookupDns = async () => [{ address: '192.168.0.1', family: 4 }];
    await assert.rejects(
      () => openPublic('https://loja.com/'),
      (err) => err instanceof Pending && /rede interna/.test(err.message),
    );
  });
});

describe('Homelab', () => {
  it('runs supplier test on the remote SSH server', async () => {
    await withTempDir(async (dir) => {
      const jobs = new Jobs(DEFAULTS, dir, 'meu-homelab');
      try {
        let lastArgs = null;
        jobsDeps.execFileSync = (cmd, args) => {
          lastArgs = [cmd, ...args];
          return '{"result": {"found": false}}\n';
        };
        assert.deepEqual(await jobs.test({ part: 'Y-G04' }), { found: false });
        assert.ok(lastArgs.includes('meu-homelab'));
        assert.ok(lastArgs.some((a) => a.includes('node server/index.js --run-job')));

        for (const [reply, reason] of [
          ['{"error": "VPN desligada."}\n', /VPN/],
          ['', /conexão/],
        ]) {
          jobsDeps.execFileSync = () => reply;
          await assert.rejects(
            () => jobs.test({ part: 'Y-G04' }),
            (err) => err instanceof Pending && reason.test(err.message),
          );
        }
      } finally {
        jobs.close();
      }
    });
  });
});

describe('SheetsIntegration', () => {
  function makeFixture() {
    const grid = Array.from({ length: 3 }, () => Array(20).fill(''));
    for (const [col, header] of Object.entries(HEADERS)) {
      grid[0][Number(col)] = header;
    }
    grid[1][0] = 'B000000001';
    grid[1][9] = 7;
    grid[1][16] = 6;
    for (const [col, options] of Object.entries(formulas(2))) {
      grid[1][Number(col)] = options[0];
    }
    const item = {
      asin: 'B000000001', brand: 'SMC', part: 'Y-G04', pack: 6, price: '80.49',
      stock: 15, supplier: 'Motion', handling: 5, shipping: '40',
      link: 'https://www.motion.com/products/sku/05154238',
    };
    return { grid, item };
  }

  it('existing ASIN updates only input fields', () => {
    const { grid, item } = makeFixture();
    const [rows, rejected] = planRows(grid, [item]);
    assert.deepEqual(rejected, []);
    const [, row, values] = rows[0];
    assert.equal(row, 2);
    assert.equal(values[8], 80.49);
    assert.equal(values[11], 209);
    for (const preserved of [9, 12, 13, 14, 15, 16, 17, 18, 19]) {
      assert.equal(preserved in values, false);
    }
    grid.push([...grid[1]]);
    assert.equal(planRows(grid, [item])[1].length, 1);
  });

  it('new ASIN fills FBM and FBA defaults and formulas', () => {
    const { grid, item } = makeFixture();
    const [rows, rejected] = planRows(grid, [{ ...item, asin: 'B000000002' }]);
    assert.deepEqual(rejected, []);
    const [, row, values] = rows[0];
    assert.equal(row, 3);
    assert.deepEqual([values[9], values[16]], [7, 6]);
    assert.deepEqual(values[13], { formulaValue: '=L3-I3-J3-K3-M3' });
    assert.deepEqual(values[17], { formulaValue: '=L3-I3-J3-K3-M3-Q3' });
  });

  it('checks written row and actual FBM and FBA margins', async () => {
    const { grid, item } = makeFixture();
    const fbaMargin = 44.16 / 209;
    const responses = [
      JSON.stringify({ sheets: [{ properties: { sheetId: 4, title: 'Teste', gridProperties: { rowCount: 10 } } }] }),
      JSON.stringify({ values: grid }),
      '{}',
      JSON.stringify({
        values: [[
          'B000000001', 'SMC', 'Y-G04', 6, 'Motion', 15, 5, 'link',
          80.49, 7, 40, 209, 31.35, 50.16, 0.62, 0.24, 6, 44.16, 0.55, fbaMargin,
        ]],
      }),
    ];
    sheetsDeps.request = async () => responses.shift();
    const sheet = new Sheets('/test', 'test', 4);
    sheet.auth = async () => 'test-token';
    const [rows, rejected] = await sheet.commit([item]);
    assert.deepEqual(rejected, []);
    assert.equal(rows[0][1], 2);
    assert.equal(item.margin, 0.24);
    assert.equal(Number(item.fba_margin.toFixed(6)), Number(fbaMargin.toFixed(6)));
  });
});

describe('ExpressDashboard', () => {
  it('sets initial total for known batches in Jobs.prepare', async () => {
    await withTempDir((dir) => {
      const jobs = new Jobs(DEFAULTS, dir);
      try {
        const [demoJob] = jobs.prepare({ brand: 'SMC', mode: 'demo', limit: 8 });
        assert.equal(demoJob.total, 3);
        const [inputJob] = jobs.prepare({
          brand: 'SMC',
          mode: 'input',
          limit: 8,
          input: 'B000000001\nB000000002',
          suppliers: [{ links: ['https://www.motion.com'], shipping: 40, handling: 5 }],
        });
        assert.equal(inputJob.total, 2);
        const [keepaJob] = jobs.prepare({
          brand: 'SMC',
          mode: 'keepa',
          limit: 8,
          input: '{}',
          suppliers: [{ links: ['https://www.motion.com'], shipping: 40, handling: 5 }],
        });
        assert.equal(keepaJob.total, 0);
      } finally {
        jobs.close();
      }
    });
  });

  it('serves favicon without 404 and runs demo batch end to end via Express API', async () => {
    await withTempDir(async (dir) => {
      const jobs = new Jobs(DEFAULTS, dir);
      const app = createApp(jobs);
      const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      try {
        const svgResp = await fetch(`${base}/favicon.svg`);
        assert.equal(svgResp.status, 200);
        assert.ok((svgResp.headers.get('content-type') || '').includes('image/svg+xml'));

        const icoResp = await fetch(`${base}/favicon.ico`);
        assert.equal(icoResp.status, 204);

        const setupResp = await fetch(`${base}/api/setup`);
        assert.equal(setupResp.status, 200);
        const setupData = await setupResp.json();
        assert.equal(setupData.remote_worker, false);
        assert.equal(setupData.known['motion.com'].name, 'Motion');

        const badContentType = await fetch(`${base}/api/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: '{}',
        });
        assert.equal(badContentType.status, 415);

        const createResp = await fetch(`${base}/api/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brand: 'SMC', mode: 'demo', limit: 8, input: '', suppliers: [] }),
        });
        assert.equal(createResp.status, 202);
        const created = await createResp.json();

        await jobs.queue;
        const jobResp = await fetch(`${base}/api/jobs/${created.id}`);
        assert.equal(jobResp.status, 200);
        const finished = await jobResp.json();
        assert.equal(finished.status, 'done');
        assert.equal(finished.items.length, 3);
        const byPart = Object.fromEntries(finished.items.map((item) => [item.part, item]));
        assert.equal(byPart['NCQ2B63-25DZ'].status, 'pending');
        assert.equal(byPart['Y-G04'].supplier, 'SMC Pneumatics');
        assert.equal(byPart['Y-G04'].sold_for, '155.49');
        assert.equal(byPart['KQ2F11-35A'].supplier, 'Motion');
        assert.equal(byPart['KQ2F11-35A'].sold_for, '106.31');
      } finally {
        await new Promise((resolve) => server.close(resolve));
        jobs.close();
      }
    });
  });

  it('rejects untrusted Origin headers on Express endpoints', async () => {
    await withTempDir(async (dir) => {
      const jobs = new Jobs(DEFAULTS, dir);
      const app = createApp(jobs);
      const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      const { port } = server.address();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/setup`, {
          headers: { Origin: 'https://evil.example' },
        });
        assert.equal(res.status, 403);
      } finally {
        await new Promise((resolve) => server.close(resolve));
        jobs.close();
      }
    });
  });
});
