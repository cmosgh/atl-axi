import { readFileSync } from "node:fs";
import { bool, expectPositionals, parseArgs, requireFlag } from "../args.js";
import { fetchCloudId, jiraJson, normalizeSite, resolveCloudId } from "../client.js";
import { readConfig, writeConfig } from "../config.js";
import { clearToken, LOGIN_HINT, resolveCredentials, storeToken, type Credentials } from "../credentials.js";
import { AxiError, usageError } from "../errors.js";
import { fetchUser } from "../me.js";
import { block, helpBlock, out } from "../render.js";

export const AUTH_HELP = `usage: atl-axi auth <subcommand> [flags]
subcommands[3]:
  status, login, logout
flags{login}:
  --site <name>.atlassian.net (required), --email <atlassian-account-email> (required), --token-stdin (required; the API token is read from stdin, never from argv)
notes:
  Create a token at https://id.atlassian.com/manage-profile/security/api-tokens. Scoped tokens need read:jira-work and write:jira-work; add read:jira-user (assignee lookup) and read:board-scope:jira-software + read:sprint:jira-software (sprint list --board) as needed.
  The token is stored in the OS keychain. Environment overrides: ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN with ATLASSIAN_SITE or JIRA_CLOUD_ID.
examples[3]:
  pbpaste | atl-axi auth login --site acme.atlassian.net --email you@example.com --token-stdin
  atl-axi auth status
  atl-axi auth logout
`;

export async function authCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "status") return authStatus(rest);
  if (sub === "login") return authLogin(rest);
  if (sub === "logout") return authLogout(rest);
  throw usageError(sub ? `unknown auth subcommand '${sub}'` : "missing auth subcommand", ["subcommands: status, login, logout"]);
}

/** Probe one endpoint per scope family; 401 from a scoped token = scope missing. */
async function probe(path: string, credentials: Credentials, cloudId: string): Promise<string> {
  try {
    await jiraJson(path, { credentials, cloudId, timeoutMs: 10_000 });
    return "ok";
  } catch (error) {
    if (error instanceof AxiError && (error.code === "AUTH_REQUIRED" || error.code === "FORBIDDEN")) return "missing";
    return error instanceof AxiError ? `unknown (${error.code})` : "unknown";
  }
}

async function authStatus(args: string[]): Promise<string> {
  const command = "atl-axi auth status";
  expectPositionals(parseArgs(args, [], command), 0, command);
  const credentials = await resolveCredentials();
  if (!credentials) return out(block({ auth: { status: "not authenticated" } }), helpBlock([LOGIN_HINT]));
  const cloudId = await resolveCloudId();
  const [work, user, agile] = await Promise.all([
    probe("/rest/api/3/mypermissions?permissions=BROWSE_PROJECTS", credentials, cloudId),
    probe("/rest/api/3/myself", credentials, cloudId),
    probe("/rest/agile/1.0/board?maxResults=1", credentials, cloudId),
  ]);
  const me = user === "ok" ? await fetchUser(credentials, cloudId).catch(() => undefined) : undefined;
  const config = readConfig();
  const site = process.env["ATLASSIAN_SITE"] ?? (process.env["JIRA_CLOUD_ID"] ? `cloud id ${cloudId}` : config.site ?? "unknown");
  return out(
    block({
      auth: {
        status: work === "ok" ? "ok" : "invalid or missing read:jira-work",
        source: credentials.source === "env" ? "ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN" : "OS keychain",
        site,
        email: credentials.email,
        user: me?.displayName ?? "unknown (needs read:jira-user)",
        access: `jira work ${work}; users ${user}; agile boards ${agile}`,
      },
    }),
    helpBlock(work === "ok" ? [] : [LOGIN_HINT]),
  );
}

async function authLogin(args: string[]): Promise<string> {
  const command = "atl-axi auth login";
  const usage = `<token-command> | ${command} --site <name>.atlassian.net --email <atlassian-email> --token-stdin`;
  const parsed = parseArgs(args, [{ name: "--site" }, { name: "--email" }, { name: "--token-stdin", boolean: true }], command);
  expectPositionals(parsed, 0, usage);
  const site = normalizeSite(requireFlag(parsed, "--site", usage));
  const email = requireFlag(parsed, "--email", usage);
  if (!bool(parsed, "--token-stdin")) throw usageError("--token-stdin is required: the token is only ever read from stdin", [usage]);
  if (process.stdin.isTTY) throw usageError("no token on stdin (atl-axi never prompts)", [usage]);
  const token = readFileSync(0, "utf-8").trim();
  if (token === "") throw usageError("the token read from stdin is empty", [usage]);

  // Validate before storing so a typo never replaces a working credential.
  const cloudId = await fetchCloudId(site);
  const credentials: Credentials = { email, token, source: "env" };
  const work = await probe("/rest/api/3/mypermissions?permissions=BROWSE_PROJECTS", credentials, cloudId);
  if (work !== "ok") {
    throw new AxiError(`the token was rejected by ${site} (read:jira-work ${work})`, "AUTH_REQUIRED", [
      "Check the email is the Atlassian account email and the token is current and has read:jira-work",
    ]);
  }
  const me = await fetchUser(credentials, cloudId).catch(() => undefined);
  await storeToken(email, token);
  const previous = readConfig();
  if (previous.email && previous.email !== email) await clearToken(previous.email);
  writeConfig({ email, site, cloudId, ...(me ? { user: { ...me, email } } : {}) });

  return out(
    block({ auth: { status: "logged in", site, email, user: me?.displayName ?? "unknown (needs read:jira-user)", stored: "OS keychain" } }),
    helpBlock(["Run `atl-axi` for your open issues", "Run `atl-axi auth status` to see which scopes the token has"]),
  );
}

async function authLogout(args: string[]): Promise<string> {
  const command = "atl-axi auth logout";
  expectPositionals(parseArgs(args, [], command), 0, command);
  const config = readConfig();
  if (!config.email) return block({ auth: { status: "no stored credential (no-op)" } });
  const removed = await clearToken(config.email);
  writeConfig({});
  return block({ auth: { status: removed ? "logged out - token removed from the OS keychain" : "no stored token found (no-op)" } });
}
