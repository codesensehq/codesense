# npm `.cmd` shims

The `.cmd` files npm writes on Windows for a global install (`npm i -g`), byte for byte (CRLF line ends). `cli::npm_shim_script` matches its two accepted forms against these files verbatim, with the script or program path the only part that varies.

| File         | Package                             | `bin` entry      | cmd-shim form                                                           |
| ------------ | ----------------------------------- | ---------------- | ----------------------------------------------------------------------- |
| `claude.cmd` | `@anthropic-ai/claude-code` 2.1.330 | `bin/claude.exe` | direct program: the file has no shebang, so the shim runs it as written |
| `codex.cmd`  | `@openai/codex` 0.171.0             | `bin/codex.js`   | node: `#!/usr/bin/env node`, so the shim runs the script under `node`   |

## How they were made

They were not captured on a Windows machine. They were generated with cmd-shim 9.0.2's own template: the cmd-shim that npm 12.2.3 (the registry's `latest` on 2026-11-20) bundles through bin-links 7.0.1. The script ran that cmd-shim from the npm tarball on each package's real `bin` file, taken from its registry tarball, laid out as a global install lays it out (`<prefix>\claude` → `<prefix>\node_modules\@anthropic-ai\claude-code\bin\claude.exe`). cmd-shim writes the `.cmd` text with fixed `\r\n` line ends and turns the relative path into `\` separators itself, so the bytes don't depend on the OS that runs it.

Claude Code's package ships `bin/claude.exe` as a placeholder with no shebang. Its postinstall then copies the native binary over the placeholder, so npm's shim starts the `.exe` directly.

When npm moves to a cmd-shim whose template differs, regenerate both files the same way and update this table. The parser refuses any shim that doesn't match.
