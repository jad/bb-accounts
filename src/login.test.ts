import { describe, expect, it } from "vitest";
import type { Account } from "./core";
import { type LoginChild, type LoginSession, LoginManager } from "./login";

function fakeChild() {
  const listeners: ((chunk: string) => void)[] = [];
  let exit!: (code: number | null) => void;
  const child = {
    written: [] as string[],
    killed: false,
    write(text: string) {
      child.written.push(text);
    },
    kill() {
      child.killed = true;
      exit(null);
    },
    onOutput: (listener: (chunk: string) => void) => listeners.push(listener),
    exited: new Promise<number | null>((resolve) => (exit = resolve)),
    say: (text: string) => listeners.forEach((listener) => listener(text)),
    exit: (code: number) => exit(code),
  };
  return child satisfies LoginChild;
}

const claude: Account = { id: "claude-work", provider: "claude-code", label: "Work", configDir: "/tmp/work" };
const codex: Account = { id: "codex-work", provider: "codex", label: "Work", configDir: null };

function setup() {
  const changes: LoginSession[] = [];
  const spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv; child: ReturnType<typeof fakeChild> }[] = [];
  const manager = new LoginManager(
    (session) => changes.push(session),
    (command, args, env) => {
      const child = fakeChild();
      spawned.push({ command, args, env, child });
      return child;
    },
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { manager, changes, spawned, settle };
}

describe("LoginManager", () => {
  it("runs a Claude login for the account's folder and forwards a pasted code", async () => {
    const { manager, spawned, settle } = setup();
    await manager.start(claude);
    const [{ command, args, env, child }] = spawned;
    expect([command, ...args]).toEqual(["claude", "auth", "login"]);
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/work");
    expect(env.BROWSER).toMatch(/open-login\.sh$/u);

    child.say("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1\n");
    expect(manager.list()[0]).toMatchObject({ phase: "waiting", link: "https://claude.com/cai/oauth/authorize?code=true&x=1" });

    manager.submitCode("claude-work", " abc#123 ");
    expect(child.written).toEqual(["abc#123\n"]);
    child.exit(0);
    await settle();
    expect(manager.list()[0]?.phase).toBe("done");
    await manager.dispose();
  });

  it("uses the Codex device flow and reads its link and code", async () => {
    const { manager, spawned } = setup();
    await manager.start(codex);
    const [{ args, env, child }] = spawned;
    expect(args).toEqual(["login", "--device-auth"]);
    expect(env.CODEX_HOME).toBeUndefined();
    child.say("1. Open this link\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n2. Enter this one-time code \u001b[90m(expires)\u001b[0m\n   \u001b[94mABCD-12345\u001b[0m\n");
    expect(manager.list()[0]).toMatchObject({ link: "https://auth.openai.com/codex/device", code: "ABCD-12345" });
    await manager.dispose();
  });

  it("reports a failure without the one-time link", async () => {
    const { manager, spawned, settle } = setup();
    await manager.start(claude);
    spawned[0]!.child.say("visit: https://claude.com/secret\nOAuth error: access denied\n");
    spawned[0]!.child.exit(1);
    await settle();
    const session = manager.list()[0]!;
    expect(session.phase).toBe("failed");
    expect(session.message).toContain("access denied");
    expect(session.message).not.toContain("secret");
  });

  it("cancels by killing the CLI, and does not start a second login for the same account", async () => {
    const { manager, spawned } = setup();
    await manager.start(codex);
    await manager.start(codex);
    expect(spawned).toHaveLength(1);
    manager.cancel("codex-work");
    expect(spawned[0]!.child.killed).toBe(true);
    expect(manager.list()[0]?.phase).toBe("cancelled");
    manager.dismiss("codex-work");
    expect(manager.list()).toEqual([]);
  });
});
