import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "./fixture.ts";
import { SnapshotStore, type Cache } from "../../web/src/lib/store.ts";
function cache(s?: any): Cache {
  const m = new Map<string, string>();
  if (s) m.set("market-weather:snapshot:v1", JSON.stringify(s));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
}
function respond(value: any, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
test("first load needs no credentials and caches validated data", async () => {
  let options: any;
  const store = new SnapshotStore(
    "/data/latest.json",
    cache(),
    async (_url, opts) => {
      options = opts;
      return respond(snapshot());
    },
  );
  await store.refresh();
  assert.equal(store.state.snapshot?.snapshot_id, "test-1");
  assert.equal(options.credentials, "omit");
  assert.equal(store.state.loading, false);
});
test("failed refresh preserves last good cached data", async () => {
  const store = new SnapshotStore("/data", cache(snapshot()), async () =>
    respond({}, 503),
  );
  await store.refresh();
  assert.equal(store.state.snapshot?.snapshot_id, "test-1");
  assert.match(store.state.error ?? "", /服务/);
  assert.equal(store.state.fromCache, true);
});
test("new content is announced before replacement", async () => {
  const store = new SnapshotStore("/data", cache(snapshot()), async () =>
    respond(snapshot("new", "2026-11-20T08:00:00Z")),
  );
  await store.refresh();
  assert.equal(store.state.snapshot?.snapshot_id, "test-1");
  assert.equal(store.state.pending?.snapshot_id, "new");
  store.acceptPending();
  assert.equal(store.state.snapshot?.snapshot_id, "new");
  assert.equal(store.state.pending, null);
});
test("older snapshots never overwrite newer data", async () => {
  const store = new SnapshotStore(
    "/data",
    cache(snapshot("new", "2026-11-20T08:00:00Z")),
    async () => respond(snapshot("old")),
  );
  await store.refresh();
  assert.equal(store.state.snapshot?.snapshot_id, "new");
  assert.equal(store.state.pending, null);
});
test("repeated refresh shares one in-flight request", async () => {
  let resolve!: (r: Response) => void,
    calls = 0;
  const store = new SnapshotStore("/data", cache(), async () => {
    calls++;
    return await new Promise<Response>((r) => (resolve = r));
  });
  const a = store.refresh(),
    b = store.refresh();
  assert.equal(a, b);
  resolve(respond(snapshot()));
  await a;
  assert.equal(calls, 1);
});
test("bad JSON and storage quota failures do not blank a good snapshot", async () => {
  const c = cache(snapshot());
  c.setItem = () => {
    throw Error("quota");
  };
  const store = new SnapshotStore(
    "/data",
    c,
    async () => new Response("not JSON"),
  );
  await store.refresh();
  assert.equal(store.state.snapshot?.snapshot_id, "test-1");
  assert.ok(store.state.error);
});
test("all failed modules do not replace existing usable data", async () => {
  const bad = snapshot("bad", "2026-11-20T09:00:00Z");
  Object.values(bad.modules).forEach((m: any) => {
    m.status = "failed";
    delete m.data;
  });
  const store = new SnapshotStore("/data", cache(snapshot()), async () =>
    respond(bad),
  );
  await store.refresh();
  assert.equal(store.state.snapshot?.snapshot_id, "test-1");
  assert.equal(store.state.pending, null);
  assert.ok(store.state.error);
});
test("timeout aborts request and retains cached data", async () => {
  const store = new SnapshotStore(
    "/data",
    cache(snapshot()),
    async (_u, opts) =>
      await new Promise((_r, reject) =>
        opts?.signal?.addEventListener("abort", () => reject(Error("aborted"))),
      ),
    5,
  );
  await store.refresh();
  assert.match(store.state.error ?? "", /超时/);
  assert.equal(store.state.snapshot?.snapshot_id, "test-1");
});
test("a malformed cache is ignored and a missing source becomes an explicit empty state", async () => {
  const c = cache();
  c.getItem = () => "{";
  const store = new SnapshotStore("/data", c, async () => respond({}, 404));
  assert.equal(store.state.snapshot, null);
  await store.refresh();
  assert.match(store.state.error ?? "", /尚未/);
});
test("native-style fetch is invoked without the store as its receiver", async () => {
  const fetcher: typeof fetch = async function (this: unknown) {
    assert.equal(this, undefined);
    return respond(snapshot());
  };
  const store = new SnapshotStore("/data", cache(), fetcher);
  await store.refresh();
  assert.equal(store.state.error, null);
  assert.equal(store.state.snapshot?.snapshot_id, "test-1");
});
test("different project paths cannot reuse one another’s cached snapshot", async () => {
  const shared = cache();
  const one = new SnapshotStore(
    "/one/data",
    shared,
    async () => respond(snapshot()),
    12000,
    "one",
  );
  await one.refresh();
  const two = new SnapshotStore(
    "/two/data",
    shared,
    async () => respond({}, 404),
    12000,
    "two",
  );
  assert.equal(two.state.snapshot, null);
  await two.refresh();
  assert.equal(two.state.snapshot, null);
});
