"""Small explicit public-source adapters. TLS verification remains enabled."""
import hashlib
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, time as dtime
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from .metrics import validate_bars, number

CST = ZoneInfo('Asia/Shanghai')
SW_BASE = 'https://www.swsresearch.com/institute-sw/api/index_publish/'
SOURCES = {
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

    def get(self, key, url):
        path = self.root / (key + '.raw')
        if self.replay:
            data = (self.replay / (key + '.raw')).read_bytes()
            path.write_bytes(data)
            return data
        error = None
        for attempt in range(self.attempts):
            try:
                request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (MarketWeather research prototype)', 'Accept': '*/*'})
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    data = response.read(10_000_001)
                    if len(data) > 10_000_000:
                        raise ValueError('response exceeds 10 MB')
                path.write_bytes(data)
                return data
            except (OSError, urllib.error.URLError) as exc:
                error = exc
                if attempt + 1 < self.attempts:
                    time.sleep(0.5 * (attempt + 1))
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
    params = {'secid': '1.' + code, 'klt': 101, 'fqt': 0, 'beg': '20250101', 'end': now.astimezone(CST).strftime('%Y%m%d'),
              'lmt': 180, 'fields1': 'f1,f2,f3,f4,f5,f6', 'fields2': 'f51,f52,f53,f54,f55,f56,f57'}
    data = fetch.json('em_' + code, 'https://push2his.eastmoney.com/api/qt/stock/kline/get?' + urllib.parse.urlencode(params))
    rows = []
    for line in data['data']['klines']:
        v = line.split(',')
        rows.append({'date': v[0], 'close': v[2], 'amount': v[6]})
    rows = completed_cn(rows, now)[-180:]
    if not rows:
        raise ValueError('no completed Chinese sessions')
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
    merged = {r['event_id']: dict(r) for r in previous}
    for item in incoming:
        old = merged.get(item['event_id'])
        if old:
            origins = {(s['source'], s['url']): s for s in old.get('sources', []) + item['sources']}
            item = dict(item, sources=list(origins.values()), first_seen_at=old.get('first_seen_at', old['collected_at']))
            revisions = list(old.get('revisions', []))
            if old.get('revision_hash') != item['revision_hash']:
                revisions.append({'revision_hash': old.get('revision_hash'), 'collected_at': old['collected_at'], 'title': old['title']})
            item['revisions'] = revisions
        else:
            item = dict(item, first_seen_at=item['collected_at'], revisions=[])
        merged[item['event_id']] = item
    today = now.astimezone(CST).date()
    results = [r for r in merged.values() if 0 <= (today - datetime.fromisoformat(r['published_date']).date()).days <= retention_days]
    return sorted(results, key=lambda r: (r['published_date'], r['published_at'] or '', r['event_id']), reverse=True)
