"""CLI: collect -> validate -> compute -> immutable local snapshot -> report."""
import argparse
import hashlib
import json
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from .metrics import rank_industries
from .providers import (CST, SOURCES, Fetcher, sw_universe, sw_history, cn_history,
                        yahoo_quote, rss_news, pbc_news, merge_news)
from .storage import atomic_json, publish

GLOBAL = [
    ('^GSPC', '标普500', 'index'), ('^IXIC', '纳斯达克综合', 'index'),
    ('^DJI', '道琼斯工业', 'index'), ('^HSI', '恒生指数', 'index'),
    ('HSTECH.HK', '恒生科技', 'index'), ('DX-Y.NYB', '美元指数', 'index'),
    ('^TNX', '美国10年期国债收益率', 'yield'), ('GC=F', '黄金期货连续', 'continuous_futures'),
    ('CL=F', 'WTI原油期货连续', 'continuous_futures'),
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
    universe = guarded(lambda: sw_universe(fetch))
    evidence['sw_universe'] = {k: v for k, v in universe.items() if k != 'data'}
    histories, quotes = {}, []
    jobs = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs[pool.submit(guarded, lambda: cn_history(fetch, '000300', now))] = ('benchmark', '000300', None)
        jobs[pool.submit(guarded, lambda: cn_history(fetch, '000001', now))] = ('cn_index', '000001', None)
        for industry in universe.get('data', []):
            code, name = industry['code'], industry['name']
            jobs[pool.submit(guarded, lambda c=code: sw_history(fetch, c, now))] = ('industry', code, name)
        for symbol, name, kind in GLOBAL:
            jobs[pool.submit(guarded, lambda s=symbol,n=name,k=kind: yahoo_quote(fetch, s, n, k, now))] = ('global', symbol, None)
        news_jobs = [
            ('fed', lambda: rss_news(fetch, 'fed', 'https://www.federalreserve.gov/feeds/press_all.xml', now)),
            ('cns', lambda: rss_news(fetch, 'cns', 'https://www.chinanews.com.cn/rss/finance.xml', now)),
            ('pbc', lambda: pbc_news(fetch, now)),
        ]
        for source, call in news_jobs:
            jobs[pool.submit(guarded, call)] = ('news', source, None)
        benchmark, cn_indices, incoming = [], {}, []
        source_news_count = {}
        for future in as_completed(jobs):
            result = future.result()
            kind, key, name = jobs[future]
            evidence[kind + ':' + key] = {k: v for k, v in result.items() if k != 'data'}
            if result['status'] != 'succeeded':
                continue
            data = result['data']
            if kind == 'industry':
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
        modules['cn_market'] = {'status': 'succeeded', 'collected_at': now.isoformat(), 'carried_forward': False,
                                'data': {'benchmark': benchmark, 'indices': cn_indices}, 'source_as_of_date': benchmark[-1]['date']}
    else:
        modules['cn_market'] = {'status': 'failed', 'error': {'code': 'NO_BENCHMARK', 'message': 'no valid completed benchmark bars'}}
    modules['global'] = {'status': 'succeeded' if len(quotes) == len(GLOBAL) else ('partial' if quotes else 'failed'),
                         'collected_at': now.isoformat(), 'carried_forward': False, 'data': sorted(quotes, key=lambda r: r['symbol'])}
    for quote in modules['global']['data']:
        quote['freshness'] = 'stale' if quote['age_hours'] > 7 * 24 else 'latest_available'
        if quote['freshness'] == 'stale':
            modules['global']['status'] = 'partial'
    old_news = prior['modules'].get('news', {}).get('data', [])
    news = merge_news(old_news, incoming, now, settings['news_retention_days'])
    # Preserve news as a retained set, but do not call retention a successful fetch.
    modules['news'] = {'status': 'succeeded' if len(source_news_count) == 3 and news else ('partial' if incoming and news else 'failed'),
                       'collected_at': now.isoformat(), 'carried_forward': False, 'data': news, 'sources': source_news_count,
                       'dedup_scope': 'exact title and canonical URL; semantic clustering deferred'}
    for name, module in list(modules.items()):
        if module['status'] == 'failed' and name in prior['modules'] and prior['modules'][name].get('data'):
            old = prior['modules'][name]
            modules[name] = dict(old, status='stale', carried_forward=True, last_attempt_error=module.get('error'),
                                 last_attempt_at=now.isoformat())
    # An observed historical session calendar is sufficient for 30-session metrics;
    # it deliberately does not pretend to predict exchange holidays for scheduling.
    calendar = {'source': 'benchmark_observed_daily_sessions', 'sessions': [r['date'] for r in benchmark],
                'through_date': benchmark[-1]['date'] if benchmark else None, 'future_schedule_calendar_status': 'official_2026_configured_unknown_years_blocked'}
    snapshot = {'schema_version': '1.0', 'snapshot_id': run_id, 'started_at': now.isoformat(),
                'published_at': datetime.now(timezone.utc).isoformat(), 'trigger': 'local_manual_validation',
                'timezone': 'Asia/Shanghai', 'public_access_requires_login': False,
                'analysis_status': 'phase_5_not_implemented', 'modules': modules, 'calendar': calendar,
                'sources': SOURCES, 'evidence': evidence,
                'rule_version': 'sw31-return30-transaction-share30-5v25-v1',
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
