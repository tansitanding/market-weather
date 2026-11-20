"""Exchange-year coverage is explicit. Unknown years are not guessed from weekdays."""
import json
from datetime import date, timedelta
from pathlib import Path


def year_calendar(year):
    path = Path(__file__).resolve().parents[2] / 'config' / ('calendar-cn-%d.json' % year)
    if not path.exists():
        raise ValueError('official calendar not configured for year %d' % year)
    return json.loads(path.read_text())


def is_cn_session(day):
    day = date.fromisoformat(day) if isinstance(day, str) else day
    config = year_calendar(day.year)
    return day.weekday() < 5 and not any(start <= day.isoformat() <= end for start, end in config['closure_ranges'])


def cn_sessions(start, end):
    cursor, end = date.fromisoformat(start), date.fromisoformat(end)
    result = []
    while cursor <= end:
        if is_cn_session(cursor):
            result.append(cursor.isoformat())
        cursor += timedelta(days=1)
    return result
