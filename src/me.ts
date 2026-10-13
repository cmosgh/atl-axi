import { jiraJson } from "./client.js";
import { readConfig, writeConfig } from "./config.js";
import { resolveCredentials, type Credentials } from "./credentials.js";
import { AxiError } from "./errors.js";
import { arr, dig, obj, str } from "./render.js";

export interface Me {
  accountId: string;
  displayName: string;
}

/** `/myself` needs read:jira-user; JQL `currentUser()` does not. */
async function viaJql(): Promise<Me | undefined> {
  for (const role of ["assignee", "reporter"] as const) {
    const page = obj(
      await jiraJson("/rest/api/3/search/jql", {
        query: { jql: `${role} = currentUser() ORDER BY updated DESC`, maxResults: 1, fields: role },
      }),
    );
    const user = obj(dig(arr(page["issues"])[0], "fields", role));
    if (str(user["accountId"])) return { accountId: str(user["accountId"]), displayName: str(user["displayName"]) };
  }
  return undefined;
}

export async function fetchUser(credentials?: Credentials, cloudId?: string): Promise<Me | undefined> {
  try {
    const user = obj(await jiraJson("/rest/api/3/myself", { credentials, cloudId }));
    return { accountId: str(user["accountId"]), displayName: str(user["displayName"]) };
  } catch (error) {
    if (!(error instanceof AxiError) || error.code !== "AUTH_REQUIRED") throw error;
    return undefined;
  }
}

/** The authenticated user, cached in config.json keyed by email. */
export async function currentUser(): Promise<Me | undefined> {
  const credentials = await resolveCredentials();
  if (!credentials) return undefined;
  const config = readConfig();
  if (config.user && config.user.email === credentials.email && config.user.accountId) {
    return { accountId: config.user.accountId, displayName: config.user.displayName };
  }
  const me = (await fetchUser()) ?? (await viaJql().catch(() => undefined));
  if (me?.accountId) {
    try {
      writeConfig({ ...readConfig(), user: { ...me, email: credentials.email } });
    } catch {
      // cache is an optimisation; a read-only config dir must not fail the command
    }
  }
  return me;
}
