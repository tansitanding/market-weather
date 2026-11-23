import type {
  Snapshot,
  DataModule,
  IndustryModule,
  InvestmentPlan,
  IndustryDay,
  IndustryRecord,
  NewsItem,
  GlobalQuote,
  CNMarket,
  ResearchCard,
  Bar,
  Temperature,
  SectorReview,
  MacroReview,
  GlobalReview,
  TrackedSignal,
} from "../contracts.ts";
type Obj = Record<string, unknown>;
const statuses = ["succeeded", "partial", "failed", "stale"];
function obj(v: unknown): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("字段结构不正确");
  return v as Obj;
}
function str(v: unknown, max = 500): string {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw Error("文本字段缺失或过长");
  return v;
}
function num(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw Error("数值字段无效");
  return v;
}
function nullable(v: unknown): number | null {
  return v == null ? null : num(v);
}
function list(v: unknown, max = 5000): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw Error("列表格式无效");
  return v;
}
export function day(v: unknown): string {
  const s = str(v, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    new Date(s + "T00:00:00Z").toISOString().slice(0, 10) !== s
  )
    throw Error("日期格式无效");
  return s;
}
export function stamp(v: unknown): string {
  const s = str(v, 50);
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) || !Number.isFinite(Date.parse(s)))
    throw Error("时间必须包含时区");
  return s;
}
export function safeURL(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
function code(v: unknown): string {
  const s = str(v, 24);
  if (!/^[A-Za-z0-9._-]+$/.test(s)) throw Error("代码无效");
  return s;
}
function dates(v: unknown) {
  return list(v).map(day);
}
function bars(v: unknown): Bar[] {
  const seen = new Set<string>();
  return list(v)
    .map((x) => {
      const r = obj(x),
        d = day(r.date),
        close = num(r.close),
        amount = nullable(r.amount);
      if (close <= 0 || (amount !== null && amount < 0) || seen.has(d))
        throw Error("日线数值或日期无效");
      seen.add(d);
      return { date: d, close, amount };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
function record(v: unknown): IndustryRecord {
  const r = obj(v),
    missing = dates(r.missing_session_dates),
    seen = new Set<string>();
  const series = list(r.series)
    .map((x) => {
      const p = obj(x),
        d = day(p.date);
      if (seen.has(d)) throw Error("曲线日期重复");
      seen.add(d);
      return { date: d, cumulative_return_pct: num(p.cumulative_return_pct) };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (series.some((p) => missing.includes(p.date)))
    throw Error("缺失日期与曲线矛盾");
  return {
    code: code(r.code),
    name: str(r.name, 80),
    return_30d_pct: nullable(r.return_30d_pct),
    excess_30d_pp: nullable(r.excess_30d_pp),
    return_5d_pct: nullable(r.return_5d_pct),
    max_drawdown_30d_pct: missing.length
      ? null
      : nullable(r.max_drawdown_30d_pct),
    missing_session_dates: missing,
    series,
    ...(r.transaction_heat_30d_share_pct == null
      ? {}
      : {
          transaction_heat_30d_share_pct: num(r.transaction_heat_30d_share_pct),
        }),
    ...(r.heat_rising_5v25_pct == null
      ? {}
      : { heat_rising_5v25_pct: num(r.heat_rising_5v25_pct) }),
  };
}
function dailyReturns(v: unknown, validCodes: Set<string>): IndustryDay[] {
  let previous = "";
  return list(v, 30).map((x) => {
    const item = obj(x),
      date = day(item.date);
    if (date <= previous) throw Error("交易日顺序无效");
    previous = date;
    const seen = new Set<string>();
    const rows = list(item.rows, 31)
      .map((y) => {
        const r = obj(y),
          id = code(r.code);
        if (!validCodes.has(id) || seen.has(id)) throw Error("行业代码无效");
        seen.add(id);
        return {
          code: id,
          name: str(r.name, 80),
          change_pct: num(r.change_pct),
        };
      })
      .sort(
        (a, b) => b.change_pct - a.change_pct || a.code.localeCompare(b.code),
      );
    return { date, rows };
  });
}
function industry(v: unknown): IndustryModule {
  const r = obj(v),
    rows = list(r.industries, 100).map(record),
    codes = new Set(rows.map((x) => x.code)),
    b = obj(r.benchmark),
    rankings = obj(r.rankings);
  if (
    codes.size !== rows.length ||
    num(r.valid_count) !== rows.length ||
    num(r.expected_count) !== 31 ||
    num(r.return_intervals) !== 30 ||
    r.classification !== "SW2021_L1"
  )
    throw Error("行业统计口径不匹配");
  const start = day(r.window_start),
    end = day(r.as_of_date);
  if (
    start >= end ||
    rows.some((x) => x.series.some((p) => p.date < start || p.date > end))
  )
    throw Error("行业窗口无效");
  const heat =
    r.heat_status === "succeeded" &&
    rows.length === 31 &&
    rows.every(
      (x) =>
        !x.missing_session_dates.length &&
        x.transaction_heat_30d_share_pct != null &&
        x.heat_rising_5v25_pct != null,
    );
  const ranked = (v: unknown) =>
    list(v, 100)
      .map(code)
      .filter((c) => codes.has(c));
  return {
    status: r.status === "succeeded" ? "succeeded" : "partial",
    classification: "SW2021_L1",
    expected_count: 31,
    valid_count: rows.length,
    as_of_date: end,
    window_start: start,
    return_intervals: 30,
    heat_status: heat ? "succeeded" : "unavailable",
    heat_reason: heat
      ? null
      : typeof r.heat_reason === "string"
        ? r.heat_reason
        : "incomplete_data",
    freshness:
      r.freshness === "stale"
        ? "stale"
        : r.freshness === "lags_benchmark"
          ? "lags_benchmark"
          : "latest_available",
    missing_session_dates: dates(r.missing_session_dates ?? []),
    recommendations: r.recommendations ? sectorReviews(r.recommendations) : [],
    daily_returns:
      r.daily_returns == null ? [] : dailyReturns(r.daily_returns, codes),
    benchmark: {
      ...(b.series
        ? {
            series: list(b.series).map((x) => {
              const q = obj(x);
              return {
                date: day(q.date),
                cumulative_return_pct: num(q.cumulative_return_pct),
              };
            }),
          }
        : {}),
      code: code(b.code),
      name: str(b.name, 80),
      return_30d_pct: nullable(b.return_30d_pct),
    },
    rankings: {
      return_top: ranked(rankings.return_top),
      transaction_heat_top: heat ? ranked(rankings.transaction_heat_top) : [],
      heat_rising_top: heat ? ranked(rankings.heat_rising_top) : [],
    },
    industries: rows,
  };
}
function news(v: unknown): NewsItem[] {
  return list(v, 2000)
    .map((x): NewsItem => {
      const r = obj(x),
        url = safeURL(r.url);
      if (!url) throw Error("新闻链接协议无效");
      const precision = r.date_precision === "day" ? "day" : "second";
      return {
        event_id: code(r.event_id),
        title: str(r.title, 2000),
        importance_score:
          r.importance_score == null ? undefined : num(r.importance_score),
        importance_reason:
          r.importance_reason == null
            ? undefined
            : str(r.importance_reason, 80),
        related_sources:
          r.related_sources == null
            ? []
            : list(r.related_sources, 8).flatMap((value) => {
                const link = obj(value),
                  url = safeURL(link.url);
                return url ? [{ source: str(link.source, 80), url }] : [];
              }),
        url,
        source: str(r.source, 80),
        published_at: precision === "day" ? null : stamp(r.published_at),
        published_date: day(r.published_date),
        date_precision: precision,
        collected_at: stamp(r.collected_at),
        event_occurred_at:
          r.event_occurred_at == null ? null : stamp(r.event_occurred_at),
      };
    })
    .sort(
      (a, b) =>
        b.published_date.localeCompare(a.published_date) ||
        (b.published_at ?? "").localeCompare(a.published_at ?? ""),
    );
}
function globalQuotes(v: unknown): GlobalQuote[] {
  const seen = new Set<string>();
  return list(v, 100).map((x) => {
    const r = obj(x),
      symbol = str(r.symbol, 40),
      zone = str(r.exchange_timezone, 80);
    new Intl.DateTimeFormat("zh-CN", { timeZone: zone });
    if (seen.has(symbol)) throw Error("行情代码重复");
    seen.add(symbol);
    const price = num(r.price);
    if (price <= 0) throw Error("行情价格无效");
    return {
      symbol,
      name: str(r.name, 100),
      asset_type: str(r.asset_type, 50),
      price,
      unit: str(r.unit, 50),
      currency: typeof r.currency === "string" ? r.currency : undefined,
      observed_at: stamp(r.observed_at),
      market_date: day(r.market_date),
      exchange_timezone: zone,
      source: str(r.source, 80),
      change_vs_previous_day_close_pct:
        r.unit === "percent_yield"
          ? null
          : nullable(r.change_vs_previous_day_close_pct),
      change_bp: r.unit === "percent_yield" ? nullable(r.change_bp) : null,
      freshness: r.freshness === "stale" ? "stale" : "latest_available",
      is_live_guaranteed: false,
    };
  });
}
function cn(v: unknown): CNMarket {
  const r = obj(v),
    indices = obj(r.indices);
  return {
    benchmark: bars(r.benchmark),
    indices: Object.fromEntries(
      Object.entries(indices).map(([k, v]) => [code(k), bars(v)]),
    ),
  };
}
function research(v: unknown): ResearchCard[] {
  return list(v, 100).map((x) => {
    const r = obj(x);
    return {
      code: code(r.code),
      name: str(r.name, 100),
      state: str(r.state, 50),
      conclusion: str(r.conclusion, 3000),
      trigger: str(r.trigger, 2000),
      invalidation: str(r.invalidation, 2000),
      risks: list(r.risks, 20).map((x) => str(x, 1000)),
      published_at: stamp(r.published_at),
      evidence: list(r.evidence, 100).map((x) => {
        const e = obj(x),
          url = safeURL(e.url);
        if (!url) throw Error("研究来源链接无效");
        return {
          title: str(e.title, 1000),
          url,
          published_at: stamp(e.published_at),
        };
      }),
    };
  });
}
function sectorReviews(v: unknown): SectorReview[] {
  return list(v, 3).map((x) => {
    const r = obj(x);
    return {
      code: code(r.code),
      as_of_date: r.as_of_date == null ? undefined : day(r.as_of_date),
      name: str(r.name),
      state: str(r.state),
      conclusion: str(r.conclusion, 3000),
      trigger: str(r.trigger, 2000),
      invalidation: str(r.invalidation, 2000),
      risks: list(r.risks, 20).map((x) => str(x)),
      published_at: stamp(r.published_at),
      rule_version: str(r.rule_version),
    };
  });
}
function temperatureData(v: unknown): Temperature {
  const r = obj(v),
    score = num(r.score);
  if (score < 0 || score > 100) throw Error("温度超出范围");
  const components = list(r.components, 10).map((x) => {
    const c = obj(x),
      s = num(c.score),
      w = num(c.weight);
    if (s < 0 || s > 100 || w < 0 || w > 1) throw Error("温度分项无效");
    return { name: str(c.name), score: s, weight: w, detail: str(c.detail) };
  });
  if (Math.abs(components.reduce((n, c) => n + c.weight, 0) - 1) > 0.001)
    throw Error("权重不完整");
  return {
    score,
    label: str(r.label),
    as_of_date: day(r.as_of_date),
    basis: str(r.basis),
    calibration: str(r.calibration),
    components,
  };
}
function globalReviewData(v: unknown): GlobalReview {
  const r = obj(v);
  const heat = (value: unknown) => {
    const s = num(value);
    if (s < 0 || s > 100) throw Error("冷暖分数无效");
    return s;
  };
  return {
    score: r.score == null ? null : heat(r.score),
    label: str(r.label, 40),
    markets: list(r.markets, 2).map((x) => {
      const m = obj(x);
      const coverage = num(m.coverage),
        expected = num(m.expected),
        advancing = num(m.advancing);
      if (
        ![coverage, expected, advancing].every(Number.isInteger) ||
        coverage < 1 ||
        coverage > expected ||
        advancing < 0 ||
        advancing > coverage
      )
        throw Error("指数覆盖无效");
      return {
        name: str(m.name, 20),
        date: day(m.date),
        average_pct: num(m.average_pct),
        score: heat(m.score),
        coverage,
        expected,
        advancing,
      };
    }),
    notes: list(r.notes, 6).map((x) => {
      const n = obj(x);
      return { title: str(n.title, 50), text: str(n.text, 500) };
    }),
  };
}
function macroData(v: unknown): MacroReview {
  const r = obj(v);
  return {
    method: str(r.method),
    ...(r.global_review
      ? { global_review: globalReviewData(r.global_review) }
      : {}),
    interpretation: str(r.interpretation, 3000),
    counter_evidence: str(r.counter_evidence, 3000),
    facts: list(r.facts, 20).map((x) => {
      const f = obj(x),
        u = safeURL(f.source_url);
      if (!u) throw Error("分析来源链接无效");
      return {
        title: str(f.title),
        text: str(f.text),
        as_of: stamp(f.as_of),
        source_url: u,
      };
    }),
    industry_news: Object.fromEntries(
      Object.entries(obj(r.industry_news)).map(([k, v]) => [code(k), news(v)]),
    ),
  };
}
function trackingData(v: unknown): TrackedSignal[] {
  return list(v, 300).map((x) => {
    const r = obj(x);
    if (r.modelled !== true) throw Error("只展示明确的模型观察记录");
    return {
      id: str(r.id, 150),
      code: code(r.code),
      name: str(r.name),
      status: str(r.status),
      created_at: stamp(r.created_at),
      note: str(r.note, 1500),
      horizons: Object.fromEntries(
        Object.entries(obj(r.horizons)).map(([k, v]) => {
          const h = obj(v);
          if (!["5", "10", "20"].includes(k)) throw Error("观察窗口无效");
          return [
            k,
            {
              date: day(h.date),
              net_return_pct: num(h.net_return_pct),
              benchmark_return_pct: nullable(h.benchmark_return_pct),
              excess_pp: nullable(h.excess_pp),
              exit_reason: str(h.exit_reason),
            },
          ];
        }),
      ),
    };
  });
}
function investmentPlan(v: unknown): InvestmentPlan {
  const r = obj(v);
  return {
    as_of_date: day(r.as_of_date),
    sector_date: r.sector_date ? day(r.sector_date) : null,
    stance: str(r.stance, 40),
    action: str(r.action),
    evidence: list(r.evidence, 10).map((v) => str(v)),
    confirm: str(r.confirm),
    invalidate: str(r.invalidate),
    risk: str(r.risk),
    rule_version: str(r.rule_version, 80),
  };
}
function moduleData<T>(v: unknown, decode: (v: unknown) => T): DataModule<T> {
  try {
    const r = obj(v);
    if (!statuses.includes(String(r.status))) throw Error("模块状态无效");
    const data = r.data == null ? undefined : decode(r.data);
    return {
      status: r.status as DataModule<T>["status"],
      data,
      collected_at: r.collected_at ? stamp(r.collected_at) : undefined,
      source_as_of_date: r.source_as_of_date
        ? day(r.source_as_of_date)
        : undefined,
      carried_forward: r.carried_forward === true,
      explanation:
        typeof r.explanation === "string"
          ? str(r.explanation, 1500)
          : undefined,
      validated_count:
        r.validated_count == null ? undefined : num(r.validated_count),
      pool_count:
        typeof r.pool_count === "number" ? num(r.pool_count) : undefined,
      market_gate:
        typeof r.market_gate === "string" ? str(r.market_gate) : undefined,
      error: r.error
        ? { code: "SOURCE_ERROR", message: "上游资料暂不可用" }
        : undefined,
    };
  } catch {
    return {
      status: "failed",
      error: {
        code: "INVALID_MODULE",
        message: "模块数据未通过校验，请稍后刷新",
      },
    };
  }
}
export function parseSnapshot(v: unknown): Snapshot {
  const r = obj(v);
  if (
    r.schema_version !== "1.0" ||
    r.public_access_requires_login !== false ||
    r.timezone !== "Asia/Shanghai"
  )
    throw Error("快照版本或访问配置不受支持");
  const m = obj(r.modules),
    started = stamp(r.started_at),
    published = stamp(r.published_at);
  if (Date.parse(published) < Date.parse(started))
    throw Error("快照时间顺序无效");
  return {
    schema_version: "1.0",
    snapshot_id: code(r.snapshot_id),
    collection_run_id:
      typeof r.collection_run_id === "string" &&
      /^\d{1,20}$/.test(r.collection_run_id)
        ? r.collection_run_id
        : undefined,
    started_at: started,
    published_at: published,
    public_access_requires_login: false,
    timezone: "Asia/Shanghai",
    analysis_status:
      typeof r.analysis_status === "string" ? r.analysis_status : "unavailable",
    modules: {
      industry: moduleData(m.industry, industry),
      ...(m.investment
        ? { investment: moduleData(m.investment, investmentPlan) }
        : {}),
      ...(m.temperature
        ? { temperature: moduleData(m.temperature, temperatureData) }
        : {}),
      ...(m.macro ? { macro: moduleData(m.macro, macroData) } : {}),
      ...(m.tracking ? { tracking: moduleData(m.tracking, trackingData) } : {}),
      cn_market: moduleData(m.cn_market, cn),
      global: moduleData(m.global, globalQuotes),
      news: moduleData(m.news, news),
      ...(m.observations
        ? { observations: moduleData(m.observations, research) }
        : {}),
    },
  };
}
