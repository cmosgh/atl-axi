---
name: atl-axi
description: "Operate Jira Cloud through the atl-axi CLI - view and search issues by JQL, read comments, set story points, sprint, parent, assignee, labels or any custom field by name, transition status, comment, create issues and link them (blocks / is blocked by). Use whenever a task touches a Jira issue key (PROJ-123), a sprint or an atlassian.net Jira site."
user-invocable: false
---

# atl-axi

Jira Cloud CLI for agents - view and search issues, edit fields (story points, sprint, parent, any custom field by name), transition, comment, create and link issues. Prefer it over raw API calls.

Use atl-axi whenever a task touches Jira: issues, JQL search, sprints, story points, transitions, comments or issue links.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- `npx -y atl-axi` for your open issues (and the issue of the current git branch)
- `npx -y atl-axi --help` for the command index
- `npx -y atl-axi <command> --help` for per-command flags and examples

Authentication is a one-time, user-performed step: `<token-command> | npx -y atl-axi auth login --site <site>.atlassian.net --email <atlassian-email> --token-stdin`. Never ask for the token in chat or pass it as an argument.
