"""Rank market news from titles and group high-confidence duplicate coverage."""
import re
import unicodedata
from datetime import date
from difflib import SequenceMatcher

OFFICIAL = {'fed', 'pbc', 'stats', 'csrc'}
RULES = [
    ('货币政策与利率决议', 90, r'fomc (statement|minutes)|federal reserve issues.*statement|降准|降息|加息|利率决议|政策利率|贷款市场报价利率|\blpr\b'),
    ('主要经济数据', 80, r'国内生产总值|\bgdp\b|\bcpi\b|\bppi\b|居民消费价格|非农就业|失业率|工业增加值|社会消费品零售总额|采购经理指数|\bpmi\b'),
    ('财政、贸易或监管政策', 75, r'关税|出口管制|出口限制|特别国债|专项债|证监会.*(?:发布|规定|办法|新规)|金融监管.*(?:发布|办法|新规)|重大资产重组|交易规则.*(?:调整|修订)'),
    ('值得关注的市场事件', 65, r'主权债券|大面积停牌|熔断|债务违约|石油减产|原油减产|opec.*(?:减产|增产)'),
]
ROUTINE = re.compile(r'代表发言|例行记者会|优化支付服务|宣传活动|防范诈骗|日常巡查|例行维护|speaks at|welcoming remarks|testimony|\bnotice of meeting\b', re.I)
NUMBERS = re.compile(r'(?<!\w)\d+(?:\.\d+)?%?|\d+(?:\.\d+)?[%％万亿元月日点]', re.I)
FORECAST = re.compile(r'或将|可能|预计|预期|猜测|传闻|market expects|preview', re.I)
DIRECTION = re.compile(r'上涨|下跌|上升|下降|降息|加息|增产|减产|increase|decrease|raises|cuts', re.I)


def normalized_title(title):
    title = unicodedata.normalize('NFKC', title).lower()
    return re.sub(r'^\s*(?:【[^】]{1,16}】|（[^）]{1,16}）|\([^)]{1,16}\)|快讯[:：]|独家[:：])\s*', '', title).strip()


def importance(item):
    title = normalized_title(item['title'])
    if ROUTINE.search(title) or FORECAST.search(title):
        return 0, None
    for label, score, pattern in RULES:
        if re.search(pattern, title, re.I):
            return min(100, score + (5 if item['source'] in OFFICIAL else 0)), label
    return 0, None


def duplicate(a, b):
    if a['url'] == b['url']:
        return True
    if abs((date.fromisoformat(a['published_date']) - date.fromisoformat(b['published_date'])).days) > 2:
        return False
    left, right = (normalized_title(item['title']) for item in (a, b))
    if NUMBERS.findall(left) != NUMBERS.findall(right) or DIRECTION.findall(left) != DIRECTION.findall(right):
        return False
    left, right = (re.sub(r'\W+', '', title) for title in (left, right))
    if left == right:
        return True
    return min(len(left), len(right)) >= 12 and SequenceMatcher(None, left, right, autojunk=False).ratio() >= .86


def curate_news(items):
    """Prefer the official report where available, keeping related source links."""
    prioritized = sorted(items, key=lambda item: item['source'] in OFFICIAL, reverse=True)
    groups = []
    for item in prioritized:
        match = next((group for group in groups if duplicate(item, group[0])), None)
        if match is None:
            groups.append([item])
        else:
            match.append(item)
    result = []
    for group in groups:
        canonical = group[0]
        score, reason = max((importance(item) for item in group), key=lambda pair: pair[0])
        sources = {}
        for item in group:
            for link in [*item.get('sources', []), *item.get('related_sources', []), dict(source=item['source'], url=item['url'])]:
                if link['url'] != canonical['url']:
                    sources[link['url']] = link
        result.append(dict(canonical, importance_score=score, importance_reason=reason,
                           related_sources=list(sources.values())[:8]))
    return sorted(result, key=lambda item: (item['published_date'], item['published_at'] or ''), reverse=True)
