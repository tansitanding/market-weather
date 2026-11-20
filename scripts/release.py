"""Collect, generate research, and export a bounded public brief for Pages."""
import argparse,json,sys
from pathlib import Path
from datetime import datetime,timezone
from market_weather.pipeline import collect
from market_weather.export import export_snapshot
from market_weather.storage import atomic_json
from market_weather.calendar import is_cn_session
p=argparse.ArgumentParser();p.add_argument('--root',default='.local/data');p.add_argument('--out',default='.release');p.add_argument('--trigger',default='manual');a=p.parse_args()
now=datetime.now(timezone.utc)
if a.trigger=='schedule':
 from zoneinfo import ZoneInfo
 try:
  if not is_cn_session(now.astimezone(ZoneInfo('Asia/Shanghai')).date()):print('非A股交易日，跳过定时采集');sys.exit(3)
 except ValueError:print('交易日历未知，继续更新资讯但相关信号将降级')
snapshot,advanced=collect(a.root,now=now)
if not advanced:raise SystemExit('本次没有可发布的新版本，保留现有网页')
export_snapshot(snapshot,a.out)
tracking=Path(a.root)/'tracking.json'
if tracking.exists():atomic_json(Path(a.out)/'tracking.json',json.loads(tracking.read_text()))
print(json.dumps({'snapshot':snapshot['snapshot_id'],'modules':{k:v['status'] for k,v in snapshot['modules'].items()},'source_failures':{k:v.get('error') for k,v in snapshot.get('evidence',{}).items() if v['status']=='failed'}},ensure_ascii=False))
