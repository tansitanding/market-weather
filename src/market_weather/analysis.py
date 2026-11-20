"""Versioned, deterministic research. No LLM claims or trade execution."""
import copy
import math
import statistics
from datetime import datetime, timedelta
from .calendar import cn_sessions
RULE = 'research-v1.0'
KEYWORDS = {
 '801010':['农业','农产品','养殖'], '801030':['化工','化肥'], '801040':['钢铁','粗钢'],
 '801050':['有色金属','铜价','铝价','稀土'], '801080':['半导体','芯片','集成电路','消费电子'],
 '801110':['家电','空调','冰箱'], '801120':['白酒','食品饮料','乳制品'],
 '801130':['纺织','服装'], '801140':['轻工','造纸'], '801150':['医药','药品','生物医药'],
 '801160':['电力供应','水务','公用事业'], '801170':['航空','航运','物流','快递'],
 '801180':['房地产','楼市'], '801200':['零售','电商'], '801210':['旅游','酒店','餐饮'],
 '801710':['建材','水泥'], '801720':['建筑','基建'], '801730':['光伏','风电','电池','储能'],
 '801740':['国防','军工'], '801750':['软件','人工智能','计算机'], '801760':['传媒','电影','游戏'],
 '801770':['通信','5G','6G','光通信'], '801780':['银行','支付','信贷'], '801790':['证券','保险','券商'],
 '801880':['汽车','新能源车'], '801890':['机械','机器人','工业设备'],
 '801950':['煤炭','煤价'], '801960':['原油','石油','石化'], '801970':['环保','碳排放'], '801980':['化妆品','美容护理']}


def clamp(v): return max(0.0, min(100.0, v))


def temperature(benchmark, breadth):
    if len(benchmark) < 22 or not breadth or not breadth.get('completed_session', True):
        raise ValueError('完整日线或市场广度不足')
    rows = benchmark[-22:]
    dates = [r['date'] for r in rows]
    if dates != cn_sessions(dates[0], dates[-1]) or breadth['as_of_date'] != dates[-1]:
        raise ValueError('广度与日线不在同一日终；保留最近已确认评估')
    closes = [r['close'] for r in rows]
    if not all(r.get('amount') and r['amount'] > 0 for r in rows):
        raise ValueError('完整成交额缺失')
    ma20 = statistics.mean(closes[-20:])
    ratio = rows[-1]['amount'] / statistics.mean(r['amount'] for r in rows[-21:-1])
    vol = statistics.pstdev([closes[i]/closes[i-1]-1 for i in range(2,22)])*math.sqrt(252)*100
    components = [
      {'name':'A股报价池上涨广度','score':100*breadth['advancing']/breadth['valid_count'],'weight':.30,'detail':f"上涨 {breadth['advancing']} / 有效 {breadth['valid_count']} 家"},
      {'name':'沪深300趋势','score':clamp(50+(closes[-1]/ma20-1)*500),'weight':.30,'detail':f"收盘相对20日均线 {(closes[-1]/ma20-1)*100:+.2f}%"},
      {'name':'成交活跃度','score':clamp(50+(ratio-1)*50),'weight':.25,'detail':f"成交额为此前20日均值 {ratio:.2f} 倍"},
      {'name':'波动风险','score':clamp(100-2*vol),'weight':.15,'detail':f"20日年化波动 {vol:.2f}%，波动越高该项越低"}]
    score=round(sum(x['score']*x['weight'] for x in components),1)
    label = '冰冷' if score<20 else '偏冷' if score<40 else '中性' if score<60 else '偏暖' if score<80 else '过热'
    for c in components:c['score']=round(c['score'],2)
    return {'score':score,'label':label,'as_of_date':dates[-1],'basis':'完整日终；盘前及午间沿用最近已确认日终',
            'components':components,'breadth':{k:v for k,v in breadth.items() if k!='securities'},
            'rule_version':RULE,'calibration':'研究规则，未经收益优势验证；不是上涨概率'}


def macro_review(quotes, news, industry):
    by={q['symbol']:q for q in quotes};facts=[]
    for symbol,label in [('^GSPC','标普500'),('^IXIC','纳斯达克综合'),('DX-Y.NYB','美元指数')]:
        q=by.get(symbol)
        if q and q.get('change_vs_previous_day_close_pct') is not None:
            facts.append({'title':label,'text':f"相对前一完整收盘 {q['change_vs_previous_day_close_pct']:+.2f}%",
                          'as_of':q['observed_at'],'source_url':'https://finance.yahoo.com/quote/'+symbol.replace('^','%5E')+'/'})
    q=by.get('^TNX')
    if q and q.get('change_bp') is not None:facts.append({'title':'美国10年期收益率','text':f"变化 {q['change_bp']:+.2f} bp",'as_of':q['observed_at'],'source_url':'https://finance.yahoo.com/quote/%5ETNX/'})
    sp=by.get('^GSPC',{}).get('change_vs_previous_day_close_pct')
    interpretation='外部市场变化仅提供背景；国内行业的量价与事件证据仍需独立验证。'
    if sp is not None:interpretation=('隔夜美股走弱，可能压制风险偏好；国内政策与资金节奏可能形成反向影响。' if sp<0 else '隔夜美股走强，可能改善风险偏好；不能据此认定国内相关股票必然受益。')
    related={}
    for row in (industry or {}).get('industries',[]):
        hits=[n for n in news if any(k in n['title'] for k in KEYWORDS.get(row['code'],[]))][:5]
        if hits:related[row['code']]=hits
    return {'method':'规则解读与关键词关联，无生成式AI调用','facts':facts,'interpretation':interpretation,
            'counter_evidence':'需继续验证国内成交、行业扩散与公告；新闻关联不等于已证实的利好或因果。',
            'industry_news':related,'news_coverage_note':'只依据已采集公开标题，来源覆盖有限。'}


def industry_research(industry, now):
    daily = industry.get('daily_returns', [])
    complete = [day for day in daily if len(day['rows']) == industry['expected_count']]
    if not complete:
        return []
    latest = complete[-1]
    recent = [day for day in daily if day['date'] <= latest['date']][-5:]
    covered = [day for day in recent if len(day['rows']) == industry['expected_count']]
    if len(covered) < 3:
        return []
    recent_leaders = [
        {row['code'] for row in day['rows'][:10] if row['change_pct'] > 0}
        for day in covered
    ]
    results = []
    for rank, row in enumerate(latest['rows'][:10], start=1):
        appearances = sum(row['code'] in leaders for leaders in recent_leaders)
        if row['change_pct'] <= 0 or appearances < 3:
            continue
        results.append((appearances, rank, {
            'code': row['code'], 'name': row['name'], 'state': '优先观察',
            'conclusion': (
                f"{latest['date']} 日涨幅 {row['change_pct']:+.2f}%，排名第 {rank}。"
                f"截至该日的近 5 个交易日中，有 {len(covered)} 日数据齐全，"
                f"其中 {appearances} 日上涨且进入 Top 10。"
            ),
            'trigger': '下一交易日仍处于涨幅前列，并核验成交与成分股是否同步走强。',
            'invalidation': '后续收盘转弱或跌出涨幅前十，降低观察优先级。',
            'risks': ['连续上榜也可能来自短期轮动', '权重股拉动不代表多数成分股上涨'],
            'published_at': now.isoformat(), 'rule_version': 'sector-daily-v1.0',
        }))
    results.sort(key=lambda item: (-item[0], item[1]))
    return [card for _, _, card in results[:3]]


def stock_card(security, bars, benchmark, industry_name, now):
    if len(bars)<31 or len(benchmark)<31:return None
    dates=[r['date'] for r in benchmark[-31:]];by={r['date']:r for r in bars}
    try:
        if dates!=cn_sessions(dates[0],dates[-1]):return None
    except ValueError:return None
    if any(d not in by for d in dates):return None
    rows=[by[d] for d in dates];last=rows[-1];closes=[r['close'] for r in rows]
    ma=statistics.mean(closes[-20:]);ret30=(closes[-1]/closes[0]-1)*100;ret5=(closes[-1]/closes[-6]-1)*100
    liquidity=statistics.mean(r['amount'] for r in rows[-20:])
    if not (closes[-1]>ma and ret30>0 and 0<ret5<=8 and closes[-1]/ma<=1.12 and liquidity>=100_000_000):return None
    pivot=max(r['high'] for r in rows[-21:-1]);amount_trigger=statistics.mean(r['amount'] for r in rows[-21:-1])*1.2
    atr=statistics.mean(max(rows[i]['high']-rows[i]['low'],abs(rows[i]['high']-rows[i-1]['close']),abs(rows[i]['low']-rows[i-1]['close'])) for i in range(17,31))
    met=last['close']>pivot and last['amount']>=amount_trigger
    code=security['code'];market='sh' if security['market']==1 else 'bj' if code.startswith(('4','8','92')) else 'sz'
    return {'code':code,'name':security['name'],'state':'条件满足，待次日验证' if met else '待触发',
      'conclusion':f"来自{industry_name}有限成分研究池；收盘高于20日均线，30日 {ret30:+.2f}%，5日 {ret5:+.2f}%。规则筛选，未经收益优势验证。",
      'trigger':f"完整收盘突破近20日高点 {pivot:.2f} 元且成交额达到此前20日均值1.2倍；下一可交易日开盘偏离信号收盘超过3%取消观察入场。",
      'invalidation':f"收盘跌回20日均线或催化被证伪；信号参考风险线 {max(0,closes[-1]-1.5*atr):.2f} 元（收盘减1.5ATR，非实际成交止损）。",
      'risks':['仅在有限行业成分池筛选，非全市场推荐','停牌、涨跌停和跳空可能导致无法执行','5/10/20日仅为观察窗口，不代表收益承诺'],
      'evidence':[{'title':'前复权日线与成交额（本次采集核验）','url':'https://quote.eastmoney.com/'+market+code+'.html','published_at':now.isoformat()}],
      'published_at':now.isoformat(),'signal_date':last['date'],'reference_close':last['close'],'trigger_price':pivot,'amount_trigger':amount_trigger,
      'atr14':atr,'conditions_met':met,'return_30d_pct':round(ret30,4),'industry':industry_name,'rule_version':RULE}


def track_signals(previous, cards, histories, benchmark):
    """Explicit paper simulation, never actual user fills. Original rules immutable."""
    if len(benchmark)<31:return previous
    records=copy.deepcopy(previous)
    active={r['code'] for r in records if r['status'] in ('watching','confirmed','model_position')}
    for c in cards:
        if c['code'] not in active:
            records.append({'id':c['code']+'-'+c['signal_date']+'-'+RULE,'code':c['code'],'name':c['name'],'created_at':c['published_at'],
                            'signal_date':c['signal_date'],'reference_close':c['reference_close'],'trigger_price':c['trigger_price'],
                            'amount_trigger':c['amount_trigger'],'atr14':c['atr14'],'rule_version':RULE,
                            'status':'confirmed' if c['conditions_met'] else 'watching','confirmed_date':c['signal_date'] if c['conditions_met'] else None,
                            'modelled':True,'cost_roundtrip_pct':.1,'horizons':{},'note':'仅纸面模型，不代表用户成交；未模拟排队与全部滑点。'})
            active.add(c['code'])
    sessions=[r['date'] for r in benchmark]
    for r in records:
        bars=histories.get(r['code'],[]);by={b['date']:b for b in bars}
        if not bars or r['status'] in ('cancelled','expired','adjustment_changed'):continue
        original=by.get(r['signal_date'])
        if original and abs(original['close']/r['reference_close']-1)>.005:
            r['status']='adjustment_changed';r['note']='复权基准变化，停止模型统计，保留原始信号';continue
        window=[d for d in sessions if d>r['signal_date']][:20]
        future=[b for b in bars if b['date'] in window]
        if r['status']=='watching':
            for b in future:
                if b['close']>r['trigger_price'] and b['amount']>=r['amount_trigger']:
                    r['confirmed_date']=b['date'];r['status']='confirmed';break
            if r['status']=='watching' and len([d for d in sessions if d>r['signal_date']])>=20:r['status']='expired'
        if r['status']=='confirmed':
            entry=next((b for b in bars if b['date']>r['confirmed_date']),None)
            if entry:
                expected=next((d for d in sessions if d>r['confirmed_date']),None)
                ref=by.get(r['confirmed_date'])
                if entry['date']!=expected or not ref or abs(entry['open']/ref['close']-1)>.03:
                    r['status']='cancelled';r['note']='下一交易日停牌、缺报价或开盘偏离超过3%，取消模型入场';continue
                r.update(status='model_position',entry_date=entry['date'],entry_price=entry['open'],risk_price=max(0,entry['open']-1.5*r['atr14']))
        if r.get('entry_date'):
            expected_dates=[d for d in sessions if d>=r['entry_date']]
            if any(d not in by for d in expected_dates):
                r['note']='模型期间有停牌或缺失报价，暂停新增统计；不把复牌日当作连续交易日';continue
            future=[b for b in bars if b['date']>=r['entry_date']]
            # A-share T+1: a model position cannot sell on entry day.
            stop=next((b for b in future[1:] if b['low']<=r['risk_price']),None)
            for horizon in (5,10,20):
                window=[d for d in sessions if d>=r['entry_date']][:horizon]
                if len(window)==horizon and all(d in by for d in window):
                    end=by[window[-1]];exit_price=end['close'];reason='窗口收盘'
                    if stop and stop['date']<=end['date']:exit_price=min(stop['open'],r['risk_price']);reason='模型风险线'
                    bm={b['date']:b['close'] for b in benchmark}
                    base=next((b['close'] for b in reversed(benchmark) if b['date']<r['entry_date']),None)
                    net=round((exit_price/r['entry_price']-1)*100-.1,4)
                    benchmark_return=round((bm[end['date']]/base-1)*100,4) if base else None
                    r['horizons'][str(horizon)]={'date':end['date'],'net_return_pct':net,'benchmark_return_pct':benchmark_return,'excess_pp':round(net-benchmark_return,4) if benchmark_return is not None else None,'exit_reason':reason}
            if '20' in r['horizons']:r['status']='completed'
    return records[-300:]
