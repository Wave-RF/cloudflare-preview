// A small GitHub REST client on Node's built-in fetch: retries, pagination, nothing else.

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {object} o
 * @param {string} o.token
 * @param {string} [o.apiUrl]   GITHUB_API_URL (GHES-aware)
 * @param {number} [o.attempts]
 * @param {number} [o.retryDelayMs]
 * @param {typeof fetch} [o.fetch]
 */
export function createClient({
  token,
  apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
  attempts = 3,
  retryDelayMs = Number(process.env.CFP_GITHUB_RETRY_MS ?? 2000),
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  if (!token) throw new Error("a GitHub token is required (input github-token)");
  const base = apiUrl.replace(/\/+$/, "");

  async function request(method, path, body) {
    const url = path.startsWith("http") ? path : `${base}${path}`;
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "cloudflare-preview-action",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        // Network failure: retry, then surface it.
        if (attempt >= attempts) throw new GitHubError(`${method} ${path}: ${err.message}`, undefined);
        await sleep(retryDelayMs * attempt);
        continue;
      }
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (res.ok) return { status: res.status, data, headers: res.headers };
      // A secondary rate limit arrives as 403 with retry-after or remaining=0.
      const rateLimited =
        res.status === 403 && (res.headers.get("retry-after") || res.headers.get("x-ratelimit-remaining") === "0");
      if (attempt < attempts && (RETRYABLE.has(res.status) || rateLimited)) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 60_000) : retryDelayMs * attempt);
        continue;
      }
      const message = typeof data === "object" && data?.message ? data.message : `HTTP ${res.status}`;
      throw new GitHubError(`${method} ${path} failed: HTTP ${res.status} ${message}`, res.status, data);
    }
  }

  /** GET every page of a list endpoint (per_page=100), up to maxPages. */
  async function paginate(path, { maxPages = 10 } = {}) {
    const sep = path.includes("?") ? "&" : "?";
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await request("GET", `${path}${sep}per_page=100&page=${page}`);
      if (!Array.isArray(data)) break;
      all.push(...data);
      if (data.length < 100) break;
    }
    return all;
  }

  return { request, paginate };
}

/** owner/name from GITHUB_REPOSITORY, validated so it can be placed in a URL path. */
export function repoFromEnv(value = process.env.GITHUB_REPOSITORY) {
  if (!value || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
    throw new Error(`GITHUB_REPOSITORY is not owner/name: ${JSON.stringify(value)}`);
  return value;
}
