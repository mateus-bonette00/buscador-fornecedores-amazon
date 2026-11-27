/**
 * Google Sheets API v4 writes by ASIN (columns A to T), signing service-account JWT via node:crypto.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Pending, formatCents, request, toCents } from './suppliers.js';

export const COLUMNS = [
  'ASIN', 'Marca', 'Peça', 'Pack', 'Fornecedor', 'Estoque', 'Prazo (dias)', 'Link',
  'Custo (US$)', 'Preparo (US$)', 'Frete (US$)', 'Preço de venda (US$)',
  'Taxa Amazon (US$)', 'Lucro FBM (US$)', 'ROI FBM', 'Margem FBM',
  'Taxa FBA (US$)', 'Lucro FBA (US$)', 'ROI FBA', 'Margem FBA',
];
export const HEADERS = Object.fromEntries(COLUMNS.map((name, index) => [index, name]));
export const ASIN_COL = 0;
export const COST = 8;
export const PREP = 9;
export const SHIPPING = 10;
export const PRICE = 11;
export const MARGIN_FBM = 15;
export const FBA_FEE = 16;
export const MARGIN_FBA = 19;
export const DEFAULT_PREP = 7;
export const DEFAULT_FBA_FEE = 6;
export const LAST_COL = 'T';

export const sheetsDeps = {
  request,
};

export function field(row, col) {
  return Array.isArray(row) && col < row.length ? row[col] : '';
}

/**
 * Compute target sale price in cents for ~24% FBM margin (15% Amazon fee -> 0.61 cost ratio).
 * Uses exact BigInt comparisons to match Python Decimal precision to the cent.
 */
export function soldFor(cost, prep, shipping) {
  const total = BigInt(toCents(cost) + toCents(prep) + toCents(shipping));
  const lower = (total * 100n) / 61n;
  const candidates = [lower, lower + 1n].filter((v) => v > 0n);
  let best = candidates[0];
  for (const cand of candidates.slice(1)) {
    const dBest = (61n * best - 100n * total) < 0n ? -(61n * best - 100n * total) : (61n * best - 100n * total);
    const dCand = (61n * cand - 100n * total) < 0n ? -(61n * cand - 100n * total) : (61n * cand - 100n * total);
    if (dCand * best < dBest * cand) best = cand;
  }
  return formatCents(Number(best));
}

export function formulas(row) {
  return {
    12: [`=L${row}*0,15`, `=L${row}*15/100`],
    13: [`=IF(I${row}="";"";L${row}-I${row}-J${row}-K${row}-M${row})`, `=L${row}-I${row}-J${row}-K${row}-M${row}`],
    14: [`=IF(I${row}="";"";N${row}/I${row})`, `=N${row}/I${row}`],
    15: [`=IF(L${row}="";"";N${row}/L${row})`, `=N${row}/L${row}`],
    17: [`=IF(I${row}="";"";L${row}-I${row}-J${row}-K${row}-M${row}-Q${row})`, `=L${row}-I${row}-J${row}-K${row}-M${row}-Q${row}`],
    18: [`=IF(I${row}="";"";R${row}/I${row})`, `=R${row}/I${row}`],
    19: [`=IF(L${row}="";"";R${row}/L${row})`, `=R${row}/L${row}`],
  };
}

export function planRows(grid, products) {
  if (!grid.length || COLUMNS.some((name, i) => String(field(grid[0], i)).trim() !== name)) {
    throw new Pending('As colunas da aba foram alteradas. A gravação foi suspensa.');
  }

  const byAsin = new Map();
  const available = [];
  for (let i = 1; i < grid.length; i += 1) {
    const index = i + 1;
    const row = grid[i];
    const asin = String(field(row, ASIN_COL)).trim().toUpperCase();
    if (asin) {
      if (!byAsin.has(asin)) byAsin.set(asin, []);
      byAsin.get(asin).push(index);
    } else {
      const f = formulas(index);
      const occupied = COLUMNS.some((_, col) => {
        if (col === PREP || col === FBA_FEE || Object.prototype.hasOwnProperty.call(f, col)) return false;
        const val = field(row, col);
        return val !== '' && val !== null && val !== undefined;
      });
      if (!occupied) available.push(index);
    }
  }

  let tail = Math.max(2, grid.length + 1);
  const merged = [];
  const rejected = [];

  for (const product of products) {
    const known = byAsin.get(product.asin) || [];
    if (known.length > 1) {
      rejected.push([product, 'ASIN encontrado em mais de uma linha da planilha.']);
      continue;
    }
    let index;
    if (known.length === 1) {
      index = known[0];
    } else if (available.length > 0) {
      index = available.shift();
    } else {
      index = tail;
      tail += 1;
    }

    const row = index <= grid.length ? grid[index - 1] : [];
    const defaults = formulas(index);
    const mismatch = Object.entries(defaults).some(([colStr, allowed]) => {
      const val = field(row, Number(colStr));
      return val && !allowed.includes(String(val).trim());
    });
    const prep = field(row, PREP);
    const fbaFee = field(row, FBA_FEE);
    const invalidPrep = prep !== '' && (typeof prep !== 'number' || Number.isNaN(prep) || prep < 0);
    const invalidFba = fbaFee !== '' && (typeof fbaFee !== 'number' || Number.isNaN(fbaFee) || fbaFee < 0);
    if (mismatch || invalidPrep || invalidFba) {
      rejected.push([product, `Taxas ou fórmula diferentes na linha ${index}.`]);
      continue;
    }

    const cost = formatCents(toCents(product.price));
    const shipping = formatCents(toCents(product.shipping));
    const effectivePrep = prep !== '' ? prep : DEFAULT_PREP;
    const priceVal = soldFor(cost, effectivePrep, shipping);

    const changes = {
      [ASIN_COL]: product.asin,
      1: product.brand,
      2: product.part,
      3: product.pack,
      4: product.supplier,
      5: product.stock,
      6: product.handling,
      7: product.link,
      [COST]: Number(cost),
      [SHIPPING]: Number(shipping),
      [PRICE]: Number(priceVal),
    };
    if (prep === '') changes[PREP] = DEFAULT_PREP;
    if (fbaFee === '') changes[FBA_FEE] = DEFAULT_FBA_FEE;
    for (const [colStr, choices] of Object.entries(defaults)) {
      const col = Number(colStr);
      if (!field(row, col)) {
        changes[col] = { formulaValue: choices[choices.length - 1] };
      }
    }
    merged.push([product, index, changes, priceVal]);
  }
  return [merged, rejected];
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf-8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export class Sheets {
  constructor(credentialsPath, spreadsheetId, sheetId) {
    this.credentialsPath = credentialsPath;
    this.root = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
    this.sheetId = sheetId;
  }

  async auth() {
    try {
      const credentials = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf-8'));
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: credentials.client_email,
        aud: 'https://oauth2.googleapis.com/token',
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        iat: now,
        exp: now + 3600,
      };
      const payload = `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${base64url(JSON.stringify(claims))}`;
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(payload);
      signer.end();
      const signature = signer.sign(credentials.private_key);
      const assertion = `${payload}.${base64url(signature)}`;
      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString();
      const raw = await sheetsDeps.request('https://oauth2.googleapis.com/token', {
        data: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      return JSON.parse(raw).access_token;
    } catch {
      throw new Pending('A credencial do Google Sheets não pôde ser usada.');
    }
  }

  async commit(products) {
    const token = await this.auth();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const fields = new URLSearchParams({ fields: 'sheets(properties(sheetId,title,gridProperties(rowCount)))' }).toString();
    const meta = JSON.parse(await sheetsDeps.request(`${this.root}?${fields}`, { headers }));
    const tab = (meta.sheets || []).map((s) => s.properties).find((p) => p.sheetId === this.sheetId);
    if (!tab) throw new Pending('A aba configurada do Google Sheets não foi encontrada.');

    const name = `'${tab.title.replace(/'/g, "''")}'!`;
    const a1 = encodeURIComponent(`${name}A1:${LAST_COL}`);
    const rows = JSON.parse(await sheetsDeps.request(`${this.root}/values/${a1}?valueRenderOption=FORMULA`, { headers })).values || [];
    const [merged, rejected] = planRows(rows, products);
    if (!merged.length) return [merged, rejected];

    const requests = [];
    const highestRow = Math.max(...merged.map(([, row]) => row));
    const extra = highestRow - tab.gridProperties.rowCount;
    if (extra > 0) {
      requests.push({ appendDimension: { sheetId: this.sheetId, dimension: 'ROWS', length: extra } });
    }
    for (const [, row, changes] of merged) {
      for (const [colStr, value] of Object.entries(changes)) {
        const col = Number(colStr);
        let cell;
        if (value && typeof value === 'object') cell = value;
        else if (typeof value === 'number') cell = { numberValue: value };
        else cell = { stringValue: String(value) };
        requests.push({
          updateCells: {
            start: { sheetId: this.sheetId, rowIndex: row - 1, columnIndex: col },
            rows: [{ values: [{ userEnteredValue: cell }] }],
            fields: 'userEnteredValue',
          },
        });
      }
    }
    await sheetsDeps.request(`${this.root}:batchUpdate`, {
      data: JSON.stringify({ requests }),
      headers,
    });

    const first = Math.min(...merged.map(([, row]) => row));
    const checkRange = encodeURIComponent(`${name}A${first}:${LAST_COL}${highestRow}`);
    const values = JSON.parse(
      await sheetsDeps.request(`${this.root}/values/${checkRange}?valueRenderOption=UNFORMATTED_VALUE`, { headers }),
    ).values || [];

    const verified = [];
    for (const [product, row, changes, priceStr] of merged) {
      const cells = field(values, row - first);
      const marginFbm = field(cells, MARGIN_FBM);
      const marginFba = field(cells, MARGIN_FBA);
      const prep = field(cells, PREP);
      const fbaFee = field(cells, FBA_FEE);
      if (
        field(cells, ASIN_COL) !== product.asin
        || field(cells, PRICE) !== changes[PRICE]
        || typeof marginFbm !== 'number'
        || typeof marginFba !== 'number'
        || typeof prep !== 'number'
        || typeof fbaFee !== 'number'
      ) {
        rejected.push([product, `Gravação sem confirmação de preço e margem na linha ${row}.`]);
        continue;
      }
      const expectedFbm = 0.85 - (changes[COST] + changes[SHIPPING] + prep) / changes[PRICE];
      const expectedFba = expectedFbm - fbaFee / changes[PRICE];
      if (Math.abs(marginFbm - expectedFbm) > 0.000001 || Math.abs(marginFba - expectedFba) > 0.000001) {
        rejected.push([product, `A margem calculada na planilha divergiu na linha ${row}.`]);
        continue;
      }
      Object.assign(product, { sold_for: priceStr, sheet_row: row, margin: marginFbm, fba_margin: marginFba });
      verified.push([product, row, changes]);
    }
    return [verified, rejected];
  }
}
