# Install CodeSense

_Install CodeSense, then open on the CodeSense Docs with a local profile._

CodeSense runs locally on macOS. There's no CodeSense account: you don't sign in to a CodeSense service or connect a code-host account to get started.

## Install and open

CodeSense is for Macs with Apple Silicon. Download it from the [download page](https://codesense.ai/download), open the DMG and drag CodeSense to Applications. Or with Homebrew: `brew install --cask codesensehq/tap/codesense`. Open the app, then follow the dependency check if Git is missing. Install the agent CLI you want to use, Claude Code, Codex or OpenCode, and sign in to it with that CLI's own instructions.

The first time it opens, CodeSense opens **CodeSense Docs**: a read-only context repo of these docs that ships with every install, open at its README. There's no welcome screen or setup wizard.

### Linux

The Linux downloads (the AppImage, the `.deb` and the `.rpm`) come with a checksum list, `SHA256SUMS`, and its signature, `SHA256SUMS.asc`, made with the CodeSense release key. The release key's public half is [`codesense-release.asc`](https://github.com/codesensehq/codesense/blob/main/codesense-release.asc), in the root of the CodeSense repository. Its fingerprint is:

```text
FB7C 0E5F 0FAF AB81 2A72  FE13 03DD 39B8 5420 866B
```

To check a download, put `codesense-release.asc`, `SHA256SUMS`, `SHA256SUMS.asc` and the files you downloaded in one folder, then run:

```sh
gpg --import codesense-release.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
```

`gpg --verify` must report a good signature from the key with the fingerprint above; it may also warn that the key isn't certified, which only means you haven't signed it yourself. `sha256sum` must print `OK` for each file you downloaded. If either fails, don't install the file.

The `.deb` and `.rpm` depend on WebKitGTK 4.1 and GTK 3, so install them with your package manager to pull those in: `sudo apt install ./<file>.deb` or `sudo dnf install ./<file>.rpm`.

## Your local profile

CodeSense makes a local profile for you. A profile keeps its context repos, files and routines apart from other profiles on this Mac; it is not a service login. If CodeSense finds several profiles from earlier installs, it asks you to choose one. You can switch later in **Settings → Local profile**.

## Connect or create your context

Open the context repo menu: the name at the top left, or ⌘⇧G. At the bottom of its context repos:

- **Connect a context repo…** for one your team already has. Clone it with git first, then pick the folder.
- **Create a new context repo…** to start one. It goes in `~/CodeSense/<name>` unless you choose another location.

Then create your first team and [attach your source repos](attach-repos.md). [Create or connect a context repo](workspace.md) has the details and the MCP tools an agent uses for the same steps.

The same menu holds **Private**, **Agent definitions**, **Schedule**, **Machines**, **Settings** and **Keyboard shortcuts**. The **Inbox** sits at the top right of the window.

## Updates

CodeSense checks for updates and installs a newer build when you quit. Your context repos stay in their folders.

## What you need

- An Apple Silicon Mac.
- At least one agent CLI you already use: Claude Code, Codex or OpenCode (2.1.4 or a newer 2.x release), signed in with your own account.
- A git repo for your team’s context. Start a new one or add one you have.
- Optional: a Linux box you can reach over SSH, for remote agents.

OpenCode runs on your Mac only. Remote machines and line attribution work with Claude Code and Codex. CodeSense starts OpenCode with its own config folder: your `opencode auth login` logins and a repo’s `opencode.json` apply, but `~/.config/opencode` doesn’t.

> **Note**
>
> CodeSense never calls a model and never touches your tokens. Each agent is the official CLI, on your own Claude or ChatGPT plan or OpenCode provider, so there’s nothing to configure here beyond the logins you already have.

## If it doesn’t work

### CodeSense can’t find your CLI

CodeSense launches the CLIs on your `PATH`. Check that the one you use runs in a terminal, then restart CodeSense.

```sh
which claude codex opencode
claude --version
```

### macOS warns before opening the app

macOS should open CodeSense without a warning. If you see one, check that you downloaded it from codesense.ai, then open it from Applications.

### Still stuck

Open an issue on GitHub, or ask an agent: CodeSense’s own docs ship with it, so your agent can look up the fix.
