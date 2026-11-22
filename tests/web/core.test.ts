import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "./fixture.ts";
import { parseSnapshot, safeURL } from "../../web/src/lib/validate.ts";
import {
  segments,
  comparisonData,
  parseRoute,
  escapeHTML,
} from "../../web/src/lib/presentation.ts";
test("valid snapshot isolates modules and uses basis points for yields", () => {
  const s = parseSnapshot(snapshot());
  assert.equal(s.modules.industry.data?.valid_count, 1);
  assert.equal(
    s.modules.global.data?.[0].change_vs_previous_day_close_pct,
    null,
  );
  assert.equal(s.modules.global.data?.[0].change_bp, 10);
});
test("unsupported envelope and timezone-less timestamps are rejected", () => {
  for (const field of ["schema_version", "started_at"]) {
    const s = snapshot();
    s[field] = "invalid";
    assert.throws(() => parseSnapshot(s));
  }
});
test("invalid numeric module does not remove other usable modules", () => {
  const s = snapshot();
  s.modules.industry.data.industries[0].return_30d_pct = NaN;
  const result = parseSnapshot(s);
  assert.equal(result.modules.industry.status, "failed");
  assert.equal(result.modules.news.data?.length, 1);
});
test("unsafe news links never enter the rendering model", () => {
  const s = snapshot();
  s.modules.news.data[0].url = "javascript:alert(1)";
  const result = parseSnapshot(s);
  assert.equal(result.modules.news.status, "failed");
  assert.equal(result.modules.news.data, undefined);
});
test("unsupported protocols and credential-bearing URLs are rejected", () => {
  for (const u of [
    "javascript:alert(1)",
    "data:text/html,test",
    "//example.com",
    "https://user:secret@example.com",
  ])
    assert.equal(safeURL(u), null);
  assert.equal(safeURL("https://example.com/a"), "https://example.com/a");
});
test("day-precision news does not invent midnight time", () => {
  const s = snapshot();
  s.modules.news.data[0].date_precision = "day";
  s.modules.news.data[0].published_at = null;
  assert.equal(parseSnapshot(s).modules.news.data?.[0].published_at, null);
});
test("heat is disabled when the universe is incomplete even if upstream claims success", () => {
  const s = snapshot();
  s.modules.industry.data.heat_status = "succeeded";
  assert.equal(
    parseSnapshot(s).modules.industry.data?.heat_status,
    "unavailable",
  );
});
test("known missing dates cannot remain in an industry series", () => {
  const s = snapshot();
  s.modules.industry.data.industries[0].series.push({
    date: "2026-11-17",
    cumulative_return_pct: 2,
  });
  assert.equal(parseSnapshot(s).modules.industry.status, "failed");
});
test("chart uses benchmark session positions and breaks at missing industry dates", () => {
  const s = parseSnapshot(snapshot()),
    r = s.modules.industry.data!.industries[0];
  const data = comparisonData(s, r);
  assert.equal(data.industry[1].value, null);
  assert.deepEqual(
    segments(
      data.industry,
      (i) => i,
      (v) => v,
    ),
    ["M0.00,0.00", "M2.00,3.00 L3.00,5.00"],
  );
  assert.equal(data.benchmark.length, 4);
});
test("hash routes work with project subpaths and reject malformed detail paths", () => {
  assert.deepEqual(parseRoute("#/industry/801080"), {
    page: "industry",
    code: "801080",
  });
  assert.equal(parseRoute("#/industry/%3Cscript%3E").page, "notfound");
  assert.equal(parseRoute("#/global/other").page, "notfound");
  assert.equal(parseRoute("#/advice").page, "advice");
  assert.equal(parseRoute("#/advice/other").page, "notfound");
  assert.equal(parseRoute("").page, "home");
});
test("rendered text is escaped, including long or injected titles", () => {
  assert.equal(
    escapeHTML('<img src=x onerror="x">'),
    "&lt;img src=x onerror=&quot;x&quot;&gt;",
  );
});
test("research-card contract preserves evidence and distinguishes an empty published pool", () => {
  const s = snapshot();
  s.modules.observations = { status: "succeeded", data: [] };
  assert.deepEqual(parseSnapshot(s).modules.observations?.data, []);
  s.modules.observations.data = [
    {
      code: "TEST-A",
      name: "测试证券",
      state: "待触发",
      conclusion: "测试结论",
      trigger: "测试条件",
      invalidation: "测试失效",
      risks: ["测试风险"],
      published_at: s.published_at,
      evidence: [
        {
          title: "测试来源",
          url: "https://example.com/evidence",
          published_at: s.published_at,
        },
      ],
    },
  ];
  assert.equal(parseSnapshot(s).modules.observations?.data?.[0].code, "TEST-A");
  s.modules.observations.data[0].evidence[0].url = "javascript:alert(1)";
  assert.equal(parseSnapshot(s).modules.observations?.status, "failed");
});
test("temperature bounds fail independently and valid weights are preserved", () => {
  const s = snapshot();
  s.modules.temperature = {
    status: "succeeded",
    data: {
      score: 36.4,
      label: "偏冷",
      as_of_date: "2026-11-20",
      basis: "完整日终",
      calibration: "未经验证",
      components: [{ name: "趋势", score: 36.4, weight: 1, detail: "测试" }],
    },
  };
  assert.equal(parseSnapshot(s).modules.temperature?.data?.score, 36.4);
  s.modules.temperature.data.score = 101;
  assert.equal(parseSnapshot(s).modules.temperature?.status, "failed");
  assert.equal(parseSnapshot(s).modules.news.data?.length, 1);
});
test("public derived benchmark series remains comparable after raw history trimming", () => {
  const s = snapshot();
  s.modules.industry.data.benchmark.series = [
    { date: "2026-11-16", cumulative_return_pct: 0 },
    { date: "2026-11-17", cumulative_return_pct: 1 },
    { date: "2026-11-18", cumulative_return_pct: 2 },
    { date: "2026-11-19", cumulative_return_pct: 3 },
  ];
  s.modules.cn_market.data.benchmark =
    s.modules.cn_market.data.benchmark.slice(-2);
  const p = parseSnapshot(s);
  const points = comparisonData(p, p.modules.industry.data!.industries[0]);
  assert.equal(points.dates.length, 4);
  assert.equal(points.benchmark.at(-1)?.value, 3);
});
test("tracking requires paper label and keeps versioned signal identifiers", () => {
  const s = snapshot();
  s.modules.tracking = {
    status: "succeeded",
    data: [
      {
        id: "600000-2026-11-20-research-v1.0",
        code: "600000",
        name: "测试",
        status: "watching",
        created_at: s.published_at,
        note: "纸面",
        modelled: true,
        horizons: {},
      },
    ],
  };
  assert.equal(parseSnapshot(s).modules.tracking?.data?.length, 1);
  s.modules.tracking.data[0].modelled = false;
  assert.equal(parseSnapshot(s).modules.tracking?.status, "failed");
});
