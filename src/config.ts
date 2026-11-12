import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CachedUser {
  accountId: string;
  displayName: string;
  /** Email the identity was resolved with; a different email invalidates it. */
  email: string;
}

/** One Atlassian account on one site. The token lives in the OS keychain under the profile name. */
export interface Profile {
  email: string;
  /** e.g. acme.atlassian.net */
  site: string;
  cloudId: string;
  user?: CachedUser;
}

/** Non-secret settings only. Tokens live in the OS keychain, never here. */
export interface Config {
  active?: string;
  profiles?: Record<string, Profile>;
  /** Caches for the ATLASSIAN_* environment credentials: the ATLASSIAN_SITE cloud id and the user. */
  site?: string;
  cloudId?: string;
  user?: CachedUser;
}

/** Name a pre-profile login is read as; its token stays under the email in the keychain. */
export const LEGACY_PROFILE = "default";

export function validProfileName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name);
}

export function configDir(): string {
  const override = process.env["ATL_AXI_CONFIG_DIR"];
  if (override) return override;
  const xdg = process.env["XDG_CONFIG_HOME"];
  return join(xdg && xdg !== "" ? xdg : join(homedir(), ".config"), "atl-axi");
}

function readJson<T>(name: string, fallback: T): T {
  const path = join(configDir(), name);
  if (!existsSync(path)) return fallback;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    // A corrupt file must not brick the CLI; treat it as empty.
    return fallback;
  }
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir(), name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function readConfig(): Config {
  const raw = readJson<Config & { email?: unknown }>("config.json", {});
  if (Array.isArray(raw)) return {};
  // 0.x stored one account at the top level.
  if (typeof raw.email === "string" && raw.profiles === undefined) {
    const legacy: Profile = { email: raw.email, site: raw.site ?? "", cloudId: raw.cloudId ?? "", ...(raw.user ? { user: raw.user } : {}) };
    return { active: LEGACY_PROFILE, profiles: { [LEGACY_PROFILE]: legacy } };
  }
  const { email: _email, ...config } = raw;
  return config;
}

export function writeConfig(config: Config): void {
  writeJson("config.json", config);
}

/** Best-effort cache files (field catalog); failures are ignored. */
export function readCache<T>(name: string): T | undefined {
  return readJson<T | undefined>(`cache-${name}.json`, undefined);
}

export function writeCache(name: string, value: unknown): void {
  try {
    writeJson(`cache-${name}.json`, value);
  } catch {
    // cache is an optimisation; a read-only config dir must not fail the command
  }
}
