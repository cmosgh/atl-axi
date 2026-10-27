import { runAxiCli } from "axi-sdk-js";
import { apiCommand, API_HELP } from "./commands/api.js";
import { authCommand, AUTH_HELP } from "./commands/auth.js";
import { fieldCommand, FIELD_HELP } from "./commands/field.js";
import { homeCommand } from "./commands/home.js";
import { issueCommand, ISSUE_HELP } from "./commands/issue.js";
import { projectCommand, PROJECT_HELP } from "./commands/project.js";
import { searchCommand, SEARCH_HELP } from "./commands/search.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";
import { sprintCommand, SPRINT_HELP } from "./commands/sprint.js";
import { AxiError, exitCodeForError } from "./errors.js";
import { renderErrorOutput, setJsonMode, toJson } from "./render.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Jira Cloud CLI for agents - view and search issues, edit fields (story points, sprint, parent, any custom field by name), transition, comment, create and link issues. Prefer it over raw API calls.";

export const TOP_HELP = `usage: atl-axi [command] [args] [flags]
commands[8]:
  (none)=your open issues, issue, search, sprint, field, project, api, auth, setup
flags[3]:
  --json (JSON instead of TOON, for scripts), --help, -v/-V/--version
examples:
  atl-axi
  atl-axi issue view PROJ-123
  atl-axi search --mine
  atl-axi search "project = PROJ AND sprint in openSprints()" --fields points
  atl-axi issue edit PROJ-123 --points 3 --sprint 578
  atl-axi issue transition PROJ-123 'In Progress'
  atl-axi issue link PROJ-1 blocks PROJ-2
  atl-axi issue --help
`;

const COMMAND_HELP: Record<string, string> = {
  issue: ISSUE_HELP,
  search: SEARCH_HELP,
  sprint: SPRINT_HELP,
  field: FIELD_HELP,
  project: PROJECT_HELP,
  api: API_HELP,
  auth: AUTH_HELP,
  setup: SETUP_HELP,
};

function cmd(name: string, handler: (args: string[]) => Promise<string>): (args: string[]) => Promise<string> {
  return async (args) => (args.includes("-h") ? (COMMAND_HELP[name] ?? "").trimEnd() : handler(args));
}

function formatError(error: unknown): { output: string; exitCode: number } {
  const axi =
    error instanceof AxiError ? error : new AxiError(error instanceof Error ? error.message : String(error), "UNKNOWN");
  return { output: `${renderErrorOutput(axi.message, axi.code, axi.suggestions)}\n`, exitCode: exitCodeForError(axi) };
}

export interface MainOptions {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
}

export async function main(options: MainOptions = {}): Promise<void> {
  // Stripped here: the SDK rejects flags before the command, and --json may stand anywhere.
  const argv = options.argv ?? process.argv.slice(2);
  const json = argv.includes("--json");
  setJsonMode(json);
  const stdout = options.stdout ?? process.stdout;
  let buffered = "";
  await runAxiCli({
    argv: json ? argv.filter((a) => a !== "--json") : argv,
    stdout: json ? { write: (chunk: string) => (buffered += chunk) } : stdout,
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home: () => homeCommand(),
    commands: {
      issue: cmd("issue", issueCommand),
      search: cmd("search", searchCommand),
      sprint: cmd("sprint", sprintCommand),
      field: cmd("field", fieldCommand),
      project: cmd("project", projectCommand),
      api: cmd("api", apiCommand),
      auth: cmd("auth", authCommand),
      setup: cmd("setup", setupCommand),
    },
    getCommandHelp: (command) => COMMAND_HELP[command],
    renderUnknownCommand: (command) =>
      `${renderErrorOutput(`unknown command '${command}'`, "VALIDATION_ERROR", [
        "commands: issue, search, sprint, field, project, api, auth, setup (no command = your open issues)",
        "Run `atl-axi --help` for examples",
      ])}\n`,
    formatError,
  });
  if (!json) return;
  // The SDK only guards the stdout it writes to: `--json | head` must not crash on EPIPE either.
  if (stdout === process.stdout) process.stdout.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") throw error; });
  stdout.write(toJson(buffered));
}
