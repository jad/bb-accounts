Use several Claude Code and Codex logins in one bb, such as personal, startup,
and client accounts. Choose the account per project, and each thread stays on
the account it started with.

## What you get

- An account picker in the new-thread composer. It shows when the selected
  provider has more than one account. Your pick is remembered for that project.
- A badge in the thread header that shows which account the thread runs on.
- An **Accounts** section in Settings. Use it to add, rename, and remove
  accounts, log each one in with one click, see who it is logged in as, and
  set per-project defaults.
- A `bb accounts` command for the same tasks from a terminal or an agent.

## How it works

Each account is a separate config directory: `CLAUDE_CONFIG_DIR` for Claude
Code and `CODEX_HOME` for Codex. When a thread's first message is sent, the
thread is pinned to its project's account (a fork keeps its source's
account). Before each provider command, the plugin passes that account's
directory to the provider. Nothing ever switches accounts automatically.
There is no pooling or failover.

Logins stay with the CLIs themselves: the macOS keychain or files inside each
account directory. The plugin stores only account names, paths, and project
choices.

## Setup

In Settings → Plugins → Accounts, add an account (for example "Startup"), then
click **Log in** on it:

- **Claude Code** opens a private browser window on the bb machine. If you are
  on another device, open the sign-in link shown in bb and paste back the code
  the page gives you.
- **Codex** shows a link and a one-time code. Open the link on any device and
  enter the code.

From a terminal instead:

```sh
bb accounts add claude Startup        # creates ~/.claude-accounts/startup
CLAUDE_CONFIG_DIR=~/.claude-accounts/startup claude auth login
bb accounts add codex Startup         # creates ~/.codex-accounts/startup
CODEX_HOME=~/.codex-accounts/startup codex login
bb accounts default claude-startup --project "My startup"
```

Existing account folders under `~/.claude-accounts/` and `~/.codex-accounts/`
are picked up automatically the first time the plugin loads.
