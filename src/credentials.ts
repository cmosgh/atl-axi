import { readConfig, type Profile } from "./config.js";
import { axiError, usageError } from "./errors.js";

const KEYCHAIN_SERVICE = "atl-axi";

export interface Credentials {
  email: string;
  token: string;
  source: "env" | "keychain";
  profile?: string;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

async function keychainEntry(account: string): Promise<KeyringEntry> {
  try {
    // Loaded lazily: an unsupported platform degrades to the env-var path.
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(KEYCHAIN_SERVICE, account);
  } catch {
    throw axiError("OS keychain is not available on this system", "AUTH_REQUIRED", [
      "Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in the environment instead",
    ]);
  }
}

let profileFlag: string | undefined;

/** `-p/--profile` of this invocation; it wins over the ATLASSIAN_* environment. */
export function setProfileFlag(name: string | undefined): void {
  profileFlag = name;
}

export function profileFlagValue(): string | undefined {
  return profileFlag;
}

export const LOGIN_HINT = "Run `<token-command> | atl-axi auth login --site <site>.atlassian.net --email <atlassian-email> --token-stdin [--profile <name>]`";

/** The profile a command uses: -p/--profile, then ATL_AXI_PROFILE, then the active one. */
export function selectedProfile(): string | undefined {
  return profileFlag ?? (process.env["ATL_AXI_PROFILE"] || undefined) ?? readConfig().active;
}

/** The selected profile's settings; an unknown -p/ATL_AXI_PROFILE is a usage error listing the profiles. */
export function activeProfile(): { name: string; profile: Profile } | undefined {
  const name = selectedProfile();
  if (!name) return undefined;
  const profiles = readConfig().profiles ?? {};
  const profile = profiles[name];
  if (profile === undefined || typeof profile?.email !== "string") {
    if (profileFlag || process.env["ATL_AXI_PROFILE"]) {
      throw usageError(`no profile '${name}'`, [`profiles: ${Object.keys(profiles).join(", ") || "none"}`, LOGIN_HINT]);
    }
    return undefined;
  }
  return { name, profile };
}

/** True when the ATLASSIAN_* environment supplies the account (it does unless -p is given). */
export function envCredentials(): boolean {
  return !profileFlag && Boolean(process.env["ATLASSIAN_EMAIL"] && process.env["ATLASSIAN_API_TOKEN"]);
}

/** -p/--profile, then the environment (CI, one-off overrides), then ATL_AXI_PROFILE or the active profile. */
export async function resolveCredentials(): Promise<Credentials | undefined> {
  if (envCredentials()) return { email: process.env["ATLASSIAN_EMAIL"]!, token: process.env["ATLASSIAN_API_TOKEN"]!, source: "env" };
  const selected = activeProfile();
  if (process.env["ATL_AXI_NO_KEYCHAIN"] === "1" || !selected) return undefined;
  const { name, profile } = selected;
  try {
    // A login from before profiles kept the token under the email.
    const token = (await keychainEntry(name)).getPassword() ?? (await keychainEntry(profile.email)).getPassword();
    return token ? { email: profile.email, token, source: "keychain", profile: name } : undefined;
  } catch {
    return undefined;
  }
}

export async function requireCredentials(): Promise<Credentials> {
  const credentials = await resolveCredentials();
  if (!credentials) {
    throw axiError("not authenticated with Atlassian", "AUTH_REQUIRED", [
      LOGIN_HINT,
      "Or set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN (plus ATLASSIAN_SITE or JIRA_CLOUD_ID) in the environment",
    ]);
  }
  return credentials;
}

export async function storeToken(profile: string, token: string): Promise<void> {
  (await keychainEntry(profile)).setPassword(token);
}

/** Removes the tokens stored under these accounts; true when one was removed. */
export async function clearToken(...accounts: string[]): Promise<boolean> {
  let removed = false;
  for (const account of accounts) {
    try {
      removed = (await keychainEntry(account)).deletePassword() || removed;
    } catch {
      // nothing stored, or no keychain
    }
  }
  return removed;
}

export function authorizationHeader(credentials: Credentials): string {
  return `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`, "utf-8").toString("base64")}`;
}
