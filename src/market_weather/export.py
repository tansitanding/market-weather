"""Publish a bounded research brief, not a raw market-data mirror."""
import copy
from pathlib import Path
from .storage import atomic_json


def export_snapshot(snapshot, output):
    s=copy.deepcopy(snapshot)
    s.pop('evidence',None);s.pop('settings_sha256',None)
    industry=s['modules'].get('industry',{}).get('data')
    market=s['modules'].get('cn_market',{}).get('data')
    if industry and market:
        rows=[r for r in market['benchmark'] if industry['window_start']<=r['date']<=industry['as_of_date']]
        if rows and rows[0]['date']==industry['window_start'] and rows[-1]['date']==industry['as_of_date']:
            industry['benchmark']['series']=[{'date':r['date'],'cumulative_return_pct':round((r['close']/rows[0]['close']-1)*100,6)} for r in rows]
    if market:
        market['benchmark']=market['benchmark'][-2:]
        market['indices']={k:v[-2:] for k,v in market['indices'].items()}
        for rows in [market['benchmark'],*market['indices'].values()]:
            for row in rows:row['amount']=None
    s.pop('calendar',None)
    for q in s['modules'].get('global',{}).get('data',[]):q.pop('source_session',None)
    for n in s['modules'].get('news',{}).get('data',[]):
        for key in ('revisions','revision_hash','first_seen_at','sources'):n.pop(key,None)
    for m in s['modules'].values():
        m.pop('last_attempt_error',None)
    s['publication']={'scope':'公开研究简报：必要的观测、衍生指标与来源链接；不提供完整原始行情下载',
                      'research_only':True,'rule_version':s['rule_version'],'generated_analysis':'deterministic_rules',
                      'schedule_local':['08:45','11:45','17:30'],'schedule_timezone':'Asia/Shanghai',
                      'notice':'条件化研究，规则未证明具有稳定收益优势，不执行交易。'}
    s['distribution']={'public_export_enabled':True,'mode':'bounded_research_brief_with_attribution'}
    output=Path(output);output.mkdir(parents=True,exist_ok=True)
    atomic_json(output/'latest.json',s)
    return s
