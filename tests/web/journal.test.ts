import { test } from "node:test";
import assert from "node:assert/strict";
import {
  realizedProfit,
  mergeJournalBackup,
  journalMarkdown,
  watchReview,
  validEntry,
  saveJournal,
  readJournal,
  type JournalEntry,
} from "../../web/src/lib/journal.ts";
import { snapshot } from "./fixture.ts";

test("records persist in the selected browser storage and compute fees only for closed trades", () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
  } as Storage;
  const entry: JournalEntry = {
    id: "sample",
    symbol: "测试",
    date: "2026-11-20",
    kind: "trade",
    note: "复盘",
    entry: 10,
    exit: null,
    quantity: 100,
    fees: 8,
  };
  assert.ok(validEntry(entry));
  saveJournal([entry], storage);
  assert.deepEqual(readJournal(storage), [entry]);
  assert.equal(realizedProfit(entry), null);
  assert.equal(realizedProfit({ ...entry, exit: 11 }), 92);
  assert.equal(validEntry({ ...entry, date: "2026-02-30" }), false);
  assert.equal(validEntry({ ...entry, quantity: 0 }), false);
});

const watch: JournalEntry = {
  id: "watch", date: "2026-11-18", symbol: "测试行业", kind: "watch", note: "测试",
  entry: null, exit: null, quantity: null, fees: null,
  target: { kind: "industry", code: "801080" }, checkIndustryRank: true,
  nextCheck: "收盘后复查", reviewDate: "2026-11-20",
};
test("imports legacy and new plans without overwriting current records", () => {
  const { target, checkIndustryRank, nextCheck, reviewDate, ...legacy } = watch;
  const result = mergeJournalBackup(JSON.stringify([legacy, { ...watch, id: "next" }]), [watch]);
  assert.equal(result.added, 1);
  assert.deepEqual(result.rows[0], watch);
  assert.equal(result.rows[1].nextCheck, "收盘后复查");
  assert.throws(() => mergeJournalBackup(JSON.stringify([{ ...watch, reviewDate: "2026-02-30" }]), [watch]));
  assert.match(journalMarkdown(result.rows), /收盘后复查/);
  assert.match(journalMarkdown([{ ...watch, note: "<script>" }]), /&lt;script&gt;/);
});
test("industry watch identifies changes only on a complete current session", () => {
  const brief = snapshot();
  const module = brief.modules.industry;
  const rows = Array.from({ length: 30 }, (_, index) => ({
    code: String(900000 + index), name: "其他", change_pct: 1,
  }));
  const entry = { code: "801080", name: "测试行业", change_pct: 2 };
  module.data.freshness = "latest_available";
  module.data.daily_returns = [
    { date: "2026-11-18", rows: [...rows, { ...entry, change_pct: -1 }] },
    { date: "2026-11-19", rows: [entry, ...rows] },
  ];
  assert.equal(watchReview(watch, brief).label, "新进入上涨前十");
  module.data.daily_returns[1].rows = rows;
  assert.equal(watchReview(watch, brief).label, "数据不足");
  module.data.daily_returns[1].rows = [entry, ...rows];
  module.status = "stale";
  assert.equal(watchReview(watch, brief).label, "数据不足");
  assert.equal(watchReview({ ...watch, checkIndustryRank: false }, brief).label, "待手动复核");
});
