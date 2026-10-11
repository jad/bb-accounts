// Accounts, defaults, and the rule that picks a thread's account.
//
// One account is one provider config directory: CLAUDE_CONFIG_DIR for Claude
// Code, CODEX_HOME for Codex. Each provider always has a built-in default
// account whose directory is null, meaning "set no variable" so the CLI uses
// its own home (~/.claude, ~/.codex) exactly as it does without this plugin.
//
// A thread is pinned to one account per provider the first time it needs
// one. The pin lives in the thread's plugin metadata and never changes, so a
// resumed session always finds its transcript in the same directory.
import { z } from "zod";
import { NEW_ACCOUNTS_DIR, slugify } from "./names";

export { slugify } from "./names";

export const PROVIDERS = {
  "claude-code": {
    name: "Claude Code",
    short: "claude",
    envVar: "CLAUDE_CONFIG_DIR",
    defaultDirLabel: "~/.claude",
    newAccountsDir: NEW_ACCOUNTS_DIR["claude-code"],
  },
  codex: {
    name: "Codex",
    short: "codex",
    envVar: "CODEX_HOME",
    defaultDirLabel: "~/.codex",
    newAccountsDir: NEW_ACCOUNTS_DIR.codex,
  },
} as const;

export type ProviderId = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
export const providerIdSchema = z.enum(["claude-code", "codex"]);

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}

/** Accepts `claude`, `claude-code`, and `codex` as typed on a command line. */
export function parseProvider(value: string | undefined): ProviderId | null {
  const lower = value?.trim().toLowerCase();
  if (lower === "claude" || lower === "claude-code") return "claude-code";
  if (lower === "codex") return "codex";
  return null;
}

export const accountSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
  provider: providerIdSchema,
  label: z.string().trim().min(1).max(60),
  /** Absolute path; null = the provider's own home (no variable set). */
  configDir: z.string().nullable(),
});
export type Account = z.infer<typeof accountSchema>;

const providerDefaultsSchema = z.object({
  /** Account for projects without their own choice. */
  global: z.string(),
  /** projectId → account id. */
  projects: z.record(z.string(), z.string()),
});

export const stateSchema = z.object({
  accounts: z.array(accountSchema),
  defaults: z.object({
    "claude-code": providerDefaultsSchema,
    codex: providerDefaultsSchema,
  }),
});
export type State = z.infer<typeof stateSchema>;

export function defaultAccountId(provider: ProviderId): string {
  return `${PROVIDERS[provider].short}-default`;
}

export function initialState(): State {
  return {
    accounts: PROVIDER_IDS.map((provider) => ({
      id: defaultAccountId(provider),
      provider,
      label: "Default",
      configDir: null,
    })),
    defaults: {
      "claude-code": { global: defaultAccountId("claude-code"), projects: {} },
      codex: { global: defaultAccountId("codex"), projects: {} },
    },
  };
}

/** Reads stored state, repairing anything a removed account left behind. */
export function normalizeState(raw: unknown): State {
  const parsed = stateSchema.safeParse(raw);
  const state = parsed.success ? parsed.data : initialState();
  for (const provider of PROVIDER_IDS) {
    if (!state.accounts.some((a) => a.id === defaultAccountId(provider))) {
      state.accounts.unshift(initialState().accounts.find((a) => a.provider === provider)!);
    }
    const defaults = state.defaults[provider];
    const valid = (id: string) => findAccount(state, provider, id) !== null;
    if (!valid(defaults.global)) defaults.global = defaultAccountId(provider);
    for (const [projectId, id] of Object.entries(defaults.projects)) {
      if (!valid(id)) delete defaults.projects[projectId];
    }
  }
  return state;
}

export function findAccount(
  state: State,
  provider: ProviderId,
  id: unknown,
): Account | null {
  if (typeof id !== "string") return null;
  return state.accounts.find((a) => a.id === id && a.provider === provider) ?? null;
}

export function accountsFor(state: State, provider: ProviderId): Account[] {
  return state.accounts.filter((a) => a.provider === provider);
}

/** Looks an account up by id, or by label when the label is unambiguous. */
export function lookupAccount(state: State, query: string): Account | null {
  const byId = state.accounts.find((a) => a.id === query);
  if (byId !== undefined) return byId;
  const lower = query.trim().toLowerCase();
  const byLabel = state.accounts.filter((a) => a.label.toLowerCase() === lower);
  return byLabel.length === 1 ? byLabel[0]! : null;
}


/** A fresh id like `claude-startup`, suffixed when taken. */
export function newAccountId(state: State, provider: ProviderId, label: string): string {
  const base = `${PROVIDERS[provider].short}-${slugify(label) || "account"}`;
  let id = base;
  for (let n = 2; state.accounts.some((a) => a.id === id); n++) id = `${base}-${n}`;
  return id;
}

/** The account a new thread in this project gets when nothing else decides. */
export function projectAccount(state: State, provider: ProviderId, projectId: string): Account {
  const defaults = state.defaults[provider];
  return (
    findAccount(state, provider, defaults.projects[projectId]) ??
    findAccount(state, provider, defaults.global) ??
    findAccount(state, provider, defaultAccountId(provider))!
  );
}

/** Thread plugin metadata: provider id → pinned account id. */
export type ThreadPins = Partial<Record<ProviderId, string>>;

export function readPins(metadata: unknown): ThreadPins {
  if (typeof metadata !== "object" || metadata === null) return {};
  const pins: ThreadPins = {};
  for (const provider of PROVIDER_IDS) {
    const value = (metadata as Record<string, unknown>)[provider];
    if (typeof value === "string") pins[provider] = value;
  }
  return pins;
}

export type Resolution =
  | { kind: "pinned"; account: Account }
  /** A new pin; `from` says why this account was chosen. */
  | { kind: "new"; account: Account; from: "source-thread" | "project" }
  /** The thread is pinned to an account that no longer exists. */
  | { kind: "missing"; accountId: string };

/**
 * The account a thread runs on: its own pin, else the pin of the thread it was
 * forked or spawned from (so a fork can resume the same transcript), else the
 * project's choice.
 */
export function resolveAccount(
  state: State,
  provider: ProviderId,
  input: { pins: ThreadPins; sourcePins: ThreadPins | null; projectId: string },
): Resolution {
  const pinned = input.pins[provider];
  if (pinned !== undefined) {
    const account = findAccount(state, provider, pinned);
    return account === null ? { kind: "missing", accountId: pinned } : { kind: "pinned", account };
  }
  const inherited = findAccount(state, provider, input.sourcePins?.[provider]);
  if (inherited !== null) return { kind: "new", account: inherited, from: "source-thread" };
  return { kind: "new", account: projectAccount(state, provider, input.projectId), from: "project" };
}

/** Single-quotes a value for a POSIX shell. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The terminal command that logs this account in. */
export function loginCommand(account: Account): string {
  const prefix =
    account.configDir === null
      ? ""
      : `${PROVIDERS[account.provider].envVar}=${shellQuote(account.configDir)} `;
  return account.provider === "claude-code"
    ? `${prefix}claude auth login`
    : `${prefix}codex login`;
}
