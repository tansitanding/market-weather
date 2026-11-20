"""Small explicit public-source adapters. TLS verification remains enabled."""
import hashlib
import html
import json
import re
import ssl
import time
import threading
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, time as dtime
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from .metrics import validate_bars, number
from .news import OFFICIAL

CST = ZoneInfo('Asia/Shanghai')
SW_BASE = 'https://www.swsresearch.com/institute-sw/api/index_publish/'
SOURCES = {
    'sina': {'name':'新浪财经报价池','url':'https://finance.sina.com.cn/','redistribution':'unverified'},
    'sw': {'name': '申万宏源研究', 'url': 'https://www.swsresearch.com/institute_sw/allIndex/releasedIndex', 'redistribution': 'unverified'},
    'eastmoney': {'name': '东方财富', 'url': 'https://quote.eastmoney.com/zs000300.html', 'redistribution': 'unverified'},
    'yahoo': {'name': 'Yahoo Finance', 'url': 'https://finance.yahoo.com/', 'redistribution': 'unverified'},
    'fed': {'name': 'Federal Reserve', 'url': 'https://www.federalreserve.gov/feeds/feeds.htm', 'redistribution': 'headline_and_link_reviewed'},
    'pbc': {'name': '中国人民银行', 'url': 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html', 'redistribution': 'headline_and_link_pending_review'},
    'cns': {'name': '中国新闻网', 'url': 'https://www.chinanews.com.cn/rss/', 'redistribution': 'unverified'},
}


class Fetcher:
    def __init__(self, root, timeout=15, attempts=2, replay=None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.timeout, self.attempts, self.replay = timeout, attempts, Path(replay) if replay else None
        self._rate_lock = threading.Lock()
        self._host_next = {}

    def _context(self, host):
        if host != 'www.swsresearch.com':
            return None
        # The server omits its DigiCert intermediate. Keep hostname checks and
        # require a chain ending in a system-trusted root.
        context = ssl.create_default_context()
        context.verify_flags &= ~getattr(ssl, 'VERIFY_X509_PARTIAL_CHAIN', 0)
        context.load_verify_locations(
            Path(__file__).resolve().parents[2] / 'config/sw-geotrust-intermediate.pem'
        )
        return context

    def get(self, key, url):
        path = self.root / (key + '.raw')
        if self.replay:
            data = (self.replay / (key + '.raw')).read_bytes()
            path.write_bytes(data)
            return data
        error = None
        for attempt in range(self.attempts):
            try:
                host=urllib.parse.urlsplit(url).netloc
                with self._rate_lock:
                    delay=max(0,self._host_next.get(host,0)-time.monotonic())
                    if delay:time.sleep(delay)
                    self._host_next[host]=time.monotonic()+.4
                request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (MarketWeather research prototype)', 'Accept': '*/*', **({'Referer':'https://finance.sina.com.cn/'} if 'sina' in host else {})})
                with urllib.request.urlopen(request, timeout=self.timeout, context=self._context(host)) as response:
                    data = response.read(10_000_001)
                    if len(data) > 10_000_000:
                        raise ValueError('response exceeds 10 MB')
                path.write_bytes(data)
                return data
            except (OSError, urllib.error.URLError) as exc:
                error = exc
                if attempt + 1 < self.attempts:
                    time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(type(error).__name__ + ': ' + str(error))

    def json(self, key, url):
        return json.loads(self.get(key, url))


def sw_universe(fetch):
    url = SW_BASE + 'current/?' + urllib.parse.urlencode({'page': 1, 'page_size': 50, 'indextype': '一级行业'})
    data = fetch.json('sw_universe', url)['data']
    rows = data['results']
    if data['count'] != 31 or len(rows) != 31 or len({r['swindexcode'] for r in rows}) != 31:
        raise ValueError('expected 31 distinct SW level-1 industries')
    return [{'code': r['swindexcode'], 'name': r['swindexname']} for r in rows]


def completed_cn(rows, now):
    local = now.astimezone(CST)
    # No unfinished intraday bar is treated as a daily close. Publication can lag.
    return [r for r in validate_bars(rows) if r['date'] < local.date().isoformat() or (r['date'] == local.date().isoformat() and local.time() >= dtime(15, 10))]


def sw_history(fetch, code, now):
    data = fetch.json('sw_' + code, SW_BASE + 'trend/?' + urllib.parse.urlencode({'swindexcode': code, 'period': 'DAY'}))
    rows = [{'date': r['bargaindate'][:10], 'close': r['closeindex'], 'amount': r['bargainsum']} for r in data['data']]
    return completed_cn(rows, now)[-180:]


def cn_history(fetch, code, now):
    params = {'secid': ('0.' if code == '399006' else '1.') + code, 'klt': 101, 'fqt': 0, 'end': '20500101',
              'lmt': 180, 'fields1': 'f1,f2,f3,f4,f5,f6', 'fields2': 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'}
    data = fetch.json('em_' + code, 'https://push2his.eastmoney.com/api/qt/stock/kline/get?' + urllib.parse.urlencode(params))
    rows = []
    for line in data['data']['klines']:
        v = line.split(',')
        rows.append({'date': v[0], 'close': v[2], 'amount': v[6]})
    rows = completed_cn(rows, now)[-180:]
    if not rows:
        raise ValueError('no completed Chinese sessions')
    return rows


def growth_index_history(fetch, now):
    try:
        return cn_history(fetch, '399006', now)
    except (RuntimeError, ValueError, KeyError, TypeError):
        url = ('https://quotes.sina.cn/cn/api/jsonp_v2.php/var=/'
               'CN_MarketDataService.getKLineData?symbol=sz399006&scale=240&ma=no&datalen=12')
        payload = fetch.get('sina_sz399006', url).decode('utf-8').strip()
        match = re.search(r'var=\((\[.*\])\);$', payload, re.S)
        if not match:
            raise ValueError('创业板备用数据格式无效')
        rows = [{'date': r['day'], 'close': r['close'], 'amount': None}
                for r in json.loads(match[1])]
        rows = completed_cn(rows, now)
        if len(rows) < 2:
            raise ValueError('创业板收盘数据不足')
        return rows


def yahoo_quote(fetch, symbol, name, asset_type, now):
    url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + urllib.parse.quote(symbol, safe='') + '?range=6mo&interval=1d'
    data = fetch.json('yahoo_' + re.sub(r'[^a-zA-Z0-9]', '_', symbol), url)
    result = data['chart']['result'][0]
    meta = result['meta']
    timestamp = int(meta['regularMarketTime'])
    observed = datetime.fromtimestamp(timestamp, timezone.utc)
    if observed > now:
        raise ValueError('future quote timestamp')
    exchange_zone = ZoneInfo(meta['exchangeTimezoneName'])
    day = observed.astimezone(exchange_zone).date().isoformat()
    price = number(meta['regularMarketPrice'], positive=True)
    quotes = result['indicators']['quote'][0]
    closes = []
    for ts, close in zip(result.get('timestamp', []), quotes.get('close', [])):
        if close is None:
            continue
        dt = datetime.fromtimestamp(ts, timezone.utc)
        # Previous local-day close only: current daily bar may be unfinished.
        if dt.astimezone(exchange_zone).date().isoformat() < day:
            closes.append((dt, number(close, positive=True)))
    prior = closes[-1][1] if closes else None
    return {'symbol': symbol, 'name': name, 'asset_type': asset_type, 'price': price,
            'unit': 'percent_yield' if symbol == '^TNX' else ('index_points' if asset_type == 'index' else meta.get('currency')),
            'currency': meta.get('currency'), 'market_date': day, 'observed_at': observed.isoformat(),
            'exchange_timezone': meta['exchangeTimezoneName'], 'source': 'yahoo',
            'change_vs_previous_day_close_pct': None if prior is None or symbol == '^TNX' else round((price / prior - 1) * 100, 6), 'change_bp': round((price - prior) * 100, 6) if prior is not None and symbol == '^TNX' else None,
            'change_unit': 'bp' if symbol == '^TNX' else 'percent', 'availability': 'latest_available_observation',
            'age_hours': round((now - observed).total_seconds() / 3600, 3),
            'source_session': meta.get('currentTradingPeriod'), 'is_live_guaranteed': False}


def normalize_title(title):
    return re.sub(r'\W+', '', html.unescape(title)).lower()


def news_item(source, title, url, now, published_at=None, published_date=None):
    title = html.unescape(re.sub('<[^>]+>', '', title)).strip()
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ('https', 'http') or not u.netloc or not title:
        raise ValueError('invalid news metadata')
    query = [(k, v) for k, v in urllib.parse.parse_qsl(u.query) if not k.startswith('utm_')]
    url = urllib.parse.urlunsplit((u.scheme, u.netloc.lower(), u.path, urllib.parse.urlencode(query), ''))
    key = hashlib.sha256(normalize_title(title).encode()).hexdigest()[:20]
    if published_at is not None:
        published_at = published_at.astimezone(timezone.utc)
        if published_at > now:
            raise ValueError('future news publication')
        published_date = published_at.astimezone(CST).date().isoformat()
    if not published_date:
        raise ValueError('news publication date missing')
    return {'event_id': key, 'title': title, 'source': source, 'url': url,
            'published_at': published_at.isoformat() if published_at else None,
            'published_date': published_date, 'date_precision': 'second' if published_at else 'day',
            'event_occurred_at': None, 'collected_at': now.isoformat(),
            'sources': [{'source': source, 'url': url}], 'analysis': None,
            'dedup_method': 'exact_normalized_title', 'revision_hash': hashlib.sha256((title + url).encode()).hexdigest()[:20]}


def rss_news(fetch, source, url, now):
    root = ET.fromstring(fetch.get('news_' + source, url))
    results, excluded = [], 0
    for item in root.findall('.//item'):
        try:
            published = parsedate_to_datetime(item.findtext('pubDate') or '')
            if published.tzinfo is None:
                raise ValueError('timezone missing')
            results.append(news_item(source, item.findtext('title') or '', item.findtext('link') or '', now, published_at=published))
        except (ValueError, TypeError, OverflowError):
            excluded += 1
    if not results:
        raise ValueError('no dated RSS entries')
    return results, excluded


def pbc_news(fetch, now):
    text = fetch.get('news_pbc', SOURCES['pbc']['url']).decode('utf-8')
    pattern = r'<a\b(?P<attrs>[^>]*\bistitle="true"[^>]*)>(?P<text>.*?)</a>.*?<span[^>]*>(?P<date>\d{4}-\d{2}-\d{2})</span>'
    results = []
    for m in re.finditer(pattern, text, re.S):
        attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', m['attrs']))
        if m['date'] > now.astimezone(CST).date().isoformat():
            continue
        url = urllib.parse.urljoin(SOURCES['pbc']['url'], attrs.get('href', ''))
        results.append(news_item('pbc', attrs.get('title') or m['text'], url, now, published_date=m['date']))
    if not results:
        raise ValueError('PBC list structure changed or no dated entries')
    return results, 0


def merge_news(previous, incoming, now, retention_days=30):
    merged = {(r['event_id'], r['published_date']): dict(r) for r in previous}
    for item in incoming:
        key = (item['event_id'], item['published_date'])
        old = merged.get(key)
        if old:
            origins = {(s['source'], s['url']): s for s in old.get('sources', []) + item['sources']}
            primary = old if old['source'] in OFFICIAL and item['source'] not in OFFICIAL else item
            item = dict(primary, sources=list(origins.values()),
                        related_sources=old.get('related_sources', []),
                        first_seen_at=old.get('first_seen_at', old['collected_at']))
            revisions = list(old.get('revisions', []))
            if old.get('revision_hash') != item['revision_hash']:
                revisions.append({'revision_hash': old.get('revision_hash'), 'collected_at': old['collected_at'], 'title': old['title']})
            item['revisions'] = revisions
        else:
            item = dict(item, first_seen_at=item['collected_at'], revisions=[])
        merged[key] = item
    today = now.astimezone(CST).date()
    results = [r for r in merged.values() if 0 <= (today - datetime.fromisoformat(r['published_date']).date()).days <= retention_days]
    return sorted(results, key=lambda r: (r['published_date'], r['published_at'] or '', r['event_id']), reverse=True)


def _market_universe_em(fetch, now):
    """EM paginates at 100 rows even when a larger page size is requested."""
    from collections import Counter
    from concurrent.futures import ThreadPoolExecutor
    base = 'https://push2.eastmoney.com/api/qt/clist/get?'
    params = {'pn': 1, 'pz': 100, 'po': 1, 'np': 1, 'fltt': 2, 'invt': 2, 'fid': 'f12',
              'fs': 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048',
              'fields': 'f2,f3,f6,f12,f13,f14,f124'}
    def page(n):
        return fetch.json('market_page_%d' % n, base + urllib.parse.urlencode(dict(params, pn=n)))['data']
    first = page(1)
    total = int(first['total'])
    if not 100 <= total <= 10000:
        raise ValueError('unexpected A-share universe size')
    rows = list(first['diff'])
    with ThreadPoolExecutor(max_workers=2) as pool:
        for data in pool.map(page, range(2, (total + 99) // 100 + 1)):
            rows.extend(data['diff'])
    seen, valid = set(), []
    for r in rows:
        identity = (str(r.get('f13')), str(r.get('f12')))
        if identity in seen:
            raise ValueError('duplicate security across market pages')
        seen.add(identity)
        try:
            price = number(r['f2'], positive=True)
            change = number(r['f3'])
            amount = number(r['f6'])
            observed = datetime.fromtimestamp(int(r['f124']), timezone.utc)
            if observed > now or amount <= 0:
                continue
            valid.append({'code': str(r['f12']), 'market': int(r['f13']), 'name': r['f14'],
                          'price': price, 'change_pct': change, 'amount': amount,
                          'date': observed.astimezone(CST).date().isoformat(), 'observed_at': observed.isoformat()})
        except (ValueError, TypeError, KeyError, OverflowError):
            continue
    if len(seen) < total * .98 or not valid:
        raise ValueError('market pagination incomplete')
    trade_date = Counter(r['date'] for r in valid).most_common(1)[0][0]
    current = [r for r in valid if r['date'] == trade_date]
    if len(current) < total * .85:
        raise ValueError('market breadth coverage below 85%')
    return {'as_of_date': trade_date, 'expected_count': total, 'valid_count': len(current),
            'advancing': sum(r['change_pct'] > 0 for r in current),
            'declining': sum(r['change_pct'] < 0 for r in current),
            'unchanged': sum(r['change_pct'] == 0 for r in current), 'securities': current,
            'source': 'eastmoney', 'collected_at': now.isoformat()}


def sw_components(fetch, industry_code):
    data = fetch.json('components_' + industry_code, SW_BASE + 'details/component_stocks/?' + urllib.parse.urlencode(
        {'swindexcode': industry_code, 'page': 1, 'page_size': 10000}))['data']
    rows = data['results']
    if len(rows) != data['count']:
        raise ValueError('industry components incomplete')
    return [{'code': r['stockcode'], 'name': r['stockname']} for r in rows]


def stock_history(fetch, security, now):
    params = {'secid': str(security['market']) + '.' + security['code'], 'klt': 101, 'fqt': 1,
              'end': '20500101', 'lmt': 180,
              'fields1': 'f1,f2,f3,f4,f5,f6', 'fields2': 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'}
    data = fetch.json('stock_' + security['code'], 'https://push2his.eastmoney.com/api/qt/stock/kline/get?' + urllib.parse.urlencode(params))['data']
    rows = []
    for line in data['klines']:
        v = line.split(',')
        values = [number(x, positive=True) for x in v[1:5]]
        if values[2] < max(values[0], values[1]) or values[3] > min(values[0], values[1]):
            raise ValueError('OHLC range invalid')
        rows.append({'date': v[0], 'open': values[0], 'close': values[1], 'high': values[2], 'low': values[3], 'amount': number(v[6])})
    return completed_cn(rows, now)[-180:]


def market_universe(fetch, now):
    from concurrent.futures import ThreadPoolExecutor
    source='https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/'
    index=fetch.get('sina_breadth_date','https://hq.sinajs.cn/list=sh000001').decode('gb18030')
    match=re.search(r',([0-9]{4}-[0-9]{2}-[0-9]{2}),([0-9]{2}:[0-9]{2}:[0-9]{2}),',index)
    if not match:raise ValueError('Sina quote date unavailable')
    trade_date=match[1]
    total=int(fetch.json('sina_universe_count',source+'Market_Center.getHQNodeStockCount?node=hs_a'))
    if not 100<=total<=10000:raise ValueError('unexpected Sina universe size')
    def page(n):
        return fetch.json('sina_market_%d'%n,source+'Market_Center.getHQNodeData?'+urllib.parse.urlencode({'node':'hs_a','sort':'symbol','asc':1,'page':n,'num':100}))
    rows=[]
    with ThreadPoolExecutor(max_workers=2)as pool:
        for batch in pool.map(page,range(1,(total+99)//100+1)):
            if not isinstance(batch,list):raise ValueError('Sina market page invalid')
            rows.extend(batch)
    if len({r['symbol'] for r in rows})!=len(rows) or len(rows)<total*.98:raise ValueError('Sina pagination incomplete')
    valid=[]
    for r in rows:
        try:
            price=number(r['trade'],positive=True);change=number(r['changepercent']);amount=number(r['amount'])
            if amount<=0:continue
            observed=datetime.fromisoformat(trade_date+'T'+r['ticktime']+'+08:00')
            if observed>now:continue
            valid.append({'code':r['code'],'market':1 if r['symbol'].startswith('sh')else 0,'name':r['name'],'price':price,'change_pct':change,'amount':amount,'date':trade_date,'observed_at':observed.isoformat()})
        except(ValueError,TypeError,KeyError):continue
    if len(valid)<total*.85:raise ValueError('Sina breadth coverage below 85%')
    return {'as_of_date':trade_date,'expected_count':total,'valid_count':len(valid),'advancing':sum(r['change_pct']>0 for r in valid),'declining':sum(r['change_pct']<0 for r in valid),'unchanged':sum(r['change_pct']==0 for r in valid),'completed_session':match[2]>='15:00:00','securities':valid,'source':'sina','collected_at':now.isoformat()}
