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
}

const key = "market-weather:private-journal:v1";
const validNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e10;
export function validEntry(value: unknown): value is JournalEntry {
  if (!value || typeof value !== "object") return false;
  const r = value as JournalEntry;
  if (!(
    typeof r.id === "string" &&
    /^[\w-]{1,80}$/.test(r.id) &&
    typeof r.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
    Number.isFinite(Date.parse(r.date)) &&
    new Date(r.date).toISOString().slice(0, 10) === r.date &&
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
