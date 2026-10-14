import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANA, doc, issue, ME, mockApi, run, useTestEnv } from "./helpers.js";

beforeEach(() => useTestEnv());
afterEach(() => vi.unstubAllGlobals());

const ISSUE = "/rest/api/3/issue/PROJ-1";
const LINK_TYPES = {
  issueLinkTypes: [
    { id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" },
    { id: "2", name: "Relates", inward: "relates to", outward: "relates to" },
  ],
};

describe("issue view", () => {
  it("renders a compact summary with numeric points, open sprint, links and a fenced description", async () => {
    const { calls } = mockApi([
      {
        path: ISSUE,
        json: issue("PROJ-1", {
          customfield_10014: 3,
          customfield_10010: [
            { id: 7, name: "Sprint 6", state: "closed", boardId: 2 },
            { id: 8, name: "Sprint 7", state: "active", boardId: 2 },
          ],
          parent: { key: "PROJ-0", fields: { summary: "Epic" } },
          description: doc("Retries transient failures."),
          issuelinks: [
            { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: { key: "PROJ-2", fields: { summary: "Next", status: { name: "To Do" } } } },
            { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: "PROJ-3", fields: { summary: "Prev", status: { name: "Done" } } } },
          ],
          comment: { total: 2, comments: [] },
        }),
      },
    ]);
    const { stdout, exitCode } = await run("issue", "view", "proj-1");
    expect(exitCode).toBe(0);
    const fields = calls.find((c) => c.path === ISSUE)!.url.searchParams.get("fields")!;
    expect(fields).toContain("customfield_10014");
    expect(fields).toContain("customfield_10010");
    expect(stdout).toContain("points: 3\n");
    expect(stdout).toContain("sprint: Sprint 7 (active; id 8)");
    expect(stdout).toContain("parent: PROJ-0 Epic");
    expect(stdout).toContain("blocks,PROJ-2,To Do,Next");
    expect(stdout).toContain("is blocked by,PROJ-3,Done,Prev");
    expect(stdout).toContain("---\nRetries transient failures.\n---");
    expect(stdout).toContain("atl-axi issue comments PROJ-1");
  });

  it("rejects a malformed key before any request", async () => {
    const { calls } = mockApi([]);
    const { stdout, exitCode } = await run("issue", "view", "nope");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("expected e.g. PROJ-123");
    expect(calls).toHaveLength(0);
  });
});

describe("search", () => {
  it("combines JQL with shortcut filters and keeps an explicit ORDER BY", async () => {
    const { calls } = mockApi([{ path: "/rest/api/3/search/jql", json: { issues: [issue("PROJ-1")], isLast: true } }]);
    const { stdout } = await run("search", 'type = Bug ORDER BY created ASC', "--project", "proj", "--status", 'In "QA"');
    const jql = calls.find((c) => c.path === "/rest/api/3/search/jql")!.url.searchParams.get("jql");
    expect(jql).toBe('(type = Bug) AND project = PROJ AND status = "In \\"QA\\"" ORDER BY created ASC');
    expect(stdout).toContain("issues[1]{key,summary,status,assignee}:");
    expect(stdout).toContain("PROJ-1,Retry the sync worker,To Do,Ana Author");
  });

  it("needs a query or a filter", async () => {
    const { calls } = mockApi([]);
    expect((await run("search")).exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("issue edit", () => {
  const editmeta = { fields: { summary: {}, labels: {}, customfield_10014: {}, customfield_10010: {}, customfield_10200: {} } };

  it("sets points and sprint on the fields that are on the edit screen, sending only changes", async () => {
    const { calls } = mockApi([
      { path: ISSUE, json: issue("PROJ-1", { customfield_10014: 3, customfield_10010: [] }) },
      { path: `${ISSUE}/editmeta`, json: editmeta },
      { method: "PUT", path: ISSUE, status: 204 },
    ]);
    const { stdout, exitCode } = await run("issue", "edit", "PROJ-1", "--points", "5", "--sprint", "8", "--summary", "Retry the sync worker");
    expect(exitCode).toBe(0);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ fields: { customfield_10014: 5, customfield_10010: 8 } });
    expect(stdout).toContain("result: updated");
    expect(stdout).toContain("unchanged: summary");
  });

  // Regression: with both points fields on screen, an edit must target the one
  // that holds the value instead of filling the empty parallel field.
  it("edits the points field that already holds a value when two are on screen", async () => {
    const both = { fields: { ...editmeta.fields, customfield_10103: {} } };
    const { calls } = mockApi([
      { path: ISSUE, json: issue("PROJ-1", { customfield_10014: 0.5, customfield_10103: null }) },
      { path: `${ISSUE}/editmeta`, json: both },
      { method: "PUT", path: ISSUE, status: 204 },
    ]);
    expect((await run("issue", "edit", "PROJ-1", "--points", "0.5")).stdout).toContain("(no-op)");
    await run("issue", "edit", "PROJ-1", "--points", "2");
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ fields: { customfield_10014: 2 } });
  });

  it("refuses to fill an empty points field when the value lives in one off the edit screen", async () => {
    const offScreen = { fields: { summary: {}, customfield_10103: {} } };
    const { calls } = mockApi([
      { path: ISSUE, json: issue("PROJ-1", { customfield_10014: 0.5, customfield_10103: null }) },
      { path: `${ISSUE}/editmeta`, json: offScreen },
    ]);
    const { stdout, exitCode } = await run("issue", "edit", "PROJ-1", "--points", "0.5");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("Story Points (customfield_10014) holds 0.5 on PROJ-1 but is not on its edit screen");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("is a no-op when every value already matches", async () => {
    const { calls } = mockApi([
      { path: ISSUE, json: issue("PROJ-1", { customfield_10014: 5, customfield_10010: [{ id: 8, name: "Sprint 7", state: "active" }], labels: ["a"] }) },
      { path: `${ISSUE}/editmeta`, json: editmeta },
    ]);
    const { stdout } = await run("issue", "edit", "PROJ-1", "--points", "5", "--sprint", "8", "--add-label", "a");
    expect(stdout).toContain("(no-op)");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("coerces --set values by field name and validates flags before the network", async () => {
    const { calls } = mockApi([
      { path: ISSUE, json: issue("PROJ-1") },
      { path: `${ISSUE}/editmeta`, json: editmeta },
      { method: "PUT", path: ISSUE, status: 204 },
    ]);
    await run("issue", "edit", "PROJ-1", "--set", "team=Platform");
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ fields: { customfield_10200: { value: "Platform" } } });

    const before = calls.length;
    const bad = await run("issue", "edit", "PROJ-1", "--points", "lots");
    expect(bad.exitCode).toBe(2);
    expect(calls.length).toBe(before);
  });

  it("assigns through the assignee endpoint, resolving 'me'", async () => {
    const { calls } = mockApi([
      { path: ISSUE, json: issue("PROJ-1") },
      { path: `${ISSUE}/editmeta`, json: editmeta },
      { method: "PUT", path: `${ISSUE}/assignee`, status: 204 },
    ]);
    const { stdout } = await run("issue", "edit", "PROJ-1", "--assignee", "me");
    expect(calls.find((c) => c.path === `${ISSUE}/assignee`)!.body).toEqual({ accountId: ME.accountId });
    expect(stdout).toContain("assignee,Robin Reviewer");
  });
});

describe("issue transition", () => {
  const transitions = { transitions: [{ id: "21", name: "Start work", to: { name: "In Progress" } }, { id: "31", name: "Finish", to: { name: "Done" } }] };

  it("matches a target status name and posts the transition id", async () => {
    const { calls } = mockApi([
      { path: ISSUE, json: issue("PROJ-1") },
      { path: `${ISSUE}/transitions`, json: transitions },
      { method: "POST", path: `${ISSUE}/transitions`, status: 204 },
    ]);
    const { stdout } = await run("issue", "transition", "PROJ-1", "in progress");
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ transition: { id: "21" } });
    expect(stdout).toContain("moved To Do -> In Progress");
  });

  it("is a no-op when already in the target status and lists options for an unknown one", async () => {
    mockApi([
      { path: ISSUE, json: issue("PROJ-1") },
      { path: `${ISSUE}/transitions`, json: transitions },
    ]);
    expect((await run("issue", "transition", "PROJ-1", "To Do")).stdout).toContain("already in To Do (no-op)");
    const unknown = await run("issue", "transition", "PROJ-1", "Shipped");
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stdout).toContain("Start work -> In Progress");
  });
});

describe("issue comment", () => {
  it("posts ADF and skips an identical recent comment", async () => {
    const comments = { comments: [{ id: "100", author: ME, body: doc("Already said") }] };
    const { calls } = mockApi([
      { path: `${ISSUE}/comment`, json: comments },
      { method: "POST", path: `${ISSUE}/comment`, json: { id: "101" } },
    ]);
    expect((await run("issue", "comment", "PROJ-1", "--body", "Already said")).stdout).toContain("already posted (no-op)");
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    const { stdout } = await run("issue", "comment", "PROJ-1", "--body", "First line\nsecond line\n\n- a\n- b");
    const body = calls.find((c) => c.method === "POST")!.body as { body: { content: Array<{ type: string }> } };
    expect(body.body.content.map((n) => n.type)).toEqual(["paragraph", "bulletList"]);
    expect(stdout).toContain("comment: 101");
  });
});

describe("issue link", () => {
  const linked = (links: unknown[]) => issue("PROJ-1", { issuelinks: links });
  const blocksTwo = { id: "900", type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: { key: "PROJ-2" } };

  it("'A blocks B' posts inwardIssue=A and verifies by reading back", async () => {
    let created = false;
    const { calls } = mockApi([
      { path: "/rest/api/3/issueLinkType", json: LINK_TYPES },
      { path: ISSUE, reply: () => ({ json: linked(created ? [blocksTwo] : []) }) },
      { method: "POST", path: "/rest/api/3/issueLink", reply: () => ((created = true), { status: 201 }) },
    ]);
    const { stdout, exitCode } = await run("issue", "link", "PROJ-1", "blocks", "PROJ-2");
    expect(exitCode).toBe(0);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      type: { name: "Blocks" },
      inwardIssue: { key: "PROJ-1" },
      outwardIssue: { key: "PROJ-2" },
    });
    expect(stdout).toContain("result: linked");
  });

  it("'A is blocked by B' swaps the ends", async () => {
    const isBlocked = { id: "901", type: blocksTwo.type, inwardIssue: { key: "PROJ-2" } };
    let created = false;
    const { calls } = mockApi([
      { path: "/rest/api/3/issueLinkType", json: LINK_TYPES },
      { path: ISSUE, reply: () => ({ json: linked(created ? [isBlocked] : []) }) },
      { method: "POST", path: "/rest/api/3/issueLink", reply: () => ((created = true), { status: 201 }) },
    ]);
    await run("issue", "link", "PROJ-1", "is blocked by", "PROJ-2");
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ inwardIssue: { key: "PROJ-2" }, outwardIssue: { key: "PROJ-1" } });
  });

  it("is a no-op when the link exists, unlinks by id, and flags a reversed read-back", async () => {
    const { calls } = mockApi([
      { path: "/rest/api/3/issueLinkType", json: LINK_TYPES },
      { path: ISSUE, json: linked([blocksTwo]) },
      { method: "DELETE", path: "/rest/api/3/issueLink/900", status: 204 },
    ]);
    expect((await run("issue", "link", "PROJ-1", "blocks", "PROJ-2")).stdout).toContain("already linked (no-op)");
    expect((await run("issue", "unlink", "PROJ-1", "blocks", "PROJ-2")).stdout).toContain("result: removed");
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);

    vi.unstubAllGlobals();
    mockApi([
      { path: "/rest/api/3/issueLinkType", json: LINK_TYPES },
      { path: ISSUE, json: linked([]) },
      { method: "POST", path: "/rest/api/3/issueLink", status: 201 },
    ]);
    const reversed = await run("issue", "link", "PROJ-1", "blocks", "PROJ-2");
    expect(reversed.exitCode).toBe(1);
    expect(reversed.stdout).toContain("does not read 'blocks PROJ-2'");
  });
});

describe("issue create", () => {
  it("resolves the type, places points on the create screen field and guards duplicates", async () => {
    const { calls } = mockApi([
      { path: "/rest/api/3/issue/createmeta/PROJ/issuetypes", json: { issueTypes: [{ id: "10001", name: "Task" }] } },
      { path: "/rest/api/3/issue/createmeta/PROJ/issuetypes/10001", json: { fields: [{ fieldId: "summary" }, { fieldId: "customfield_10103" }] } },
      { path: "/rest/api/3/search/jql", json: { issues: [], isLast: true } },
      { method: "POST", path: "/rest/api/3/issue", json: { key: "PROJ-9" } },
    ]);
    const { stdout } = await run("issue", "create", "--project", "PROJ", "--type", "task", "--summary", "New thing", "--points", "2");
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      fields: { project: { key: "PROJ" }, issuetype: { id: "10001" }, summary: "New thing", customfield_10103: 2 },
    });
    expect(stdout).toContain("issue: PROJ-9");

    vi.unstubAllGlobals();
    const dup = mockApi([
      { path: "/rest/api/3/issue/createmeta/PROJ/issuetypes", json: { issueTypes: [{ id: "10001", name: "Task" }] } },
      { path: "/rest/api/3/search/jql", json: { issues: [issue("PROJ-9", { summary: "New thing" })], isLast: true } },
    ]);
    expect((await run("issue", "create", "--project", "PROJ", "--type", "Task", "--summary", "New thing")).stdout).toContain("(no-op)");
    expect(dup.calls.some((c) => c.method === "POST")).toBe(false);
    const search = dup.calls.find((c) => c.path === "/rest/api/3/search/jql")!;
    expect(search.url.searchParams.get("jql")).toContain("reporter = currentUser()");
  });

  it("--allow-duplicate skips the guard", async () => {
    const { calls } = mockApi([
      { path: "/rest/api/3/issue/createmeta/PROJ/issuetypes", json: { issueTypes: [{ id: "10001", name: "Task" }] } },
      { method: "POST", path: "/rest/api/3/issue", json: { key: "PROJ-10" } },
    ]);
    const { stdout } = await run("issue", "create", "--project", "PROJ", "--type", "Task", "--summary", "New thing", "--allow-duplicate");
    expect(stdout).toContain("issue: PROJ-10");
    expect(calls.some((c) => c.path === "/rest/api/3/search/jql")).toBe(false);
  });
});

describe("sprint list", () => {
  it("collects distinct sprints from issues via JQL, without the Agile API", async () => {
    const sprints = [
      { id: 8, name: "Sprint 7", state: "active", boardId: 2 },
      { id: 9, name: "Sprint 8", state: "future", boardId: 2 },
    ];
    const { calls } = mockApi([
      {
        path: "/rest/api/3/search/jql",
        json: { issues: [issue("PROJ-1", { customfield_10010: sprints }), issue("PROJ-2", { customfield_10010: [sprints[0]] })], isLast: true },
      },
    ]);
    const { stdout } = await run("sprint", "list", "--project", "PROJ");
    expect(calls.some((c) => c.path.includes("/agile/"))).toBe(false);
    expect(stdout).toContain("8,Sprint 7,active,2");
    expect(stdout).toContain("9,Sprint 8,future,2");
  });
});

describe("home and auth", () => {
  it("makes no network calls when atl-axi is not configured", async () => {
    delete process.env["ATLASSIAN_API_TOKEN"];
    const { calls } = mockApi([]);
    const { stdout } = await run();
    expect(stdout).toContain("jira: not configured");
    expect(calls).toHaveLength(0);
  });

  it("shows open issues when configured", async () => {
    mockApi([{ path: "/rest/api/3/search/jql", json: { issues: [issue("PROJ-1", { assignee: ANA })], isLast: true } }]);
    const { stdout } = await run();
    expect(stdout).toContain("your_open_issues[1]{key,summary,status,updated}:");
  });

  it("auth status reports per-scope access", async () => {
    mockApi([
      { path: "/rest/api/3/mypermissions", json: { permissions: {} } },
      { path: "/rest/agile/1.0/board", status: 401, json: { message: "Unauthorized; scope does not match" } },
    ]);
    const { stdout } = await run("auth", "status");
    expect(stdout).toContain("access: jira work ok; users ok; agile boards missing");
    expect(stdout).toContain("user: Robin Reviewer");
  });

  it("names the missing scope on a 401", async () => {
    mockApi([{ path: "/rest/agile/1.0/board/2/sprint", status: 401, json: { message: "Unauthorized; scope does not match" } }]);
    const { stdout, exitCode } = await run("sprint", "list", "--board", "2");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("read:sprint:jira-software");
  });
});

describe("api", () => {
  it("only accepts /rest/ paths and previews DELETE", async () => {
    const { calls } = mockApi([]);
    expect((await run("api", "/wiki/x")).exitCode).toBe(2);
    expect((await run("api", "DELETE", "/rest/api/3/issue/PROJ-1")).stdout).toContain("NOT executed - DELETE needs --confirm");
    expect(calls).toHaveLength(0);
  });

  it("refuses to send credentials outside the API base", async () => {
    const { calls } = mockApi([]);
    const { stdout } = await run("api", "/rest/api/3/../../../../evil");
    expect(calls.every((c) => c.url.pathname.startsWith("/ex/jira/test-cloud"))).toBe(true);
    expect(stdout).toContain("error");
  });
});

describe("setup hooks", () => {
  const saved = { home: process.env["HOME"], argv1: process.argv[1] };
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "atl-axi-home-"));
    process.env["HOME"] = home;
  });
  afterEach(() => {
    process.env["HOME"] = saved.home;
    process.argv[1] = saved.argv1!;
  });

  it("fails instead of claiming success when nothing was written", async () => {
    // Under vitest argv[1] is not a atl-axi binary, so the SDK skips the install.
    const { stdout, exitCode } = await run("setup", "hooks");
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("no hooks were installed");
    expect(stdout).toContain("code: SETUP_FAILED");
  });

  it("reports installed agents and fails on a partial install", async () => {
    const bin = join(home, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "atl-axi"), "");
    process.argv[1] = join(bin, "atl-axi");
    writeFileSync(join(home, ".codex"), "not a directory");
    const partial = await run("setup", "hooks");
    expect(partial.exitCode).not.toBe(0);
    expect(partial.stdout).toContain("hooks only partly installed (installed: Claude Code; OpenCode)");
    expect(partial.stdout).toContain(".codex");

    const status = await run("setup", "status");
    expect(status.stdout).toContain("claude_code: installed");
    expect(status.stdout).toContain("codex: not installed");
  });
});
