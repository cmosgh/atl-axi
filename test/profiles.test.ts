import { readFileSync as realRead, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ME, run, useTestEnv } from "./helpers.js";

// In-memory OS keychain, keyed by account, and a token on stdin.
const keychain = new Map<string, string>();
let stdin = "";
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(_service: string, private account: string) {}
    getPassword(): string | null {
      return keychain.get(this.account) ?? null;
    }
    setPassword(value: string): void {
      keychain.set(this.account, value);
    }
    deletePassword(): boolean {
      return keychain.delete(this.account);
    }
  },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: ((path: unknown, ...rest: unknown[]) => (path === 0 ? stdin : (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest))) as typeof actual.readFileSync };
});

const WORK = "robin@work.example.test";
const CLIENT = "robin@client.example.test";

interface Seen {
  cloud: string;
  email: string;
}

/** Each site's cloud id is `cloud-<name>`; every Jira call is recorded with its cloud id and Basic-auth email. */
function stubJira(): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/_edge/tenant_info") return new Response(JSON.stringify({ cloudId: `cloud-${url.hostname.split(".")[0]}` }));
    const header = ((init?.headers ?? {}) as Record<string, string>)["Authorization"] ?? "";
    const email = Buffer.from(header.replace(/^Basic /, ""), "base64").toString("utf-8").split(":")[0]!;
    seen.push({ cloud: url.pathname.split("/")[3] ?? "", email });
    return new Response(JSON.stringify(url.pathname.endsWith("/myself") ? ME : {}));
  });
  return seen;
}

function config(): Record<string, unknown> {
  return JSON.parse(realRead(join(process.env["ATL_AXI_CONFIG_DIR"]!, "config.json"), "utf-8")) as Record<string, unknown>;
}

async function login(site: string, email: string, ...extra: string[]): Promise<string> {
  stdin = `token-for-${email}\n`;
  return (await run("auth", "login", "--site", site, "--email", email, "--token-stdin", ...extra)).stdout;
}

beforeEach(() => {
  useTestEnv();
  delete process.env["ATLASSIAN_EMAIL"];
  delete process.env["ATLASSIAN_API_TOKEN"];
  delete process.env["JIRA_CLOUD_ID"];
  delete process.env["ATL_AXI_NO_KEYCHAIN"];
  delete process.env["ATL_AXI_PROFILE"];
  keychain.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("profiles", () => {
  it("login stores one token per profile, with its site, and makes it active", async () => {
    stubJira();
    expect(await login("work", WORK)).toContain("profile: default");
    expect(await login("client.atlassian.net", CLIENT, "--profile", "client")).toContain("profile: client");
    expect([...keychain.keys()].sort()).toEqual(["client", "default"]);
    expect(config()).toMatchObject({ active: "client", profiles: { default: { site: "work.atlassian.net", cloudId: "cloud-work" } } });

    const status = await run("auth", "status");
    expect(status.stdout).toContain("profiles[2]{name,site,email,active}:");
    expect(status.stdout).toContain("profile client");
    expect(status.stdout).toContain("site: client.atlassian.net");
  });

  it("-p, ATL_AXI_PROFILE and the active profile pick account and site, in that order", async () => {
    const seen = stubJira();
    await login("work", WORK, "--profile", "work");
    await login("client", CLIENT, "--profile", "client");
    const last = (): Seen => seen.at(-1)!;

    await run("api", "/rest/api/3/serverInfo");
    expect(last()).toEqual({ cloud: "cloud-client", email: CLIENT });
    process.env["ATL_AXI_PROFILE"] = "work";
    await run("api", "/rest/api/3/serverInfo");
    expect(last()).toEqual({ cloud: "cloud-work", email: WORK });
    await run("api", "/rest/api/3/serverInfo", "-p", "client");
    expect(last()).toEqual({ cloud: "cloud-client", email: CLIENT });

    delete process.env["ATL_AXI_PROFILE"];
    expect((await run("auth", "use", "work")).stdout).toContain("switched");
    await run("api", "/rest/api/3/serverInfo");
    expect(last()).toEqual({ cloud: "cloud-work", email: WORK });
  });

  it("environment credentials and cloud id win unless -p is given", async () => {
    const seen = stubJira();
    await login("work", WORK, "--profile", "work");
    process.env["ATLASSIAN_EMAIL"] = "ci@example.test";
    process.env["ATLASSIAN_API_TOKEN"] = "ci-token";
    process.env["JIRA_CLOUD_ID"] = "cloud-ci";
    await run("api", "/rest/api/3/serverInfo");
    expect(seen.at(-1)).toEqual({ cloud: "cloud-ci", email: "ci@example.test" });
    await run("api", "/rest/api/3/serverInfo", "--profile=work");
    expect(seen.at(-1)).toEqual({ cloud: "cloud-work", email: WORK });
  });

  it("an unknown -p is a usage error listing the profiles", async () => {
    stubJira();
    await login("work", WORK, "--profile", "work");
    const { stdout, exitCode } = await run("api", "/rest/api/3/serverInfo", "-p", "nope");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("no profile 'nope'");
    expect(stdout).toContain("profiles: work");
  });

  it("a pre-profile login keeps working as the 'default' profile", async () => {
    writeFileSync(join(process.env["ATL_AXI_CONFIG_DIR"]!, "config.json"), JSON.stringify({ email: WORK, site: "work.atlassian.net", cloudId: "cloud-work" }));
    keychain.set(WORK, "legacy-token");
    const seen = stubJira();
    await run("api", "/rest/api/3/serverInfo");
    expect(seen.at(-1)).toEqual({ cloud: "cloud-work", email: WORK });

    // A fresh login moves the token to the profile name.
    await login("work", WORK);
    expect([...keychain.keys()]).toEqual(["default"]);
    expect(config()).toMatchObject({ active: "default", profiles: { default: { email: WORK, cloudId: "cloud-work" } } });
  });

  it("logout removes the profile and its token, idempotently", async () => {
    stubJira();
    await login("work", WORK, "--profile", "work");
    await login("client", CLIENT, "--profile", "client");
    const out = (await run("auth", "logout", "--profile", "client")).stdout;
    expect(out).toContain("token removed");
    expect(out).toContain("active: work");
    expect([...keychain.keys()]).toEqual(["work"]);
    expect((await run("auth", "logout", "--profile", "client")).stdout).toContain("(no-op)");
  });

  it("rejects a profile name that is not a plain word", async () => {
    stubJira();
    stdin = "t\n";
    const { exitCode, stdout } = await run("auth", "login", "--site", "work", "--email", WORK, "--token-stdin", "--profile", "a b");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("invalid profile name");
  });
});
