import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dispatchCollection,
  collectionStatus,
} from "../../web/src/lib/collection.ts";

const testCredential = "github_pat_" + "fake_test_only_".repeat(3);
test("dispatch targets the fixed repository and requires a real run ID", async () => {
  const fakeFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(
      url,
      "https://api.github.com/repos/tansitanding/market-weather/actions/workflows/refresh.yml/dispatches",
    );
    assert.equal(init?.method, "POST");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer " + testCredential,
    );
    assert.deepEqual(JSON.parse(String(init?.body)), {
      ref: "main",
      return_run_details: true,
    });
    return Response.json({ workflow_run_id: 1234 });
  };
  assert.equal(await dispatchCollection(testCredential, fakeFetch), 1234);
  await assert.rejects(
    dispatchCollection(testCredential, async () => Response.json({})),
    /编号/,
  );
  await assert.rejects(
    dispatchCollection(
      testCredential,
      async () => new Response(null, { status: 403 }),
    ),
    /未授权/,
  );
});
test("public tracking omits repository credentials and verifies run identity", async () => {
  const fakeFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.match(String(url), /actions\/runs\/1234$/);
    assert.equal(init?.credentials, "omit");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return Response.json({
      id: 1234,
      status: "completed",
      conclusion: "success",
    });
  };
  assert.deepEqual(await collectionStatus(1234, fakeFetch), {
    status: "completed",
    conclusion: "success",
  });
  await assert.rejects(
    collectionStatus(1234, async () =>
      Response.json({ id: 1, status: "completed" }),
    ),
    /格式异常/,
  );
});
