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


def recover_daily_returns(industry, end):
    """Migrate a pre-daily public brief using its already-published return curves.

    Ratios between adjacent cumulative values recover daily moves to the
    precision of the original published figures. Missing dates stay missing.
    """
    start = industry['window_start']
    try:
        sessions = cn_sessions(start, end)
    except ValueError:
        return []
    if len(sessions) < 31:
        return []
    maps = {
        row['code']: {
            point['date']: {'close': 1 + point['cumulative_return_pct'] / 100}
            for point in row['series']
            if point['cumulative_return_pct'] > -100
        }
        for row in industry['industries']
    }
    names = {row['code']: row['name'] for row in industry['industries']}
    return daily_industry_returns(maps, names, sessions)


def rank_industries(histories, benchmark, expected_count=31):
    """Use official sessions and calculate each metric from its required inputs."""
    benchmark = validate_bars(benchmark)
    maps = {}
    for code, history in histories.items():
        try:
            bars = validate_bars(history['bars'])
        except (KeyError, TypeError, ValueError):
            continue
        if bars:
            maps[code] = {bar['date']: bar for bar in bars}
    if not maps:
        raise ValueError('industry history missing')
    bm = {bar['date']: bar for bar in benchmark}
    industry_dates = set().union(*maps.values())
    all_dates = industry_dates | bm.keys()
    sessions = cn_sessions(min(all_dates), max(all_dates))
    end = next((day for day in reversed(sessions) if day in industry_dates), None)
    if end is None:
        raise ValueError('no official industry closing session')
    window = sessions[:sessions.index(end) + 1][-31:]
    if len(window) < 2:
        raise ValueError('fewer than two closing sessions')
    missing_path = [day for day in window if any(day not in rows for rows in maps.values())]

    def endpoint_return(rows, intervals):
        if len(window) <= intervals:
            return None
        start = window[-intervals - 1]
        if start not in rows or end not in rows:
            return None
        return (rows[end]['close'] / rows[start]['close'] - 1) * 100

    bm_return = endpoint_return(bm, 30)
    records = []
    for code, rows in maps.items():
        available = [d for d in window if d in rows]
        closes = [rows[d]['close'] for d in available]
        ret = endpoint_return(rows, 30)
        ret5 = endpoint_return(rows, 5)
        missing = [d for d in window if d not in rows]
        records.append({
            'code': code, 'name': histories[code]['name'],
            'return_30d_pct': round(ret, 6) if ret is not None else None,
            'excess_30d_pp': round(ret - bm_return, 6) if ret is not None and bm_return is not None else None,
            'return_5d_pct': round(ret5, 6) if ret5 is not None else None,
            'max_drawdown_30d_pct': None if missing or len(window) != 31 else round(drawdown(closes), 6), 'missing_session_dates': missing,
            'series': [{'date': d, 'cumulative_return_pct': round((rows[d]['close'] / closes[0] - 1) * 100, 6)} for d in available],
        })
    amount_days = window[1:]
    heat_reason = None
    if len(window) != 31 or missing_path:
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
    ranked = sorted((r for r in records if r['return_30d_pct'] is not None),
                    key=lambda r: (-r['return_30d_pct'], r['code']))
    ranked_codes = {r['code'] for r in ranked}
    records = ranked + [r for r in records if r['code'] not in ranked_codes]
    return {
        'status': 'succeeded' if len(records) == expected_count and not heat_reason and bm_return is not None else 'partial',
        'classification': 'SW2021_L1', 'expected_count': expected_count, 'valid_count': len(records),
        'window_start': window[0], 'as_of_date': end, 'return_intervals': 30,
        'benchmark': {'code': '000300', 'name': '沪深300', 'return_30d_pct': round(bm_return, 6) if bm_return is not None else None},
        'industry_latest_lags_benchmark': bool(benchmark and end < benchmark[-1]['date']),
        'missing_session_dates': missing_path,
        'heat_status': 'unavailable' if heat_reason else 'succeeded', 'heat_reason': heat_reason,
        'news_heat_status': 'not_implemented', 'breadth_status': 'not_implemented',
        'rankings': {
            'return_top': [r['code'] for r in ranked[:5]],
            'transaction_heat_top': [] if heat_reason else [r['code'] for r in sorted(records, key=lambda r: (-r['transaction_heat_30d_share_pct'], r['code']))[:5]],
            'heat_rising_top': [] if heat_reason else [r['code'] for r in sorted(records, key=lambda r: (-r['heat_rising_5v25_pct'], r['code']))[:5]],
        },
        'industries': records,
        'daily_returns': daily_industry_returns(
            maps, {code: row['name'] for code, row in histories.items()},
            sessions[-31:],
        ),
        'recommendations': [], 'recommendation_status': 'phase_5_not_implemented',
    }
