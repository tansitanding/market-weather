"""Pure daily metrics, date-aligned and independent of network/providers."""
import math
from datetime import date
from .calendar import cn_sessions


def number(value, *, positive=False):
    if isinstance(value, bool):
        raise ValueError('boolean is not a number')
    result = float(value)
    if not math.isfinite(result) or (positive and result <= 0):
        raise ValueError('invalid numeric value')
    return result


def validate_bars(rows):
    by_date = {}
    for row in rows:
        day = date.fromisoformat(row['date']).isoformat()
        close = number(row['close'], positive=True)
        amount = None if row.get('amount') is None else number(row['amount'])
        if amount is not None and amount < 0:
            raise ValueError('negative amount')
        entry = dict(row, date=day, close=close, amount=amount)
        if day in by_date and by_date[day] != entry:
            raise ValueError('conflicting duplicate date: ' + day)
        by_date[day] = entry
    return [by_date[d] for d in sorted(by_date)]


def drawdown(values):
    peak, worst = values[0], 0.0
    for value in values:
        peak = max(peak, value)
        worst = min(worst, value / peak - 1)
    return worst * 100


def daily_industry_returns(maps, names, sessions):
    """Use only adjacent official closing sessions, even when a bar is missing."""
    result = []
    window = sessions[-31:]
    for previous, current in zip(window, window[1:]):
        rows = [
            {'code': code, 'name': names[code],
             'change_pct': round((bars[current]['close'] / bars[previous]['close'] - 1) * 100, 6)}
            for code, bars in maps.items() if previous in bars and current in bars
        ]
        rows.sort(key=lambda row: (-row['change_pct'], row['code']))
        result.append({'date': current, 'rows': rows})
    return result


def rank_industries(histories, benchmark, expected_count=31):
    """30 return intervals = 31 common closes. Heat uses a fixed 31-sector denominator.

    Reference is the newest common completed session of all available industries and
    the benchmark. A failed industry still permits partial return ranks; heat is null.
    No forward-filling, missing-day compression or changing-denominator heat ranks.
    """
    benchmark = validate_bars(benchmark)
    if not benchmark:
        raise ValueError('benchmark missing')
    clean = {k: validate_bars(v['bars']) for k, v in histories.items()}
    clean = {k: v for k, v in clean.items() if v}
    if not clean:
        raise ValueError('industry history missing')
    common = set(b['date'] for b in benchmark)
    for rows in clean.values():
        common &= {b['date'] for b in rows}
    dates = sorted(common)
    if not dates:
        raise ValueError('no common closing date')
    # Require the selected 31 dates to be consecutive benchmark sessions, not
    # 31 observations with a missing day silently compressed away.
    end = dates[-1]
    benchmark_dates = [b['date'] for b in benchmark if b['date'] <= end]
    window = benchmark_dates[-31:]
    if len(window) != 31:
        raise ValueError('fewer than 31 benchmark sessions')
    official = cn_sessions(window[0], window[-1])
    if window != official:
        raise ValueError('benchmark sessions differ from official exchange calendar')
    missing_path = sorted(d for d in window if d not in common)
    if window[0] not in common or window[-6] not in common:
        raise ValueError('missing required return endpoint')
    bm = {b['date']: b for b in benchmark}
    bm_return = (bm[end]['close'] / bm[window[0]]['close'] - 1) * 100
    maps = {k: {b['date']: b for b in rows} for k, rows in clean.items()}
    records = []
    for code, rows in maps.items():
        available = [d for d in window if d in rows]
        closes = [rows[d]['close'] for d in available]
        ret = (rows[end]['close'] / rows[window[0]]['close'] - 1) * 100
        missing = [d for d in window if d not in rows]
        records.append({
            'code': code, 'name': histories[code]['name'],
            'return_30d_pct': round(ret, 6),
            'excess_30d_pp': round(ret - bm_return, 6),
            'return_5d_pct': round((rows[end]['close'] / rows[window[-6]]['close'] - 1) * 100, 6),
            'max_drawdown_30d_pct': None if missing else round(drawdown(closes), 6), 'missing_session_dates': missing,
            'series': [{'date': d, 'cumulative_return_pct': round((rows[d]['close'] / closes[0] - 1) * 100, 6)} for d in available],
        })
    amount_days = window[1:]
    heat_reason = None
    if missing_path:
        heat_reason = 'missing_official_trading_sessions'
    elif len(maps) != expected_count:
        heat_reason = 'incomplete_industry_universe'
    elif any(rows[d]['amount'] is None or rows[d]['amount'] <= 0 for rows in maps.values() for d in amount_days):
        heat_reason = 'missing_or_zero_industry_amount'
    if heat_reason is None:
        totals = {d: sum(rows[d]['amount'] for rows in maps.values()) for d in amount_days}
        for record in records:
            shares = [maps[record['code']][d]['amount'] / totals[d] for d in amount_days]
            recent = sum(shares[-5:]) / 5
            earlier = sum(shares[:25]) / 25
            record['transaction_heat_30d_share_pct'] = round(sum(shares) / 30 * 100, 6)
            record['heat_rising_5v25_pct'] = round((recent / earlier - 1) * 100, 6)
    records.sort(key=lambda r: (-r['return_30d_pct'], r['code']))
    return {
        'status': 'succeeded' if len(records) == expected_count and not heat_reason else 'partial',
        'classification': 'SW2021_L1', 'expected_count': expected_count, 'valid_count': len(records),
        'window_start': window[0], 'as_of_date': end, 'return_intervals': 30,
        'benchmark': {'code': '000300', 'name': '沪深300', 'return_30d_pct': round(bm_return, 6)},
        'industry_latest_lags_benchmark': end < benchmark[-1]['date'],
        'missing_session_dates': missing_path,
        'heat_status': 'unavailable' if heat_reason else 'succeeded', 'heat_reason': heat_reason,
        'news_heat_status': 'not_implemented', 'breadth_status': 'not_implemented',
        'rankings': {
            'return_top': [r['code'] for r in records[:5]],
            'transaction_heat_top': [] if heat_reason else [r['code'] for r in sorted(records, key=lambda r: (-r['transaction_heat_30d_share_pct'], r['code']))[:5]],
            'heat_rising_top': [] if heat_reason else [r['code'] for r in sorted(records, key=lambda r: (-r['heat_rising_5v25_pct'], r['code']))[:5]],
        },
        'industries': records,
        'daily_returns': daily_industry_returns(
            maps, {code: row['name'] for code, row in histories.items()},
            cn_sessions(benchmark[-31]['date'], benchmark[-1]['date']),
        ),
        'recommendations': [], 'recommendation_status': 'phase_5_not_implemented',
    }
