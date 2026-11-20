import { test } from "node:test";
import assert from "node:assert/strict";
import {
  realizedProfit,
  validEntry,
  saveJournal,
  readJournal,
  type JournalEntry,
} from "../../web/src/lib/journal.ts";

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
