const repo = "tansitanding/market-weather";
const api = "https://api.github.com/repos/" + repo;
export const collectionWorkflow =
  "https://github.com/" + repo + "/actions/workflows/refresh.yml";
export const fineGrainedTokens =
  "https://github.com/settings/personal-access-tokens/new";

export function isCollectionToken(value: string) {
  return /^github_pat_[A-Za-z0-9_]{20,250}$/.test(value);
}

export async function dispatchCollection(
  token: string,
  request: typeof fetch = fetch,
): Promise<number> {
  if (!isCollectionToken(token))
    throw Error("请使用这个仓库的 GitHub 细粒度令牌。");
  const response = await request(
    api + "/actions/workflows/refresh.yml/dispatches",
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: JSON.stringify({ ref: "main", return_run_details: true }),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  if ([401, 403, 404].includes(response.status))
    throw Error(
      "GitHub 未授权。请核对令牌是否有效，以及该仓库的 Actions 权限是否为读写。",
    );
  if (response.status !== 200)
    throw Error(
      `GitHub 返回 ${response.status}。请先核对任务记录，再决定是否重试。`,
    );
  const id: unknown = (await response.json()).workflow_run_id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
    throw Error("GitHub 没有返回可核验的任务编号，请先查看任务记录。");
  return id;
}

export function collectionRunURL(id: number) {
  return `https://github.com/${repo}/actions/runs/${id}`;
}
export async function collectionStatus(
  id: number,
  request: typeof fetch = fetch,
): Promise<{ status: string; conclusion: string | null }> {
  const response = await request(api + "/actions/runs/" + id, {
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error("暂时无法读取任务状态");
  const run = await response.json();
  if (run.id !== id || typeof run.status !== "string")
    throw Error("任务状态格式异常");
  return {
    status: run.status,
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
  };
}
