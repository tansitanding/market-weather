import unittest
from datetime import datetime, timezone
from market_weather.metrics import rank_industries, validate_bars, recover_daily_returns
from market_weather.calendar import cn_sessions, is_cn_session
from market_weather.providers import completed_cn

DAYS = cn_sessions('2026-08-03', '2026-09-23')[-31:]

def bars(mult=1, amount=100):
    return [{'date': d, 'close': 100 + i * mult, 'amount': amount} for i, d in enumerate(DAYS)]

def universe():
    return {'A': {'name': 'A', 'bars': bars(1, 100)}, 'B': {'name': 'B', 'bars': bars(2, 200)}}

class MetricsTests(unittest.TestCase):
    def test_exact_30_intervals_not_30_observations(self):
        value = rank_industries(universe(), bars(0), expected_count=2)
        self.assertAlmostEqual(value['industries'][0]['return_30d_pct'], 60)
        self.assertEqual(value['return_intervals'], 30)
        self.assertEqual(value['window_start'], DAYS[0])

    def test_excess_pp_and_five_day_endpoint(self):
        result = rank_industries(universe(), bars(.5), 2)
        first = result['industries'][0]
        self.assertAlmostEqual(first['excess_30d_pp'], 45)
        self.assertAlmostEqual(first['return_5d_pct'], (160/150-1)*100, places=5)

    def test_heat_fixed_denominator_and_rising(self):
        u = universe()
        for row in u['A']['bars'][-5:]: row['amount'] = 300
        result = rank_industries(u, bars(0), 2)
        a = next(r for r in result['industries'] if r['code'] == 'A')
        self.assertAlmostEqual(a['heat_rising_5v25_pct'], 80)
        total = sum(r['transaction_heat_30d_share_pct'] for r in result['industries'])
        self.assertAlmostEqual(total, 100, places=5)

    def test_daily_returns_never_bridge_a_missing_close(self):
        u = universe()
        del u['A']['bars'][10]
        days = rank_industries(u, bars(0), 2)['daily_returns']
        self.assertEqual([d['date'] for d in days], DAYS[1:])
        self.assertEqual([r['code'] for r in days[9]['rows']], ['B'])
        self.assertEqual([r['code'] for r in days[10]['rows']], ['B'])
        self.assertEqual([r['code'] for r in days[11]['rows']], ['B', 'A'])

    def test_recover_daily_from_public_curve_preserves_gaps(self):
        u = universe()
        del u['A']['bars'][10]
        industry = rank_industries(u, bars(0), 2)
        recovered = recover_daily_returns(industry, DAYS[-1])
        self.assertEqual(len(recovered), 30)
        for original, fallback in zip(industry['daily_returns'], recovered):
            self.assertEqual(original['date'], fallback['date'])
            self.assertEqual([r['code'] for r in original['rows']], [r['code'] for r in fallback['rows']])
            for a, b in zip(original['rows'], fallback['rows']):
                self.assertAlmostEqual(a['change_pct'], b['change_pct'], places=5)

    def test_missing_industry_never_reweights_heat(self):
        result = rank_industries({'A': universe()['A']}, bars(0), 2)
        self.assertEqual(result['heat_status'], 'unavailable')
        self.assertEqual(result['rankings']['transaction_heat_top'], [])

    def test_missing_internal_day_preserves_endpoint_return_but_not_drawdown(self):
        u = universe(); del u['A']['bars'][10]
        result = rank_industries(u, bars(0), 2)
        a = next(r for r in result['industries'] if r['code']=='A')
        self.assertEqual(a['return_30d_pct'], 30)
        self.assertIsNone(a['max_drawdown_30d_pct'])
        self.assertEqual(result['heat_reason'], 'missing_official_trading_sessions')
        self.assertIn(DAYS[10], a['missing_session_dates'])

    def test_missing_benchmark_session_rejected(self):
        bm = bars(0); del bm[15]
        with self.assertRaises(ValueError): rank_industries(universe(), bm, 2)

    def test_zero_amount_disables_heat_not_returns(self):
        u=universe(); u['A']['bars'][-1]['amount']=0
        result=rank_industries(u,bars(0),2)
        self.assertEqual(len(result['rankings']['return_top']),2)
        self.assertEqual(result['heat_status'],'unavailable')

    def test_nonfinite_price_rejected(self):
        for bad in [float('nan'),float('inf'),-1,0,True]:
            with self.assertRaises(ValueError): validate_bars([{'date':DAYS[0],'close':bad}])

    def test_conflicting_duplicate_rejected(self):
        with self.assertRaises(ValueError): validate_bars([{'date':DAYS[0],'close':1},{'date':DAYS[0],'close':2}])

    def test_intraday_bar_excluded(self):
        now=datetime(2026,11,20,3,45,tzinfo=timezone.utc)
        result=completed_cn([{'date':'2026-11-19','close':1},{'date':'2026-11-20','close':2}],now)
        self.assertEqual(len(result),1)

    def test_official_holiday_and_unknown_year(self):
        self.assertFalse(is_cn_session('2026-10-01'))
        self.assertFalse(is_cn_session('2026-10-10'))
        self.assertTrue(is_cn_session('2026-10-08'))
        with self.assertRaises(ValueError): is_cn_session('2027-01-04')

if __name__ == '__main__': unittest.main()
