import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

from vpn import proton_connection
from sheets import HEADERS, Sheets, formulas, plan_rows, sold_for
from app import DEFAULTS, Jobs, choose, extract, parse_input, supplier_rules
from suppliers import Pending, contains_part, motion, offer, open_public, public_link, site, smc


class ProtonLifecycle(unittest.TestCase):
    @patch('vpn.subprocess.run')
    def test_only_checks_active_us_profile(self, run):
        run.return_value = CompletedProcess([], 0, 'wireguard:activated:ProtonVPN US-FREE#12\n')
        with proton_connection() as connection:
            connection.require_us()
        for call in run.call_args_list:
            self.assertEqual(call.args[0][-3:], ['connection', 'show', '--active'])

    @patch('vpn.subprocess.run')
    def test_rejects_unconnected_or_non_us_profiles(self, run):
        for profile, reason in [('vpn:activating:ProtonVPN US-FREE#12', 'manualmente'),
                                ('vpn:activated:ProtonVPN NL-FREE#7', 'Estados Unidos')]:
            with self.subTest(profile=profile), self.assertRaisesRegex(Pending, reason):
                run.return_value = CompletedProcess([], 0, profile)
                with proton_connection():
                    self.fail('VPN dos EUA ainda indisponível.')


class BusinessRules(unittest.TestCase):
    def test_extracts_pack_variants_and_exact_part(self):
        self.assertEqual(extract('SMC Y-G04 Pack Of 6, fits 40Mm. Y-G04 Pack Of 6'), ('Y-G04', 6))
        self.assertEqual(extract('SMC Sy5000-27-1N (6Pack)'), ('SY5000-27-1N', 6))
        self.assertEqual(extract('SMC NCQ2B63-25DZ cylinder'), ('NCQ2B63-25DZ', 1))
        self.assertEqual(extract('Cylinder NCQ2B63-25DZ.'), ('NCQ2B63-25DZ', 1))
        self.assertFalse(contains_part('NCQ2B63-25DZ-XC8', 'NCQ2B63-25DZ'))
        with self.assertRaises(Pending):
            extract('SMC Y-G04 KQ2F11-35A')

    def test_keeps_original_price_and_uses_24_percent_target(self):
        self.assertEqual(sold_for(Decimal('80.49'), Decimal(7), Decimal(40)), Decimal('209.00'))

    def test_preference_at_two_point_four_and_stock_for_pack(self):
        rules = DEFAULTS['suppliers']
        motion_offer = offer(rules['motion'], Decimal('2'), 15, 'https://www.motion.com')
        def picks(smc_qty, pack=1):
            smc_offer = offer(rules['smc'], Decimal('2'), smc_qty, 'https://www.smcpneumatics.com')
            return choose({'motion': motion_offer, 'smc': smc_offer}, {'motion': 11, 'smc': 11}, pack)
        self.assertEqual(picks(35).supplier, 'Motion')
        self.assertEqual(picks(36).supplier, 'SMC Pneumatics')
        self.assertEqual(picks(20, 16).supplier, 'SMC Pneumatics')
        self.assertIsNone(picks(20, 21))
        self.assertIsNone(choose({'smc': offer(rules['smc'], Decimal('2'), 10, 'https://www.smcpneumatics.com')},
                                 {'smc': 11}, 1))

    def test_smc_checks_today_then_tomorrow_without_using_similar_items(self):
        part = 'NCQ2B63-25DZ'
        text = ('Part Number: NCQ2B63-25DZ Your Price: $75.90 '
                'Available to Ship Today*: 10 qty Available to Ship Tomorrow*: 12 qty '
                'Close match in stock items 50+ NCQ2B63-15DM')
        with patch('suppliers.request', return_value=text) as fetch:
            stock = smc(DEFAULTS['suppliers']['smc'], part, 1, 'http://127.0.0.1:3128')
            self.assertEqual((stock.timing, stock.handling, stock.user_stock), ('Tomorrow', 7, 12))
            self.assertIn('/NCQ2B63-25DZ.html', fetch.call_args.args[0])
        with patch('suppliers.request', return_value=text.replace('10 qty', '11 qty')):
            stock = smc(DEFAULTS['suppliers']['smc'], part, 10, 'http://127.0.0.1:3128')
            self.assertEqual((stock.timing, stock.handling), ('Today', 6))

    def test_motion_matches_mfr_and_does_not_count_order_quantity(self):
        search = ('<a href="/products/sku/05154238">NCQ2B63-25DZ</a>'
                  '<a href="/products/sku/13866782">NCQ2B63-25DZ-XC8</a>')
        product = 'MFR # NCQ2B63-25DZ $80.49 /each Factory Order QTY 99'
        with patch('suppliers.request', side_effect=[search, product]):
            self.assertIsNone(motion(DEFAULTS['suppliers']['motion'], 'NCQ2B63-25DZ', 1))
        with patch('suppliers.request', side_effect=[search, product.replace('Factory Order QTY 99', '18 in stock')]):
            stock = motion(DEFAULTS['suppliers']['motion'], 'NCQ2B63-25DZ', 1)
            self.assertEqual((stock.user_stock, stock.price), (18, Decimal('80.49')))

    def test_deduplicates_input(self):
        ids = parse_input('ASIN;Title\nB000000001;SMC Y-G04\nB000000001;SMC Y-G04 Pack Of 6')
        self.assertEqual(ids, [{'asin': 'B000000001', 'title': 'SMC Y-G04 Pack Of 6'}])


def product_page(mpn='KQ2H06-01AS', stock=40, price='3.10'):
    level = f',"inventoryLevel":{{"value":{stock}}}' if stock is not None else ''
    return ('<script type="application/ld+json">{"@type":"Product","mpn":"' + mpn + '","offers":'
            '{"price":"' + price + '","priceCurrency":"USD","availability":"https://schema.org/InStock"'
            + level + '}}</script>')


@patch('suppliers.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))])
class SupplierLinks(unittest.TestCase):
    def rules(self, *links):
        return supplier_rules(DEFAULTS, [{'links': list(links), 'shipping': 25, 'handling': 3}])['loja.com']

    def read(self, pages, *links):
        with patch('suppliers.request', side_effect=lambda url, **_: pages[url]):
            return site(self.rules(*links), 'KQ2H06-01AS', 1)

    def test_reads_product_search_and_discovered_search(self, _dns):
        item = 'https://loja.com/p/1'
        found = self.read({item: product_page()}, item)
        self.assertEqual((found.price, found.user_stock, found.shipping, found.handling),
                         (Decimal('3.10'), 40, Decimal(25), 3))
        pages = {'https://loja.com/s?q=KQ2H06-01AS': '<a href="/p/1">Fitting KQ2H06-01AS</a>'
                 '<a href="/p/2">KQ2H06-01AS-X</a><a href="https://outra.com/p/3">KQ2H06-01AS</a>',
                 item: product_page()}
        self.assertEqual(self.read(pages, 'https://loja.com/s?q={part}').link, item)
        pages['https://loja.com/'] = ('<script type="application/ld+json">{"@type":"WebSite","potentialAction":'
                                      '{"@type":"SearchAction","target":"https://loja.com/s?q={search_term_string}"}}</script>')
        self.assertEqual(self.read(pages, 'https://loja.com/').link, item)

    def test_tries_next_link_and_reads_labeled_text(self, _dns):
        pages = {'https://loja.com/a': product_page('OUTRO-1'),
                 'https://loja.com/b': '<p>Part Number: KQ2H06-01AS</p><p>Your Price: $4.00</p><span>18 in stock</span>'}
        found = self.read(pages, *pages)
        self.assertEqual((found.price, found.user_stock), (Decimal('4.00'), 18))
        self.assertIsNone(self.read(pages, 'https://loja.com/a'))

    def test_refuses_what_it_cannot_confirm(self, _dns):
        link = 'https://loja.com/p/1'
        for page, reason in [(product_page(stock=None), 'quantidade'),
                             (product_page().replace('USD', 'BRL'), 'dólar')]:
            with self.subTest(reason=reason), self.assertRaisesRegex(Pending, reason):
                self.read({link: page}, link)

    def test_stock_is_not_guessed_from_prices_or_model_names(self, _dns):
        link = 'https://loja.com/p/1'
        for noise in ('<p>$552.46 In stock</p>', '<p>Arduino Mega 2560 In stock</p>'):
            with self.subTest(noise=noise), self.assertRaisesRegex(Pending, 'quantidade'):
                self.read({link: product_page(stock=None) + noise}, link)
        self.assertEqual(self.read({link: product_page(stock=None) + '<span> 18 in stock </span>'}, link).user_stock, 18)

    def test_groups_links_and_blocks_internal_addresses(self, dns):
        rules = supplier_rules(DEFAULTS, [{'links': ['https://www.motion.com/a', 'https://motion.com/b'],
                                           'shipping': 12.5, 'handling': 2}])
        self.assertEqual((rules['motion']['driver'], rules['motion']['shipping']), ('motion', 12.5))
        for link in ('http://loja.com', 'https://127.0.0.1/', 'https://localhost/', 'https://u:p@loja.com/',
                     'https://loja.com:8080/'):
            with self.subTest(link=link), self.assertRaises(Pending):
                public_link(link)
        with self.assertRaisesRegex(Pending, 'mesmo site'):
            supplier_rules(DEFAULTS, [{'links': ['https://loja.com', 'https://outra.com']}])
        dns.return_value = [(2, 1, 6, '', ('192.168.0.1', 443))]
        with self.assertRaisesRegex(Pending, 'rede interna'):
            open_public('https://loja.com/')


class Homelab(unittest.TestCase):
    @patch('app.subprocess.run')
    def test_supplier_test_runs_on_the_server(self, run):
        with tempfile.TemporaryDirectory() as folder:
            jobs = Jobs(DEFAULTS, Path(folder), worker_host='meu-homelab')
            run.return_value = CompletedProcess([], 0, '{"result": {"found": false}}\n')
            self.assertEqual(jobs.test({'part': 'Y-G04'}), {'found': False})
            self.assertIn('meu-homelab', run.call_args.args[0])
            for reply, reason in [('{"error": "VPN desligada."}\n', 'VPN'), ('', 'conexão')]:
                with self.subTest(reason=reason), self.assertRaisesRegex(Pending, reason):
                    run.return_value = CompletedProcess([], 0, reply)
                    jobs.test({'part': 'Y-G04'})


class SheetsIntegration(unittest.TestCase):
    def setUp(self):
        self.grid = [[''] * 16 for _ in range(3)]
        for col, header in HEADERS.items():
            self.grid[0][col] = header
        self.grid[1][0] = 'B000000001'
        self.grid[1][9] = 7
        for col, options in formulas(2).items():
            self.grid[1][col] = options[0]
        self.item = {'asin': 'B000000001', 'brand': 'SMC', 'part': 'Y-G04', 'pack': 6, 'price': '80.49',
                     'stock': 15, 'supplier': 'Motion', 'handling': 5, 'shipping': '40',
                     'link': 'https://www.motion.com/products/sku/05154238'}

    def test_existing_asin_updates_only_input_fields(self):
        rows, rejected = plan_rows(self.grid, [self.item])
        self.assertEqual(rejected, [])
        _, row, values = rows[0]
        self.assertEqual(row, 2)
        self.assertEqual(values[8], Decimal('80.49'))
        self.assertEqual(values[11], Decimal('209.00'))
        self.assertFalse(set(values).intersection({9, 12, 13, 14, 15}))
        duplicate = self.grid[1].copy()
        self.grid.append(duplicate)
        self.assertEqual(len(plan_rows(self.grid, [self.item])[1]), 1)

    @patch.object(Sheets, 'auth', return_value='test-token')
    @patch('sheets.request')
    def test_checks_written_row_and_actual_margin(self, fetch, _auth):
        import json
        fetch.side_effect = [
            json.dumps({'sheets': [{'properties': {'sheetId': 4, 'title': 'Teste', 'gridProperties': {'rowCount': 10}}}]}),
            json.dumps({'values': self.grid}), '{}',
            json.dumps({'values': [['B000000001', 'SMC', 'Y-G04', 6, 'Motion', 15, 5, 'link', 80.49, 7, 40, 209, 31.35, 50.16, 0.62, .24]]}),
        ]
        rows, rejected = Sheets('/test', 'test', 4).commit([self.item])
        self.assertEqual(rejected, [])
        self.assertEqual((rows[0][1], self.item['margin']), (2, .24))


if __name__ == '__main__':
    unittest.main()
