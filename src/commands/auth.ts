import { readFileSync } from "node:fs";
import { bool, expectPositionals, flag, parseArgs, requireFlag } from "../args.js";
import { fetchCloudId, jiraJson, normalizeSite, resolveCloudId } from "../client.js";
import { LEGACY_PROFILE, readConfig, validProfileName, writeConfig } from "../config.js";
import { clearToken, envCredentials, LOGIN_HINT, profileFlagValue, resolveCredentials, setProfileFlag, storeToken, type Credentials } from "../credentials.js";
import { AxiError, usageError } from "../errors.js";
import { fetchUser } from "../me.js";
import { block, helpBlock, out } from "../render.js";

export const AUTH_HELP = `usage: atl-axi auth <subcommand> [flags]
subcommands[4]:
  status, login, use <profile>, logout
flags{login}:
  --site <name>.atlassian.net (required), --email <atlassian-account-email> (required), --token-stdin (required; the API token is read from stdin, never from argv), --profile <name> (default: the active profile, or 'default')
flags{status,logout}:
  -p/--profile <name> (default: the active profile)
notes:
  Create a token at https://id.atlassian.com/manage-profile/security/api-tokens. Scoped tokens need read:jira-work and write:jira-work; add read:jira-user (assignee lookup) and read:board-scope:jira-software + read:sprint:jira-software (sprint list --board) as needed.
  Tokens are stored in the OS keychain, one per profile; a profile (site, email, cloud id) lives in ~/.config/atl-axi. Login makes the profile active.
  Pick a profile with -p/--profile <name> on any command, or ATL_AXI_PROFILE for a single command. Environment overrides: ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN with ATLASSIAN_SITE or JIRA_CLOUD_ID; they win over the profiles unless -p is given.
examples[5]:
  pbpaste | atl-axi auth login --site acme.atlassian.net --email you@example.com --token-stdin
  pbpaste | atl-axi auth login --profile client --site client.atlassian.net --email you@client.example --token-stdin
  atl-axi auth use client
  atl-axi search --mine -p client
  atl-axi auth logout --profile client
`;

export async function authCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "status") return authStatus(rest);
  if (sub === "login") return authLogin(rest);
  if (sub === "use") return authUse(rest);
  if (sub === "logout") return authLogout(rest);
  throw usageError(sub ? `unknown auth subcommand '${sub}'` : "missing auth subcommand", ["subcommands: status, login, use, logout"]);
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
  const parsed = parseArgs(args, [{ name: "--profile", alias: "-p" }], command);
  expectPositionals(parsed, 0, `${command} [-p <profile>]`);
  setProfileFlag(flag(parsed, "--profile"));
  const profiles = profileRows();
  const listing = profiles.length > 1 ? block({ profiles }) : "";
  const credentials = await resolveCredentials();
  if (!credentials) return out(block({ auth: { status: "not authenticated" } }), listing, helpBlock([LOGIN_HINT]));
  const cloudId = await resolveCloudId();
  const [work, user, agile] = await Promise.all([
    probe("/rest/api/3/mypermissions?permissions=BROWSE_PROJECTS", credentials, cloudId),
    probe("/rest/api/3/myself", credentials, cloudId),
    probe("/rest/agile/1.0/board?maxResults=1", credentials, cloudId),
  ]);
  const me = user === "ok" ? await fetchUser(credentials, cloudId).catch(() => undefined) : undefined;
  const profileSite = credentials.profile ? readConfig().profiles?.[credentials.profile]?.site : undefined;
  const site = profileFlagValue()
    ? (profileSite ?? "unknown")
    : (process.env["ATLASSIAN_SITE"] ?? (process.env["JIRA_CLOUD_ID"] ? `cloud id ${cloudId}` : (profileSite ?? readConfig().site ?? "unknown")));
  return out(
    block({
      auth: {
        status: work === "ok" ? "ok" : "invalid or missing read:jira-work",
        source: credentials.source === "env" ? "ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN" : `OS keychain (profile ${credentials.profile})`,
        site,
        email: credentials.email,
        user: me?.displayName ?? "unknown (needs read:jira-user)",
        access: `jira work ${work}; users ${user}; agile boards ${agile}`,
      },
    }),
    listing,
    helpBlock(work === "ok" ? [] : [LOGIN_HINT]),
  );
}

async function authLogin(args: string[]): Promise<string> {
  const command = "atl-axi auth login";
  const usage = `<token-command> | ${command} --site <name>.atlassian.net --email <atlassian-email> --token-stdin [--profile <name>]`;
  const parsed = parseArgs(
    args,
    [{ name: "--site" }, { name: "--email" }, { name: "--token-stdin", boolean: true }, { name: "--profile", alias: "-p" }],
    command,
  );
  expectPositionals(parsed, 0, usage);
  const site = normalizeSite(requireFlag(parsed, "--site", usage));
  const email = requireFlag(parsed, "--email", usage);
  const config = readConfig();
  const name = flag(parsed, "--profile") ?? config.active ?? LEGACY_PROFILE;
  if (!validProfileName(name)) throw usageError(`invalid profile name '${name}' - use letters, digits, '.', '_' and '-'`);
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
  await storeToken(name, token);
  // A pre-profile token sits under the old email; the profile name holds it from now on.
  const previous = config.profiles?.[name];
  if (previous?.email) await clearToken(previous.email);
  writeConfig({ ...config, active: name, profiles: { ...config.profiles, [name]: { email, site, cloudId, ...(me ? { user: { ...me, email } } : {}) } } });

  return out(
    block({ auth: { status: "logged in", profile: name, site, email, user: me?.displayName ?? "unknown (needs read:jira-user)", stored: "OS keychain", active: true } }),
    helpBlock(["Run `atl-axi` for your open issues", "Run `atl-axi auth status` to see which scopes the token has"]),
  );
}

function profileRows(): Array<{ name: string; site: string; email: string; active: boolean }> {
  const active = profileFlagValue() ?? (process.env["ATL_AXI_PROFILE"] || undefined) ?? readConfig().active;
  return Object.entries(readConfig().profiles ?? {}).map(([name, p]) => ({
    name,
    site: typeof p?.site === "string" && p.site ? p.site : "unknown",
    email: typeof p?.email === "string" ? p.email : "invalid - no email",
    active: name === active,
  }));
}

async function authUse(args: string[]): Promise<string> {
  const command = "atl-axi auth use";
  const [name] = expectPositionals(parseArgs(args, [], command), 1, `${command} <profile>`);
  const config = readConfig();
  const profiles = Object.keys(config.profiles ?? {});
  if (!profiles.includes(name!)) throw usageError(`no profile '${name}'`, [`profiles: ${profiles.join(", ") || "none"}`, LOGIN_HINT]);
  if (config.active === name) return block({ auth: { active: name, result: "already active (no-op)" } });
  writeConfig({ ...config, active: name! });
  return out(
    block({ auth: { active: name, result: "switched" } }),
    helpBlock(envCredentials() ? ["ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN are set in the environment and still win unless -p is given"] : []),
  );
}

async function authLogout(args: string[]): Promise<string> {
  const command = "atl-axi auth logout";
  const parsed = parseArgs(args, [{ name: "--profile", alias: "-p" }], command);
  expectPositionals(parsed, 0, `${command} [--profile <name>]`);
  const config = readConfig();
  const name = flag(parsed, "--profile") ?? config.active;
  const profiles = { ...config.profiles };
  if (!name || profiles[name] === undefined) return block({ auth: { status: "no such profile (no-op)" } });
  const email = profiles[name]?.email;
  const removed = await clearToken(name, ...(typeof email === "string" ? [email] : []));
  delete profiles[name];
  const active = config.active === name ? Object.keys(profiles)[0] : config.active;
  const { active: _old, profiles: _p, ...caches } = config;
  writeConfig({ ...caches, ...(active ? { active } : {}), profiles });
  return block({
    auth: { profile: name, status: removed ? "logged out - token removed from the OS keychain" : "removed - no stored token found", active: active ?? "none" },
  });
}
