import "./style.css";
import type {
  Snapshot,
  IndustryModule,
  IndustryRecord,
  DataModule,
  NewsItem,
  GlobalQuote,
} from "./contracts.ts";
import { SnapshotStore } from "./lib/store.ts";
import {
  escapeHTML as e,
  decimal,
  signed,
  direction,
  timeLabel,
  dataOf,
  parseRoute,
  segments,
  comparisonData,
} from "./lib/presentation.ts";
import { safeURL } from "./lib/validate.ts";
const root = document.querySelector<HTMLElement>("#app");
if (!root) throw Error("缺少页面容器");
const app = root;
let cache: Storage | undefined;
try {
  cache = localStorage;
} catch {
  /* Private browser storage may be disabled. */
}
const dataURL = new URL(
  "data/latest.json",
  new URL(import.meta.env.BASE_URL, document.baseURI),
).href;
const store = new SnapshotStore(
  dataURL,
  cache,
  fetch,
  12000,
  "market-weather:snapshot:v1:" + new URL(dataURL).pathname,
);
let hash = location.hash;
let route = parseRoute(hash);
let rank = "return";
let showAll = false;
let newsCount = 6;
let newsFilter = "all";
let managerOpen = false;
const scrolls = new Map<string, number>();
const expanded = new Set<string>();
try {
  const saved = sessionStorage.getItem("market-weather:rank");
  if (["return", "heat", "rising"].includes(saved ?? "")) rank = saved!;
} catch {}
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
const sourceNames: Record<string, string> = {
  sw: "申万宏源研究",
  eastmoney: "东方财富",
  yahoo: "Yahoo Finance",
  fed: "美联储",
  pbc: "中国人民银行",
  cns: "中新网财经",
};
const sourceURLs: Record<string, string> = {
  sw: "https://www.swsresearch.com/institute_sw/allIndex/releasedIndex",
  eastmoney: "https://quote.eastmoney.com/zs000300.html",
  yahoo: "https://finance.yahoo.com/",
};
const icon = (name: string) =>
  ({ home: "◒", industry: "▦", global: "◎", observe: "◇" })[name] ?? "◒";
function external(url: string, label: string, cls = "source-link") {
  const u = safeURL(url);
  return u
    ? `<a class="${cls}" href="${e(u)}" target="_blank" rel="noopener noreferrer">${e(label)}<span class="sr-only">（在新窗口打开）</span></a>`
    : `<span class="muted">${e(label)} · 链接待核验</span>`;
}
function heading(label: string, title: string, sub = "") {
  return `<div class="page-heading"><span class="eyebrow">${label}</span><h1>${title}</h1>${sub ? `<p class="muted">${sub}</p>` : ""}</div>`;
}
function card(title: string, content: string, extra = "") {
  return `<section class="card ${extra}"><h2>${title}</h2>${content}</section>`;
}
function empty(title: string, body: string) {
  return `<div class="empty"><span aria-hidden="true">◇</span><h3>${title}</h3><p>${body}</p></div>`;
}
function fold(id: string, label: string, body: string) {
  return `<details data-fold="${id}" ${expanded.has(id) ? "open" : ""}><summary>${label}</summary><div class="detail-content">${body}</div></details>`;
}
function moduleNote<T>(m: DataModule<T> | undefined, label: string) {
  if (!m) return "";
  let text = "";
  if (m.status === "failed") text = `${label}暂不可用，其他模块可继续阅读。`;
  else if (m.carried_forward || m.status === "stale")
    text = `${label}沿用上次有效数据，请留意资料时间。`;
  else if (m.status === "partial")
    text = `${label}部分资料缺失，相关指标已暂停。`;
  return text ? `<div class="module-note">${text}</div>` : "";
}
function nav() {
  return `<nav class="bottom" aria-label="主导航">${[
    ["home", "总览", "#/"],
    ["industry", "行业", "#/industry"],
    ["global", "全球", "#/global"],
    ["observe", "观察", "#/observe"],
  ]
    .map(
      ([key, label, url]) =>
        `<a href="${url}" ${route.page === key ? 'aria-current="page" class="active"' : ""}><span aria-hidden="true">${icon(key)}</span>${label}</a>`,
    )
    .join("")}</nav>`;
}
function sourceTag(source: string) {
  return e(sourceNames[source] ?? source);
}
function article(n: NewsItem) {
  return `<article class="story"><div class="story-meta"><span>${sourceTag(n.source)}</span><time>${n.published_at ? e(timeLabel(n.published_at)) + " 北京" : e(n.published_date) + " · 日期精度到日"}</time></div>${external(n.url, n.title, "news-link")}${n.event_occurred_at ? `<small>事件时间 ${e(timeLabel(n.event_occurred_at))}</small>` : ""}</article>`;
}
function newsSection(snapshot: Snapshot, limit: number, filters = false) {
  const m = snapshot.modules.news;
  const all = dataOf(m) ?? [];
  const rows = all.filter(
    (n) => newsFilter === "all" || n.source === newsFilter,
  );
  const sources = [...new Set(all.map((n) => n.source))];
  return card(
    "最新资讯",
    `${moduleNote(m, "资讯")}${filters ? `<label class="filter">资讯来源<select id="news-source" aria-label="资讯来源"><option value="all">全部来源</option>${sources.map((s) => `<option value="${e(s)}" ${newsFilter === s ? "selected" : ""}>${sourceTag(s)}</option>`).join("")}</select></label>` : ""}${rows.length ? rows.slice(0, limit).map(article).join("") : empty("暂无可用资讯", all.length ? "所选来源暂时没有条目。" : "资料尚未提供，或未通过来源校验。")}${rows.length > limit ? `<button class="text-button full" data-action="more-news">再看 ${Math.min(6, rows.length - limit)} 条资讯</button>` : ""}<p class="caption">按发布时间排序 · 标题与原文链接 · 不将转载数量当作利好</p>`,
  );
}
function globalRow(q: GlobalQuote) {
  const change =
    q.unit === "percent_yield"
      ? q.change_bp
      : q.change_vs_previous_day_close_pct;
  const unit = q.unit === "percent_yield" ? " bp" : "%";
  return `<article class="quote"><div class="quote-top"><strong>${e(q.name)}</strong><b class="${direction(change)}">${signed(change, unit)}</b></div><div class="quote-price">${decimal(q.price)} <small>${q.unit === "percent_yield" ? "% · 收益率" : q.unit === "index_points" ? "点" : e(q.currency ?? q.unit)}${q.asset_type === "continuous_futures" ? " · 连续期货" : ""}</small></div><div class="quote-time">${e(q.market_date)} · ${e(timeLabel(q.observed_at, q.exchange_timezone).split(" ").at(-1))} 来源市场时间<br>北京时间 ${e(timeLabel(q.observed_at))} · ${q.freshness === "stale" ? "资料较旧" : "最近可用观测"}</div><div class="quote-source">${external(sourceURLs[q.source] ?? "https://finance.yahoo.com/", sourceNames[q.source] ?? q.source)}</div></article>`;
}
function cnRows(snapshot: Snapshot) {
  const m = snapshot.modules.cn_market;
  const data = dataOf(m);
  const rows = data
    ? [
        { name: "上证指数", bars: data.indices["000001"] ?? [] },
        { name: "沪深 300", bars: data.benchmark },
      ]
    : [];
  return (
    moduleNote(m, "A 股行情") +
    (rows.some((r) => r.bars.length)
      ? rows
          .filter((r) => r.bars.length)
          .map((r) => {
            const last = r.bars.at(-1)!,
              prior = r.bars.at(-2),
              change = prior ? (last.close / prior.close - 1) * 100 : null;
            return `<div class="quote"><div class="quote-top"><strong>${r.name}</strong><b class="${direction(change)}">${signed(change)}</b></div><div class="quote-price">${decimal(last.close)} <small>点</small></div><div class="quote-time">${e(last.date)} · 日线收盘 · ${sourceTag("eastmoney")}</div></div>`;
          })
          .join("")
      : empty("A 股资料暂不可用", "等待完整日线，不用模拟数值补齐。"))
  );
}
function climate(snapshot: Snapshot) {
  const m = snapshot.modules.temperature,
    t = dataOf(m);
  return `<section class="hero"><div class="eyebrow">最新市场概览</div><h1>看市场变化<br>也看判断的依据</h1>${t ? `<div class="climate-score"><strong>${decimal(t.score, 1)}<small> / 100</small></strong><span>${e(t.label)}</span></div><div class="climate-scale"><i style="left:${t.score}%"></i></div><div class="scale-labels"><span>冷</span><span>中性</span><span>热</span></div><p class="hero-note">${e(t.as_of_date)} · ${e(t.basis)}</p>` : `<div class="temperature-placeholder"><strong>冷暖暂不可评估</strong><span>等待同一日终的完整行情与市场广度</span></div>`}<p class="hero-note">透明规则研究 · 不执行交易 · 不代表上涨概率</p></section>${moduleNote(m, "市场温度")}${t ? card("温度如何得出", `${t.components.map((c) => `<div class="factor"><div><strong>${e(c.name)}</strong><b>${decimal(c.score, 1)}<small> · 权重 ${Math.round(c.weight * 100)}%</small></b></div><p>${e(c.detail)}</p></div>`).join("")}<p class="caption">${e(t.calibration)} · 行情：东方财富；广度：新浪财经报价池</p>`) : ""}`;
}
function macroSummary(snapshot: Snapshot) {
  const m = snapshot.modules.macro,
    d = dataOf(m);
  if (!d) return "";
  return card(
    "宏观线索与判断",
    `${moduleNote(m, "宏观解读")}<span class="badge">事实依据</span>${d.facts.map((f) => `<div class="story"><strong>${e(f.title)}</strong><p>${e(f.text)}</p><small>${e(timeLabel(f.as_of))} 北京时间</small>${external(f.source_url, "来源")}</div>`).join("")}<h3>条件化判断</h3><p>${e(d.interpretation)}</p><h3>仍需验证</h3><p>${e(d.counter_evidence)}</p><p class="caption">${e(d.method)}</p>`,
  );
}
function sectorReviews(snapshot: Snapshot, code?: string) {
  const rows = (
    dataOf(snapshot.modules.industry)?.recommendations ?? []
  ).filter((r) => !code || r.code === code);
  return card(
    "行业研究观察",
    rows.length
      ? rows
          .map(
            (r) =>
              `<article class="sector-review"><a class="section-link" href="#/industry/${encodeURIComponent(r.code)}">${e(r.name)}</a><span class="badge">${e(r.state)}</span><p>${e(r.conclusion)}</p>${fold("sector-" + r.code, "查看条件、风险与版本", `<h3>观察条件</h3><p>${e(r.trigger)}</p><h3>失效条件</h3><p>${e(r.invalidation)}</p><ul>${r.risks.map((v) => `<li>${e(v)}</li>`).join("")}</ul><small>${e(r.rule_version)} · ${e(timeLabel(r.published_at))}</small>`)}</article>`,
          )
          .join("")
      : empty(
          "暂无行业入选",
          "同时要求30日收益、相对强度和5日收益为正。排行靠前并不自动入选。",
        ),
  );
}
function trackingSection(snapshot: Snapshot) {
  const rows = dataOf(snapshot.modules.tracking) ?? [];
  const labels: Record<string, string> = {
    watching: "等待触发",
    confirmed: "信号确认",
    model_position: "模型观察中",
    completed: "观察完成",
    cancelled: "入场取消",
    expired: "观察过期",
    adjustment_changed: "复权变更暂停",
  };
  return card(
    "5 / 10 / 20 日纸面跟踪",
    `<p class="caption">保存原始信号和规则版本；仅为纸面模拟，非用户成交。包含0.1%往返成本，未模拟全部滑点与涨跌停排队。基准采用模型入场前一交易日收盘至各窗口收盘，非同步成交。</p>${
      rows.length
        ? rows
            .slice(-15)
            .reverse()
            .map(
              (r) =>
                `<article class="story"><strong>${e(r.name)} · ${e(r.code)}</strong><span class="badge">${e(labels[r.status] ?? r.status)}</span><small>建立于 ${e(timeLabel(r.created_at))}</small><div class="metrics">${[5, 10, 20].map((n) => metric(n + "日净收益", r.horizons[String(n)] ? signed(r.horizons[String(n)].net_return_pct) + `<small>相对基准 ${signed(r.horizons[String(n)].excess_pp, "pp")}</small>` : "待观察")).join("")}</div><p class="caption">${e(r.note)}</p></article>`,
            )
            .join("")
        : empty(
            "尚无可跟踪信号",
            "从首个满足条件的真实研究信号开始累计，不回填示例业绩。",
          )
    }`,
  );
}
function home(snapshot: Snapshot) {
  const industry = dataOf(snapshot.modules.industry);
  const globals = dataOf(snapshot.modules.global) ?? [];
  return `${climate(snapshot)}${macroSummary(snapshot)}${card("本次资料覆盖", `<div class="coverage"><div><strong>${industry?.valid_count ?? "—"}</strong><span>一级行业</span></div><div><strong>${globals.length}</strong><span>国际观测</span></div><div><strong>${dataOf(snapshot.modules.news)?.length ?? 0}</strong><span>资讯条目</span></div></div>${industry?.missing_session_dates.length ? `<p class="caption">行业窗口有 ${industry.missing_session_dates.length} 个交易日缺口，热度与回撤暂停计算。</p>` : ""}`)}${card("A 股收盘行情", cnRows(snapshot))}${card(
    "行业近 30 日表现",
    `${moduleNote(snapshot.modules.industry, "行业数据")}${
      industry
        ? `<p class="caption">${e(industry.window_start)} 至 ${e(industry.as_of_date)} · 30 个交易间隔</p>${[
            ...industry.industries,
          ]
            .sort((a, b) => b.return_30d_pct - a.return_30d_pct)
            .slice(0, 3)
            .map((r, i) => rankRow(r, i, "return"))
            .join(
              "",
            )}<a class="section-link" href="#/industry">查看全部行业与统计口径</a>`
        : empty("行业资料暂不可用", "其他市场与资讯仍可继续阅读。")
    }`,
  )}${
    globals.length
      ? card(
          "隔夜美股",
          globals
            .filter((q) => ["^GSPC", "^IXIC"].includes(q.symbol))
            .map(globalRow)
            .join("") +
            '<a class="section-link" href="#/global">查看全球行情与宏观资讯</a>',
        )
      : ""
  }${newsSection(snapshot, newsCount, true)}`;
}
function rankRow(r: IndustryRecord, i: number, mode: string) {
  const v =
    mode === "heat"
      ? r.transaction_heat_30d_share_pct
      : mode === "rising"
        ? r.heat_rising_5v25_pct
        : r.return_30d_pct;
  return `<a class="rank-row" href="#/industry/${encodeURIComponent(r.code)}"><span class="rank-number">${String(i + 1).padStart(2, "0")}</span><div><strong>${e(r.name)}</strong><small>${e(r.code)} · 申万一级</small></div><b class="${mode === "heat" ? "neutral" : direction(v)}">${mode === "heat" ? (v == null ? "—" : decimal(v) + "%") : signed(v)}</b></a>`;
}
function industryPage(snapshot: Snapshot) {
  const m = snapshot.modules.industry;
  const data = dataOf(m);
  if (!data)
    return (
      heading("INDUSTRY", "行业分析") +
      moduleNote(m, "行业") +
      card(
        "行业资料",
        empty("行业资料暂不可用", "可返回总览查看其他模块，或刷新资料重试。"),
      )
    );
  const rows = [...data.industries].sort((a, b) =>
    rank === "heat"
      ? (b.transaction_heat_30d_share_pct ?? -Infinity) -
        (a.transaction_heat_30d_share_pct ?? -Infinity)
      : rank === "rising"
        ? (b.heat_rising_5v25_pct ?? -Infinity) -
          (a.heat_rising_5v25_pct ?? -Infinity)
        : b.return_30d_pct - a.return_30d_pct,
  );
  const unavailable = rank !== "return" && data.heat_status !== "succeeded";
  return (
    heading(
      "INDUSTRY",
      "行业分析",
      "申万 2021 一级行业 · " +
        data.valid_count +
        " / " +
        data.expected_count +
        " 个行业",
    ) +
    `<div class="window"><span>统计区间</span><strong>${e(data.window_start)} — ${e(data.as_of_date)}</strong><small>30 个交易间隔 · 日终口径</small></div>${moduleNote(m, "行业")}${data.freshness === "lags_benchmark" ? '<div class="module-note">行业尚未更新至最新 A 股基准日期，请以本页截至日期为准。</div>' : ""}<div class="segment" role="group" aria-label="行业排行维度">${[
      ["return", "涨幅"],
      ["heat", "交易热度"],
      ["rising", "升温"],
    ]
      .map(
        ([k, l]) =>
          `<button data-action="rank" data-value="${k}" aria-pressed="${rank === k}">${l}</button>`,
      )
      .join("")}</div>${card(
      rank === "return"
        ? "近 30 日涨幅排行"
        : rank === "heat"
          ? "30 日交易热度排行"
          : "交易关注升温排行",
      unavailable
        ? empty(
            "数据有缺口，暂停排行",
            `缺少 ${e(data.missing_session_dates.join("、") || "必要的成交资料")}。不沿用演示排名，也不把缺失值记为零。`,
          )
        : `<p class="caption">${rank === "return" ? "区间收益用于比较强弱，不代表推荐顺序。" : rank === "heat" ? "行业成交额占 31 行业总额的日均份额。" : "最近 5 日成交份额均值相对前 25 日的变化。"}</p>${rows
            .slice(0, showAll ? rows.length : 5)
            .map((r, i) => rankRow(r, i, rank))
            .join(
              "",
            )}${rows.length > 5 ? `<button class="text-button full" data-action="all-industries">${showAll ? "收起到 Top 5" : "查看全部 " + rows.length + " 个行业"}</button>` : ""}`,
    )} ${sectorReviews(snapshot)}${card("如何理解这些指标", fold("industry-method", "查看统计口径与缺失处理", "<p>30 日涨幅由起止收盘计算；升温与热度需要完整成交路径。中间交易日缺失时仍可计算起止收益，但热度、升温和完整最大回撤不可计算。</p><p>基准为沪深 300，同区间差值以“百分点”表示。行业研究采用固定规则；关键词新闻关联不作为收益预测或推荐得分。</p>"))}`
  );
}
function chart(snapshot: Snapshot, r: IndustryRecord) {
  const points = comparisonData(snapshot, r);
  if (!points.dates.length)
    return empty(
      "对比曲线暂不可用",
      "缺少同区间基准，不能绘制可比较的收益曲线。",
    );
  const values = [0, ...points.industry, ...points.benchmark].flatMap((p) =>
    typeof p === "number" ? [p] : p.value === null ? [] : [p.value],
  );
  let low = Math.min(...values),
    high = Math.max(...values);
  if (high === low) {
    low -= 1;
    high += 1;
  }
  const pad = (high - low) * 0.12;
  low -= pad;
  high += pad;
  const x = (i: number) =>
    40 + (i / Math.max(1, points.dates.length - 1)) * 272;
  const y = (v: number) => 20 + ((high - v) / (high - low)) * 148;
  const lines = (data: typeof points.industry, cls: string) =>
    segments(data, x, y)
      .map((d) => `<path d="${d}" class="${cls}"/>`)
      .join("");
  return `<svg class="return-chart" viewBox="0 0 328 207" role="img" aria-label="${e(r.name)}与沪深300的区间累计收益，缺失交易日断线显示"><line x1="40" x2="312" y1="${y(0)}" y2="${y(0)}" class="chart-grid"/><text x="3" y="27">${decimal(high, 1)}%</text><text x="3" y="168">${decimal(low, 1)}%</text>${lines(points.benchmark, "benchmark-line")}${lines(points.industry, "industry-line")}<text x="40" y="198">${points.dates[0].slice(5)}</text><text x="276" y="198">${points.dates.at(-1)!.slice(5)}</text></svg><div class="chart-legend"><span><i class="industry-key"></i>${e(r.name)}</span><span><i class="benchmark-key"></i>沪深 300</span></div>`;
}
function metric(label: string, value: string, cls = "") {
  return `<div class="metric"><span>${label}</span><strong class="${cls}">${value}</strong></div>`;
}
function industryDetail(snapshot: Snapshot, code: string) {
  const m = snapshot.modules.industry,
    data = dataOf(m),
    r = data?.industries.find((r) => r.code === code);
  if (!data || !r)
    return (
      heading("INDUSTRY", "未找到该行业") +
      empty(
        "行业资料不存在或暂不可用",
        "代码 " + e(code) + " 未包含在当前有效快照。",
      ) +
      '<a class="section-link" href="#/industry">返回行业排行</a>'
    );
  return `<a class="back-link" href="#/industry">返回行业排行</a>${heading(e(r.code) + " · 申万一级", e(r.name), e(data.window_start) + " 至 " + e(data.as_of_date))}${moduleNote(m, "行业数据")}<section class="card chart-card"><span class="eyebrow">近 30 个交易间隔</span><div class="return-head"><strong class="${direction(r.return_30d_pct)}">${signed(r.return_30d_pct)}</strong><span>相对沪深 300 <b class="${direction(r.excess_30d_pp)}">${signed(r.excess_30d_pp, " 个百分点")}</b></span></div>${chart(snapshot, r)}${r.missing_session_dates.length ? `<p class="caption">缺口 ${e(r.missing_session_dates.join("、"))} · 曲线断线显示，未补值。</p>` : ""}</section>${card("趋势与交易指标", `<div class="metrics">${metric("最近 5 日收益", signed(r.return_5d_pct), direction(r.return_5d_pct))}${metric("30 日最大回撤", signed(r.max_drawdown_30d_pct), direction(r.max_drawdown_30d_pct))}${metric("30 日交易份额", data.heat_status === "succeeded" && r.transaction_heat_30d_share_pct != null ? decimal(r.transaction_heat_30d_share_pct) + "%" : "暂不可计算")}${metric("交易关注升温", data.heat_status === "succeeded" ? signed(r.heat_rising_5v25_pct) : "暂不可计算")}</div>`)}${card("依据与来源", `${external(sourceURLs.sw, "申万宏源研究 · 行业指数")}${external(sourceURLs.eastmoney, "东方财富 · 沪深 300 基准")}${fold("industry-evidence", "查看计算方法与数据范围", "<p>起止收盘形成 30 个交易间隔收益，5 日收益使用对应交易日收盘。基准与行业对齐同一区间，不使用后来发布的资料修改原始快照。</p>")}<p class="caption">行业与新闻按标题关键词关联，不能据此确认催化或利好。</p>`)}${sectorReviews(snapshot, code)}${card("相关资讯线索", `<p class="caption">仅标题关键词关联，需阅读原文核验。</p>${(dataOf(snapshot.modules.macro)?.industry_news[code] ?? []).map(article).join("") || empty("暂无匹配资讯", "当前来源覆盖有限，未匹配不代表没有事件。")}`)}${card(
    "相关个股",
    (dataOf(snapshot.modules.observations) ?? [])
      .filter((x) => x.conclusion.includes(r.name))
      .map(
        (x) =>
          `<a class="section-link" href="#/observe/${encodeURIComponent(x.code)}">${e(x.name)} · ${e(x.state)}</a>`,
      )
      .join("") || '<p class="muted">本行业暂无满足当前规则的个股候选。</p>',
  )}`;
}
function globalPage(snapshot: Snapshot) {
  const m = snapshot.modules.global,
    rows = dataOf(m) ?? [];
  const groups = [
    [
      "美股主要指数",
      rows.filter((q) => ["^GSPC", "^IXIC", "^DJI"].includes(q.symbol)),
    ],
    ["港股指数", rows.filter((q) => ["^HSI", "HSTECH.HK"].includes(q.symbol))],
    [
      "宏观资产",
      rows.filter(
        (q) =>
          !["^GSPC", "^IXIC", "^DJI", "^HSI", "HSTECH.HK"].includes(q.symbol),
      ),
    ],
  ] as const;
  return (
    heading(
      "GLOBAL CONTEXT",
      "全球与宏观",
      "各市场独立标注时间，均为最近可用观测。",
    ) +
    macroSummary(snapshot) +
    moduleNote(m, "国际行情") +
    (rows.length
      ? groups
          .filter(([, r]) => r.length)
          .map(([title, r]) => card(title, r.map(globalRow).join("")))
          .join("")
      : card(
          "国际行情",
          empty("暂无可用国际行情", "国内行情和资讯仍可继续阅读。"),
        )) +
    card(
      "时间与品种说明",
      fold(
        "global-method",
        "为何各市场的数据时间不同？",
        "<p>美股、港股、美元和期货交易时间不同。每项显示来源市场时间与北京时间，不将页面刷新时间当行情时间，不保证实时。</p><p>美债收益率使用百分比，变动使用基点（bp）。黄金与原油为连续期货观测，不等于现货报价。</p>",
      ),
    ) +
    newsSection(snapshot, newsCount, true)
  );
}
function observe(snapshot: Snapshot) {
  const m = snapshot.modules.observations,
    rows = dataOf(m) ?? [];
  if (route.code) {
    const r = rows.find((r) => r.code === route.code);
    if (!r)
      return (
        heading("RESEARCH", "研究卡暂不可用") +
        empty("未找到已发布的研究卡", "当前版本没有该证券的已核验研究结果。") +
        '<a class="section-link" href="#/observe">返回观察池</a>'
      );
    return `<a class="back-link" href="#/observe">返回观察池</a>${heading(e(r.code), e(r.name), e(timeLabel(r.published_at)) + " 北京时间")}<span class="badge">${e(r.state)}</span>${card("研究结论", `<p>${e(r.conclusion)}</p>`)}${card("条件与风险", `<h3>触发条件</h3><p>${e(r.trigger)}</p><h3>失效条件</h3><p>${e(r.invalidation)}</p><h3>主要风险</h3><ul>${r.risks.map((x) => `<li>${e(x)}</li>`).join("")}</ul>`)}${card("证据来源", r.evidence.map((x) => `<div class="story">${external(x.url, x.title)}<small>${e(timeLabel(x.published_at))}</small></div>`).join("") || '<p class="muted">暂无有效证据来源。</p>')}`;
  }
  return (
    heading(
      "RESEARCH WATCH",
      "个股观察",
      "研究周期基线：5 / 10 / 20 个交易日",
    ) +
    moduleNote(m, "研究资料") +
    (m?.pool_count != null
      ? `<p class="caption">本期成分研究池 ${m.pool_count} 只 · 取得日线 ${m.validated_count ?? "—"} 只</p>`
      : "") +
    (rows.length
      ? card(
          "已发布研究卡",
          rows
            .map(
              (r) =>
                `<a class="research-row" href="#/observe/${encodeURIComponent(r.code)}"><strong>${e(r.name)}</strong><span class="badge">${e(r.state)}</span><p>${e(r.conclusion)}</p><small>${e(r.code)} · ${e(timeLabel(r.published_at))}</small></a>`,
            )
            .join(""),
        )
      : card(
          "观察池",
          empty(
            m?.status === "failed"
              ? "研究资料暂不可用"
              : m
                ? "本期暂无候选"
                : "研究筛选待启用",
            m?.status === "failed"
              ? "研究模块未返回有效资料，请稍后刷新。"
              : m
                ? e(
                    m.explanation ??
                      "当前已发布的观察池为空，不强制凑满推荐数量。",
                  )
                : "个股筛选与证据分析尚未启用。当前仅提供行情与行业事实指标，不生成示例推荐。",
          ),
        )) +
    trackingSection(snapshot) +
    card(
      "筛选与跟踪规则",
      '<div class="process"><div><b>研究依据</b><span>行业背景、量价事实与来源</span></div><div><b>条件与风险</b><span>何时触发，何时失效，哪些判断待验证</span></div><div><b>后续跟踪</b><span>保留原始信号，以纸面成本追踪各窗口</span></div></div>',
    )
  );
}
function render(preserve = true) {
  const y = preserve ? window.scrollY : (scrolls.get(hash) ?? 0);
  const focused = (document.activeElement as HTMLElement | null)?.id;
  const state = store.state,
    snapshot = state.snapshot;
  const age = snapshot
    ? (Date.now() - Date.parse(snapshot.published_at)) / 86400000
    : 0;
  const banner = [
    state.error
      ? `<div class="notice error" role="status">${e(state.error)}${snapshot ? " · 继续显示已保存资料。" : ""}</div>`
      : "",
    state.pending
      ? '<button class="new-content" data-action="accept">有新资料，点击查看更新</button>'
      : state.note
        ? `<div class="notice" role="status">${e(state.note)}</div>`
        : "",
    age > 1
      ? '<div class="notice">这份资料已超过 24 小时未更新，请留意各模块截至时间。</div>'
      : "",
  ].join("");
  let content = "";
  if (!snapshot)
    content =
      heading("MARKET WEATHER", "市场资料工作台") +
      (state.loading
        ? '<div class="card loading" role="status"><div class="skeleton"></div><h2>正在读取最新资料</h2><p class="muted">无需登录，保留各市场的数据时间。</p></div>'
        : card(
            "暂未取得资料",
            empty(
              "没有可读取的市场快照",
              "可以稍后重新读取。开发期真实数据只在本机提供，尚未发布正式网站。",
            ) +
              '<button class="primary full" data-action="refresh">重新读取资料</button>',
          ));
  else if (route.page === "home") content = home(snapshot);
  else if (route.page === "industry")
    content = route.code
      ? industryDetail(snapshot, route.code)
      : industryPage(snapshot);
  else if (route.page === "global") content = globalPage(snapshot);
  else if (route.page === "observe") content = observe(snapshot);
  else
    content =
      heading("NOT FOUND", "页面不存在") +
      '<a class="section-link" href="#/">返回市场总览</a>';
  app.innerHTML = `<a class="skip-link" href="#main-content">跳到主要内容</a><div class="app-shell"><header><a class="brand" href="#/" aria-label="股市气象站首页"><span aria-hidden="true">◒</span><div><b>股市气象站</b><small>最新资料 · 公开阅读</small></div></a><button class="refresh" data-action="refresh" ${state.loading ? "disabled" : ""}>${state.loading ? "读取中…" : "刷新资料"}</button></header>${banner}<main id="main-content" tabindex="-1"><div class="snapshot-meta">${snapshot ? `<span>上次发布 ${e(timeLabel(snapshot.published_at))} 北京时间</span><small>${state.fromCache ? "本机缓存 · " : ""}交易日 08:45 / 11:45 / 17:30 采集</small>` : state.loading ? "<span>正在读取资料快照</span>" : "<span>暂无有效资料快照</span>"}</div>${content}<footer><p>行情时间独立标注 · 无需登录阅读</p><button id="manager-open" class="text-button" data-action="manager">采集管理</button><small>固定规则研究，未经收益优势验证。</small></footer></main>${nav()}</div>${managerOpen ? `<div class="sheet-backdrop"><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="manager-title"><div class="handle"></div><span class="badge">所有者管理入口</span><h2 id="manager-title">手动采集与发布</h2><p>“刷新资料”只读取最新已发布快照，不触发新的行情或新闻采集。</p><p class="muted">定时采集由 GitHub Actions 运行，可能排队延迟。所有者可打开任务页，点击 Run workflow 立即采集；只有管理任务需要 GitHub 登录，阅读网页无需登录。</p>${external("https://github.com/tansitanding/market-weather/actions/workflows/refresh.yml", "打开采集任务 →", "primary full manager-link")}<button id="close-manager" class="primary full" data-action="close-manager">知道了，继续阅读</button></section></div>` : ""}`;
  document.title =
    (route.page === "industry"
      ? "行业分析"
      : route.page === "global"
        ? "全球与宏观"
        : route.page === "observe"
          ? "个股观察"
          : "市场总览") + " · 股市气象站";
  document.body.classList.toggle("sheet-open", managerOpen);
  requestAnimationFrame(() => {
    window.scrollTo({ top: y, behavior: "instant" });
    if (managerOpen)
      document.getElementById("close-manager")?.focus({ preventScroll: true });
    else if (!preserve)
      document.getElementById("main-content")?.focus({ preventScroll: true });
    else if (focused)
      document.getElementById(focused)?.focus({ preventScroll: true });
  });
}
function closeManager() {
  managerOpen = false;
  render();
  requestAnimationFrame(() =>
    document.getElementById("manager-open")?.focus({ preventScroll: true }),
  );
}
app.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest(".skip-link")) {
    event.preventDefault();
    document.getElementById("main-content")?.focus();
    return;
  }
  const el = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-action]",
  );
  if (!el) return;
  switch (el.dataset.action) {
    case "refresh":
      void store.refresh();
      break;
    case "accept":
      store.acceptPending();
      break;
    case "more-news":
      newsCount += 6;
      render();
      break;
    case "rank":
      rank = el.dataset.value!;
      showAll = false;
      try {
        sessionStorage.setItem("market-weather:rank", rank);
      } catch {}
      render();
      break;
    case "all-industries":
      showAll = !showAll;
      render();
      break;
    case "manager":
      managerOpen = true;
      render();
      break;
    case "close-manager":
      closeManager();
      break;
  }
});
app.addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.id === "news-source") {
    newsFilter = target.value;
    newsCount = 6;
    render();
  }
});
app.addEventListener(
  "toggle",
  (event) => {
    const target = event.target as HTMLDetailsElement;
    if (target.dataset.fold) {
      if (target.open) expanded.add(target.dataset.fold);
      else expanded.delete(target.dataset.fold);
    }
  },
  true,
);
window.addEventListener("hashchange", () => {
  if (location.hash === "#main-content") {
    document.getElementById("main-content")?.focus();
    return;
  }
  scrolls.set(hash, window.scrollY);
  hash = location.hash;
  route = parseRoute(hash);
  managerOpen = false;
  render(false);
});
document.addEventListener("keydown", (event) => {
  if (managerOpen && event.key === "Escape") {
    closeManager();
  }
  if (managerOpen && event.key === "Tab") {
    const items = Array.from(
      app.querySelectorAll<HTMLElement>(".sheet a[href], .sheet button"),
    );
    const i = items.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    items[
      (i + (event.shiftKey ? -1 : 1) + items.length) % items.length
    ]?.focus();
  }
});
store.subscribe(() => render());
render(false);
void store.refresh();
