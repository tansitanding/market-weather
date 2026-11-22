import type { Snapshot, IndustryRecord, DataModule } from "../contracts.ts";
export function escapeHTML(v: unknown): string {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export const decimal = (v: number, digits = 2) =>
  new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(v);
export const signed = (v: number | null | undefined, unit = "%") =>
  v == null ? "暂不可计算" : `${v > 0 ? "+" : ""}${decimal(v)}${unit}`;
export const direction = (v: number | null | undefined) =>
  v == null ? "muted" : v > 0 ? "up" : v < 0 ? "down" : "muted";
export function timeLabel(v: string, zone = "Asia/Shanghai") {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: zone,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(v));
  } catch {
    return "时间待核验";
  }
}
export function dataOf<T>(m: DataModule<T> | undefined): T | undefined {
  return m?.status === "failed" ? undefined : m?.data;
}
export type Route = {
  page: "home" | "industry" | "global" | "advice" | "observe" | "notfound";
  code?: string;
};
export function parseRoute(hash: string): Route {
  const p = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (!p.length) return { page: "home" };
  if (p[0] === "industry" && p.length <= 2 && (!p[1] || /^\d{6}$/.test(p[1])))
    return { page: "industry", code: p[1] };
  if (p[0] === "advice" && p.length === 1) return { page: "advice" };
  if (p[0] === "global" && p.length === 1) return { page: "global" };
  if (
    p[0] === "observe" &&
    p.length <= 2 &&
    (!p[1] || /^[A-Za-z0-9._-]+$/.test(p[1]))
  )
    return { page: "observe", code: p[1] };
  return { page: "notfound" };
}
export interface Point {
  date: string;
  value: number | null;
}
export function segments(
  points: Point[],
  x: (i: number) => number,
  y: (v: number) => number,
): string[] {
  const paths: string[] = [];
  let current = "";
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current) paths.push(current);
      current = "";
    } else
      current += `${current ? " L" : "M"}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`;
  });
  if (current) paths.push(current);
  return paths;
}
export function comparisonData(
  snapshot: Snapshot,
  record: IndustryRecord,
): { industry: Point[]; benchmark: Point[]; dates: string[] } {
  const m = dataOf(snapshot.modules.industry);
  if (!m) return { industry: [], benchmark: [], dates: [] };
  const bars = (dataOf(snapshot.modules.cn_market)?.benchmark ?? []).filter(
    (b) => b.date >= m.window_start && b.date <= m.as_of_date,
  );
  if (m.benchmark.series?.length) {
    const points = m.benchmark.series;
    const map = new Map(
      record.series.map((p) => [p.date, p.cumulative_return_pct]),
    );
    return {
      dates: points.map((p) => p.date),
      benchmark: points.map((p) => ({
        date: p.date,
        value: p.cumulative_return_pct,
      })),
      industry: points.map((p) => ({
        date: p.date,
        value: record.missing_session_dates.includes(p.date)
          ? null
          : (map.get(p.date) ?? null),
      })),
    };
  }
  const dates = bars.map((b) => b.date);
  const map = new Map(
    record.series.map((p) => [p.date, p.cumulative_return_pct]),
  );
  if (!dates.length) return { industry: [], benchmark: [], dates: [] };
  return {
    dates,
    industry: dates.map((date) => ({
      date,
      value: record.missing_session_dates.includes(date)
        ? null
        : (map.get(date) ?? null),
    })),
    benchmark: bars.map((b) => ({
      date: b.date,
      value: (b.close / bars[0].close - 1) * 100,
    })),
  };
}
