import { installSessionStartHooks, sessionStartHookStatus, uninstallSessionStartHooks } from "axi-sdk-js";
import { bool, expectPositionals, parseArgs } from "../args.js";
import { usageError } from "../errors.js";
import { block, helpBlock, out } from "../render.js";

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
  const scope = bool(parsed, "--project") ? "project" : "user";

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
    await uninstallSessionStartHooks({ ...IDENTITY, scope });
    return block({ hooks: { scope, status: "removed (or were not installed)" } });
  }

  await installSessionStartHooks({ ...IDENTITY, scope });
  return out(
    block({ hooks: { scope, status: "installed or already up to date", integrations: "Claude Code, Codex, OpenCode" } }),
    helpBlock(["Restart the agent session to receive the atl-axi home view as ambient context"]),
  );
}
