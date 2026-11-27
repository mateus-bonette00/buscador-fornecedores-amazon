import unittest
from decimal import Decimal
from subprocess import CompletedProcess
from unittest.mock import patch

from vpn import proton_connection
from sheets import HEADERS, Sheets, formulas, plan_rows, sold_for
from app import DEFAULTS, choose, extract, parse_input
from suppliers import Pending, contains_part, motion, offer, smc


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
