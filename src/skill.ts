import { DESCRIPTION } from "./cli.js";

// Trigger string agents match against to auto-load the skill.
export const SKILL_DESCRIPTION =
  "Operate Jira Cloud through the atl-axi CLI - view and search issues by JQL, read comments, set story points, sprint, parent, " +
  "assignee, labels or any custom field by name, transition status, comment, create issues and link them (blocks / is blocked by). " +
  "Use whenever a task touches a Jira issue key (PROJ-123), a sprint or an atlassian.net Jira site.";

// Hard cap so a regeneration cannot re-inflate the stub with CLI-owned guidance.
export const MAX_SKILL_MARKDOWN_CHARS = 2000;

/** A discovery stub, not a copy of the CLI's guidance: `atl-axi --help` never goes stale. */
export function createSkillMarkdown(): string {
  const markdown = `---
name: atl-axi
description: ${JSON.stringify(SKILL_DESCRIPTION)}
user-invocable: false
---

# atl-axi

${DESCRIPTION}

Use atl-axi whenever a task touches Jira: issues, JQL search, sprints, story points, transitions, comments or issue links.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- \`npx -y atl-axi\` for your open issues (and the issue of the current git branch)
- \`npx -y atl-axi --help\` for the command index
- \`npx -y atl-axi <command> --help\` for per-command flags and examples

Authentication is a one-time, user-performed step: \`<token-command> | npx -y atl-axi auth login --site <site>.atlassian.net --email <atlassian-email> --token-stdin\`. Never ask for the token in chat or pass it as an argument.
`;
  if (markdown.length > MAX_SKILL_MARKDOWN_CHARS) {
    throw new Error(`generated SKILL.md is ${markdown.length} chars; keep it under ${MAX_SKILL_MARKDOWN_CHARS}`);
  }
  return markdown;
}
