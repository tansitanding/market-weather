"""CLI: collect -> validate -> compute -> immutable local snapshot -> report."""
import argparse
import hashlib
import json
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from .metrics import rank_industries, recover_daily_returns
from .providers import (CST, SOURCES, Fetcher, sw_universe, sw_history, cn_history, growth_index_history,
                        yahoo_quote, shanghai_etf_quote, rss_news, pbc_news, merge_news)
from .storage import atomic_json, publish
from .news import curate_news
from .analysis import temperature, macro_review, industry_research, stock_card, track_signals, investment_plan, RULE
from .providers import market_universe, sw_components, stock_history

GLOBAL = [
    ('^GSPC', '标普500', 'index'), ('^IXIC', '纳斯达克综合', 'index'),
    ('^DJI', '道琼斯工业', 'index'), ('^HSI', '恒生指数', 'index'),
    ('HSTECH.HK', '恒生科技', 'index'), ('DX-Y.NYB', '美元指数', 'index'),
    ('^TNX', '美国10年期国债收益率', 'yield'), ('GC=F', '黄金期货连续', 'continuous_futures'),
    ('CL=F', 'WTI原油期货连续', 'continuous_futures'),
]

SHANGHAI_ETFS = [
    ('510300', '沪深300ETF华泰柏瑞', 'equity_etf'),
    ('510500', '中证500ETF南方', 'equity_etf'),
    ('511010', '国泰上证5年期国债ETF', 'bond_etf'),
]


def guarded(fn):
    try:
        return {'status': 'succeeded', 'data': fn()}
    except Exception as e:
        return {'status': 'failed', 'error': {'code': type(e).__name__, 'message': str(e)[:300]}}


def collect(root, now=None, replay=None, settings=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError('collection time must include timezone')
    root = Path(root)
    settings = settings or json.loads((Path(__file__).resolve().parents[2] / 'config/settings.json').read_text())
    run_id = now.strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:8]
    raw_dir = root / 'runs' / run_id / 'raw'
    fetch = Fetcher(raw_dir, settings['provider_timeout_seconds'], settings['provider_attempts'], replay=replay)
    prior_path = root / 'latest.json'
    prior = json.loads(prior_path.read_text()) if prior_path.exists() else {'modules': {}}
    evidence = {}
    tracking_path = root / 'tracking.json'
    previous_tracking = json.loads(tracking_path.read_text()) if tracking_path.exists() else []
    universe = guarded(lambda: sw_universe(fetch))
    evidence['sw_universe'] = {k: v for k, v in universe.items() if k != 'data'}
    histories, quotes = {}, []
    jobs = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs[pool.submit(guarded, lambda: market_universe(fetch, now))] = ('breadth', 'all', None)
        jobs[pool.submit(guarded, lambda: cn_history(fetch, '000300', now))] = ('benchmark', '000300', None)
        jobs[pool.submit(guarded, lambda: cn_history(fetch, '000001', now))] = ('cn_index', '000001', None)
        jobs[pool.submit(guarded, lambda: growth_index_history(fetch, now))] = ('cn_index', '399006', None)
        for industry in universe.get('data', []):
            code, name = industry['code'], industry['name']
            jobs[pool.submit(guarded, lambda c=code: sw_history(fetch, c, now))] = ('industry', code, name)
        for symbol, name, kind in GLOBAL:
            jobs[pool.submit(guarded, lambda s=symbol,n=name,k=kind: yahoo_quote(fetch, s, n, k, now))] = ('global', symbol, None)
        for code, name, kind in SHANGHAI_ETFS:
            future = pool.submit(guarded, lambda c=code,n=name,k=kind: shanghai_etf_quote(fetch, c, n, k, now))
            jobs[future] = ('global', code + '.SS', None)
        news_jobs = [
            ('fed', lambda: rss_news(fetch, 'fed', 'https://www.federalreserve.gov/feeds/press_all.xml', now)),
            ('cns', lambda: rss_news(fetch, 'cns', 'https://www.chinanews.com.cn/rss/finance.xml', now)),
            ('pbc', lambda: pbc_news(fetch, now)),
        ]
        for source, call in news_jobs:
            jobs[pool.submit(guarded, call)] = ('news', source, None)
        benchmark, cn_indices, incoming, breadth = [], {}, [], None
        source_news_count = {}
        for future in as_completed(jobs):
            result = future.result()
            kind, key, name = jobs[future]
            evidence[kind + ':' + key] = {k: v for k, v in result.items() if k != 'data'}
            if result['status'] != 'succeeded':
                continue
            data = result['data']
            if kind == 'breadth':
                breadth = data
            elif kind == 'industry':
                histories[key] = {'name': name, 'bars': data}
            elif kind == 'benchmark':
                benchmark = data
            elif kind == 'cn_index':
                cn_indices[key] = data
            elif kind == 'global':
                quotes.append(data)
            elif kind == 'news':
                incoming.extend(data[0])
                source_news_count[key] = {'parsed': len(data[0]), 'excluded': data[1]}
    industry = guarded(lambda: rank_industries(histories, benchmark, settings['industry_expected_count']))
    modules = {}
    if industry['status'] == 'succeeded':
        value = industry['data']
        age = (now.astimezone(CST).date() - datetime.fromisoformat(value['as_of_date']).date()).days
        value['age_calendar_days'] = age
        value['freshness'] = 'stale' if age > 7 else ('lags_benchmark' if value['industry_latest_lags_benchmark'] else 'latest_available')
        modules['industry'] = {'status': 'partial' if value['status'] == 'partial' or age > 7 or value['industry_latest_lags_benchmark'] else 'succeeded',
                               'source_as_of_date': value['as_of_date'], 'collected_at': now.isoformat(), 'data': value, 'carried_forward': False}
    else:
        modules['industry'] = industry
    if benchmark:
        previous_indices = prior['modules'].get('cn_market', {}).get('data', {}).get('indices', {})
        cn_indices = {**previous_indices, **cn_indices}
        modules['cn_market'] = {'status': 'succeeded', 'collected_at': now.isoformat(), 'carried_forward': False,
                                'data': {'benchmark': benchmark, 'indices': cn_indices}, 'source_as_of_date': benchmark[-1]['date']}
    else:
        modules['cn_market'] = {'status': 'failed', 'error': {'code': 'NO_BENCHMARK', 'message': 'no valid completed benchmark bars'}}
    modules['global'] = {'status': 'succeeded' if len(quotes) == len(GLOBAL) + len(SHANGHAI_ETFS) else ('partial' if quotes else 'failed'),
                         'collected_at': now.isoformat(), 'carried_forward': False, 'data': sorted(quotes, key=lambda r: r['symbol'])}
    for quote in modules['global']['data']:
        quote['freshness'] = 'stale' if quote['age_hours'] > 7 * 24 else 'latest_available'
        if quote['freshness'] == 'stale':
            modules['global']['status'] = 'partial'
    old_news = prior['modules'].get('news', {}).get('data', [])
    news = curate_news(merge_news(old_news, incoming, now, settings['news_retention_days']))
    # Preserve news as a retained set, but do not call retention a successful fetch.
    modules['news'] = {'status': 'succeeded' if len(source_news_count) == 3 and news else ('partial' if incoming and news else 'failed'),
                       'collected_at': now.isoformat(), 'carried_forward': False, 'data': news, 'sources': source_news_count,
                       'dedup_scope': 'canonical URL and conservative title similarity within two days'}
    for name, module in list(modules.items()):
        if module['status'] == 'failed' and name in prior['modules'] and prior['modules'][name].get('data'):
            old = prior['modules'][name]
            modules[name] = dict(old, status='stale', carried_forward=True, last_attempt_error=module.get('error'),
                                 last_attempt_at=now.isoformat())
    # Research is derived only after all independent source modules are settled.
    market_temp = guarded(lambda: temperature(benchmark, breadth))
    if market_temp['status'] == 'succeeded':
        modules['temperature'] = {'status':'succeeded','data':market_temp['data'],'collected_at':now.isoformat()}
    elif prior['modules'].get('temperature',{}).get('data'):
        modules['temperature'] = dict(prior['modules']['temperature'],status='stale',carried_forward=True,last_attempt_at=now.isoformat())
    else:
        modules['temperature'] = market_temp
    industry_value = modules['industry'].get('data')
    modules['macro'] = {'status':'succeeded' if quotes else 'partial','data':macro_review(quotes,news,industry_value),'collected_at':now.isoformat()}
    if industry_value and not industry_value.get('daily_returns'):
        market_bars = modules['cn_market'].get('data', {}).get('benchmark', [])
        end = max(industry_value['as_of_date'], market_bars[-1]['date']) if market_bars else industry_value['as_of_date']
        industry_value['daily_returns'] = recover_daily_returns(industry_value, end)
    industry_cards = industry_research(industry_value,now) if industry_value else []
    if industry_value:
        industry_value['recommendations']=industry_cards
        industry_value['recommendation_status']='sector-daily-v2.0'
    security_map={r['code']:r for r in (breadth or {}).get('securities',[])}
    pool={}
    actionable_sectors = [card for card in industry_cards if card['state'] == '优先观察']
    for sector in actionable_sectors:
        result=guarded(lambda c=sector['code']:sw_components(fetch,c))
        evidence['components:'+sector['code']]={k:v for k,v in result.items() if k!='data'}
        matching=[security_map[x['code']] for x in result.get('data',[]) if x['code'] in security_map]
        matching=[x for x in matching if 'ST' not in x['name'].upper() and '退' not in x['name'] and x['amount']>=100_000_000]
        for row in sorted(matching,key=lambda x:-x['amount'])[:6]:pool[row['code']]=dict(row,industry=sector['name'])
    # Tracking continues even if an older signal leaves the current candidate pool.
    for record in previous_tracking:
        if record['status'] in ('watching','confirmed','model_position') and record['code'] in security_map:
            pool.setdefault(record['code'],dict(security_map[record['code']],industry='历史观察'))
    stock_histories={};cards=[]
    with ThreadPoolExecutor(max_workers=4) as workers:
        futures={workers.submit(guarded,lambda sec=sec:stock_history(fetch,sec,now)):sec for sec in list(pool.values())[:60]}
        for future in as_completed(futures):
            sec=futures[future];result=future.result()
            evidence['stock:'+sec['code']]={k:v for k,v in result.items() if k!='data'}
            if result['status']=='succeeded':
                stock_histories[sec['code']]=result['data']
                candidate=stock_card(sec,result['data'],benchmark,sec['industry'],now)
                if candidate and sec['industry']!='历史观察':cards.append(candidate)
    # Broad-market trend is a research gate, not an automatic order.
    trend_known=len(benchmark)>=31
    trend_ok = bool(trend_known and benchmark[-1]['close']>sum(r['close'] for r in benchmark[-20:])/20)
    selected=[];seen_industries=set()
    if trend_ok:
        for card in sorted(cards,key=lambda c:(-c['return_30d_pct'],c['code'])):
            if card['industry'] not in seen_industries:selected.append(card);seen_industries.add(card['industry'])
            if len(selected)>=3:break
    research_complete=bool(breadth and trend_known and len(stock_histories)==len(pool) and pool)
    explanation=('沪深300收盘未高于20日均线，本期不新增个股候选。' if not trend_ok else '仅在满足行业规则的有限成分池中筛选，允许无候选。') if trend_known else '缺少完整基准日线，暂停新增个股候选。'
    if len(stock_histories)<len(pool):explanation+=' 部分成分日线未取得，仅使用通过校验的资料。'
    if not pool:explanation+=' 当前没有可验证的研究成分池。'
    modules['observations']={'status':'succeeded' if research_complete else 'partial','data':selected,'collected_at':now.isoformat(),
                             'pool_count':len(pool),'validated_count':len(stock_histories),'market_gate':('open' if trend_ok else 'closed') if trend_known else 'unknown',
                             'explanation':explanation}
    sector_date = actionable_sectors[0]['as_of_date'] if actionable_sectors else None
    modules['investment'] = guarded(lambda: investment_plan(
        benchmark, modules['temperature'].get('data'),
        [card['name'] for card in actionable_sectors], sector_date, len(selected),
    ))
    tracking=track_signals(previous_tracking,selected,stock_histories,benchmark)
    modules['tracking']={'status':'succeeded','data':tracking,'collected_at':now.isoformat()}
    atomic_json(tracking_path,tracking)
    # An observed historical session calendar is sufficient for 30-session metrics;
    # it deliberately does not pretend to predict exchange holidays for scheduling.
    calendar = {'source': 'benchmark_observed_daily_sessions', 'sessions': [r['date'] for r in benchmark],
                'through_date': benchmark[-1]['date'] if benchmark else None, 'future_schedule_calendar_status': 'official_2026_configured_unknown_years_blocked'}
    snapshot = {'schema_version': '1.0', 'snapshot_id': run_id, 'started_at': now.isoformat(),
                'published_at': datetime.now(timezone.utc).isoformat(), 'trigger': 'local_manual_validation',
                'timezone': 'Asia/Shanghai', 'public_access_requires_login': False,
                'analysis_status': 'rules_v1', 'modules': modules, 'calendar': calendar,
                'sources': SOURCES, 'evidence': evidence,
                'rule_version': RULE,
                'distribution': {'public_export_enabled': False, 'reason': 'local validation; source redistribution permissions not presumed'},
                'settings_sha256': hashlib.sha256(json.dumps(settings, sort_keys=True).encode()).hexdigest()}
    atomic_json(root / 'runs' / run_id / 'normalized.json', {'industry_histories': histories, 'benchmark': benchmark})
    atomic_json(root / 'runs' / run_id / 'evidence.json', evidence)
    advanced = publish(root, snapshot)
    atomic_json(root / 'runs' / run_id / 'result.json', {'snapshot_id': run_id, 'latest_advanced': advanced})
    return snapshot, advanced


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='.local/data')
    parser.add_argument('--replay', help='path to a prior run raw directory, no network')
    parser.add_argument('--as-of', help='ISO time used for replay; cannot be in the future')
    args = parser.parse_args()
    now = datetime.fromisoformat(args.as_of) if args.as_of else datetime.now(timezone.utc)
    if now.tzinfo is None or now > datetime.now(timezone.utc):
        parser.error('--as-of must include timezone and not be in the future')
    snapshot, advanced = collect(args.root, now=now, replay=args.replay)
    summary = {'snapshot_id': snapshot['snapshot_id'], 'latest_advanced': advanced,
               'modules': {k: v['status'] for k, v in snapshot['modules'].items()},
               'industry_count': snapshot['modules']['industry'].get('data', {}).get('valid_count', 0),
               'news_count': len(snapshot['modules']['news'].get('data', [])),
               'global_count': len(snapshot['modules']['global'].get('data', []))}
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if snapshot['modules']['industry']['status'] in ('succeeded', 'partial') else 2


if __name__ == '__main__':
    sys.exit(main())
