import "./style.css";
import type {
  Snapshot,
  IndustryModule,
  IndustryDay,
  IndustryRecord,
  DataModule,
  NewsItem,
  GlobalQuote,
} from "./contracts.ts";
import {
  readJournal,
  saveJournal,
  validEntry,
  realizedProfit,
  type JournalEntry,
} from "./lib/journal.ts";
import { SnapshotStore } from "./lib/store.ts";
import {
  escapeHTML as e,
  decimal,
  signed,
  direction,
  timeLabel,
  dataOf,
  parseRoute,
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
let selectedIndustryDate = "";
let newsCount = 10;
let newsMode: "important" | "recent" = "important";
let newsFilter = "all";
let refreshing = false;
let refreshMessage = "";
let journal = readJournal(cache);
let journalEditing: JournalEntry | "new" | null = null;
const scrolls = new Map<string, number>();
const expanded = new Set<string>();
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
    ["observe", "跟踪", "#/observe"],
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
  const related = n.related_sources ?? [];
  return `<article class="story"><div class="story-meta"><span>${sourceTag(n.source)}</span><time>${n.published_at ? e(timeLabel(n.published_at)) + " 北京" : e(n.published_date)}</time></div>${external(n.url, n.title, "news-link")}
    ${n.importance_reason ? `<small>关注原因 · ${e(n.importance_reason)}</small>` : ""}
    ${related.length ? fold("news-" + n.event_id + "-" + n.published_date, "同事件其他来源 · " + related.length, related.map((r) => external(r.url, sourceNames[r.source] ?? r.source)).join(" ")) : ""}
    </article>`;
}
function newsSection(snapshot: Snapshot, limit: number) {
  const m = snapshot.modules.news;
  const all = dataOf(m) ?? [];
  const cutoff = Date.parse(snapshot.published_at) - 7 * 86400000;
  const important = (n: NewsItem) =>
    (n.importance_score ?? 0) > 0 &&
    Date.parse(n.published_date + "T23:59:59+08:00") >= cutoff;
  const matchesSource = (n: NewsItem) =>
    newsFilter === "all" ||
    n.source === newsFilter ||
    n.related_sources?.some((r) => r.source === newsFilter);
  const rows = all.filter(
    (n) => matchesSource(n) && (newsMode === "recent" || important(n)),
  );
  if (newsMode === "important")
    rows.sort((a, b) => (b.importance_score ?? 0) - (a.importance_score ?? 0));
  const sources = [
    ...new Set(
      all.flatMap((n) => [
        n.source,
        ...(n.related_sources ?? []).map((r) => r.source),
      ]),
    ),
  ];
  const toggle = `<div class="segment" role="group" aria-label="资讯浏览方式">
    <button data-action="news-mode" data-value="important" aria-pressed="${newsMode === "important"}">重要资讯</button>
    <button data-action="news-mode" data-value="recent" aria-pressed="${newsMode === "recent"}">全部 · 按时间</button>
    </div>`;
  const filter = `<label class="filter">资讯来源<select id="news-source" aria-label="资讯来源"><option value="all">全部来源</option>${sources.map((source) => `<option value="${e(source)}" ${newsFilter === source ? "selected" : ""}>${sourceTag(source)}</option>`).join("")}</select></label>`;
  const body = rows.length
    ? rows.slice(0, limit).map(article).join("")
    : empty(
        newsMode === "important" ? "暂无符合条件的重要资讯" : "暂无可用资讯",
        newsMode === "important"
          ? "可切换到全部资讯查看已采集报道。"
          : "当前来源暂无可展示条目。",
      );
  return card(
    "市场资讯",
    moduleNote(m, "资讯") +
      toggle +
      filter +
      `<p class="caption">${newsMode === "important" ? "按近 7 天事件的市场相关性与来源排序，同等级优先最新。" : "按发布时间倒序。"} 同一事件合并展示。</p>` +
      body +
      (rows.length > limit
        ? `<button class="text-button full" data-action="more-news">再看 ${Math.min(10, rows.length - limit)} 条资讯</button>`
        : "") +
      fold(
        "news-method",
        "怎么筛选重要资讯？",
        "<p>根据公开标题识别货币政策、关键经济数据、监管与贸易政策、市场事件。同类消息优先采用官方来源，合并相近时间的高度相似标题。标题差异较大的转载可能分开显示。</p>",
      ),
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
  const module = snapshot.modules.cn_market;
  const data = dataOf(module);
  const rows = [
    { name: "上证指数", bars: data?.indices["000001"] },
    { name: "沪深 300", bars: data?.benchmark },
    { name: "创业板指", bars: data?.indices["399006"] },
  ];
  return (
    moduleNote(module, "A 股行情") +
    `<div class="index-tiles">${rows
      .map(({ name, bars }) => {
        const close = bars?.at(-1),
          prior = bars?.at(-2);
        const pct =
          close && prior ? (close.close / prior.close - 1) * 100 : null;
        const heat =
          pct === null
            ? ""
            : pct >= 1
              ? "warm-strong"
              : pct > 0
                ? "warm"
                : pct <= -1
                  ? "cool-strong"
                  : pct < 0
                    ? "cool"
                    : "";
        return `<div class="index-tile ${heat}"><strong>${name}</strong><b class="${direction(pct)}">${pct === null ? "—" : signed(pct)}</b><span>${close ? decimal(close.close) : "待更新"}</span><small>${close ? e(close.date.slice(5)) + " 收盘" : "暂无日线"}</small></div>`;
      })
      .join(
        "",
      )}</div><p class="caption">红涨绿跌，颜色越深表示单日涨跌幅越大。</p>`
  );
}
function advice(snapshot: Snapshot) {
  const p = dataOf(snapshot.modules.investment);
  if (!p)
    return card(
      "投资建议",
      empty("等待本期研判", "需要完整的沪深300日线才能生成研判。"),
    );
  return card(
    "投资建议",
    `<div class="advice-lead"><strong>${e(p.stance)}</strong><small>${e(p.as_of_date)} 收盘判断</small><p>${e(p.action)}</p></div><h3>判断依据</h3><ul>${p.evidence.map((line) => `<li>${e(line)}</li>`).join("")}</ul><div class="advice-rules"><div><h3>何时考虑参与</h3><p>${e(p.confirm)}</p></div><div><h3>何时重新评估</h3><p>${e(p.invalidate)}</p></div></div><p class="caption">${e(p.risk)}</p><a class="section-link" href="#/observe">查看个股候选与我的跟踪</a>`,
    "advice-card",
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
  ).filter(
    (r) =>
      ["sector-daily-v1.0", "sector-daily-v2.0"].includes(r.rule_version) &&
      (!code || r.code === code),
  );
  return card(
    "行业建议",
    rows.length
      ? rows
          .map(
            (r) =>
              `<article class="sector-review"><a class="section-link" href="#/industry/${encodeURIComponent(r.code)}">${e(r.name)}</a><span class="badge">${e(r.state)}</span><p>${e(r.conclusion)}</p>${fold("sector-" + r.code, "查看条件、风险与版本", `<h3>观察条件</h3><p>${e(r.trigger)}</p><h3>失效条件</h3><p>${e(r.invalidation)}</p><ul>${r.risks.map((v) => `<li>${e(v)}</li>`).join("")}</ul><small>${e(r.rule_version)} · ${e(timeLabel(r.published_at))}</small>`)}</article>`,
          )
          .join("") +
          (code
            ? ""
            : '<p class="caption">初步观察依据可见样本，优先观察需要当日完整覆盖且近五个交易日至少三次上涨上榜。</p>')
      : empty(
          code ? "保持观察" : "暂缓追涨",
          code
            ? "目前没有该行业的领先证据。等日涨幅和排名改善，再验证成交与成分股扩散。"
            : "现有可核验榜单暂无上涨的领先行业，或日涨幅暂缺。先等下一次收盘，观察上涨行业是否增多。",
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
  return `${card("A 股主要指数", cnRows(snapshot))}${advice(snapshot)}${climate(snapshot)}${macroSummary(snapshot)}${card("本次资料覆盖", `<div class="coverage"><div><strong>${industry?.valid_count ?? "—"}</strong><span>一级行业</span></div><div><strong>${globals.length}</strong><span>国际观测</span></div><div><strong>${dataOf(snapshot.modules.news)?.length ?? 0}</strong><span>资讯条目</span></div></div>${industry?.missing_session_dates.length ? `<p class="caption">行业窗口有 ${industry.missing_session_dates.length} 个交易日缺口，热度与回撤暂停计算。</p>` : ""}`)}${card(
    "最新行业涨幅",
    moduleNote(snapshot.modules.industry, "行业数据") +
      dailyRanking(latestIndustryDay(industry), 3) +
      '<a class="section-link" href="#/industry">查看每日 Top 10 与行业建议</a>',
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
  }${newsSection(snapshot, newsCount)}`;
}
function latestIndustryDay(data?: IndustryModule) {
  const days = data?.daily_returns ?? [];
  return (
    days.filter((day) => day.rows.length === data?.expected_count).at(-1) ??
    days.filter((day) => day.rows.length > 0).at(-1)
  );
}

function dailyRanking(day: IndustryDay | undefined, limit: number) {
  if (!day?.rows.length)
    return empty("该日涨幅不可计算", "需要当日与上一交易日的收盘数据。");
  const rows = day.rows.slice(0, limit);
  const extent = Math.max(0.01, ...rows.map((r) => Math.abs(r.change_pct)));
  return (
    `<p class="caption">${e(day.date)} · 可计算 ${day.rows.length} / 31 个行业${day.rows.length < 31 ? " · 按可用行业排名" : ""}</p>` +
    rows
      .map((r, i) => {
        const width = (Math.abs(r.change_pct) / extent) * 50;
        return `<a class="daily-row" href="#/industry/${encodeURIComponent(r.code)}"><span class="rank-number">${i + 1}</span><strong>${e(r.name)}</strong><b class="${direction(r.change_pct)}">${signed(r.change_pct)}</b><span class="daily-track" aria-hidden="true"><i class="${r.change_pct >= 0 ? "gain" : "loss"}" style="width:${width}%;left:${r.change_pct >= 0 ? 50 : 50 - width}%"></i></span></a>`;
      })
      .join("")
  );
}

function frequencyChart(data: IndustryModule) {
  const complete = (data.daily_returns ?? []).filter(
    (day) => day.rows.length === data.expected_count,
  );
  if (!complete.length)
    return empty("暂无完整榜单", "取得齐全的行业数据后统计上榜频率。");
  const counts = new Map<string, { name: string; count: number }>();
  for (const day of complete)
    for (const row of day.rows.slice(0, 10)) {
      const previous = counts.get(row.code)?.count ?? 0;
      counts.set(row.code, { name: row.name, count: previous + 1 });
    }
  const leaders = [...counts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"))
    .slice(0, 10);
  return `<p class="caption">近 30 个交易日中，按 ${complete.length} 天完整榜单统计。上榜不一定为正涨幅。</p>${leaders.map((r) => `<div class="frequency-row"><span>${e(r.name)}</span><meter min="0" max="${complete.length}" value="${r.count}" aria-label="${e(r.name)}上榜次数"></meter><b>${r.count} 天</b></div>`).join("")}`;
}

function industryPage(snapshot: Snapshot) {
  const m = snapshot.modules.industry,
    data = dataOf(m);
  if (!data)
    return (
      heading("INDUSTRY", "行业分析") +
      moduleNote(m, "行业") +
      card(
        "行业资料",
        empty("行业资料暂不可用", "可返回总览查看其他模块，或刷新资料重试。"),
      )
    );
  const daily = data.daily_returns ?? [];
  const latest = latestIndustryDay(data);
  const selected =
    daily.find((d) => d.date === selectedIndustryDate) ??
    latest ??
    daily.at(-1);
  const selector = daily.length
    ? `<label class="filter">交易日<select id="industry-date" aria-label="行业交易日"><option value="" ${selectedIndustryDate ? "" : "selected"}>最新有效榜单</option>${[
        ...daily,
      ]
        .reverse()
        .map(
          (d) =>
            `<option value="${e(d.date)}" ${selectedIndustryDate === d.date ? "selected" : ""}>${e(d.date)}${!d.rows.length ? " · 缺数据" : d.rows.length < 31 ? " · 部分覆盖" : ""}</option>`,
        )
        .join("")}</select></label>`
    : "";
  return (
    heading("INDUSTRY", "行业分析", "申万一级行业 · 近 30 个交易日逐日排行") +
    moduleNote(m, "行业") +
    (latest && daily.at(-1)?.date !== latest.date
      ? `<p class="module-note">最近完整榜单截至 ${e(latest.date)}。可切换日期查看其后的数据状态。</p>`
      : "") +
    card("当日涨幅 Top 10", selector + dailyRanking(selected, 10)) +
    sectorReviews(snapshot) +
    card("Top 10 上榜次数", frequencyChart(data)) +
    card(
      "计算口径",
      "<p>每日涨幅按当日收盘相对上一交易日收盘计算。前后任一日缺数据时留空。行业建议使用最近有数据的交易日。日榜覆盖或延续性不足时降为初步观察，并注明样本范围。</p>",
    )
  );
}

function dailyMoveChart(data: IndustryModule, code: string) {
  const days = data.daily_returns ?? [];
  const values = days.map(
    (d) => d.rows.find((r) => r.code === code)?.change_pct,
  );
  if (!values.some((v) => v !== undefined))
    return empty("暂无每日涨跌", "等待有效日线数据。");
  const extent = Math.max(0.01, ...values.map((v) => Math.abs(v ?? 0)));
  const cells = values
    .map((v, i) => {
      const label = e(
        days[i].date + " " + (v === undefined ? "缺数据" : signed(v)),
      );
      return `<span class="move-cell" title="${label}" aria-label="${label}">${v === undefined ? '<i class="missing"></i>' : `<i class="${v >= 0 ? "gain" : "loss"}" style="height:${Math.max(1, (Math.abs(v) / extent) * 50)}%;${v >= 0 ? "bottom" : "top"}:50%"></i>`}</span>`;
    })
    .join("");
  const list = values
    .map(
      (v, i) =>
        `<li>${e(days[i].date)} · ${v === undefined ? "缺数据" : signed(v)}</li>`,
    )
    .reverse()
    .join("");
  return `<p class="caption">零线上方为上涨，下方为下跌，灰点为缺数据。</p><div class="move-chart" aria-hidden="true">${cells}</div><div class="scale-labels"><span>${e(days[0].date)}</span><span>${e(days.at(-1)!.date)}</span></div>${fold("daily-" + code, "查看逐日数值", `<ul class="daily-values">${list}</ul>`)}`;
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
  const metrics: [string, number | null, string][] = [
    ["5 日涨跌", r.return_5d_pct, "%"],
    ["30 日涨跌", r.return_30d_pct, "%"],
    ["30 日相对沪深 300", r.excess_30d_pp, " 个百分点"],
    ["30 日最大回撤", r.max_drawdown_30d_pct, "%"],
  ];
  const short = r.return_5d_pct;
  const medium = r.return_30d_pct;
  const relative = r.excess_30d_pp;
  const directionNote =
    short == null || medium == null ? "等待收盘数据补齐后判断短中期方向。"
    : short > 0 && medium > 0 ? "短中期均上涨，观察后续收盘能否延续涨势。"
    : short < 0 && medium > 0 ? "中期上涨、短期回落，观察回落是否止住。"
    : short > 0 && medium < 0 ? "中期下跌、短期反弹，观察反弹能否延续。"
    : short < 0 && medium < 0 ? "短中期均下跌，观察跌幅是否收窄。"
    : "至少一个观察周期涨跌持平，等待下一交易日确认。";
  const relativeNote =
    relative == null ? "当前缺少同期对照数据。"
    : relative > 0 ? "同期跑赢沪深 300，复核超额表现能否延续。"
    : relative < 0 ? "同期跑输沪深 300，观察相对弱势是否收敛。"
    : "同期表现与沪深 300 持平。";
  const research = card("行业投资参考",
    `<p class="caption">截至 ${e(data.as_of_date)} 收盘 · 窗口内缺失收盘 ${r.missing_session_dates.length} 天</p>
     <dl>${metrics.map(([label, value, unit]) =>
       `<dt>${label}</dt><dd>${value == null ? "数据不足" : `${value.toFixed(2)}${unit}`}</dd>`,
     ).join("")}</dl>
     <h3>下一交易日观察</h3><ul><li>${directionNote}</li><li>${relativeNote}</li></ul>`);
  return `<a class="back-link" href="#/industry">返回行业排行</a>${heading(e(r.code) + " · 申万一级", e(r.name))}${moduleNote(m, "行业数据")}${research}${card("近 30 个交易日每日涨跌", dailyMoveChart(data, code))}${card("依据与来源", `${external(sourceURLs.sw, "申万宏源研究 · 行业指数")}${external(sourceURLs.eastmoney, "东方财富 · 沪深 300 基准")}${fold("industry-evidence", "查看计算方法与数据范围", "<p>涨幅按相邻两个交易日的收盘计算，遇到缺日留空。</p>")}<p class="caption">行业与新闻按标题关键词关联，不能据此确认催化或利好。</p>`)}${sectorReviews(snapshot, code)}${card("相关资讯线索", `<p class="caption">仅标题关键词关联，需阅读原文核验。</p>${(dataOf(snapshot.modules.macro)?.industry_news[code] ?? []).map(article).join("") || empty("暂无匹配资讯", "当前来源覆盖有限，未匹配不代表没有事件。")}`)}${card(
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
function globalClimate(snapshot: Snapshot) {
  const data = dataOf(snapshot.modules.macro)?.global_review;
  if (!data) return macroSummary(snapshot);
  const { score, label, markets, notes } = data;
  const meter = (value: number) =>
    `<div class="climate-scale" aria-hidden="true"><i style="left:${value}%"></i></div>`;
  const tiles = markets
    .map(
      (
        m,
      ) => `<article class="global-tile ${m.average_pct > 0.5 ? "warm" : m.average_pct < -0.5 ? "cool" : "flat"}">
    <strong>${e(m.name)}</strong><b class="${direction(m.average_pct)}">${signed(m.average_pct)}</b><span>样本平均涨跌</span>
    ${meter(m.score)}<small>${e(m.date)} · ${m.advancing}/${m.coverage} 上涨 · 覆盖 ${m.coverage}/${m.expected}</small></article>`,
    )
    .join("");
  return (
    card(
      "全球市场冷暖",
      `<div class="global-climate-summary"><div><strong>${e(label)}</strong>${score === null ? "" : `<b>${decimal(score, 1)} / 100</b>`}</div>${score === null ? '<p class="caption">综合冷暖需要同时覆盖美股和港股，并至少取得三只指数。样本不足时保留分市场走势。</p>' : meter(score) + '<div class="scale-labels"><span>冷</span><span>中性</span><span>暖</span></div>'}</div>
    ${tiles ? `<div class="global-tiles">${tiles}</div>` : ""}
    <p class="caption">由美股和港股指数样本计算，围绕 50 分按平均涨跌映射，两地等权。两地时间各自标注。覆盖不足时仅代表已取得的样本。美元、美债和商品另作分析。</p>`,
    ) +
    card(
      "跨资产研判",
      notes.length
        ? notes
            .map(
              (n) =>
                `<article class="global-insight"><h3>${e(n.title)}</h3><p>${e(n.text)}</p></article>`,
            )
            .join("")
        : empty("等待可比较的行情", "取得相应市场的变化数据后再分析。"),
    )
  );
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
    globalClimate(snapshot) +
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
    newsSection(snapshot, newsCount)
  );
}
function journalSection() {
  const row = journalEditing === "new" ? null : journalEditing;
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const form = journalEditing
    ? `<form id="journal-form" class="journal-form">
    <label>标的代码或名称<input name="symbol" required maxlength="40" value="${e(row?.symbol)}"></label>
    <div class="journal-grid"><label>记录日期<input name="date" type="date" required value="${e(row?.date ?? localDate)}"></label><label>类型<select name="kind" id="journal-kind"><option value="watch">观察计划</option><option value="trade" ${row?.kind === "trade" ? "selected" : ""}>交易记录</option></select></label></div>
    <fieldset id="journal-trade" ${row?.kind === "trade" ? "" : "hidden disabled"}><legend>价格和数量</legend><div class="journal-grid">
    <label>买入均价<input name="entry" type="number" step="any" min="0.000001" value="${e(row?.entry)}"></label>
    <label>数量<input name="quantity" type="number" step="1" min="1" value="${e(row?.quantity)}"></label>
    <label>卖出均价（选填）<input name="exit" type="number" step="any" min="0.000001" value="${e(row?.exit)}"></label>
    <label>合计费用（选填）<input name="fees" type="number" step="any" min="0" value="${e(row?.fees)}"></label></div></fieldset>
    <label>观察理由、触发或复盘<textarea name="note" maxlength="600" rows="3">${e(row?.note)}</textarea></label>
    <p id="journal-error" role="alert"></p><div class="journal-actions"><button class="primary" type="submit">保存记录</button><button class="text-button" type="button" data-action="journal-cancel">取消</button></div>
    </form>`
    : '<button class="primary" data-action="journal-new">新增记录</button>';
  const entries = [...journal]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((item) => {
      const pnl = realizedProfit(item);
      return `<article class="story journal-item"><strong>${e(item.symbol)}</strong><small>${e(item.date)} · ${item.kind === "watch" ? "观察计划" : "交易记录"}</small>${item.kind === "trade" ? `<p>买入 ${decimal(item.entry!, 4)} × ${item.quantity}${item.exit === null ? " · 待填写卖出价" : ` · 卖出 ${decimal(item.exit, 4)}`}</p>` : ""}
      ${pnl !== null ? `<p class="${direction(pnl)}">价差扣费后 ${signed(pnl, " 元")}</p>` : ""}${item.note ? `<p class="journal-note">${e(item.note)}</p>` : ""}<button class="text-button" data-action="journal-edit" data-value="${e(item.id)}">编辑</button></article>`;
    })
    .join("");
  return card(
    "我的跟踪记录",
    '<p class="caption">记录保存在当前浏览器。清理浏览器数据前可导出备份。</p>' +
      form +
      entries +
      (journal.length
        ? '<button class="text-button" data-action="journal-export">导出记录</button>'
        : ""),
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
      "跟踪",
      "记录你的计划与成交，并查看系统观察候选。",
    ) +
    journalSection() +
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
    !state.pending && state.note
      ? `<div class="notice" role="status">${e(state.note)}</div>`
      : "",
    age > 1
      ? '<div class="notice">这份资料已超过 24 小时未更新，请留意各模块截至时间。</div>'
      : "",
  ].join("");
  let content = "";
  if (!snapshot && route.page === "observe" && !route.code)
    content = heading("RESEARCH WATCH", "跟踪") + journalSection();
  else if (!snapshot)
    content =
      heading("MARKET WEATHER", "市场资料工作台") +
      (state.loading
        ? '<div class="card loading" role="status"><div class="skeleton"></div><h2>正在读取最新资料</h2><p class="muted">无需登录，保留各市场的数据时间。</p></div>'
        : card(
            "暂未取得资料",
            empty(
              "没有可读取的市场快照",
              "后台发布行情后，页面会读取最新资料。",
            ),
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
  app.innerHTML = `<a class="skip-link" href="#main-content">跳到主要内容</a><div class="app-shell"><header><a class="brand" href="#/" aria-label="股市气象站首页"><span aria-hidden="true">◒</span><div><b>股市气象站</b><small>最新资料 · 公开阅读</small></div></a><button type="button" class="refresh" data-action="refresh" ${refreshing ? "disabled" : ""}>刷新数据</button></header>${banner}<main id="main-content" tabindex="-1"><div class="snapshot-meta">${snapshot ? `<span>上次发布 ${e(timeLabel(snapshot.published_at))} 北京时间</span><small>${state.fromCache ? "本机缓存 · " : ""}交易日 08:45 / 11:45 / 17:30 采集</small>${state.checkedAt ? `<small>最近检查 ${e(timeLabel(state.checkedAt))} 北京时间</small>` : ""}` : state.loading ? "<span>正在读取资料快照</span>" : "<span>暂无有效资料快照</span>"}</div><p class="module-note" role="status" ${refreshMessage ? "" : "hidden"}>${e(refreshMessage)}</p>${content}<footer><p>行情以各市场时间为准 · 无需登录阅读</p></footer></main>${nav()}</div>`;

  document.title =
    (route.page === "industry"
      ? "行业分析"
      : route.page === "global"
        ? "全球与宏观"
        : route.page === "observe"
          ? "跟踪"
          : "市场总览") + " · 股市气象站";
  requestAnimationFrame(() => {
    window.scrollTo({ top: y, behavior: "instant" });
    if (!preserve)
      document.getElementById("main-content")?.focus({ preventScroll: true });
    else if (focused)
      document.getElementById(focused)?.focus({ preventScroll: true });
  });
}
async function refreshPublishedData() {
  if (refreshing) return;
  refreshing = true;
  refreshMessage = "正在检查已发布数据…";
  if (!journalEditing) render();
  try {
    await store.refresh();
    if (store.state.pending) {
      store.acceptPending();
      refreshMessage = "已载入最新发布的数据。";
    } else {
      refreshMessage = store.state.error
        ? "检查失败，请稍后重试。"
        : store.state.snapshot ? "当前已是最新发布版本。" : "暂无已发布数据。";
    }
  } finally {
    refreshing = false;
    if (!journalEditing) render();
  }
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
    case "news-mode":
      newsMode = el.dataset.value === "recent" ? "recent" : "important";
      newsCount = 10;
      render();
      break;
    case "more-news":
      newsCount += 10;
      render();
      break;
    case "refresh":
      void refreshPublishedData();
      break;
    case "journal-new":
      journalEditing = "new";
      render();
      document
        .querySelector<HTMLInputElement>('#journal-form [name="symbol"]')
        ?.focus();
      break;
    case "journal-edit":
      journalEditing =
        journal.find((row) => row.id === el.dataset.value) ?? null;
      render();
      document
        .getElementById("journal-form")
        ?.scrollIntoView({ block: "center" });
      break;
    case "journal-cancel":
      journalEditing = null;
      render();
      break;
    case "journal-export": {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(journal, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "market-weather-journal.json";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      break;
    }
  }
});
app.addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.id === "journal-kind") {
    const cells = document.querySelector<HTMLFieldSetElement>("#journal-trade");
    if (cells) cells.disabled = cells.hidden = target.value !== "trade";
  }
  if (target.id === "industry-date") {
    selectedIndustryDate = target.value;
    render();
  }
  if (target.id === "news-source") {
    newsFilter = target.value;
    newsCount = 10;
    render();
  }
});
app.addEventListener("submit", (event) => {
  if (
    !(event.target instanceof HTMLFormElement) ||
    event.target.id !== "journal-form"
  )
    return;
  event.preventDefault();
  const fields = new FormData(event.target);
  const text = (name: string) => String(fields.get(name) ?? "").trim();
  const number = (name: string) => (text(name) ? Number(text(name)) : null);
  const trade = text("kind") === "trade";
  const editing = journalEditing === "new" ? null : journalEditing;
  const row: JournalEntry = {
    id: editing?.id ?? crypto.randomUUID(),
    date: text("date"),
    symbol: text("symbol"),
    kind: trade ? "trade" : "watch",
    note: text("note"),
    entry: trade ? number("entry") : null,
    exit: trade ? number("exit") : null,
    quantity: trade ? number("quantity") : null,
    fees: trade ? number("fees") : null,
  };
  const feedback = document.getElementById("journal-error");
  if (!feedback) return;
  if (!validEntry(row)) {
    feedback.textContent = "请核对日期和标的。交易记录需要有效买入均价和数量。";
    return;
  }
  const next = editing
    ? journal.map((r) => (r.id === row.id ? row : r))
    : [row, ...journal];
  if (next.length > 300) {
    feedback.textContent = "当前最多保存300条记录，请先导出备份。";
    return;
  }
  try {
    saveJournal(next, cache);
  } catch {
    feedback.textContent = "保存失败。浏览器存储受限或空间不足。";
    return;
  }
  journal = next;
  journalEditing = null;
  render();
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
  journalEditing = null;
  render(false);
});
store.subscribe(() => {
  if (!journalEditing) render();
});
render(false);
void store.refresh().then(() => {
  if (!store.state.error) store.acceptPending();
});
