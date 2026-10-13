import { readConfig, writeConfig } from "./config.js";
import { authorizationHeader, requireCredentials, type Credentials } from "./credentials.js";
import { axiError, AxiError } from "./errors.js";
import { arr, obj, str } from "./render.js";
import { VERSION } from "./version.js";

const GATEWAY = "https://api.atlassian.com";
const DEFAULT_TIMEOUT_MS = 30_000;

export type Query = Record<string, string | number | readonly string[] | undefined>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Query;
  body?: unknown;
  timeoutMs?: number;
  /** Supply credentials/site explicitly (used by `auth login` before storing). */
  credentials?: Credentials;
  cloudId?: string;
}

/** Accept `acme`, `acme.atlassian.net` or a full URL; return the bare host. */
export function normalizeSite(raw: string): string {
  const host = raw.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  const full = host.includes(".") ? host : `${host}.atlassian.net`;
  if (!/^[a-z0-9][a-z0-9-]*\.(atlassian\.net|jira\.com)$/.test(full)) {
    throw axiError(`invalid Atlassian site '${raw}' - expected <name>.atlassian.net`, "VALIDATION_ERROR");
  }
  return full;
}

/** Public, unauthenticated lookup of a site's cloud id. */
export async function fetchCloudId(site: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`https://${site}/_edge/tenant_info`, {
      headers: { Accept: "application/json", "User-Agent": `atl-axi/${VERSION}` },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw axiError(`could not reach ${site}`, "NETWORK", ["Check the site name and the network connection"]);
  }
  const cloudId = response.ok ? str(obj(await response.json().catch(() => ({})))["cloudId"]) : "";
  if (!cloudId) throw axiError(`${site} is not a Jira Cloud site`, "SITE_REQUIRED", ["Check the site name (<name>.atlassian.net)"]);
  return cloudId;
}

/**
 * Scoped API tokens only work through the api.atlassian.com gateway, so every
 * request goes there. Resolution: JIRA_CLOUD_ID, ATLASSIAN_SITE, then config.
 */
export async function resolveCloudId(): Promise<string> {
  const envId = process.env["JIRA_CLOUD_ID"];
  if (envId) return envId;
  const config = readConfig();
  const envSite = process.env["ATLASSIAN_SITE"];
  if (envSite) {
    const site = normalizeSite(envSite);
    if (config.site === site && config.cloudId) return config.cloudId;
    const cloudId = await fetchCloudId(site);
    if (!config.site) {
      try {
        writeConfig({ ...config, site, cloudId });
      } catch {
        // caching the id is an optimisation only
      }
    }
    return cloudId;
  }
  if (config.cloudId) return config.cloudId;
  throw axiError("no Atlassian site configured", "SITE_REQUIRED", [
    "Run `<token-command> | atl-axi auth login --site <site>.atlassian.net --email <atlassian-email> --token-stdin`",
    "Or set ATLASSIAN_SITE=<site>.atlassian.net (or JIRA_CLOUD_ID) in the environment",
  ]);
}

export function apiBase(cloudId: string): string {
  const override = process.env["ATL_AXI_API_BASE"];
  if (override) {
    const url = new URL(override);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    // The Authorization header goes wherever this points - never plain HTTP to a remote host.
    if (url.protocol !== "https:" && !local) throw axiError("ATL_AXI_API_BASE must use https", "VALIDATION_ERROR");
    return override.replace(/\/+$/, "");
  }
  return `${GATEWAY}/ex/jira/${encodeURIComponent(cloudId)}`;
}

function buildUrl(base: string, path: string, query?: Query): URL {
  const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(`${base}${path.startsWith("/") ? "" : "/"}${path}`);
  // Only ever send credentials to the configured API base.
  if (url.origin !== new URL(base).origin || !url.pathname.startsWith(new URL(base).pathname)) {
    throw axiError(`refusing to send credentials to ${url.origin}${url.pathname}`, "API_ERROR");
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number") url.searchParams.set(key, String(value));
    else for (const item of value) url.searchParams.append(key, item);
  }
  return url;
}

/** Jira returns `errorMessages[]` plus a field-keyed `errors` map. */
export function apiMessage(bodyText: string): string {
  try {
    const parsed = obj(JSON.parse(bodyText));
    const messages = arr(parsed["errorMessages"]).map(str).filter(Boolean);
    const fields = Object.entries(obj(parsed["errors"])).map(([k, v]) => `${k} - ${str(v)}`);
    const single = str(parsed["message"]);
    return [...messages, ...fields, single].filter(Boolean).join("; ").slice(0, 400);
  } catch {
    return "";
  }
}

/** Scoped tokens answer 401 (not 403) for a missing scope; name the likely one. */
export function scopeHint(path: string, method: string): string {
  if (path.includes("/rest/agile/")) return "read:board-scope:jira-software, read:sprint:jira-software";
  if (/\/rest\/api\/3\/(myself|user)/.test(path)) return "read:jira-user";
  return method === "GET" ? "read:jira-work" : "write:jira-work";
}

function errorForStatus(status: number, bodyText: string, method: string, path: string): AxiError {
  const message = apiMessage(bodyText);
  const suffix = message ? `: ${message}` : "";
  switch (status) {
    case 400:
      return axiError(`Jira rejected the request${suffix}`, "VALIDATION_ERROR");
    case 401:
      return axiError(`Atlassian rejected the credentials for this endpoint${suffix}`, "AUTH_REQUIRED", [
        `A scoped token is likely missing the scope ${scopeHint(path, method)} - otherwise the token is invalid or expired`,
        "Run `atl-axi auth status` to check the configured account",
      ]);
    case 403:
      return axiError(`access denied${suffix}`, "FORBIDDEN", [
        `You may lack the Jira permission for this, or the token lacks ${scopeHint(path, method)}`,
      ]);
    case 404:
      return axiError(`not found${suffix}`, "NOT_FOUND", [
        "Check the issue key or id; issues you cannot browse also return 404",
      ]);
    case 409:
      return axiError(`conflict${suffix}`, "CONFLICT");
    case 429:
      return axiError("Atlassian API rate limit reached", "RATE_LIMITED", ["Wait a minute before retrying"]);
    default:
      return axiError(`Jira API error ${status}${suffix}`, "API_ERROR");
  }
}

export async function jiraJson(path: string, options: RequestOptions = {}): Promise<unknown> {
  const method = options.method ?? "GET";
  const credentials = options.credentials ?? (await requireCredentials());
  const base = apiBase(options.cloudId ?? (await resolveCloudId()));
  const url = buildUrl(base, path, options.query);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: authorizationHeader(credentials),
    "User-Agent": `atl-axi/${VERSION}`,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw axiError(timedOut ? "Jira API request timed out" : "could not reach the Jira API", "NETWORK", [
      "Check the network connection and retry",
    ]);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) throw errorForStatus(response.status, text, method, url.pathname);
  if (response.status === 204 || text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw axiError("Jira API returned a non-JSON response", "API_ERROR");
  }
}
