import { readConfig } from "./config.js";
import { axiError } from "./errors.js";

const KEYCHAIN_SERVICE = "atl-axi";

export interface Credentials {
  email: string;
  token: string;
  source: "env" | "keychain";
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

async function keychainEntry(email: string): Promise<KeyringEntry> {
  try {
    // Loaded lazily: an unsupported platform degrades to the env-var path.
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(KEYCHAIN_SERVICE, email);
  } catch {
    throw axiError("OS keychain is not available on this system", "AUTH_REQUIRED", [
      "Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in the environment instead",
    ]);
  }
}

/** Environment (CI, one-off overrides) wins over the OS keychain. */
export async function resolveCredentials(): Promise<Credentials | undefined> {
  const envEmail = process.env["ATLASSIAN_EMAIL"];
  const envToken = process.env["ATLASSIAN_API_TOKEN"];
  if (envEmail && envToken) return { email: envEmail, token: envToken, source: "env" };

  if (process.env["ATL_AXI_NO_KEYCHAIN"] === "1") return undefined;
  const email = readConfig().email;
  if (!email) return undefined;
  try {
    const token = (await keychainEntry(email)).getPassword();
    return token ? { email, token, source: "keychain" } : undefined;
  } catch {
    return undefined;
  }
}

export const LOGIN_HINT = "Run `<token-command> | atl-axi auth login --site <site>.atlassian.net --email <atlassian-email> --token-stdin`";

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

export async function storeToken(email: string, token: string): Promise<void> {
  (await keychainEntry(email)).setPassword(token);
}

/** Returns true when a stored token was removed, false when there was none. */
export async function clearToken(email: string): Promise<boolean> {
  try {
    return (await keychainEntry(email)).deletePassword();
  } catch {
    return false;
  }
}

export function authorizationHeader(credentials: Credentials): string {
  return `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`, "utf-8").toString("base64")}`;
}
