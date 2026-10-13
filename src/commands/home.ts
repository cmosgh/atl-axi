import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { jiraJson } from "../client.js";
import { readConfig } from "../config.js";
import { resolveCredentials } from "../credentials.js";
import { AxiError } from "../errors.js";
import { fields, issuePath, searchJql, statusName } from "../issue-api.js";
import { block, helpBlock, obj, out, relTime, str, type Obj } from "../render.js";

/** The home view runs at every session start: keep it fast and tiny. */
const HOME_TIMEOUT_MS = 8_000;
const HOME_ROWS = 5;

/** Jira key embedded in the current git branch name, read straight from .git/HEAD. */
export function branchIssueKey(cwd: string = process.cwd()): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const git = join(dir, ".git");
    if (existsSync(git)) {
      try {
        let head = join(git, "HEAD");
        if (!existsSync(head)) {
          // worktree: .git is a file pointing at the real git dir
          const pointer = readFileSync(git, "utf-8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
          if (!pointer) return undefined;
          head = join(pointer, "HEAD");
        }
        const ref = readFileSync(head, "utf-8").match(/^ref: refs\/heads\/(.+)$/m)?.[1] ?? "";
        return ref.toUpperCase().match(/(?:^|[^A-Z0-9])([A-Z][A-Z0-9]+-\d+)/)?.[1];
      } catch {
        return undefined;
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

export async function homeCommand(): Promise<string> {
  const configured = Boolean(process.env["ATLASSIAN_API_TOKEN"]) || Boolean(readConfig().email);
  if (!configured) {
    // No keychain or network access until the user has set atl-axi up.
    return out(
      block({ jira: "not configured" }),
      helpBlock(["Run `<token-command> | atl-axi auth login --site <site>.atlassian.net --email <atlassian-email> --token-stdin`"]),
    );
  }
  if (!(await resolveCredentials())) {
    return out(block({ jira: "not authenticated" }), helpBlock(["Run `atl-axi auth status`"]));
  }

  const branchKey = branchIssueKey();
  const summary: Obj = {};
  try {
    const [mine, branch] = await Promise.all([
      searchJql("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC", ["summary", "status", "updated"], HOME_ROWS + 1, HOME_TIMEOUT_MS),
      branchKey
        ? jiraJson(issuePath(branchKey), { query: { fields: "summary,status" }, timeoutMs: HOME_TIMEOUT_MS }).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    if (branch) {
      const issue = obj(branch);
      summary["branch_issue"] = `${branchKey} ${statusName(issue)} - ${str(fields(issue)["summary"])}`;
    }
    summary["your_open_issues"] =
      mine.issues.length > 0
        ? mine.issues.slice(0, HOME_ROWS).map((i) => ({
            key: str(i["key"]),
            summary: str(fields(i)["summary"]),
            status: statusName(i),
            updated: relTime(fields(i)["updated"]),
          }))
        : "0 open issues assigned to you";
    const help: string[] = [];
    if (mine.issues.length > HOME_ROWS || mine.more) help.push("Run `atl-axi search --mine --limit 50` for all of them");
    help.push("Run `atl-axi issue view <KEY>` for details", "Run `atl-axi --help` for every command");
    return out(block(summary), helpBlock(help));
  } catch (error) {
    const message = error instanceof AxiError ? error.message : "request failed";
    return out(block({ jira: `unavailable - ${message}` }), helpBlock(["Run `atl-axi auth status` to check credentials"]));
  }
}
