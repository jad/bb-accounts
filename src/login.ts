// Logging an account in from bb, without a terminal.
//
// Claude Code: `claude auth login` hands its consent URL to $BROWSER and
// waits for the redirect on a localhost port. We point $BROWSER at a helper
// that opens a private Chrome window on this machine (so the page does not
// reuse whichever Claude session the browser already has), falling back to
// the default browser. The CLI also prints a second link whose page shows a
// code to paste back; that path works from any device, so it is offered too
// and the pasted code goes to the CLI's stdin.
//
// Codex: `codex login` ignores $BROWSER and always opens the default
// browser, so we use `codex login --device-auth` instead: a link and a
// one-time code the user enters on any device.
//
// Consent URLs carry a one-time PKCE challenge; they are kept in memory for
// the UI and never logged.
import { spawn as spawnProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Account, PROVIDERS } from "./core";

export type LoginPhase = "waiting" | "done" | "failed" | "cancelled";

export interface LoginSession {
  accountId: string;
  provider: Account["provider"];
  phase: LoginPhase;
  /** Claude: a private window was opened on the bb machine. */
  openedHere: boolean;
  /** Claude: the paste-a-code link. Codex: the device page. */
  link: string | null;
  /** Codex: the one-time code to enter on the device page. */
  code: string | null;
  /** Why it failed, from the CLI's own output (bounded). */
  message: string | null;
  startedAt: number;
}

export interface LoginChild {
  write(text: string): void;
  kill(): void;
  onOutput(listener: (chunk: string) => void): void;
  /** Exit code; null when it could not start or was killed. */
  exited: Promise<number | null>;
}

export type SpawnLogin = (command: string, args: string[], env: NodeJS.ProcessEnv) => LoginChild;

export const LOGIN_TIMEOUT_MS = 15 * 60_000;

const BROWSER_HELPER = `#!/bin/sh
# BROWSER for \`claude auth login\` started from bb's Accounts plugin.
url="\${1:-}"
case "$url" in https://*) ;; *) exit 1 ;; esac
if [ "$(uname)" = "Darwin" ]; then
  /usr/bin/open -na "Google Chrome" --args --incognito "$url" 2>/dev/null && exit 0
  exec /usr/bin/open "$url"
fi
unset BROWSER
exec xdg-open "$url"
`;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");
}

export function spawnChild(command: string, args: string[], env: NodeJS.ProcessEnv): LoginChild {
  const child = spawnProcess(command, args, { env, cwd: homedir(), stdio: ["pipe", "pipe", "pipe"] });
  const listeners: ((chunk: string) => void)[] = [];
  const emit = (data: Buffer) => listeners.forEach((listener) => listener(data.toString("utf8")));
  child.stdout.on("data", emit);
  child.stderr.on("data", emit);
  child.stdin.on("error", () => undefined);
  return {
    write: (text) => child.stdin.write(text),
    kill: () => child.kill("SIGTERM"),
    onOutput: (listener) => listeners.push(listener),
    exited: new Promise((resolve) => {
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code));
    }),
  };
}

export class LoginManager {
  private readonly sessions = new Map<string, { session: LoginSession; child: LoginChild; timer: NodeJS.Timeout }>();
  private helperDir: string | null = null;

  constructor(
    private readonly onChange: (session: LoginSession) => void,
    private readonly spawn: SpawnLogin = spawnChild,
  ) {}

  list(): LoginSession[] {
    return [...this.sessions.values()].map((entry) => ({ ...entry.session }));
  }

  /** Starts a login, or returns the one already running for this account. */
  async start(account: Account): Promise<LoginSession> {
    const running = this.sessions.get(account.id);
    if (running?.session.phase === "waiting") return { ...running.session };

    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CODEX_HOME;
    if (account.configDir !== null) env[PROVIDERS[account.provider].envVar] = account.configDir;
    let command: string;
    let args: string[];
    if (account.provider === "claude-code") {
      env.BROWSER = await this.browserHelper();
      command = "claude";
      args = ["auth", "login"];
    } else {
      command = "codex";
      args = ["login", "--device-auth"];
    }

    const session: LoginSession = {
      accountId: account.id,
      provider: account.provider,
      phase: "waiting",
      openedHere: account.provider === "claude-code",
      link: null,
      code: null,
      message: null,
      startedAt: Date.now(),
    };
    const child = this.spawn(command, args, env);
    const timer = setTimeout(() => this.finish(account.id, "failed", "Timed out after 15 minutes."), LOGIN_TIMEOUT_MS);
    this.sessions.set(account.id, { session, child, timer });

    let output = "";
    child.onOutput((chunk) => {
      output = (output + stripAnsi(chunk)).slice(-8_000);
      const before = `${session.link}|${session.code}`;
      if (account.provider === "claude-code") {
        session.link ??= /visit:\s*(https:\/\/\S+)/u.exec(output)?.[1] ?? null;
      } else {
        session.link ??= /(https:\/\/auth\.openai\.com\/\S*device\S*)/u.exec(output)?.[1] ?? null;
        session.code ??= /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/u.exec(output)?.[1] ?? null;
      }
      if (`${session.link}|${session.code}` !== before) this.onChange({ ...session });
    });
    void child.exited.then((code) => {
      if (this.sessions.get(account.id)?.child !== child) return;
      if (code === 0) this.finish(account.id, "done", null);
      else this.finish(account.id, "failed", lastLines(output) ?? `${command} could not be started.`);
    });

    this.onChange({ ...session });
    return { ...session };
  }

  /** Claude: passes the code shown on the fallback page to the waiting CLI. */
  submitCode(accountId: string, code: string): void {
    const entry = this.sessions.get(accountId);
    if (entry === undefined || entry.session.phase !== "waiting") throw new Error("No login is waiting for that account.");
    if (entry.session.provider !== "claude-code") throw new Error("Codex logins take their code on the device page.");
    entry.child.write(`${code.trim()}\n`);
  }

  cancel(accountId: string): void {
    if (this.sessions.get(accountId)?.session.phase === "waiting") this.finish(accountId, "cancelled", null);
  }

  /** Forgets a finished session so the UI stops showing it. */
  dismiss(accountId: string): void {
    const entry = this.sessions.get(accountId);
    if (entry !== undefined && entry.session.phase !== "waiting") this.sessions.delete(accountId);
  }

  async dispose(): Promise<void> {
    for (const id of this.sessions.keys()) this.cancel(id);
    if (this.helperDir !== null) await rm(this.helperDir, { recursive: true, force: true });
  }

  private finish(accountId: string, phase: Exclude<LoginPhase, "waiting">, message: string | null): void {
    const entry = this.sessions.get(accountId);
    if (entry === undefined || entry.session.phase !== "waiting") return;
    clearTimeout(entry.timer);
    if (phase !== "done") entry.child.kill();
    entry.session.phase = phase;
    entry.session.message = message;
    this.onChange({ ...entry.session });
  }

  private async browserHelper(): Promise<string> {
    this.helperDir ??= await mkdtemp(join(tmpdir(), "bb-accounts-"));
    const path = join(this.helperDir, "open-login.sh");
    await writeFile(path, BROWSER_HELPER);
    await chmod(path, 0o700);
    return path;
  }
}

/** The CLI's last few meaningful lines, with links removed (they carry one-time secrets). */
function lastLines(output: string): string | null {
  const lines = output
    .split("\n")
    .map((line) => line.replace(/https:\/\/\S+/gu, "<link>").trim())
    .filter((line) => line !== "" && !line.startsWith("Paste code here"));
  return lines.length === 0 ? null : lines.slice(-3).join(" ").slice(0, 400);
}
