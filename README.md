# atl-axi

Agent-ergonomic **Jira Cloud** CLI, built on the [AXI](https://axi.md) principles: token-efficient [TOON](https://toonformat.dev/) output, minimal schemas, definitive empty states, structured errors, idempotent mutations, and next-step hints.

It talks to the Jira REST API directly - no `acli`, no MCP server - and works with **scoped API tokens**. The things agents get wrong in Jira are the plumbing: which `customfield_*` holds story points on this screen, how to move an issue into a sprint, which end of a "blocks" link is which. `atl-axi` handles that for them.

```
$ atl-axi issue view PROJ-123
issue:
  key: PROJ-123
  summary: Retry the sync worker
  type: Task
  status: In Progress
  assignee: Ana Author
  priority: Medium
  points: 3
  sprint: Sprint 7 (active; id 578)
  parent: PROJ-100 Sync reliability
  labels: none
  updated: 1h ago
  links[1]{relation,key,status,summary}:
    is blocked by,PROJ-120,Done,Add backoff helper
  comments: 2
---
Retries transient failures with exponential backoff.
---
help[2]:
  Run `atl-axi issue comments PROJ-123` to read the 2 comments
  Run `atl-axi issue transition PROJ-123` to list status transitions
```

> **Status: early (v0.1.x).** Covered by unit and mocked end-to-end tests and checked against a live Jira Cloud site.

## Install

Requires Node.js 20+.

```sh
npm install -g atl-axi
```

Prefer the global install over `npx -y atl-axi`: npx adds start-up time and, inside npm workspaces, `npm notice` lines on stderr for every call.

One line in `CLAUDE.md` / `AGENTS.md`:

```
Use `atl-axi` for anything in Jira (issues, JQL, sprints, story points, transitions, comments, links).
```

Optional: `atl-axi setup hooks` shows your open issues (and the issue named in the current git branch) at agent session start.

## Authenticate

Create an [Atlassian API token with scopes](https://id.atlassian.com/manage-profile/security/api-tokens) for Jira:

`read:jira-work` `write:jira-work` (plus `read:jira-user` for `--assignee <name>` and your display name, and `read:board-scope:jira-software` `read:sprint:jira-software` for `sprint list --board`)

| Scope | For |
| --- | --- |
| `read:jira-work` | everything that reads |
| `write:jira-work` | edit, transition, comment, create, link |
| `read:jira-user` | optional - `--assignee <name>`, your display name |
| `read:board-scope:jira-software` `read:sprint:jira-software` | optional - `sprint list --board` (empty future sprints) |

```sh
pbpaste | atl-axi auth login --site acme.atlassian.net --email you@example.com --token-stdin
atl-axi auth status   # shows which scope families the token has
```

- The token is read **only from stdin** - never from argv, so it cannot land in shell history or an agent transcript - validated against the API, then stored in the OS keychain (macOS Keychain, Windows Credential Manager, libsecret). `atl-axi` never prompts.
- Use the **Atlassian account email**.
- Requests always go through `api.atlassian.com/ex/jira/<cloudId>` (required for scoped tokens); the cloud id is looked up from the site.

### Environment variables

Override the stored login (CI, containers, agent shells):

| Variable | Purpose |
| --- | --- |
| `ATLASSIAN_EMAIL` | Atlassian account email (with `ATLASSIAN_API_TOKEN`) |
| `ATLASSIAN_API_TOKEN` | API token (with `ATLASSIAN_EMAIL`) |
| `ATLASSIAN_SITE` | Site, e.g. `acme.atlassian.net`; the cloud id is looked up and cached |
| `JIRA_CLOUD_ID` | Cloud id directly; skips the lookup and wins over `ATLASSIAN_SITE` |
| `ATL_AXI_NO_KEYCHAIN` | `1` never reads or writes the OS keychain |
| `ATL_AXI_CONFIG_DIR` | Config and cache directory (default `$XDG_CONFIG_HOME/atl-axi` or `~/.config/atl-axi`) |
| `ATL_AXI_POINTS_FIELD` | Story points field to write (name or id), e.g. `customfield_10014`, when the issue screen offers a different one |

## Commands

| Command | What it does |
| --- | --- |
| `atl-axi` | Your open issues, plus the issue named in the current git branch |
| `issue view <KEY>` | Summary, points, open sprint (with id), parent, links with direction, description. `--full`, `--fields '<name>,...'` |
| `issue comments <KEY>` | Newest comments as text. `--limit`, `--full` |
| `issue edit <KEY>` | `--points`, `--sprint <id>`, `--parent`, `--assignee me`, `--labels`/`--add-label`/`--remove-label`, `--priority`, `--summary`, `--description`, `--set '<any field name>=<value>'`. Sends only changes; `(no-op)` when nothing differs |
| `issue transition <KEY> [<target>]` | Lists transitions, or moves by transition or status name. `--resolution` |
| `issue comment <KEY>` | `--body` / `--body-file -`; plain text becomes ADF. Skips an identical recent comment |
| `issue create` | `--project --type --summary` plus the edit fields. Skips a same-summary issue created in the last day |
| `issue link <A> <relation> <B>` / `unlink` | `atl-axi issue link PROJ-1 blocks PROJ-2`, `'is blocked by'`, `'relates to'`... Read back after creation |
| `search ["<JQL>"]` | `--mine`, `--project`, `--status`, `--sprint <id\|open>`, `--text`, `--fields points,sprint,...` |
| `sprint list --project <KEY>` | Active/future sprints with ids, from the project's issues (no Agile scopes needed); `--board <id>` uses the Agile API |
| `sprint issues <id>` | Issues in a sprint with a points total and status breakdown |
| `field list` | Field ids and types. `--search`, `--custom` |
| `project list` | Visible projects |
| `api [METHOD] /rest/...` | Escape hatch; `DELETE` needs `--confirm` |

Every command has `--help`.

## Development

```sh
pnpm install
pnpm run check   # typecheck + tests + build + SKILL.md freshness
```

## License

MIT
