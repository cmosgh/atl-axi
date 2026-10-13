# atl-axi - contributor notes for agents

AXI-compliant Atlassian Jira Cloud CLI. Read the AXI principles (https://axi.md) before changing output.

- **Output is the product.** Every stdout byte costs tokens. Default list schemas stay at 3-5 fields; extras go behind `--fields`. Keep numbers as numbers (TOON quotes numeric-looking strings). Avoid commas, colons and double quotes inside literal TOON string values.
- **Handlers return strings** built with `block()` (TOON), `helpBlock()` (one suggestion per line) and `out()` from `src/render.ts`. Free text (descriptions, comments) goes between `---` fences, never inside a TOON string.
- **Every flag is declared.** `parseArgs()` in `src/args.ts` rejects unknown flags with the valid set inline. Validate all input before the first network call; usage errors are `VALIDATION_ERROR` (exit 2).
- **Mutations are idempotent**: pre-check state, report `(no-op)`, exit 0. Edits send only changed fields. Links are read back after creation (Jira's POST ends are counter-intuitive).
- **Scoped tokens**: every request goes through `api.atlassian.com/ex/jira/<cloudId>`; a 401 usually means a missing scope, and errors name it (`scopeHint()` in `src/client.ts`). Prefer endpoints that work with `read:jira-work`/`write:jira-work` only (JQL over the Agile API, field edits over sprint endpoints).
- **Fields are resolved by name** through the cached catalog (`src/fields.ts`); never hard-code a site's `customfield_*` ids.
- **The home view runs at every session start.** Until atl-axi is configured it must not touch the network or the keychain.
- **Secrets**: tokens come from stdin or env only, live in the OS keychain, and are sent only to the API base (`buildUrl()` in `src/client.ts`).
- `src/version.ts` is a leaf module (node builtins only) for the `--version` fast path.
- Tests: `test/unit.test.ts` (pure logic) and `test/commands.test.ts` (whole CLI via `main()` with a mocked `fetch`). Fixtures are synthetic - never commit real site, project, issue or people names.
- `pnpm run check` must pass. `skills/atl-axi/SKILL.md` is generated: `pnpm run build:skill`.
