import copy,json,tempfile,unittest
from pathlib import Path
from datetime import datetime,timezone
from market_weather.analysis import temperature, stock_card, track_signals, industry_research
from market_weather.calendar import cn_sessions
from market_weather.export import export_snapshot
DAYS=cn_sessions('2026-07-01','2026-09-23')
def bars():
 return [dict(date=d,open=100+i*.2,close=100+i*.2,high=101+i*.2,low=99+i*.2,amount=200_000_000) for i,d in enumerate(DAYS)]
def card():
 return dict(code='600000',name='测试',signal_date=DAYS[31],published_at='2026-08-14T08:00:00+00:00',reference_close=bars()[31]['close'],trigger_price=100,amount_trigger=1,atr14=1,conditions_met=True)
class AnalysisTests(unittest.TestCase):
 def test_temperature_same_completed_day_and_bounded_components(self):
  b=bars();breadth=dict(as_of_date=DAYS[-1],advancing=300,valid_count=500)
  t=temperature(b,breadth)
  self.assertAlmostEqual(sum(c['weight'] for c in t['components']),1)
  self.assertTrue(0<=t['score']<=100)
  for patch in [dict(as_of_date=DAYS[-2]),dict(completed_session=False)]:
   with self.assertRaises(ValueError):temperature(b,dict(breadth,**patch))
  with self.assertRaises(ValueError):temperature(b[:-2]+b[-1:],breadth)
 def test_stock_missing_session_or_low_liquidity_never_selected(self):
  b=bars();sec=dict(code='600000',name='测试',market=1);now=datetime.now(timezone.utc)
  self.assertIsNotNone(stock_card(sec,b,b,'测试行业',now))
  missing=b[:-5]+b[-4:]
  self.assertIsNone(stock_card(sec,missing,b,'测试行业',now))
  self.assertIsNone(stock_card(sec,[dict(r,amount=100) for r in b],b,'行业',now))
 def test_gap_over_three_percent_cancels(self):
  b=bars();b[32]=dict(b[32],open=b[31]['close']*1.04)
  r=track_signals([], [card()],{'600000':b},b)[0]
  self.assertEqual(r['status'],'cancelled')
 def test_tracking_cost_benchmark_and_no_mutation(self):
  b=bars();r=track_signals([], [card()],{'600000':b[:35]},b[:35]);original=copy.deepcopy(r)
  done=track_signals(r,[],{'600000':b},b)[0]
  self.assertEqual(r,original)
  self.assertEqual(done['status'],'completed')
  self.assertEqual(set(done['horizons']),{'5','10','20'})
  self.assertAlmostEqual(done['horizons']['5']['net_return_pct'],round((b[36]['close']/b[32]['open']-1)*100-.1,4))
  self.assertIsNotNone(done['horizons']['5']['benchmark_return_pct'])
 def test_t_plus_one_no_same_day_stop(self):
  b=bars();b[32]=dict(b[32],low=1)
  r=track_signals([], [card()],{'600000':b},b)[0]
  self.assertEqual(r['horizons']['5']['exit_reason'],'窗口收盘')
 def test_adjustment_change_suspends_statistics(self):
  b=bars();c=card();b[31]=dict(b[31],close=b[31]['close']*.9)
  r=track_signals([], [c],{'600000':b},b)[0]
  self.assertEqual(r['status'],'adjustment_changed')
 def test_watch_cannot_confirm_after_twenty_sessions(self):
  b=bars();c=card();c.update(conditions_met=False,trigger_price=999)
  b[55]=dict(b[55],close=1000)
  r=track_signals([], [c],{'600000':b},b)[0]
  self.assertEqual(r['status'],'expired')
 def test_export_removes_raw_and_retains_derived_comparison(self):
  b=bars();x=dict(rule_version='test',calendar={},evidence={},modules=dict(cn_market=dict(data=dict(benchmark=b,indices={})),industry=dict(data=dict(window_start=DAYS[-31],as_of_date=DAYS[-1],benchmark={}))))
  with tempfile.TemporaryDirectory() as d:
   out=export_snapshot(x,d)
   self.assertEqual(len(out['modules']['cn_market']['data']['benchmark']),2)
   self.assertEqual(len(out['modules']['industry']['data']['benchmark']['series']),31)
   self.assertNotIn('evidence',out)
   self.assertEqual(len(x['modules']['cn_market']['data']['benchmark']),len(b))
