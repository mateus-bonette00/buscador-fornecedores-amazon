"""Google Sheets writes by ASIN, preserving cells outside the integration."""

import base64
import json
import re
import subprocess
import tempfile
import time
import urllib.parse
from decimal import Decimal, ROUND_FLOOR
from pathlib import Path

from suppliers import Pending, request

# Column layout of the destination tab (see docs/PLANILHA.md). Index 0 is column A.
COLUMNS = ('ASIN', 'Marca', 'Peça', 'Pack', 'Fornecedor', 'Estoque', 'Prazo (dias)', 'Link',
           'Custo (US$)', 'Preparo (US$)', 'Frete (US$)', 'Preço de venda (US$)',
           'Taxa Amazon (US$)', 'Lucro FBM (US$)', 'ROI FBM', 'Margem FBM',
           'Taxa FBA (US$)', 'Lucro FBA (US$)', 'ROI FBA', 'Margem FBA')
HEADERS = dict(enumerate(COLUMNS))
ASIN_COL, COST, PREP, SHIPPING, PRICE, MARGIN_FBM, FBA_FEE, MARGIN_FBA = 0, 8, 9, 10, 11, 15, 16, 19
DEFAULT_PREP = 7
DEFAULT_FBA_FEE = 6
LAST_COL = 'T'


def field(row, col):
    return row[col] if col < len(row) else ''


def sold_for(cost, prep, shipping):
    total = cost + prep + shipping
    lower = (total / Decimal('0.61')).quantize(Decimal('0.01'), rounding=ROUND_FLOOR)
    options = [value for value in (lower, lower + Decimal('0.01')) if value > 0]
    return min(options, key=lambda value: abs(Decimal('0.61') - total / value))


def formulas(row):
    return {
        12: (f'=L{row}*0,15', f'=L{row}*15/100'),
        13: (f'=IF(I{row}="";"";L{row}-I{row}-J{row}-K{row}-M{row})',
             f'=L{row}-I{row}-J{row}-K{row}-M{row}'),
        14: (f'=IF(I{row}="";"";N{row}/I{row})', f'=N{row}/I{row}'),
        15: (f'=IF(L{row}="";"";N{row}/L{row})', f'=N{row}/L{row}'),
        17: (f'=IF(I{row}="";"";L{row}-I{row}-J{row}-K{row}-M{row}-Q{row})',
             f'=L{row}-I{row}-J{row}-K{row}-M{row}-Q{row}'),
        18: (f'=IF(I{row}="";"";R{row}/I{row})', f'=R{row}/I{row}'),
        19: (f'=IF(L{row}="";"";R{row}/L{row})', f'=R{row}/L{row}'),
    }


def plan_rows(grid, products):
    if not grid or any(str(field(grid[0], i)).strip() != name for i, name in HEADERS.items()):
        raise Pending('As colunas da aba foram alteradas. A gravação foi suspensa.')

    by_asin = {}
    available = []
    for index, row in enumerate(grid[1:], start=2):
        asin = str(field(row, ASIN_COL)).strip().upper()
        if asin:
            by_asin.setdefault(asin, []).append(index)
        elif not any(field(row, col) not in ('', None) for col in range(len(COLUMNS))
                     if col not in (PREP, FBA_FEE) and col not in formulas(index)):
            available.append(index)

    tail = max(2, len(grid) + 1)
    merged = []
    rejected = []
    for product in products:
        known = by_asin.get(product['asin'], [])
        if len(known) > 1:
            rejected.append((product, 'ASIN encontrado em mais de uma linha da planilha.'))
            continue
        if known:
            index = known[0]
        elif available:
            index = available.pop(0)
        else:
            index = tail
            tail += 1
        row = grid[index - 1] if index <= len(grid) else []
        defaults = formulas(index)
        mismatch = any(field(row, col) and str(field(row, col)).strip() not in allowed
                       for col, allowed in defaults.items())
        prep = field(row, PREP)
        fba_fee = field(row, FBA_FEE)
        invalid_prep = prep != '' and (not isinstance(prep, (int, float)) or isinstance(prep, bool) or prep < 0)
        invalid_fba = fba_fee != '' and (not isinstance(fba_fee, (int, float)) or isinstance(fba_fee, bool) or fba_fee < 0)
        if mismatch or invalid_prep or invalid_fba:
            rejected.append((product, f'Taxas ou fórmula diferentes na linha {index}.'))
            continue
        cost, shipping = Decimal(str(product['price'])), Decimal(str(product['shipping']))
        changes = {
            ASIN_COL: product['asin'], 1: product['brand'], 2: product['part'], 3: product['pack'],
            4: product['supplier'], 5: product['stock'], 6: product['handling'], 7: product['link'],
            COST: cost, SHIPPING: shipping,
            PRICE: sold_for(cost, Decimal(str(prep if prep != '' else DEFAULT_PREP)), shipping),
        }
        if prep == '':
            changes[PREP] = DEFAULT_PREP
        if fba_fee == '':
            changes[FBA_FEE] = DEFAULT_FBA_FEE
        for col, choices in defaults.items():
            if not field(row, col):
                changes[col] = {'formulaValue': choices[-1]}
        merged.append((product, index, changes))
    return merged, rejected


def base64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=')


class Sheets:
    def __init__(self, credentials, spreadsheet_id, sheet_id):
        self.credentials = Path(credentials)
        self.root = 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheet_id
        self.sheet_id = sheet_id

    def auth(self):
        try:
            credentials = json.loads(self.credentials.read_text())
            now = int(time.time())
            claims = {'iss': credentials['client_email'], 'aud': 'https://oauth2.googleapis.com/token',
                      'scope': 'https://www.googleapis.com/auth/spreadsheets',
                      'iat': now, 'exp': now + 3600}
            payload = b'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.' + base64url(json.dumps(claims).encode())
            with tempfile.TemporaryFile() as private_key:
                private_key.write(credentials['private_key'].encode())
                private_key.seek(0)
                signature = subprocess.run(
                    ['openssl', 'dgst', '-sha256', '-sign', f'/proc/self/fd/{private_key.fileno()}'],
                    input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    pass_fds=(private_key.fileno(),), check=True, timeout=10).stdout
            assertion = (payload + b'.' + base64url(signature)).decode()
            body = urllib.parse.urlencode({'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                                          'assertion': assertion}).encode()
            result = request('https://oauth2.googleapis.com/token', data=body,
                             headers={'Content-Type': 'application/x-www-form-urlencoded'})
            return json.loads(result)['access_token']
        except (OSError, ValueError, KeyError, subprocess.SubprocessError, Pending):
            raise Pending('A credencial do Google Sheets não pôde ser usada.') from None

    def commit(self, products):
        headers = {'Authorization': 'Bearer ' + self.auth(), 'Content-Type': 'application/json'}
        fields = urllib.parse.urlencode({'fields': 'sheets(properties(sheetId,title,gridProperties(rowCount)))'})
        meta = json.loads(request(self.root + '?' + fields, headers=headers))
        tab = next((sheet['properties'] for sheet in meta.get('sheets', [])
                    if sheet['properties']['sheetId'] == self.sheet_id), None)
        if not tab:
            raise Pending('A aba configurada do Google Sheets não foi encontrada.')
        name = "'" + tab['title'].replace("'", "''") + "'!"
        a1 = urllib.parse.quote(name + 'A1:' + LAST_COL, safe='')
        rows = json.loads(request(self.root + '/values/' + a1 + '?valueRenderOption=FORMULA',
                                  headers=headers)).get('values', [])
        merged, rejected = plan_rows(rows, products)
        if not merged:
            return merged, rejected
        requests = []
        highest_row = max(row for _, row, _ in merged)
        extra = highest_row - tab['gridProperties']['rowCount']
        if extra > 0:
            requests.append({'appendDimension': {'sheetId': self.sheet_id, 'dimension': 'ROWS',
                                                  'length': extra}})
        for _, row, changes in merged:
            for col, value in changes.items():
                if isinstance(value, dict):
                    cell = value
                elif isinstance(value, (int, float, Decimal)):
                    cell = {'numberValue': float(value)}
                else:
                    cell = {'stringValue': value}
                requests.append({'updateCells': {'start': {'sheetId': self.sheet_id,
                                                            'rowIndex': row - 1, 'columnIndex': col},
                                                  'rows': [{'values': [{'userEnteredValue': cell}]}],
                                                  'fields': 'userEnteredValue'}})
        request(self.root + ':batchUpdate', data=json.dumps({'requests': requests}).encode(), headers=headers)
        first = min(row for _, row, _ in merged)
        check_range = urllib.parse.quote(name + f'A{first}:{LAST_COL}{highest_row}', safe='')
        values = json.loads(request(self.root + '/values/' + check_range + '?valueRenderOption=UNFORMATTED_VALUE',
                                    headers=headers)).get('values', [])
        verified = []
        for product, row, changes in merged:
            cells = field(values, row - first)
            margin_fbm = field(cells, MARGIN_FBM)
            margin_fba = field(cells, MARGIN_FBA)
            prep = field(cells, PREP)
            fba_fee = field(cells, FBA_FEE)
            if (field(cells, ASIN_COL) != product['asin'] or field(cells, PRICE) != float(changes[PRICE])
                    or not isinstance(margin_fbm, (float, int)) or not isinstance(margin_fba, (float, int))
                    or not isinstance(prep, (float, int)) or not isinstance(fba_fee, (float, int))):
                rejected.append((product, f'Gravação sem confirmação de preço e margem na linha {row}.'))
                continue
            expected_fbm = Decimal('0.85') - (changes[COST] + changes[SHIPPING] + Decimal(str(prep))) / changes[PRICE]
            expected_fba = expected_fbm - Decimal(str(fba_fee)) / changes[PRICE]
            if (abs(Decimal(str(margin_fbm)) - expected_fbm) > Decimal('0.000001')
                    or abs(Decimal(str(margin_fba)) - expected_fba) > Decimal('0.000001')):
                rejected.append((product, f'A margem calculada na planilha divergiu na linha {row}.'))
                continue
            product.update(sold_for=str(changes[PRICE]), sheet_row=row, margin=margin_fbm, fba_margin=margin_fba)
            verified.append((product, row, changes))
        return verified, rejected
