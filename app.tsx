// bb-plugin-accounts — frontend.
//
// Three surfaces over one server snapshot, refreshed on "accounts-changed":
// - the new-thread composer: which account the next thread in the picked
//   project uses (a pick is remembered for the project);
// - the thread header: which account this thread is pinned to (read-only);
// - Settings: add, rename, remove accounts and choose per-project defaults.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_copyToClipboard,
  useComposer,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { AccountView, Snapshot, ThreadAccount, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { NEW_ACCOUNTS_DIR, accountFolderName } from "./src/names";
import { toast } from "sonner";

type ProviderId = AccountView["provider"];
const PROVIDER_NAMES: Record<ProviderId, string> = { "claude-code": "Claude Code", codex: "Codex" };
const PROVIDER_LIST: ProviderId[] = ["claude-code", "codex"];
const CHANGED = "accounts-changed";

function isProviderId(value: unknown): value is ProviderId {
  return value === "claude-code" || value === "codex";
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refetch = useCallback(() => {
    rpc.call("snapshot").then(setSnapshot, (cause) => toast.error(errorText(cause)));
  }, [rpc]);
  /** Asks every CLI again instead of using a recent answer. */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setSnapshot(await rpc.call("snapshot", { refresh: true }));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setRefreshing(false);
    }
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, refetch);
  return { rpc, snapshot, refetch, refresh, refreshing };
}

/** Re-checks logins when the window regains focus, e.g. back from a terminal login. */
function useRefreshOnFocus(refresh: () => Promise<void>) {
  useEffect(() => {
    let last = Date.now();
    const onFocus = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 5_000) return;
      last = Date.now();
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);
}

function effectiveAccountId(snapshot: Snapshot, provider: ProviderId, projectId: string): string {
  return snapshot.projectDefaults[projectId]?.[provider] ?? snapshot.globalDefaults[provider]!;
}

function statusText(account: AccountView): string {
  if (!account.dirExists) return "Not logged in (no folder yet)";
  if (account.loggedIn === true) return account.identity ?? "Logged in";
  if (account.loggedIn === false) return "Not logged in";
  return "Couldn't check the login";
}

// ---- Composer and header ---------------------------------------------------

function AccountChip({
  label,
  compact,
  tone = "normal",
}: {
  label: string;
  compact: boolean;
  tone?: "normal" | "warning";
}) {
  return (
    <>
      <Icon
        name="UserRound"
        className={cn("size-3.5 shrink-0", tone === "warning" && "text-destructive")}
      />
      {compact ? null : <span className="max-w-32 truncate">{label}</span>}
    </>
  );
}

/**
 * The account the next thread in the composer's project gets. Picking one
 * remembers it for that project, so the next thread there starts on it too.
 */
function NewThreadAccount() {
  const composer = useComposer();
  const narrow = useIsCompactViewport();
  const { rpc, snapshot } = useSnapshot();
  const provider = composer.selection?.providerId;
  const projectId = composer.scope.kind === "new-thread" ? composer.scope.projectId : null;
  if (snapshot === null || projectId === null || !isProviderId(provider)) return null;
  const accounts = snapshot.accounts.filter((a) => a.provider === provider);
  if (accounts.length < 2) return null;
  const currentId = effectiveAccountId(snapshot, provider, projectId);
  const current = accounts.find((a) => a.id === currentId);
  const compact = composer.layout === "compact" || narrow;
  const pick = (accountId: string) => {
    rpc
      .call("set_default", { provider, projectId, accountId })
      .catch((cause) => toast.error(errorText(cause)));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          aria-label={`${PROVIDER_NAMES[provider]} account: ${current?.label ?? currentId}`}
        >
          <AccountChip label={current?.label ?? currentId} compact={compact} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-72"
        mobileTitle={`${PROVIDER_NAMES[provider]} account`}
        // bb's composer treats a stray mousedown as a click on the draft.
        onMouseDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          const active = document.activeElement;
          if (active !== null && active !== document.body) return;
          event.preventDefault();
          composer.focus();
        }}
      >
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {PROVIDER_NAMES[provider]} account for new threads in this project. Threads that already
          started keep theirs.
        </DropdownMenuLabel>
        <DropdownMenuGroup aria-label="Accounts">
          {accounts.map((account) => (
            <DropdownMenuItem
              key={account.id}
              role="menuitemradio"
              aria-checked={account.id === currentId}
              onSelect={() => pick(account.id)}
            >
              {account.id === currentId ? (
                <Icon name="Check" className="size-4 shrink-0" />
              ) : (
                <span aria-hidden className="size-4 shrink-0" />
              )}
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{account.label}</span>
                <span className="truncate text-xs text-muted-foreground">{statusText(account)}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Which account this thread is pinned to. An account never changes mid-thread. */
function ThreadHeaderAccount({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [info, setInfo] = useState<ThreadAccount | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const refetch = useCallback(() => {
    rpc.call("thread_account", { threadId }).then(setInfo, () => setInfo(null));
    rpc.call("snapshot").then(
      (s) => setAccounts(s.accounts),
      () => undefined,
    );
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, refetch);
  // Only worth the header space once there is a second account to tell apart.
  if (info === null || accounts.filter((a) => a.provider === info.provider).length < 2) return null;
  const title = info.missing
    ? `${PROVIDER_NAMES[info.provider]} account "${info.accountId}" was removed`
    : `Runs on the ${PROVIDER_NAMES[info.provider]} account "${info.label}"`;
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className="flex h-7 items-center gap-1.5 px-2 text-xs text-muted-foreground"
    >
      <AccountChip label={info.label} compact={isCompactViewport} tone={info.missing ? "warning" : "normal"} />
    </span>
  );
}

// ---- Settings --------------------------------------------------------------

function Select({
  value,
  onChange,
  label,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
    >
      {children}
    </select>
  );
}

function AccountRow({
  account,
  isGlobalDefault,
  onRename,
  onRemove,
  onMakeDefault,
}: {
  account: AccountView;
  isGlobalDefault: boolean;
  onRename: (label: string) => void;
  onRemove: () => void;
  onMakeDefault: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(account.label);
  const startEditing = () => {
    setLabel(account.label);
    setEditing(true);
  };
  const cancelEditing = () => {
    setLabel(account.label);
    setEditing(false);
  };
  const needsLogin = !account.dirExists || account.loggedIn !== true;
  const broken = !account.dirExists || account.loggedIn === false;
  return (
    <li className="flex flex-col gap-1.5 py-3 text-sm">
      <div className="flex items-center gap-2">
        {editing ? (
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (label.trim() !== "") onRename(label.trim());
              setEditing(false);
            }}
          >
            <Input
              autoFocus
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEditing();
                }
              }}
              aria-label="Account name"
              className="h-8"
            />
            <Button type="button" variant="ghost" size="sm" onClick={cancelEditing}>
              Cancel
            </Button>
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate font-medium">
              {account.label}
              {isGlobalDefault ? (
                <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs font-normal text-secondary-foreground">
                  default
                </span>
              ) : null}
            </span>
            {isGlobalDefault ? null : (
              <Button type="button" variant="ghost" size="sm" onClick={onMakeDefault}>
                Make default
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label={`Rename ${account.label}`}
              onClick={startEditing}
            >
              <Icon name="Edit" className="size-4" />
            </Button>
            {account.isDefault ? null : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${account.label}`}
                onClick={onRemove}
              >
                <Icon name="Trash2" className="size-4" />
              </Button>
            )}
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span className={cn(broken && "text-destructive")}>{statusText(account)}</span>
        <span className="font-mono">{account.dir}</span>
        <span className="font-mono">{account.id}</span>
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{account.loginCommand}</code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => {
            void experimental_copyToClipboard({ text: account.loginCommand }).then((ok) =>
              ok ? toast.success("Login command copied — run it in a terminal") : toast.error("Could not copy"),
            );
          }}
        >
          <Icon name="Copy" className="size-3.5" />
          {needsLogin ? "Copy login command" : "Copy re-login command"}
        </Button>
      </div>
    </li>
  );
}

function AddAccountForm({
  onAdd,
}: {
  onAdd: (input: { provider: ProviderId; label: string; shareConfig: boolean }) => Promise<void>;
}) {
  const [provider, setProvider] = useState<ProviderId>("claude-code");
  const [label, setLabel] = useState("");
  const [shareConfig, setShareConfig] = useState(true);
  const [pending, setPending] = useState(false);
  const folder = accountFolderName(label);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (folder === null || pending) return;
    setPending(true);
    try {
      await onAdd({ provider, label: label.trim(), shareConfig });
      setLabel("");
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={provider} onChange={(v) => setProvider(v as ProviderId)} label="Provider">
          {PROVIDER_LIST.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_NAMES[p]}
            </option>
          ))}
        </Select>
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Name, e.g. Startup"
          aria-label="Account name"
          className="h-8 min-w-44 flex-1"
        />
        <Button type="submit" size="sm" disabled={pending || folder === null}>
          <Icon name="Plus" className="size-4" />
          Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {label.trim() === "" ? (
          <>
            Creates a folder in <code className="font-mono">~/{NEW_ACCOUNTS_DIR[provider]}/</code> for this login.
          </>
        ) : folder === null ? (
          "Use at least one letter or digit in the name."
        ) : (
          <>
            Creates <code className="font-mono">~/{NEW_ACCOUNTS_DIR[provider]}/{folder}</code>
          </>
        )}
      </p>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={shareConfig} onChange={(event) => setShareConfig(event.target.checked)} />
        Share settings, skills, and plugins with the Default account (symlinks; the login stays separate)
      </label>
    </form>
  );
}

function AccountsSettings() {
  const { rpc, snapshot, refresh, refreshing } = useSnapshot();
  useRefreshOnFocus(refresh);
  const run = (promise: Promise<unknown>, success?: string) =>
    promise.then(
      () => (success === undefined ? undefined : toast.success(success)),
      (cause) => toast.error(errorText(cause)),
    );
  if (snapshot === null) {
    return <p className="text-sm text-muted-foreground">Loading accounts…</p>;
  }
  const loggedOut = snapshot.accounts.some((a) => a.loggedIn !== true);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {loggedOut
            ? "To log an account in, run its login command in a terminal. This page checks again when you come back."
            : "Every account is logged in."}
        </p>
        <Button type="button" variant="outline" size="sm" className="h-7" disabled={refreshing} onClick={() => void refresh()}>
          <Icon name="RotateCcw" className={cn("size-3.5", refreshing && "animate-spin")} />
          {refreshing ? "Checking…" : "Refresh"}
        </Button>
      </div>
      {PROVIDER_LIST.map((provider) => (
        <section key={provider} className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">{PROVIDER_NAMES[provider]}</h3>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card px-4">
            {snapshot.accounts
              .filter((a) => a.provider === provider)
              .map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  isGlobalDefault={snapshot.globalDefaults[provider] === account.id}
                  onRename={(label) => void run(rpc.call("rename_account", { id: account.id, label }))}
                  onRemove={() =>
                    void run(
                      rpc.call("remove_account", { id: account.id }),
                      `Removed ${account.label}; its directory was left on disk`,
                    )
                  }
                  onMakeDefault={() =>
                    void run(rpc.call("set_default", { provider, projectId: null, accountId: account.id }))
                  }
                />
              ))}
          </ul>
        </section>
      ))}
      <AddAccountForm
        onAdd={async (input) => {
          await rpc.call("add_account", input).then(
            (account) => toast.success(`Added ${account.label}. Copy its login command below and run it in a terminal.`),
            (cause) => {
              toast.error(errorText(cause));
              throw cause;
            },
          );
        }}
      />
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Projects</h3>
        <p className="text-xs text-muted-foreground">
          The account new threads in each project start on. You can also pick it in the new-thread composer.
          A thread keeps its account for life.
        </p>
        <ul className="divide-y divide-border rounded-lg border border-border bg-card px-4">
          {snapshot.projects.map((project) => (
            <li key={project.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {PROVIDER_LIST.map((provider) => {
                const own = snapshot.projectDefaults[project.id]?.[provider];
                const global = snapshot.accounts.find((a) => a.id === snapshot.globalDefaults[provider]);
                return (
                  <Select
                    key={provider}
                    label={`${PROVIDER_NAMES[provider]} account for ${project.name}`}
                    value={own ?? ""}
                    onChange={(value) =>
                      void run(
                        rpc.call("set_default", {
                          provider,
                          projectId: project.id,
                          accountId: value === "" ? null : value,
                        }),
                      )
                    }
                  >
                    <option value="">
                      {PROVIDER_NAMES[provider]}: follow default ({global?.label ?? "Default"})
                    </option>
                    {snapshot.accounts
                      .filter((a) => a.provider === provider)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {PROVIDER_NAMES[provider]}: {a.label}
                        </option>
                      ))}
                  </Select>
                );
              })}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "accounts",
    title: "Accounts",
    description: "Your Claude Code and Codex logins, and which one each project's new threads use.",
    component: AccountsSettings,
  });
  app.slots.experimental_threadHeaderAction({
    id: "thread-account",
    title: "Account",
    component: ThreadHeaderAccount,
  });
  app.composer.customize({
    id: "account-picker",
    scopes: ["new-thread"],
    actions: [{ id: "account-picker", component: NewThreadAccount }],
  });
});
