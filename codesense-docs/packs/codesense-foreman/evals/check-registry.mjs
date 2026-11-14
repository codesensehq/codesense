#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Standalone registry check: `node check-registry.mjs [--variants f] [--pack f] [--reports dir]`.
import console from "node:console";
import path from "node:path";
import process from "node:process";
import { checkRegistry } from "./lib/registry.mjs";

const args = process.argv.slice(2);
const paths = {};
for (let i = 0; i < args.length; i += 2) {
  const name = args[i].replace(/^--/, "");
  if (!["variants", "pack", "reports"].includes(name) || args[i + 1] === undefined) {
    console.error("usage: check-registry.mjs [--variants f] [--pack f] [--reports dir]");
    process.exit(2);
  }
  paths[name] = args[i + 1];
}
const errors = checkRegistry(paths);
const shown = path.basename(paths.variants ?? "variants.yml");
for (const e of errors) console.error(`${shown}: ${e}`);
process.exit(errors.length ? 1 : 0);
