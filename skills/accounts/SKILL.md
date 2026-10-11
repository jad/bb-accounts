---
name: accounts
description: Use when the user wants to see, add, log in, or choose which Claude Code or Codex account (login) a bb project or thread uses, via the `bb accounts` command of the Accounts plugin.
---

# Accounts: which Claude Code / Codex login a thread uses

The Accounts plugin lets one bb run several Claude Code and Codex logins side
by side (e.g. personal, startup, client). An account is one config directory:
`CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex. Each provider also
has a built-in **Default** account, which is the CLI's own home (`~/.claude`,
`~/.codex`) with no variable set.

## How a thread gets its account

1. When a thread's first message is dispatched, it is **pinned** to an account
   for its provider, and it keeps that account for life. Changing a project's
   choice later never moves existing threads.
2. A fork or a child thread takes the account of the thread it came from.
3. Otherwise the thread gets its project's account, or the global default.

This plugin never switches accounts on its own. It does not pool accounts or
fail over when a usage limit is hit.

## Commands

- `bb accounts list [--json]`: accounts, who each is logged in as, and project choices.
- `bb accounts add <claude|codex> <label> [--dir <path>] [--no-share]`: create an
  account directory (default `~/.claude-accounts/<name>` or
  `~/.codex-accounts/<name>`, where <name> is the label lowercased with dashes). By default it symlinks settings, skills, and
  plugins from the Default account's home. It prints the login command.
  Use `--dir` only to adopt a folder that is already logged in, or a new or
  empty one; a folder with other files in it is refused. Settings always uses
  the standard folder.
- `bb accounts login <account>`: print the login command for an account.
  **The user must run it in their own terminal** because it opens a browser.
  Never run it on the user's behalf.
- `bb accounts default <account> [--project <project>]`: the account new threads in
  that project (or, without `--project`, every project without its own choice) start on.
- `bb accounts unset <claude|codex> --project <project>`: the project follows the global default again.
- `bb accounts rename <account> <label>`, `bb accounts remove <account>`. Removing an
  account only forgets it; the directory and login stay on disk.
- `bb accounts thread <thread-id> [--json]`: the account a thread runs on.

`<account>` is an id from `list` (like `claude-startup`) or an unambiguous label.
`<project>` is a project id or name.

## Notes

- Paths are on the bb server's machine. A thread on an enrolled remote host
  receives the same absolute path, so that host needs the same directory,
  logged in.
- Claude Code MCP servers configured at user scope live in each account's own
  `.claude.json`, so they are not shared between accounts.
- If another plugin (such as claude-switcher) also sets `CLAUDE_CONFIG_DIR`,
  the two compete. Use only one of them for Claude Code.
