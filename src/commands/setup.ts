import { installSessionStartHooks, sessionStartHookStatus, uninstallSessionStartHooks } from "axi-sdk-js";
import { bool, expectPositionals, parseArgs } from "../args.js";
import { axiError, usageError } from "../errors.js";
import { block, helpBlock, out } from "../render.js";

type Scope = "user" | "project";

export const SETUP_HELP = `usage: atl-axi setup <hooks|status|uninstall> [--project]
Manage the opt-in SessionStart integration that shows your open Jira issues (atl-axi home view) to Claude Code, Codex and OpenCode at session start.
flags:
  --project (install into the current repository's agent config instead of your user config)
notes:
  User scope runs in every session; until atl-axi is configured the home view is two lines and makes no network calls.
examples[3]:
  atl-axi setup hooks
  atl-axi setup hooks --project
  atl-axi setup status
`;

const IDENTITY = { marker: "atl-axi", binaryNames: ["atl-axi"] };

export async function setupCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== "hooks" && sub !== "status" && sub !== "uninstall") {
    throw usageError(sub ? `unknown setup action '${sub}'` : "missing setup action", [
      "Run `atl-axi setup hooks` to install, `atl-axi setup status` to inspect, `atl-axi setup uninstall` to remove",
    ]);
  }
  const command = `atl-axi setup ${sub}`;
  const parsed = parseArgs(rest, [{ name: "--project", boolean: true }], command);
  expectPositionals(parsed, 0, `${command} [--project]`);
  const scope: Scope = bool(parsed, "--project") ? "project" : "user";

  if (sub === "status") {
    const status = sessionStartHookStatus({ ...IDENTITY, scope });
    return block({
      hooks: {
        scope,
        claude_code: status.claude.installed ? "installed" : "not installed",
        codex: status.codex.installed ? "installed" : "not installed",
        opencode: status.opencode.installed ? "installed" : "not installed",
      },
    });
  }

  if (sub === "uninstall") {
    const errors: string[] = [];
    uninstallSessionStartHooks({ ...IDENTITY, scope, onError: (message) => errors.push(message) });
    const left = installedAgents(scope);
    if (errors.length > 0 || left.length > 0) {
      throw axiError(`hooks not fully removed${left.length > 0 ? ` (still installed: ${left.join("; ")})` : ""}`, "SETUP_FAILED", errors);
    }
    return block({ hooks: { scope, status: "removed (or were not installed)" } });
  }

  // The SDK silently skips non-installed exec paths and reports write failures only via onError, so verify by re-reading.
  const errors: string[] = [];
  installSessionStartHooks({ ...IDENTITY, scope, onError: (message) => errors.push(message) });
  const installed = installedAgents(scope);
  if (installed.length === 0) {
    throw axiError("no hooks were installed", "SETUP_FAILED", errors.length > 0 ? errors : [
      "Hooks are only installed from the npm-installed binary: run `npm i -g atl-axi`, then `atl-axi setup hooks`",
    ]);
  }
  if (errors.length > 0 || installed.length < 3) {
    throw axiError(`hooks only partly installed (installed: ${installed.join("; ")})`, "SETUP_FAILED", errors);
  }
  return out(
    block({ hooks: { scope, status: "installed", integrations: installed.join("; ") } }),
    helpBlock(["Restart the agent session to receive the atl-axi home view as ambient context"]),
  );
}

function installedAgents(scope: Scope): string[] {
  const status = sessionStartHookStatus({ ...IDENTITY, scope });
  const agents: Array<[string, boolean]> = [
    ["Claude Code", status.claude.installed],
    ["Codex", status.codex.installed],
    ["OpenCode", status.opencode.installed],
  ];
  return agents.filter(([, installed]) => installed).map(([agent]) => agent);
}
