// bb-plugin-accounts — pick which Claude Code or Codex login each thread uses.
//
// One account = one provider config directory (CLAUDE_CONFIG_DIR / CODEX_HOME).
// Each project remembers an account per provider; a new thread is pinned to
// its project's account when its first message is dispatched, and keeps that
// pin for life. Before every provider command, the env resolver hands the
// pinned account's directory to the provider. Nothing here ever moves a thread
// to another account on its own: there is no pooling or failover.
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  type Account,
  type ProviderId,
  type State,
  PROVIDERS,
  PROVIDER_IDS,

  defaultAccountId,
  findAccount,
  initialState,
  isProviderId,
  loginCommand,
  lookupAccount,
  newAccountId,
  normalizeState,
  parseProvider,
  projectAccount,
  providerIdSchema,
  readPins,
  resolveAccount,
  slugify,
} from "./src/core";
import {
  checkDir,
  displayPath,
  effectiveDir,
  type LoginStatus,
  loginStatus,
  normalizeDir,
  prepareDir,
  providerHome,
  suggestedDir,
} from "./src/files";

const accountViewSchema = z.object({
  id: z.string(),
  provider: providerIdSchema,
  label: z.string(),
  configDir: z.string().nullable(),
  /** Where the provider reads, `~`-abbreviated. */
  dir: z.string(),
  isDefault: z.boolean(),
  dirExists: z.boolean(),
  loggedIn: z.boolean().nullable(),
  identity: z.string().nullable(),
  loginCommand: z.string(),
});
export type AccountView = z.infer<typeof accountViewSchema>;

const snapshotSchema = z.object({
  accounts: z.array(accountViewSchema),
  globalDefaults: z.record(providerIdSchema, z.string()),
  /** projectId → provider → account id, for projects with their own choice. */
  projectDefaults: z.record(z.string(), z.record(z.string(), z.string())),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

const threadAccountSchema = z.object({
  provider: providerIdSchema,
  accountId: z.string(),
  label: z.string(),
  missing: z.boolean(),
});
export type ThreadAccount = z.infer<typeof threadAccountSchema>;

export const rpcContract = defineRpcContract({
  snapshot: {
    /** `refresh` re-asks every CLI instead of using answers up to 30s old. */
    input: z.object({ refresh: z.boolean() }).nullable(),
    output: snapshotSchema,
  },
  add_account: {
    input: z.object({
      provider: providerIdSchema,
      label: z.string().trim().min(1).max(60),
      shareConfig: z.boolean(),
    }),
    output: accountViewSchema,
  },
  rename_account: {
    input: z.object({ id: z.string(), label: z.string().trim().min(1).max(60) }),
    output: z.null(),
  },
  remove_account: { input: z.object({ id: z.string() }), output: z.null() },
  set_default: {
    input: z.object({
      provider: providerIdSchema,
      /** null = the global default. */
      projectId: z.string().nullable(),
      /** null clears a project's own choice. */
      accountId: z.string().nullable(),
    }),
    output: z.null(),
  },
  thread_account: {
    input: z.object({ threadId: z.string() }),
    output: threadAccountSchema.nullable(),
  },
});

/** Realtime channel: any account or default changed. */
export const CHANGED = "accounts-changed";

const STATE_KEY = "state";

export default async function plugin(bb: BbPluginApi) {
  // ---- State ---------------------------------------------------------------

  let writes: Promise<unknown> = Promise.resolve();

  async function readState(): Promise<State> {
    const stored = await bb.storage.kv.get<unknown>(STATE_KEY);
    return stored === null || stored === undefined ? await firstRunState() : normalizeState(stored);
  }

  /** Serializes read-modify-write so concurrent edits never lose one another. */
  function mutate<T>(change: (state: State) => T | Promise<T>): Promise<T> {
    const run = writes.then(async () => {
      const state = await readState();
      const result = await change(state);
      await bb.storage.kv.set(STATE_KEY, state);
      bb.realtime.publish(CHANGED, {});
      return result;
    });
    writes = run.catch(() => undefined);
    return run;
  }

  /**
   * On first run, adopt directories that already hold a login in the
   * conventional places (`~/.claude-accounts/<name>`, `~/.codex-accounts/<name>`),
   * so accounts set up by hand or by another plugin show up with no work.
   */
  async function firstRunState(): Promise<State> {
    const state = initialState();
    for (const provider of PROVIDER_IDS) {
      const root = join(homedir(), PROVIDERS[provider].newAccountsDir);
      const names = await readdir(root, { withFileTypes: true }).then(
        (entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name),
        () => [] as string[],
      );
      for (const name of names.sort()) {
        const dir = join(root, name);
        const marker = provider === "claude-code" ? ".claude.json" : "auth.json";
        if (!existsSync(join(dir, marker))) continue;
        state.accounts.push({ id: newAccountId(state, provider, name), provider, label: name, configDir: dir });
      }
    }
    await bb.storage.kv.set(STATE_KEY, state);
    return state;
  }

  // Login checks start a CLI; the composer and header ask often, so answers
  // are reused for a short while unless a refresh asks again.
  const STATUS_TTL_MS = 30_000;
  const statusCache = new Map<string, { at: number; status: Promise<LoginStatus> }>();

  function cachedLoginStatus(account: Account, refresh: boolean): Promise<LoginStatus> {
    const key = `${account.provider}:${account.configDir ?? ""}`;
    const hit = statusCache.get(key);
    if (!refresh && hit !== undefined && Date.now() - hit.at < STATUS_TTL_MS) return hit.status;
    const status = loginStatus(account);
    statusCache.set(key, { at: Date.now(), status });
    status.catch(() => statusCache.delete(key));
    return status;
  }

  async function view(state: State, account: Account, refresh = false): Promise<AccountView> {
    const status = await cachedLoginStatus(account, refresh);
    return {
      id: account.id,
      provider: account.provider,
      label: account.label,
      configDir: account.configDir,
      dir: displayPath(effectiveDir(account)),
      isDefault: account.id === defaultAccountId(account.provider),
      dirExists: status.dirExists,
      loggedIn: status.loggedIn,
      identity: status.identity,
      loginCommand: loginCommand(account),
    };
  }

  async function listProjects(): Promise<{ id: string; name: string }[]> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    return projects.map((p) => ({ id: p.id, name: p.name }));
  }

  async function snapshot(refresh = false): Promise<Snapshot> {
    const state = await readState();
    const projectDefaults: Snapshot["projectDefaults"] = {};
    for (const provider of PROVIDER_IDS) {
      for (const [projectId, id] of Object.entries(state.defaults[provider].projects)) {
        (projectDefaults[projectId] ??= {})[provider] = id;
      }
    }
    return {
      accounts: await Promise.all(state.accounts.map((a) => view(state, a, refresh))),
      globalDefaults: { "claude-code": state.defaults["claude-code"].global, codex: state.defaults.codex.global },
      projectDefaults,
      projects: await listProjects(),
    };
  }

  // ---- Mutations (shared by RPC and CLI) -----------------------------------

  async function addAccount(input: {
    provider: ProviderId;
    label: string;
    dir: string | null;
    shareConfig: boolean;
  }): Promise<{ account: Account; linked: string[] }> {
    return mutate(async (state) => {
      const id = newAccountId(state, input.provider, input.label);
      const dir =
        input.dir === null || input.dir === ""
          ? suggestedDir(input.provider, slugify(input.label) || id)
          : normalizeDir(input.dir);
      if (dir === providerHome(input.provider)) {
        throw new Error(
          `${displayPath(dir)} is the Default ${PROVIDERS[input.provider].name} account; rename that one instead.`,
        );
      }
      const taken = state.accounts.find((a) => a.configDir === dir);
      if (taken !== undefined) throw new Error(`${displayPath(dir)} is already the account "${taken.label}".`);
      await checkDir(input.provider, dir);
      const linked = await prepareDir(input.provider, dir, input.shareConfig);
      const account: Account = { id, provider: input.provider, label: input.label, configDir: dir };
      state.accounts.push(account);
      return { account, linked };
    });
  }

  function requireAccount(state: State, id: string): Account {
    const account = state.accounts.find((a) => a.id === id);
    if (account === undefined) throw new Error(`No account with id ${id}. Run "bb accounts list" to see ids.`);
    return account;
  }

  async function renameAccount(id: string, label: string): Promise<void> {
    await mutate((state) => {
      requireAccount(state, id).label = label;
    });
  }

  /** Forgets the account; its directory and login stay on disk. */
  async function removeAccount(id: string): Promise<void> {
    await mutate((state) => {
      const account = requireAccount(state, id);
      if (account.id === defaultAccountId(account.provider)) {
        throw new Error("The Default account always exists; rename it instead.");
      }
      state.accounts = state.accounts.filter((a) => a.id !== id);
      Object.assign(state, normalizeState(state));
    });
  }

  async function setDefault(provider: ProviderId, projectId: string | null, accountId: string | null) {
    await mutate((state) => {
      if (accountId !== null && findAccount(state, provider, accountId) === null) {
        throw new Error(`No ${PROVIDERS[provider].name} account with id ${accountId}.`);
      }
      const defaults = state.defaults[provider];
      if (projectId === null) defaults.global = accountId ?? defaultAccountId(provider);
      else if (accountId === null) delete defaults.projects[projectId];
      else defaults.projects[projectId] = accountId;
    });
  }

  // ---- Thread pins ---------------------------------------------------------

  async function readThreadPins(threadId: string) {
    return readPins(await bb.sdk.threads.getPluginMetadata({ threadId }));
  }

  /** Pins of the thread this one was forked or spawned from, if any. */
  async function sourcePins(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    const sourceId = thread.originKind === "fork" ? thread.sourceThreadId : thread.parentThreadId;
    if (sourceId === null) return null;
    return readThreadPins(sourceId).catch(() => null);
  }

  const pinning = new Map<string, Promise<ReturnType<typeof resolveAccount>>>();

  /**
   * The thread's account for this provider, pinning it on first use. Both the
   * dispatch hook and the env resolver call this; whichever runs first pins.
   */
  function threadAccount(threadId: string, projectId: string, provider: ProviderId) {
    const key = `${threadId}:${provider}`;
    const inFlight = pinning.get(key);
    if (inFlight !== undefined) return inFlight;
    const run = (async () => {
      const state = await readState();
      const pins = await readThreadPins(threadId);
      const resolution = resolveAccount(state, provider, {
        pins,
        sourcePins: pins[provider] === undefined ? await sourcePins(threadId) : null,
        projectId,
      });
      if (resolution.kind === "new") {
        await bb.sdk.threads.updatePluginMetadata({ threadId, set: { [provider]: resolution.account.id } });
        bb.log.info(`pinned ${threadId} to ${resolution.account.id} (from ${resolution.from})`);
      }
      return resolution;
    })().finally(() => pinning.delete(key));
    pinning.set(key, run);
    return run;
  }

  // Every message passes here before its turn starts, so a new thread is
  // pinned before its provider process ever launches.
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    const provider = ctx.requestedExecution.providerId;
    if (!isProviderId(provider)) return { action: "proceed" };
    const resolution = await threadAccount(ctx.thread.id, ctx.thread.projectId, provider);
    if (resolution.kind === "missing") {
      return {
        action: "reject",
        message: `This thread runs on the ${PROVIDERS[provider].name} account "${resolution.accountId}", which was removed from Accounts. Add it back, or start a new thread.`,
      };
    }
    const dir = effectiveDir(resolution.account);
    if (!existsSync(dir)) {
      return {
        action: "reject",
        message: `The ${PROVIDERS[provider].name} account "${resolution.account.label}" has no directory at ${displayPath(dir)}. Log it in with: ${loginCommand(resolution.account)}`,
      };
    }
    return { action: "proceed" };
  });

  for (const provider of PROVIDER_IDS) {
    bb.providers.experimental_contributeEnv(provider, async ({ threadId, projectId }) => {
      const resolution = await threadAccount(threadId, projectId, provider);
      if (resolution.kind === "missing" || resolution.account.configDir === null) return [];
      return [
        {
          name: PROVIDERS[provider].envVar,
          value: resolution.account.configDir,
          reason: `Accounts plugin: this thread uses the "${resolution.account.label}" account`,
        },
      ];
    });
  }

  async function describeThread(threadId: string): Promise<ThreadAccount | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!isProviderId(thread.providerId)) return null;
    const provider = thread.providerId;
    const state = await readState();
    const pinned = (await readThreadPins(threadId))[provider];
    if (pinned === undefined) {
      // Not dispatched yet: show what it would get, without pinning.
      const account = projectAccount(state, provider, thread.projectId);
      return { provider, accountId: account.id, label: account.label, missing: false };
    }
    const account = findAccount(state, provider, pinned);
    return { provider, accountId: pinned, label: account?.label ?? pinned, missing: account === null };
  }

  // ---- RPC -----------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    snapshot: (input) => snapshot(input?.refresh ?? false),
    add_account: async (input) => {
      // The app always uses the standard folder; only the CLI takes --dir.
      const { account } = await addAccount({ ...input, dir: null });
      return view(await readState(), account, true);
    },
    rename_account: async ({ id, label }) => {
      await renameAccount(id, label);
      return null;
    },
    remove_account: async ({ id }) => {
      await removeAccount(id);
      return null;
    },
    set_default: async ({ provider, projectId, accountId }) => {
      await setDefault(provider, projectId, accountId);
      return null;
    },
    thread_account: ({ threadId }) => describeThread(threadId),
  });

  // ---- CLI -----------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb accounts list [--json]",
    "  bb accounts add <claude|codex> <label> [--dir <path>] [--no-share]",
    "  bb accounts login <account>",
    "  bb accounts rename <account> <label>",
    "  bb accounts remove <account>",
    "  bb accounts default <account> [--project <project>]",
    "  bb accounts unset <claude|codex> --project <project>",
    "  bb accounts thread <thread-id> [--json]",
    "",
    "<account> is an id from `bb accounts list` or an unambiguous label.",
    "<project> is a project id or name. Without --project, `default` sets the",
    "account for projects that have no choice of their own.",
  ].join("\n");

  function takeOption(args: string[], name: string): string | undefined {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const [, value] = args.splice(index, 2);
    if (value === undefined) throw new Error(`${name} needs a value`);
    return value;
  }

  async function findProject(query: string): Promise<{ id: string; name: string }> {
    const projects = await listProjects();
    const lower = query.toLowerCase();
    const match =
      projects.find((p) => p.id === query) ??
      (projects.filter((p) => p.name.toLowerCase() === lower).length === 1
        ? projects.find((p) => p.name.toLowerCase() === lower)
        : undefined);
    if (match === undefined) throw new Error(`No single project matches "${query}". Run "bb project list".`);
    return match;
  }

  function resolveAccountArg(state: State, query: string | undefined): Account {
    if (query === undefined) throw new Error(usage);
    const account = lookupAccount(state, query);
    if (account === null) throw new Error(`No single account matches "${query}". Run "bb accounts list".`);
    return account;
  }

  function formatList(data: Snapshot): string {
    const projectName = new Map(data.projects.map((p) => [p.id, p.name]));
    const lines: string[] = [];
    for (const provider of PROVIDER_IDS) {
      lines.push(`${PROVIDERS[provider].name}:`);
      for (const a of data.accounts.filter((x) => x.provider === provider)) {
        const status =
          a.loggedIn === true ? a.identity : a.loggedIn === false ? "not logged in" : "login unknown";
        const star = data.globalDefaults[provider] === a.id ? " (default)" : "";
        lines.push(`  ${a.id}\t${a.label}${star}\t${a.dir}\t${a.dirExists ? status : "missing directory"}`);
      }
    }
    const rows = Object.entries(data.projectDefaults);
    if (rows.length > 0) {
      lines.push("Projects:");
      for (const [projectId, choice] of rows) {
        const parts = Object.entries(choice).map(([p, id]) => `${PROVIDERS[p as ProviderId].short}=${id}`);
        lines.push(`  ${projectName.get(projectId) ?? projectId}\t${parts.join("  ")}`);
      }
    }
    return lines.join("\n");
  }

  bb.cli.register({
    name: "accounts",
    summary: "Choose which Claude Code or Codex login each project and thread uses",
    commands: [
      { name: "list", summary: "List accounts, their logins, and project choices", usage: "bb accounts list [--json]" },
      {
        name: "add",
        summary: "Add an account (a new config directory) and print its login command",
        usage: "bb accounts add <claude|codex> <label> [--dir <path>] [--no-share]",
      },
      { name: "login", summary: "Print the terminal command that logs an account in", usage: "bb accounts login <account>" },
      { name: "rename", summary: "Rename an account", usage: "bb accounts rename <account> <label>" },
      { name: "remove", summary: "Forget an account (its directory stays on disk)", usage: "bb accounts remove <account>" },
      {
        name: "default",
        summary: "Use an account for new threads in a project, or everywhere",
        usage: "bb accounts default <account> [--project <project>]",
      },
      {
        name: "unset",
        summary: "Make a project follow the global default again",
        usage: "bb accounts unset <claude|codex> --project <project>",
      },
      { name: "thread", summary: "Show which account a thread runs on", usage: "bb accounts thread <thread-id> [--json]" },
    ],
    async run(argv) {
      const args = [...argv];
      const json = args.includes("--json");
      const noShare = args.includes("--no-share");
      const rest = args.filter((a) => a !== "--json" && a !== "--no-share");
      try {
        const dir = takeOption(rest, "--dir");
        const projectArg = takeOption(rest, "--project");
        const [command, ...params] = rest;
        const ok = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
          case "list": {
            const data = await snapshot(true);
            return ok(data, formatList(data));
          }
          case "add": {
            const provider = parseProvider(params[0]);
            const label = params.slice(1).join(" ").trim();
            if (provider === null || label === "") break;
            const { account, linked } = await addAccount({ provider, label, dir: dir ?? null, shareConfig: !noShare });
            const shared = linked.length > 0 ? `\nShared from ${displayPath(providerHome(provider))}: ${linked.join(", ")}` : "";
            return ok(
              { id: account.id, configDir: account.configDir, linked, loginCommand: loginCommand(account) },
              `Added ${account.id} at ${displayPath(account.configDir!)}.${shared}\nLog it in from a terminal:\n  ${loginCommand(account)}`,
            );
          }
          case "login": {
            const account = resolveAccountArg(await readState(), params[0]);
            return ok({ id: account.id, loginCommand: loginCommand(account) }, loginCommand(account));
          }
          case "rename": {
            const account = resolveAccountArg(await readState(), params[0]);
            const label = params.slice(1).join(" ").trim();
            if (label === "") break;
            await renameAccount(account.id, label);
            return ok({ id: account.id, label }, `Renamed ${account.id} to "${label}"`);
          }
          case "remove": {
            const account = resolveAccountArg(await readState(), params[0]);
            await removeAccount(account.id);
            return ok({ removed: account.id }, `Removed ${account.id}; ${displayPath(effectiveDir(account))} was left on disk.`);
          }
          case "default": {
            const account = resolveAccountArg(await readState(), params[0]);
            const project = projectArg === undefined ? null : await findProject(projectArg);
            await setDefault(account.provider, project?.id ?? null, account.id);
            const scope = project === null ? "projects without their own choice" : `project ${project.name}`;
            return ok(
              { provider: account.provider, projectId: project?.id ?? null, accountId: account.id },
              `New ${PROVIDERS[account.provider].name} threads in ${scope} use ${account.label}. Existing threads keep their account.`,
            );
          }
          case "unset": {
            const provider = parseProvider(params[0]);
            if (provider === null || projectArg === undefined) break;
            const project = await findProject(projectArg);
            await setDefault(provider, project.id, null);
            return ok({ provider, projectId: project.id }, `${project.name} now follows the global ${PROVIDERS[provider].name} default.`);
          }
          case "thread": {
            if (params[0] === undefined) break;
            const result = await describeThread(params[0]);
            return ok(
              result,
              result === null
                ? "That thread's provider does not use accounts."
                : `${PROVIDERS[result.provider].name}: ${result.label} (${result.accountId})${result.missing ? " — removed" : ""}`,
            );
          }
        }
        return { exitCode: 1, stderr: usage };
      } catch (cause) {
        return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  });

  // Creates state (and adopts existing account directories) on first load.
  const loaded = await readState();
  bb.log.info(`loaded with ${loaded.accounts.length} accounts`);
}
