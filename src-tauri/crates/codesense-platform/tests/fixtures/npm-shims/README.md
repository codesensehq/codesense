# npm `.cmd` shims

The `.cmd` files npm writes on Windows for a global install (`npm i -g`), byte for byte (CRLF line ends). `cli::npm_shim_script` matches the forms it accepts against these files verbatim, with the script or program path the only part that varies.

| File                    | Package                             | `bin` entry      | cmd-shim | cmd-shim form                                                           |
| ----------------------- | ----------------------------------- | ---------------- | -------- | ----------------------------------------------------------------------- |
| `claude.cmd`            | `@anthropic-ai/claude-code` 2.1.330 | `bin/claude.exe` | 9.0.2    | direct program: the file has no shebang, so the shim runs it as written |
| `codex.cmd`             | `@openai/codex` 0.171.0             | `bin/codex.js`   | 9.0.2    | node: `#!/usr/bin/env node`, so the shim runs the script under `node`   |
| `codex-cmd-shim-8.cmd`  | `@openai/codex` 0.171.0             | `bin/codex.js`   | 8.0.0    | node, as cmd-shim 6 to 8 write it: `PATHEXT` is set in the `ELSE` block |

## How they were made

They were not captured on a Windows machine. They were generated with cmd-shim's own template: 9.0.2, which npm 12.2.3 (the registry's `latest` on 2026-11-20) bundles through bin-links 7.0.1, and 8.0.0, which npm 11.21.3 (the newest npm 11) bundles beside bin-links 6.0.3, for installs made with npm 11. cmd-shim 8.0.0 writes Claude's direct-program shim byte for byte as 9.0.2 does, so there is one `claude.cmd`. The script ran that cmd-shim from the npm tarball on each package's real `bin` file, taken from its registry tarball, laid out as a global install lays it out (`<prefix>\claude` → `<prefix>\node_modules\@anthropic-ai\claude-code\bin\claude.exe`). cmd-shim writes the `.cmd` text with fixed `\r\n` line ends and turns the relative path into `\` separators itself, so the bytes don't depend on the OS that runs it.

Claude Code's package ships `bin/claude.exe` as a placeholder with no shebang. Its postinstall then copies the native binary over the placeholder, so npm's shim starts the `.exe` directly.

When npm moves to a cmd-shim whose template differs, generate its shims the same way, add them beside these and update this table. The parser refuses any shim that doesn't match.
