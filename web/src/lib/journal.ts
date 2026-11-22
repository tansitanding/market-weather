import type { Snapshot } from "../contracts.ts";

export interface JournalEntry {
  id: string;
  date: string;
  symbol: string;
  kind: "watch" | "trade";
  note: string;
  entry: number | null;
  exit: number | null;
  quantity: number | null;
  fees: number | null;
  target?: { kind: "industry" | "stock"; code: string };
  confirm?: string;
  invalidate?: string;
  nextCheck?: string;
  reviewDate?: string;
  outcome?: "watching" | "confirmed" | "invalidated" | "closed";
  checkIndustryRank?: boolean;
}

const key = "market-weather:private-journal:v1";
const validNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e10;
const validDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function validEntry(value: unknown): value is JournalEntry {
  if (!value || typeof value !== "object") return false;
  const r = value as JournalEntry;
  if (!(
    typeof r.id === "string" &&
    /^[\w-]{1,80}$/.test(r.id) &&
    validDate(r.date) &&
    typeof r.symbol === "string" &&
    !!r.symbol.trim() &&
    r.symbol.length <= 40 &&
    typeof r.note === "string" &&
    r.note.length <= 600 &&
    [r.entry, r.exit, r.quantity, r.fees].every(
      (v) => v === null || validNumber(v),
    )
  ))
    return false;
  if (
    ![r.confirm, r.invalidate, r.nextCheck].every(
      (v) => v === undefined || (typeof v === "string" && v.length <= 600),
    ) ||
    (r.reviewDate !== undefined && !validDate(r.reviewDate)) ||
    (r.outcome !== undefined && !["watching", "confirmed", "invalidated", "closed"].includes(r.outcome)) ||
    (r.target !== undefined && (
      !r.target || !["industry", "stock"].includes(r.target.kind) ||
      typeof r.target.code !== "string" || !/^\d{6}$/.test(r.target.code)
    )) ||
    (r.checkIndustryRank !== undefined && (
      typeof r.checkIndustryRank !== "boolean" || (r.checkIndustryRank && r.target?.kind !== "industry")
    ))
  ) return false;
  if (r.kind === "watch")
    return [r.entry, r.exit, r.quantity, r.fees].every((v) => v === null);
  return (
    r.kind === "trade" &&
    r.entry !== null &&
    r.entry > 0 &&
    r.quantity !== null &&
    Number.isSafeInteger(r.quantity) &&
    r.quantity > 0 &&
    (r.exit === null || r.exit > 0)
  );
}
export function readJournal(storage?: Storage): JournalEntry[] {
  try {
    const rows: unknown = JSON.parse(storage?.getItem(key) ?? "[]");
    return Array.isArray(rows) ? rows.filter(validEntry).slice(0, 300) : [];
  } catch {
    return [];
  }
}
export function saveJournal(rows: JournalEntry[], storage?: Storage) {
  if (!storage) throw Error("当前浏览器无法存储记录。");
  storage.setItem(key, JSON.stringify(rows));
}
export function realizedProfit(row: JournalEntry) {
  if (row.entry === null || row.exit === null || row.quantity === null)
    return null;
  return (row.exit - row.entry) * row.quantity - (row.fees ?? 0);
}

export function mergeJournalBackup(raw: string, current: JournalEntry[]) {
  const imported: unknown = JSON.parse(raw);
  if (!Array.isArray(imported) || imported.length > 300 || !imported.every(validEntry)) {
    throw Error("备份格式无效，或超过 300 条记录。");
  }
  const byId = new Map(current.map((row) => [row.id, row]));
  for (const row of imported) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  if (byId.size > 300) throw Error("合并后超过 300 条，当前记录已保留。");
  return { rows: [...byId.values()], added: byId.size - current.length };
}

export function journalMarkdown(rows: JournalEntry[]) {
  const safe = (value: string | number) =>
    String(value).replace(/[&<>"']/g, (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
    ).replace(/[\r\n]+/g, " ").replace(/[\\`*_{}\[\]|!]/g, "\\$&");
  const field = (label: string, value: string | number | null | undefined) =>
    value == null || value === "" ? [] : [`- ${label}：${safe(value)}`];
  return ["# 股市气象站 · 私人复盘", "", ...[...rows]
    .sort((a, b) => b.date.localeCompare(a.date))
    .flatMap((row) => [
      `## ${row.date} · ${safe(row.symbol)}`,
      ...field("类型", row.kind === "watch" ? "观察计划" : "交易记录"),
      ...field("理由 / 复盘", row.note),
      ...field("关联代码", row.target?.code),
      ...field("状态", row.kind === "watch" ? watchOutcome(row) : undefined),
      ...field("条件", row.checkIndustryRank ? "完整行业榜上涨且进入前十" : undefined),
      ...field("确认条件", row.confirm),
      ...field("失效条件", row.invalidate),
      ...field("下次检查", row.nextCheck),
      ...field("复查日期", row.reviewDate),
      ...field("买入均价", row.entry),
      ...field("卖出均价", row.exit),
      ...field("数量", row.quantity),
      ...field("费用", row.fees),
      "",
    ])].join("\n");
}

export function watchOutcome(row: JournalEntry) {
  return {
    watching: "观察中", confirmed: "已确认", invalidated: "已失效", closed: "已结束",
  }[row.outcome ?? "watching"];
}

export function watchReview(row: JournalEntry, snapshot?: Snapshot) {
  if (row.target?.kind === "industry" && row.checkIndustryRank) {
    const module = snapshot?.modules.industry;
    const data = module?.data;
    const days = data?.daily_returns ?? [];
    const latest = days.at(-1);
    const prior = days.at(-2);
    if (!data || !latest || module?.status === "stale" || module?.status === "failed" ||
        data.freshness === "stale" || data.freshness === "lags_benchmark" ||
        latest.rows.length !== data.expected_count || latest.date < row.date ||
        !latest.rows.some((item) => item.code === row.target?.code)) {
      return { label: "数据不足", detail: "等待计划建立后、覆盖完整的最新行业收盘榜。", priority: 1 };
    }
    const result = (day: typeof latest) => {
      const rank = day.rows.findIndex((item) => item.code === row.target?.code);
      const change = day.rows[rank]?.change_pct;
      return { rank: rank + 1, change, fits: rank >= 0 && rank < 10 && change > 0 };
    };
    const current = result(latest);
    const previous = prior?.rows.length === data.expected_count &&
      prior.rows.some((item) => item.code === row.target?.code) ? result(prior) : null;
    const detail = `${latest.date} 收盘 · 第 ${current.rank} 名 · ${current.change.toFixed(2)}%`;
    if (previous && previous.fits !== current.fits) {
      return { label: current.fits ? "新进入上涨前十" : "已退出上涨前十", detail, priority: 3 };
    }
    if (current.fits) return { label: "榜单条件已符合", detail, priority: 2 };
    if (current.change > 0 && current.rank <= 13)
      return { label: "接近榜单条件", detail, priority: 2 };
    return { label: "榜单条件未符合", detail, priority: 0 };
  }
  if (row.target?.kind === "stock") {
    const module = snapshot?.modules.observations;
    const card = module?.status === "succeeded" || module?.status === "partial"
      ? module.data?.find((item) => item.code === row.target?.code)
      : undefined;
    if (card) return { label: "本期有研究卡", detail: card.conclusion, priority: 1 };
    return { label: "待手动复核", detail: "当前没有该股的可用研究卡。", priority: 0 };
  }
  return { label: "待手动复核", detail: "", priority: 0 };
}
