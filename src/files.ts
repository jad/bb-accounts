// Filesystem side of accounts: where a directory lives, whether it is logged
// in and as whom, and the shared-config symlinks a new account starts with.
//
// Everything here runs on the bb server's machine. Threads on an enrolled
// remote host receive the same absolute path, so that host needs the same
// directory (see the skill's "Remote machines" note).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type Account, type ProviderId, PROVIDERS } from "./core";

/**
 * Entries linked from the provider's own home into a new account, so every
 * account shares settings, skills, and plugins but keeps its own login.
 * Claude's `projects` holds transcripts: sharing it lets a fork resume on any
 * account. Codex keeps sessions next to its state databases, so those stay
 * per account.
 */
const SHARED_ENTRIES: Record<ProviderId, readonly string[]> = {
  "claude-code": [
    "settings.json",
    "CLAUDE.md",
    "commands",
    "agents",
    "skills",
    "plugins",
    "hooks",
    "output-styles",
    "projects",
  ],
  codex: ["config.toml", "AGENTS.md", "skills", "prompts", "rules", "hooks.json", "plugins"],
};

export function providerHome(provider: ProviderId): string {
  return join(homedir(), provider === "claude-code" ? ".claude" : ".codex");
}

/** The directory the provider actually reads for this account. */
export function effectiveDir(account: Account): string {
  return account.configDir ?? providerHome(account.provider);
}

/** Expands `~` and makes the path absolute. */
export function normalizeDir(input: string): string {
  const trimmed = input.trim();
  const expanded =
    trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(homedir(), expanded);
}

export function suggestedDir(provider: ProviderId, slug: string): string {
  return join(homedir(), PROVIDERS[provider].newAccountsDir, slug);
}

export function displayPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export interface LoginStatus {
  dirExists: boolean;
  /** Whom the account is logged in as, when known. */
  identity: string | null;
  /** null = could not tell (the CLI could not be run and the files are unclear). */
  loggedIn: boolean | null;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function jwtEmail(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const email = field(claims, "email");
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

function withOrg(email: string, org: unknown): string {
  return typeof org === "string" && org !== "" ? `${email} · ${org}` : email;
}

/** Runs a provider CLI with this account's variable, or returns null when it cannot run. */
function runCli(account: Account, args: string[]): Promise<{ code: number; stdout: string } | null> {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  if (account.configDir !== null) env[PROVIDERS[account.provider].envVar] = account.configDir;
  const command = account.provider === "claude-code" ? "claude" : "codex";
  return new Promise((resolvePromise) => {
    execFile(command, args, { env, cwd: homedir(), timeout: 15_000, maxBuffer: 1 << 20 }, (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      resolvePromise(code === null ? null : { code, stdout });
    });
  });
}

/** What the CLI itself says: `claude auth status --json` / `codex login status`. */
async function cliStatus(account: Account): Promise<Omit<LoginStatus, "dirExists"> | null> {
  if (account.provider === "claude-code") {
    const result = await runCli(account, ["auth", "status", "--json"]);
    if (result === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return null;
    }
    const loggedIn = field(parsed, "loggedIn");
    if (typeof loggedIn !== "boolean") return null;
    const email = field(parsed, "email");
    return {
      loggedIn,
      identity: loggedIn && typeof email === "string" ? withOrg(email, field(parsed, "orgName")) : null,
    };
  }
  const result = await runCli(account, ["login", "status"]);
  if (result === null) return null;
  if (result.code !== 0) return { loggedIn: false, identity: null };
  const email = jwtEmail(field(field(await readJson(join(effectiveDir(account), "auth.json")), "tokens"), "id_token"));
  const how = result.stdout.trim().split("\n")[0]?.replace(/^Logged in using /u, "") ?? "";
  return { loggedIn: true, identity: email ?? (how === "" ? null : how) };
}

/** Fallback when the CLI cannot run: read the files the CLI writes at login. */
async function fileStatus(account: Account): Promise<Omit<LoginStatus, "dirExists">> {
  const dir = effectiveDir(account);
  if (account.provider === "claude-code") {
    // Without CLAUDE_CONFIG_DIR the CLI keeps .claude.json beside ~/.claude.
    const file = account.configDir === null ? join(homedir(), ".claude.json") : join(dir, ".claude.json");
    const oauth = field(await readJson(file), "oauthAccount");
    const email = field(oauth, "emailAddress");
    return typeof email === "string"
      ? { loggedIn: true, identity: withOrg(email, field(oauth, "organizationName")) }
      : { loggedIn: false, identity: null };
  }
  const auth = await readJson(join(dir, "auth.json"));
  if (auth === null) return { loggedIn: false, identity: null };
  const email = jwtEmail(field(field(auth, "tokens"), "id_token"));
  if (email !== null) return { loggedIn: true, identity: email };
  const apiKey = field(auth, "OPENAI_API_KEY");
  return typeof apiKey === "string" && apiKey !== ""
    ? { loggedIn: true, identity: "API key" }
    : { loggedIn: null, identity: null };
}

export async function loginStatus(account: Account): Promise<LoginStatus> {
  // The status commands create a missing folder, so never run them for one.
  if (!existsSync(effectiveDir(account))) return { dirExists: false, identity: null, loggedIn: false };
  return { dirExists: true, ...((await cliStatus(account)) ?? (await fileStatus(account))) };
}

/** Files whose presence marks a folder as this provider's config folder. */
const CONFIG_MARKERS: Record<ProviderId, readonly string[]> = {
  "claude-code": [".claude.json", ".credentials.json", "settings.json", "projects"],
  codex: ["auth.json", "config.toml", "sessions"],
};

/**
 * Refuses a folder that cannot become an account: a file, or a folder with
 * contents that is not a config folder of this provider (a typo such as
 * ~/Documents would otherwise fill it with shared-config symlinks). A missing
 * or empty folder is fine.
 */
export async function checkDir(provider: ProviderId, dir: string): Promise<void> {
  const info = await stat(dir).catch(() => null);
  if (info === null) return;
  if (!info.isDirectory()) throw new Error(`${displayPath(dir)} is a file, not a folder.`);
  const entries = await readdir(dir);
  if (entries.length === 0) return;
  if (CONFIG_MARKERS[provider].some((marker) => entries.includes(marker))) return;
  throw new Error(
    `${displayPath(dir)} already has files and does not look like a ${PROVIDERS[provider].name} config folder (no ${CONFIG_MARKERS[provider].join(", ")}). Pick an empty or new folder.`,
  );
}

/**
 * Creates the account directory (private to the user) and links the shared
 * entries that exist in the provider's home and are absent here. Returns the
 * entries it linked.
 */
export async function prepareDir(
  provider: ProviderId,
  dir: string,
  shareConfig: boolean,
): Promise<string[]> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!shareConfig) return [];
  const home = providerHome(provider);
  const linked: string[] = [];
  for (const entry of SHARED_ENTRIES[provider]) {
    const source = join(home, entry);
    const target = join(dir, entry);
    if (!existsSync(source)) continue;
    const present = await lstat(target).then(
      () => true,
      () => false,
    );
    if (present) continue;
    await symlink(source, target);
    linked.push(entry);
  }
  return linked;
}
