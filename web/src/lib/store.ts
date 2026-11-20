import type { Snapshot } from "../contracts.ts";
import { parseSnapshot } from "./validate.ts";
export interface Cache {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
export interface State {
  snapshot: Snapshot | null;
  pending: Snapshot | null;
  loading: boolean;
  error: string | null;
  note: string | null;
  fromCache: boolean;
  checkedAt: string | null;
}
export class SnapshotStore {
  state: State = {
    snapshot: null,
    pending: null,
    loading: false,
    error: null,
    note: null,
    fromCache: false,
    checkedAt: null,
  };
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;
  private url: string;
  private cache?: Cache;
  private fetcher: typeof fetch;
  private timeoutMs: number;
  private cacheKey: string;
  constructor(
    url: string,
    cache?: Cache,
    fetcher: typeof fetch = fetch,
    timeoutMs = 12000,
    cacheKey = "market-weather:snapshot:v1",
  ) {
    this.cacheKey = cacheKey;
    this.url = url;
    this.cache = cache;
    this.fetcher = (input, init) => fetcher(input, init);
    this.timeoutMs = timeoutMs;
    try {
      const saved = cache?.getItem(cacheKey);
      if (saved) {
        this.state.snapshot = parseSnapshot(JSON.parse(saved));
        this.state.fromCache = true;
      }
    } catch {
      /* Corrupt or unavailable storage never blocks reading. */
    }
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((fn) => fn());
  }
  private save(snapshot: Snapshot) {
    this.state.snapshot = snapshot;
    this.state.fromCache = false;
    try {
      this.cache?.setItem(this.cacheKey, JSON.stringify(snapshot));
    } catch {
      /* Storage quota is optional. */
    }
  }
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
  private async load() {
    this.state.loading = true;
    this.state.error = null;
    this.state.note = null;
    this.emit();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.url, {
        cache: "no-store",
        signal: controller.signal,
        credentials: "omit",
      });
      if (!response.ok)
        throw Error(
          response.status === 404
            ? "尚未提供可读取的资料快照"
            : "资料服务暂不可用，请稍后重试",
        );
      const text = await response.text();
      if (text.length > 5_000_000) throw Error("快照过大，无法读取");
      const incoming = parseSnapshot(JSON.parse(text));
      if (
        !Object.values(incoming.modules).some(
          (m) => m?.data !== undefined && m.status !== "failed",
        )
      )
        throw Error("新快照没有通过校验的可用模块");
      const current = this.state.pending ?? this.state.snapshot;
      if (
        current &&
        Date.parse(incoming.started_at) < Date.parse(current.started_at)
      ) {
        this.state.note = "保留较新的资料版本";
      } else if (current && incoming.snapshot_id === current.snapshot_id) {
        this.state.note = "当前已是可读取的最新版本";
      } else if (this.state.snapshot) {
        this.state.pending = incoming;
        this.state.note = "发现新资料，点击后查看";
      } else this.save(incoming);
      this.state.checkedAt = new Date().toISOString();
    } catch (e) {
      this.state.error = controller.signal.aborted
        ? "读取超时，已保留当前资料"
        : e instanceof SyntaxError
          ? "资料格式异常，已保留当前资料"
          : e instanceof TypeError
            ? "网络连接失败，已保留当前资料"
            : e instanceof Error
              ? e.message
              : "网络连接失败，请稍后重试";
    } finally {
      clearTimeout(timeout);
      this.state.loading = false;
      this.emit();
    }
  }
  acceptPending() {
    if (this.state.pending) {
      this.save(this.state.pending);
      this.state.pending = null;
      this.state.note = "已显示最新资料";
      this.emit();
    }
  }
}
