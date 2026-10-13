import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adfToText, textToAdf } from "../src/adf.js";
import { normalizeSite, scopeHint } from "../src/client.js";
import { branchIssueKey } from "../src/commands/home.js";
import { resolveRelation } from "../src/commands/link.js";
import { buildJql } from "../src/commands/search.js";
import { coerceValue, findField, formatValue, toFieldDef } from "../src/fields.js";
import { createSkillMarkdown } from "../src/skill.js";
import type { AxiError } from "../src/errors.js";
import { FIELDS } from "./helpers.js";

const catalog = FIELDS.map(toFieldDef);

function suggestions(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as AxiError).suggestions.join("\n");
  }
  throw new Error("expected a throw");
}

describe("adf", () => {
  it("renders headings, lists, code, links and mentions as text", () => {
    const text = adfToText({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Plan" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
        { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "x()" }] },
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { text: "@Ana" } },
            { type: "text", text: " see " },
            { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://example.test" } }] },
          ],
        },
      ],
    });
    expect(text).toBe("## Plan\n\n- one\n\n```ts\nx()\n```\n\n@Ana see docs (https://example.test)");
  });

  it("round-trips plain text through ADF", () => {
    const source = "# Title\n\nline one\nline two\n\n- a\n- b\n\n1. x\n2. y\n\n```\ncode\n```\n\nsee `cfg` at https://example.test";
    expect(adfToText(textToAdf(source))).toBe(source.replace("https://example.test", "https://example.test"));
  });
});

describe("site and scopes", () => {
  it("normalizes site names", () => {
    expect(normalizeSite("acme")).toBe("acme.atlassian.net");
    expect(normalizeSite("https://Acme.atlassian.net/jira/x")).toBe("acme.atlassian.net");
    expect(() => normalizeSite("evil.example.com")).toThrow();
  });

  it("maps endpoints to the scope a scoped token is likely missing", () => {
    expect(scopeHint("/ex/jira/x/rest/agile/1.0/board", "GET")).toContain("read:sprint:jira-software");
    expect(scopeHint("/ex/jira/x/rest/api/3/myself", "GET")).toBe("read:jira-user");
    expect(scopeHint("/ex/jira/x/rest/api/3/issue/A-1", "PUT")).toBe("write:jira-work");
  });
});

describe("jql", () => {
  it("adds filters to a bare query and defaults the order", () => {
    expect(buildJql(undefined, { mine: true })).toBe("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC");
    expect(buildJql("project = A", {})).toBe("project = A ORDER BY updated DESC");
    expect(buildJql(undefined, { sprint: "open", text: 'a "b"' })).toBe('sprint in openSprints() AND text ~ "a \\"b\\"" ORDER BY updated DESC');
  });
});

describe("fields", () => {
  it("finds fields by id or case-insensitive name and suggests near misses", () => {
    expect(findField(catalog, "story points").id).toBe("customfield_10014");
    expect(findField(catalog, "CUSTOMFIELD_10200").name).toBe("Team");
    expect(suggestions(() => findField(catalog, "point"))).toMatch(/did you mean.*Story Points/);
  });

  it("coerces values by schema", () => {
    expect(coerceValue(findField(catalog, "Team"), "Core")).toEqual({ value: "Core" });
    expect(coerceValue(findField(catalog, "Labels"), "a, b")).toEqual(["a", "b"]);
    expect(coerceValue(findField(catalog, "Sprint"), "8")).toBe(8);
    expect(coerceValue(findField(catalog, "Story Points"), "none")).toBeNull();
    expect(coerceValue(findField(catalog, "Notes"), "hi")).toMatchObject({ type: "doc" });
    expect(() => coerceValue(findField(catalog, "Story Points"), "x")).toThrow(/expects a number/);
  });

  it("formats values on one line", () => {
    expect(formatValue([{ id: 1, name: "S1", state: "ACTIVE" }])).toBe("S1 (active)");
    expect(formatValue({ displayName: "Ana" })).toBe("Ana");
    expect(formatValue(null)).toBe("none");
  });
});

describe("link relations", () => {
  const types = [{ id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" }];
  it("maps outward and inward phrases onto Jira's POST ends", () => {
    expect(resolveRelation(types, "blocks", "A-1", "B-1")).toMatchObject({ inwardIssue: "A-1", outwardIssue: "B-1" });
    expect(resolveRelation(types, "is-blocked-by", "A-1", "B-1")).toMatchObject({ inwardIssue: "B-1", outwardIssue: "A-1" });
    expect(suggestions(() => resolveRelation(types, "fixes", "A-1", "B-1"))).toContain("'is blocked by'");
  });
});

describe("branch issue key", () => {
  it("reads the key from .git/HEAD, including worktrees", () => {
    const repo = mkdtempSync(join(tmpdir(), "atl-axi-git-"));
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/proj-42-retry\n");
    mkdirSync(join(repo, "src"));
    expect(branchIssueKey(join(repo, "src"))).toBe("PROJ-42");

    const wt = mkdtempSync(join(tmpdir(), "atl-axi-wt-"));
    const gitdir = join(repo, ".git", "worktrees", "x");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
    expect(branchIssueKey(wt)).toBeUndefined();
  });
});

describe("skill", () => {
  it("stays a short discovery stub", () => {
    expect(createSkillMarkdown()).toContain("name: atl-axi");
  });
});
