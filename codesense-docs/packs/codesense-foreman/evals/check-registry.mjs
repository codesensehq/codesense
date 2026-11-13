#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Standalone registry check: `node check-registry.mjs [--variants f] [--pack f] [--reports dir]`.
import { checkRegistry } from "./lib/registry.mjs";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const errors = checkRegistry(
  Object.fromEntries(["variants", "pack", "reports"].flatMap((k) => (opt(`--${k}`) ? [[k, opt(`--${k}`)]] : []))),
);
for (const e of errors) console.error(`variants.yml: ${e}`);
process.exit(errors.length ? 1 : 0);
