import json
import tempfile
import unittest
from datetime import datetime,timezone
from pathlib import Path
from market_weather.storage import publish
from market_weather.providers import merge_news,news_item,rss_news,yahoo_quote
NOW=datetime(2026,11,20,8,tzinfo=timezone.utc)
def snap(id,time,status='succeeded'):
    return {'snapshot_id':id,'started_at':time,'modules':{'industry':{'status':status,'data':{'test':True}}}}
class StorageTests(unittest.TestCase):
    def test_old_completion_cannot_replace_newer_run(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertTrue(publish(root,snap('new','2026-11-20T08:00:00+00:00')))
            self.assertFalse(publish(root,snap('old','2026-11-20T07:00:00+00:00')))
            self.assertEqual(json.loads((Path(root)/'latest.json').read_text())['snapshot_id'],'new')
            self.assertTrue((Path(root)/'snapshots/old.json').exists())
    def test_total_failure_retains_latest(self):
        with tempfile.TemporaryDirectory() as root:
            publish(root,snap('good','2026-11-20T07:00:00+00:00'))
            self.assertFalse(publish(root,snap('bad','2026-11-20T08:00:00+00:00','failed')))
            self.assertEqual(json.loads((Path(root)/'latest.json').read_text())['snapshot_id'],'good')
    def test_immutable_snapshot_and_lock(self):
        with tempfile.TemporaryDirectory() as root:
            s=snap('id','2026-11-20T07:00:00+00:00');publish(root,s)
            with self.assertRaises(ValueError):publish(root,s)
            self.assertFalse((Path(root)/'.publish.lock').exists())
            (Path(root)/'.publish.lock').write_text('live')
            with self.assertRaises(FileExistsError):publish(root,snap('other','2026-11-20T08:00:00+00:00'))
class NewsTests(unittest.TestCase):
    def item(self,title='测试新闻',url='https://example.com/news?utm_source=test'):
        return news_item('test',title,url,NOW,published_at=NOW)
    def test_canonical_dedup_preserves_both_sources(self):
        first=self.item();second=self.item(url='https://other.example/news');second['source']='other'
        results=merge_news([first],[second],NOW)
        self.assertEqual(len(results),1)
        self.assertEqual(len(results[0]['sources']),2)
        self.assertNotIn('utm_',first['url'])
    def test_date_precision_no_invented_midnight(self):
        item=news_item('pbc','test','https://example.com/n',NOW,published_date='2026-11-20')
        self.assertIsNone(item['published_at'])
        self.assertEqual(item['date_precision'],'day')
    def test_future_news_rejected(self):
        with self.assertRaises(ValueError):news_item('x','test','https://example.com',NOW,published_at=datetime(2026,11,21,tzinfo=timezone.utc))
    def test_bad_url_rejected(self):
        with self.assertRaises(ValueError):self.item(url='javascript:alert(1)')
    def test_retains_prior_news_and_drops_expired(self):
        previous=self.item('old');previous['published_date']='2026-09-01'
        new=self.item('fresh')
        self.assertEqual([r['title'] for r in merge_news([previous],[new],NOW)],['fresh'])
    def test_malformed_rss_fails_not_empty_success(self):
        class F:
            def get(self,*args):return b'<rss><channel><item><title>Undated</title></item></channel></rss>'
        with self.assertRaises(ValueError):rss_news(F(),'x','https://example.com',NOW)
    def test_yield_changes_are_basis_points(self):
        class F:
            def json(self,*args):return {'chart':{'result':[{'meta':{'regularMarketTime':int(datetime(2026,11,19,21,tzinfo=timezone.utc).timestamp()),'regularMarketPrice':4.2,'exchangeTimezoneName':'America/New_York','currency':'USD'},'timestamp':[int(datetime(2026,11,18,21,tzinfo=timezone.utc).timestamp())],'indicators':{'quote':[{'close':[4.1]}]}}]}}
        result=yahoo_quote(F(),'^TNX','yield','yield',NOW)
        self.assertAlmostEqual(result['change_bp'],10)
        self.assertIsNone(result['change_vs_previous_day_close_pct'])
if __name__=='__main__':unittest.main()
