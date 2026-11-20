export type ModuleStatus = "succeeded" | "partial" | "failed" | "stale";
export interface SourceError {
  code: string;
  message: string;
}
export interface DataModule<T> {
  status: ModuleStatus;
  data?: T;
  collected_at?: string;
  source_as_of_date?: string;
  carried_forward?: boolean;
  error?: SourceError;
  explanation?: string;
  pool_count?: number;
  validated_count?: number;
  market_gate?: string;
}
export interface Bar {
  date: string;
  close: number;
  amount: number | null;
}
export interface CNMarket {
  benchmark: Bar[];
  indices: Record<string, Bar[]>;
}
export interface IndustryRecord {
  code: string;
  name: string;
  return_30d_pct: number;
  excess_30d_pp: number;
  return_5d_pct: number;
  max_drawdown_30d_pct: number | null;
  missing_session_dates: string[];
  transaction_heat_30d_share_pct?: number;
  heat_rising_5v25_pct?: number;
  series: { date: string; cumulative_return_pct: number }[];
}
export interface IndustryDay {
  date: string;
  rows: { code: string; name: string; change_pct: number }[];
}
export interface IndustryModule {
  status: "succeeded" | "partial";
  classification: "SW2021_L1";
  expected_count: number;
  valid_count: number;
  as_of_date: string;
  window_start: string;
  return_intervals: number;
  heat_status: "succeeded" | "unavailable";
  heat_reason: string | null;
  freshness: "stale" | "lags_benchmark" | "latest_available";
  missing_session_dates: string[];
  benchmark: {
    code: string;
    name: string;
    return_30d_pct: number;
    series?: { date: string; cumulative_return_pct: number }[];
  };
  recommendations?: SectorReview[];
  daily_returns?: IndustryDay[];
  rankings: {
    return_top: string[];
    transaction_heat_top: string[];
    heat_rising_top: string[];
  };
  industries: IndustryRecord[];
}
export interface NewsItem {
  importance_score?: number;
  importance_reason?: string;
  related_sources?: { source: string; url: string }[];

  event_id: string;
  title: string;
  url: string;
  source: string;
  published_at: string | null;
  published_date: string;
  date_precision: "second" | "day";
  collected_at: string;
  event_occurred_at: string | null;
}
export interface GlobalQuote {
  symbol: string;
  name: string;
  asset_type: string;
  price: number;
  unit: string;
  currency?: string;
  observed_at: string;
  market_date: string;
  exchange_timezone: string;
  source: string;
  change_vs_previous_day_close_pct: number | null;
  change_bp: number | null;
  freshness: "stale" | "latest_available";
  is_live_guaranteed: false;
}
export interface ResearchCard {
  code: string;
  name: string;
  state: string;
  conclusion: string;
  trigger: string;
  invalidation: string;
  risks: string[];
  evidence: { title: string; url: string; published_at: string }[];
  published_at: string;
}
export interface Snapshot {
  schema_version: "1.0";
  snapshot_id: string;
  started_at: string;
  published_at: string;
  public_access_requires_login: false;
  timezone: "Asia/Shanghai";
  analysis_status: string;
  modules: {
    industry: DataModule<IndustryModule>;
    investment?: DataModule<InvestmentPlan>;
    news: DataModule<NewsItem[]>;
    global: DataModule<GlobalQuote[]>;
    cn_market: DataModule<CNMarket>;
    observations?: DataModule<ResearchCard[]>;
    temperature?: DataModule<Temperature>;
    macro?: DataModule<MacroReview>;
    tracking?: DataModule<TrackedSignal[]>;
  };
}

export interface Temperature {
  score: number;
  label: string;
  as_of_date: string;
  basis: string;
  calibration: string;
  components: { name: string; score: number; weight: number; detail: string }[];
}
export interface SectorReview {
  code: string;
  name: string;
  state: string;
  conclusion: string;
  trigger: string;
  invalidation: string;
  risks: string[];
  published_at: string;
  rule_version: string;
}
export interface MacroReview {
  method: string;
  facts: { title: string; text: string; as_of: string; source_url: string }[];
  interpretation: string;
  counter_evidence: string;
  industry_news: Record<string, NewsItem[]>;
}
export interface TrackedSignal {
  id: string;
  code: string;
  name: string;
  status: string;
  created_at: string;
  note: string;
  horizons: Record<
    string,
    {
      date: string;
      net_return_pct: number;
      benchmark_return_pct?: number | null;
      excess_pp?: number | null;
      exit_reason: string;
    }
  >;
}

export interface InvestmentPlan {
  as_of_date: string;
  sector_date: string | null;
  stance: string;
  action: string;
  evidence: string[];
  confirm: string;
  invalidate: string;
  risk: string;
  rule_version: string;
}
