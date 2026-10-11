import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { ThreadResponse } from "@get-bb/plugin-sdk";
import plugin from "./server";
import { initialState, loginCommand, resolveAccount } from "./src/core";

let home: string;

beforeEach(() => {
  // os.homedir() follows HOME, so every test gets its own provider homes.
  home = mkdtempSync(join(tmpdir(), "accounts-test-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  mkdirSync(join(home, ".codex"));
  // Fake CLIs: an account is logged in when its folder holds LOGGED_IN.
  const bin = join(home, "bin");
  mkdirSync(bin);
  const fake = (name: string, script: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake(
    "claude",
    `d="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; if [ -f "$d/LOGGED_IN" ]; then echo '{"loggedIn":true,"email":"me@claude.test","orgName":"Org"}'; else echo '{"loggedIn":false}'; exit 1; fi`,
  );
  fake(
    "codex",
    `d="\${CODEX_HOME:-$HOME/.codex}"; if [ -f "$d/LOGGED_IN" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in"; exit 1; fi`,
  );
  process.env.PATH = `${bin}:/usr/bin:/bin`;
});

async function load(threads: Record<string, Partial<ThreadResponse>> = {}) {
  const metadata = new Map<string, Record<string, unknown>>();
  const { bb, harness } = createFakePluginHost({
    pluginId: "accounts",
    sdk: {
      projects: {
        list: async () => [
          { id: "proj_startup", name: "Startup", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0 },
        ],
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, projectId: "proj_startup", providerId: "claude-code", ...threads[threadId] }),
        getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
        updatePluginMetadata: async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => {
          const next = { ...metadata.get(threadId), ...set };
          metadata.set(threadId, next);
          return next;
        },
      },
    } as never,
  });
  await plugin(bb);
  const dispatch = (threadId: string, providerId: string, projectId = "proj_startup") =>
    harness.inspection.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({
        thread: { id: threadId, projectId, providerId },
        requestedExecution: { providerId },
      }),
    );
  const cli = async (...argv: string[]) => harness.behavior.runCli(argv);
  return { harness, metadata, dispatch, cli };
}

describe("resolveAccount", () => {
  it("prefers the thread's pin, then its source thread, then the project", () => {
    const state = initialState();
    state.accounts.push(
      { id: "claude-work", provider: "claude-code", label: "Work", configDir: "/w" },
      { id: "claude-side", provider: "claude-code", label: "Side", configDir: "/s" },
    );
    state.defaults["claude-code"].projects.p = "claude-work";
    const project = resolveAccount(state, "claude-code", { pins: {}, sourcePins: null, projectId: "p" });
    expect(project).toMatchObject({ kind: "new", from: "project", account: { id: "claude-work" } });
    const fork = resolveAccount(state, "claude-code", {
      pins: {},
      sourcePins: { "claude-code": "claude-side" },
      projectId: "p",
    });
    expect(fork).toMatchObject({ kind: "new", from: "source-thread", account: { id: "claude-side" } });
    const pinned = resolveAccount(state, "claude-code", {
      pins: { "claude-code": "claude-side" },
      sourcePins: null,
      projectId: "p",
    });
    expect(pinned).toMatchObject({ kind: "pinned", account: { id: "claude-side" } });
    const gone = resolveAccount(state, "claude-code", { pins: { "claude-code": "claude-old" }, sourcePins: null, projectId: "p" });
    expect(gone).toEqual({ kind: "missing", accountId: "claude-old" });
  });

  it("quotes directories in login commands", () => {
    expect(loginCommand({ id: "x", provider: "codex", label: "X", configDir: "/a b/it's" })).toBe(
      `CODEX_HOME='/a b/it'\\''s' codex login`,
    );
    expect(loginCommand({ id: "x", provider: "claude-code", label: "X", configDir: null })).toBe("claude auth login");
  });
});

describe("plugin", () => {
  it("adopts existing account directories on first load", async () => {
    // No CLI on PATH: login status falls back to the files the CLI writes.
    process.env.PATH = "/usr/bin:/bin";
    mkdirSync(join(home, ".claude-accounts", "DBB"), { recursive: true });
    writeFileSync(
      join(home, ".claude-accounts", "DBB", ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "me@dbb.test", organizationName: "DBB" } }),
    );
    mkdirSync(join(home, ".claude-accounts", "empty"), { recursive: true });
    const { cli } = await load();
    const list = JSON.parse((await cli("list", "--json")).stdout!);
    const dbb = list.accounts.find((a: { label: string }) => a.label === "DBB");
    expect(dbb).toMatchObject({ id: "claude-dbb", loggedIn: true, identity: "me@dbb.test · DBB" });
    expect(list.accounts.some((a: { label: string }) => a.label === "empty")).toBe(false);
  });

  it("pins a new thread to its project's account and keeps it after the project changes", async () => {
    const { cli, dispatch, harness, metadata } = await load();
    const added = await cli("add", "claude", "Startup");
    expect(added.exitCode).toBe(0);
    const dir = join(home, ".claude-accounts", "startup");
    expect(added.stdout).toContain(`CLAUDE_CONFIG_DIR=${dir} claude auth login`);
    expect(readlinkSync(join(dir, "settings.json"))).toBe(join(home, ".claude", "settings.json"));

    expect((await cli("default", "claude-startup", "--project", "Startup")).exitCode).toBe(0);
    expect(await dispatch("thr_1", "claude-code")).toEqual({ action: "proceed" });
    expect(metadata.get("thr_1")).toEqual({ "claude-code": "claude-startup" });
    expect(
      await harness.behavior.resolveProviderEnv("claude-code", { threadId: "thr_1", projectId: "proj_startup", hostId: "h" }),
    ).toEqual([expect.objectContaining({ name: "CLAUDE_CONFIG_DIR", value: dir })]);

    // The project moves back to Default; the running thread stays put.
    await cli("unset", "claude", "--project", "proj_startup");
    expect(
      await harness.behavior.resolveProviderEnv("claude-code", { threadId: "thr_1", projectId: "proj_startup", hostId: "h" }),
    ).toEqual([expect.objectContaining({ value: dir })]);
    // A new thread follows the project again: Default means no variable.
    expect(
      await harness.behavior.resolveProviderEnv("claude-code", { threadId: "thr_2", projectId: "proj_startup", hostId: "h" }),
    ).toEqual([]);
    expect(metadata.get("thr_2")).toEqual({ "claude-code": "claude-default" });
  });

  it("gives a fork its source thread's account", async () => {
    const { cli, dispatch, metadata } = await load({
      thr_fork: { originKind: "fork", sourceThreadId: "thr_src" },
    });
    await cli("add", "codex", "Client");
    metadata.set("thr_src", { codex: "codex-client" });
    await dispatch("thr_fork", "codex");
    expect(metadata.get("thr_fork")).toEqual({ codex: "codex-client" });
  });

  it("refuses to run a thread whose account was removed", async () => {
    const { cli, dispatch, metadata } = await load();
    await cli("add", "codex", "Client");
    metadata.set("thr_1", { codex: "codex-client" });
    await cli("remove", "Client");
    expect(await dispatch("thr_1", "codex")).toMatchObject({ action: "reject" });
  });

  it("ignores providers it does not manage", async () => {
    const { dispatch, metadata } = await load();
    expect(await dispatch("thr_pi", "pi")).toEqual({ action: "proceed" });
    expect(metadata.has("thr_pi")).toBe(false);
  });

  it("refuses a --dir that has files but is not a config folder", async () => {
    const { cli } = await load();
    const docs = join(home, "Documents");
    mkdirSync(docs);
    writeFileSync(join(docs, "notes.txt"), "mine");
    const refused = await cli("add", "claude", "Oops", "--dir", "~/Documents");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("does not look like a Claude Code config folder");
    expect(existsSync(join(docs, "settings.json"))).toBe(false);

    writeFileSync(join(home, "a-file"), "");
    expect((await cli("add", "codex", "File", "--dir", join(home, "a-file"))).stderr).toContain("is a file");

    const existing = join(home, "old-login");
    mkdirSync(existing);
    writeFileSync(join(existing, ".claude.json"), "{}");
    expect((await cli("add", "claude", "Old", "--dir", existing)).exitCode).toBe(0);
    expect((await cli("add", "claude", "Fresh", "--dir", join(home, "brand", "new"))).exitCode).toBe(0);
    expect(existsSync(join(home, "brand", "new", "settings.json"))).toBe(true);
  });

  it("adds from the app into the standard folder", async () => {
    const { harness } = await load();
    const view = await harness.behavior.callRpc("add_account", {
      provider: "codex",
      label: "My Client",
      shareConfig: false,
    });
    expect(view).toMatchObject({ id: "codex-my-client", dir: "~/.codex-accounts/my-client", dirExists: true });
  });

  it("asks the CLI whether an account is logged in, and re-asks on refresh", async () => {
    const { harness } = await load();
    const codexOf = async (refresh: boolean) =>
      ((await harness.behavior.callRpc("snapshot", { refresh })) as { accounts: { id: string; loggedIn: unknown; identity: unknown }[] }).accounts.find(
        (a) => a.id === "codex-default",
      );
    expect(await codexOf(false)).toMatchObject({ loggedIn: false, identity: null });
    writeFileSync(join(home, ".codex", "LOGGED_IN"), "");
    // A recent answer is reused until a refresh asks again.
    expect(await codexOf(false)).toMatchObject({ loggedIn: false });
    expect(await codexOf(true)).toMatchObject({ loggedIn: true, identity: "ChatGPT" });

    writeFileSync(join(home, ".claude", "LOGGED_IN"), "");
    const claude = ((await harness.behavior.callRpc("snapshot", { refresh: true })) as { accounts: { id: string }[] }).accounts.find(
      (a) => a.id === "claude-default",
    );
    expect(claude).toMatchObject({ loggedIn: true, identity: "me@claude.test · Org" });
  });
});
