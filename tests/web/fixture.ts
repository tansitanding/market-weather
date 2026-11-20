// Synthetic unit-test data only. This file is never loaded by the product.
export function snapshot(id = "test-1", time = "2026-11-20T07:00:00Z"): any {
  return {
    schema_version: "1.0",
    snapshot_id: id,
    started_at: time,
    published_at: time,
    public_access_requires_login: false,
    timezone: "Asia/Shanghai",
    analysis_status: "phase_5_not_implemented",
    modules: {
      industry: {
        status: "partial",
        source_as_of_date: "2026-11-19",
        data: {
          status: "partial",
          classification: "SW2021_L1",
          expected_count: 31,
          valid_count: 1,
          as_of_date: "2026-11-19",
          window_start: "2026-11-16",
          return_intervals: 30,
          heat_status: "unavailable",
          heat_reason: "missing_official_trading_sessions",
          freshness: "lags_benchmark",
          missing_session_dates: ["2026-11-17"],
          benchmark: { code: "000300", name: "测试基准", return_30d_pct: 2 },
          rankings: {
            return_top: ["801080"],
            transaction_heat_top: [],
            heat_rising_top: [],
          },
          industries: [
            {
              code: "801080",
              name: "测试行业",
              return_30d_pct: 5,
              excess_30d_pp: 3,
              return_5d_pct: 1,
              max_drawdown_30d_pct: null,
              missing_session_dates: ["2026-11-17"],
              series: [
                { date: "2026-11-16", cumulative_return_pct: 0 },
                { date: "2026-11-18", cumulative_return_pct: 3 },
                { date: "2026-11-19", cumulative_return_pct: 5 },
              ],
            },
          ],
        },
      },
      cn_market: {
        status: "succeeded",
        data: {
          benchmark: [
            { date: "2026-11-16", close: 100, amount: 100 },
            { date: "2026-11-17", close: 101, amount: 100 },
            { date: "2026-11-18", close: 100, amount: 100 },
            { date: "2026-11-19", close: 102, amount: 100 },
          ],
          indices: {},
        },
      },
      news: {
        status: "succeeded",
        data: [
          {
            event_id: "n1",
            title: "测试资讯",
            url: "https://example.com/news",
            source: "fed",
            published_at: time,
            published_date: "2026-11-20",
            date_precision: "second",
            collected_at: time,
            event_occurred_at: null,
          },
        ],
      },
      global: {
        status: "succeeded",
        data: [
          {
            symbol: "^TNX",
            name: "测试收益率",
            asset_type: "yield",
            price: 4.2,
            unit: "percent_yield",
            observed_at: time,
            market_date: "2026-11-19",
            exchange_timezone: "America/New_York",
            source: "yahoo",
            change_vs_previous_day_close_pct: 5,
            change_bp: 10,
            freshness: "latest_available",
          },
        ],
      },
    },
  };
}
