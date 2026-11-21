// SPDX-License-Identifier: MIT
import { exportedCatalog as readCatalog } from "./mcp-reference-fixture";
import { describe, expect, it, vi } from "vitest";
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawnSync = vi.fn(() => {
    throw new Error("Node checks must not invoke Cargo or mq");
  });
  return { ...actual, spawnSync, default: { ...actual, spawnSync } };
});
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, META, validateInputReferences } from "./generate-mcp-reference.mjs";
import { REFRESH_ROUTE, strictExports } from "./lib/sealed-export.mjs";
const GENERATED = "codesense-docs/getting-started/content/generated";
const SEAL_PATH = `${GENERATED}/mcp-tools.inputs.json`;
const PAYLOAD_PATHS = ["default", "dashboard-publish"].map(
  (p) => `${GENERATED}/mcp-tools.${p}.json`,
);
const reference = () =>
  JSON.parse(
    readFileSync(
      "codesense-docs/getting-started/content/generated/mcp-tools.dashboard-publish.json",
      "utf8",
    ),
  );
// A scratch checkout with the MCP export's inputs, sealed, then given input-only drift (a nested
// schema source changed), committed as origin/main: the stale export a PR inherits. `before` runs
// on the tree ahead of the seal, so it can model main's catalog and payload state.
async function staleScratch(prefix: string, before: (root: string) => void = () => {}) {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { dirname } = await import("node:path");
  const mod = await import("./generate-mcp-reference.mjs");
  const { ROOT, CONTENT, CATALOG } = mod;
  const root = mkdtempSync(join(tmpdir(), prefix));
  const copy = (path: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(root, path));
  };
  mkdirSync(join(root, "src-tauri/crates"), { recursive: true });
  for (const path of [
    "Cargo.lock",
    "src-tauri/Cargo.toml",
    "src-tauri/build.rs",
    "src-tauri/crates/codesense-pty-core/src/agent_cli/codex.rs",
    "src-tauri/crates/codesense-pty-core/src/agent_cli/claude.rs",
    "src-tauri/src/mcp/handler.rs",
    CATALOG,
    ...PAYLOAD_PATHS,
  ])
    copy(path);
  for (const f of readCatalog().families) copy(`${CONTENT}/${f.docs.split("#")[0]}`);
  writeFileSync(join(root, CATALOG), JSON.stringify(readCatalog(), null, 2) + "\n");
  const nested = join(root, "src-tauri/src/nested.rs");
  writeFileSync(nested, "// JsonSchema nested DTO source\n");
  before(root);
  mod.sealReference(root);
  writeFileSync(nested, "// JsonSchema nested DTO changed\n");
  return { root, mod };
}
const commitAsMain = (root: string) => {
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "main");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
};
const editJson = (path: string, edit: (value: any) => void) => {
  const value = JSON.parse(readFileSync(path, "utf8"));
  edit(value);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};
describe("served MCP reference", () => {
  it("has real contracts, long descriptions and explicit absent output schemas", () => {
    // Against the committed export: strict only with CS_STRICT_EXPORTS=1, else a stale export is a
    // notice and each Docs line comes from the catalog, so the descriptions compare without it.
    const strict = strictExports();
    const doc = buildManifest(undefined, META, readCatalog(), strict ? null : [], () => {});
    const body = (text: string) => (strict ? text : text.replace(/\nDocs: [^\n]*$/, ""));
    for (const tool of reference().tools) {
      const entry = doc.tools.find((t: { name: string }) => t.name === tool.name);
      if (!entry && !strict) continue;
      expect(entry!.params, tool.name).toEqual(tool.inputSchema);
      expect(entry!.returns, tool.name).toEqual(tool.outputSchema ?? null);
      expect(body(entry!.description), tool.name).toEqual(body(tool.description));
    }
    expect(
      doc.tools.find((t: { name: string }) => t.name === "open_workspace")!.params.properties
        .story_id,
    ).toBeDefined();
    expect(
      doc.tools.find((t: { name: string }) => t.name === "codesense_overview")!.description.length,
    ).toBeGreaterThan(500);
    expect(doc.tools.find((t: { name: string }) => t.name === "publish_dashboard")!.feature).toBe(
      "dashboard-publish",
    );
  });
  it("rejects unclassified tools, missing examples and wrong example inputs", () => {
    const metadata = { ...META };
    delete metadata.role_save;
    expect(() => buildManifest(undefined, metadata, readCatalog())).toThrow(/role_save.*META/);
    const catalog = readCatalog();
    catalog.families[0].calls = [];
    expect(() => buildManifest(undefined, META, catalog)).toThrow(/example/);
    const invalid = readCatalog();
    invalid.families.find((f: { id: string }) => f.id === "discovery")!.calls[0].arguments = {
      query: 5,
    };
    expect(() => buildManifest(undefined, META, invalid)).toThrow(/invalid family example/);
  });
  it("compares explicit input markers without confusing nested inputs or outputs", () => {
    const tools = reference().tools;
    for (const [name, alias] of [
      ["open_workspace", "storyId"],
      ["open_workspace", "initialPrompt"],
      ["list_sessions", "launchedBy"],
      ["send_message", "sessionId"],
      ["who_am_i", "sessionId"],
    ]) {
      const tool = tools.find((t: { name: string }) => t.name === name);
      expect(() =>
        validateInputReferences({ ...tool, description: `Args: {${alias}}. Returns {sessionId}` }),
      ).toThrow(/schema field/);
    }
    for (const name of ["signal_done", "list_sessions", "who_am_i"])
      expect(() =>
        validateInputReferences(tools.find((t: { name: string }) => t.name === name)),
      ).not.toThrow();
    const open = tools.find((t: { name: string }) => t.name === "open_workspace");
    expect(() =>
      validateInputReferences({
        ...open,
        description: "Args: {story_id}. Returns {handle}\n\nLAUNCH AN AGENT: pass {initialPrompt}.",
      }),
    ).toThrow(/schema field/);
    const sessions = tools.find((t: { name: string }) => t.name === "list_sessions");
    expect(() =>
      validateInputReferences({
        ...sessions,
        description: "Returns {launchedBy}. Optional {launchedBy} filters sessions.",
      }),
    ).toThrow(/schema field/);
    expect(() =>
      validateInputReferences({
        ...open,
        description: "Args: {story_id}. Returns {storyId, sessionId}",
      }),
    ).not.toThrow();
  });
});

describe("Node-only freshness and resolving teaching links", () => {
  it("rejects missing pages and missing anchors", () => {
    for (const pointer of ["missing-page.html", "mcp-explorer.html#missing-anchor"]) {
      const catalog = readCatalog();
      catalog.families[0].docs = pointer;
      expect(() => buildManifest(undefined, META, catalog)).toThrow(/unresolved Docs/);
    }
  });
  it("rejects source or payload drift without invoking the compiler or queue", async () => {
    const { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { dirname, join } = await import("node:path");
    const { ROOT, CONTENT, CATALOG, OUTPUT, sealReference, generateReference } =
      await import("./generate-mcp-reference.mjs");
    const root = mkdtempSync(join(tmpdir(), "mcp-reference-check-"));
    const copy = (path: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(ROOT, path), join(root, path));
    };
    try {
      mkdirSync(join(root, "src-tauri/crates"), { recursive: true });
      for (const path of [
        "Cargo.lock",
        "src-tauri/Cargo.toml",
        "src-tauri/build.rs",
        "src-tauri/crates/codesense-pty-core/src/agent_cli/codex.rs",
        "src-tauri/crates/codesense-pty-core/src/agent_cli/claude.rs",
        "src-tauri/src/mcp/handler.rs",
        CATALOG,
        `${CONTENT}/generated/mcp-tools.default.json`,
        `${CONTENT}/generated/mcp-tools.dashboard-publish.json`,
      ])
        copy(path);
      for (const f of readCatalog().families) copy(`${CONTENT}/${f.docs.split("#")[0]}`);
      const nested = join(root, "src-tauri/src/nested.rs");
      writeFileSync(nested, "// JsonSchema nested DTO source\n");
      const unrelated = join(root, "src-tauri/src/unrelated.rs");
      writeFileSync(unrelated, "// unrelated backend source\n");
      writeFileSync(join(root, CATALOG), JSON.stringify(readCatalog(), null, 2) + "\n");
      sealReference(root);
      generateReference(root);
      // The tolerant gate only trusts a tree whose exports match main's.
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
      git("init", "-q", "-b", "main");
      // Only the export files matter to the gate; adding just those keeps the setup cheap.
      git("add", "--", ...[SEAL_PATH, OUTPUT, ...PAYLOAD_PATHS]);
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "sealed");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      expect(() => generateReference(root, { check: true })).not.toThrow();
      writeFileSync(unrelated, "// unrelated backend edit\n");
      expect(() => generateReference(root, { check: true })).not.toThrow();
      writeFileSync(nested, "// JsonSchema nested DTO changed\n");
      expect(() => generateReference(root, { check: true })).toThrow(
        /Stale MCP registry export.*changed inputs: src-tauri\/src\/nested\.rs/,
      );
      const outputPath = join(root, OUTPUT);
      const outputBeforeWarning = readFileSync(outputPath, "utf8");
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(
        generateReference(root, {
          buildScript: true,
          stdout: (line) => stdout.push(line),
          warn: (line) => stderr.push(line),
        }),
      ).toBeNull();
      expect(stdout.join("\n")).toContain("cargo:warning=MCP REFERENCE EXPORT STALE");
      expect(stdout.join("\n")).toContain("src-tauri/src/nested.rs");
      expect(stdout.join("\n")).toContain(REFRESH_ROUTE);
      expect(stdout.join("\n")).not.toContain("--export");
      expect(() => generateReference(root, { check: true })).toThrow(REFRESH_ROUTE);
      expect(stderr).toEqual([]);
      expect(readFileSync(outputPath, "utf8")).toBe(outputBeforeWarning);
      const notices: string[] = [];
      expect(
        generateReference(root, {
          check: true,
          allowStaleExport: true,
          warn: (line) => notices.push(line),
        }),
      ).not.toBeNull();
      expect(notices.join("\n")).toContain("NOTICE:");
      expect(notices.join("\n")).toContain("src-tauri/src/nested.rs");
      expect(() => generateReference(root, { check: true })).toThrow(/src-tauri\/src\/nested\.rs/);
      expect(() =>
        generateReference(root, { check: true, buildScript: true, warn: () => {} }),
      ).toThrow(/src-tauri\/src\/nested\.rs/);
      // Write mode renders mcp-tools.json from the committed exports and warns.
      const written: string[] = [];
      expect(
        generateReference(root, { strict: false, warn: (line) => written.push(line) }),
      ).not.toBeNull();
      // Under CS_STRICT_EXPORTS=1 (the refresh run) write mode is strict.
      expect(() => generateReference(root, { strict: true, warn: () => {} })).toThrow(
        /Stale MCP registry export.*nested\.rs/,
      );
      expect(written.join("\n")).toMatch(/^NOTICE: Stale MCP registry export.*nested\.rs/);
      expect(readFileSync(outputPath, "utf8")).toBe(outputBeforeWarning);
      // mcp-tools.json is Node-rendered: the PR gate compares it with the committed exports.
      writeFileSync(outputPath, `${outputBeforeWarning}\n`);
      expect(() =>
        generateReference(root, { check: true, allowStaleExport: true, warn: () => {} }),
      ).toThrow(/stale .*mcp-tools\.json/);
      writeFileSync(outputPath, outputBeforeWarning);
      writeFileSync(nested, "// JsonSchema nested DTO source\n");
      const source = join(root, "src-tauri/src/mcp/handler.rs");
      const before = readFileSync(source, "utf8");
      writeFileSync(source, before + "\n// changed input\n");
      expect(() => generateReference(root, { check: true })).toThrow(/Stale MCP registry export/);
      expect(
        generateReference(root, { check: true, allowStaleExport: true, warn: () => {} }),
      ).not.toBeNull();
      const tolerate = () =>
        generateReference(root, { check: true, allowStaleExport: true, warn: () => {} });
      const lines = before.split("\n");
      writeFileSync(source, `// prepended comment\n${before}`);
      expect(tolerate()).not.toBeNull();
      expect(() => generateReference(root, { check: true })).toThrow(/Stale MCP registry export/);
      lines.splice(Math.floor(lines.length / 2), 0, "// inserted mid-file");
      writeFileSync(source, lines.join("\n"));
      expect(tolerate()).not.toBeNull();
      writeFileSync(source, before);
      const manifest = readFileSync(outputPath, "utf8");
      for (const edit of ["description", "params"] as const) {
        const edited = JSON.parse(manifest);
        const tool = edited.tools.find((t: { name: string }) => t.name === "accept_role_message");
        if (edit === "description") tool.description += " edited";
        else tool.params = { ...tool.params, title: "edited" };
        writeFileSync(outputPath, JSON.stringify(edited, null, 2) + "\n");
        writeFileSync(source, `// prepended comment\n${before}`);
        // The edited manifest no longer matches the committed exports.
        expect(tolerate, edit).toThrow(/accept_role_message: stale .*mcp-tools\.json/);
      }
      writeFileSync(outputPath, manifest);
      writeFileSync(source, before);
      // A catalog edit re-renders mcp-tools.json from the committed exports; the gate accepts it.
      const catalogPath = join(root, CATALOG);
      const catalogBefore = readFileSync(catalogPath, "utf8");
      const catalog = JSON.parse(catalogBefore);
      catalog.families[0].searchTerms.push("an added search term");
      writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
      writeFileSync(source, `// prepended comment\n${before}`);
      expect(() => generateReference(root, { strict: false, warn: () => {} })).not.toThrow();
      expect(readFileSync(outputPath, "utf8")).toContain("an added search term");
      expect(tolerate()).not.toBeNull();
      writeFileSync(catalogPath, catalogBefore);
      writeFileSync(outputPath, manifest);
      writeFileSync(source, before);
      const payload = join(root, `${CONTENT}/generated/mcp-tools.default.json`);
      writeFileSync(payload, readFileSync(payload, "utf8") + "\n");
      expect(() => generateReference(root, { check: true })).toThrow(/Stale MCP registry export/);
      expect(() =>
        generateReference(root, { check: true, allowStaleExport: true, warn: () => {} }),
      ).toThrow(/changed payloads:/);
      rmSync(join(root, `${CONTENT}/generated/mcp-tools.inputs.json`));
      expect(() =>
        generateReference(root, { check: true, allowStaleExport: true, warn: () => {} }),
      ).toThrow(/no sealed export/);
      expect(readFileSync(join(root, OUTPUT), "utf8")).toContain("pane_write");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("tolerates a re-exported PR's drift only in inputs that main changed", async () => {
    const { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { dirname, join } = await import("node:path");
    const { ROOT, CONTENT, CATALOG, sealReference, generateReference } =
      await import("./generate-mcp-reference.mjs");
    const root = mkdtempSync(join(tmpdir(), "mcp-reference-inherited-"));
    const copy = (path: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(ROOT, path), join(root, path));
    };
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
        cwd: root,
        stdio: "pipe",
      });
    try {
      mkdirSync(join(root, "src-tauri/crates"), { recursive: true });
      for (const path of [
        "Cargo.lock",
        "src-tauri/Cargo.toml",
        "src-tauri/build.rs",
        "src-tauri/crates/codesense-pty-core/src/agent_cli/codex.rs",
        "src-tauri/crates/codesense-pty-core/src/agent_cli/claude.rs",
        "src-tauri/src/mcp/handler.rs",
        CATALOG,
        `${CONTENT}/generated/mcp-tools.default.json`,
        `${CONTENT}/generated/mcp-tools.dashboard-publish.json`,
      ])
        copy(path);
      for (const f of readCatalog().families) copy(`${CONTENT}/${f.docs.split("#")[0]}`);
      const ours = join(root, "src-tauri/src/ours.rs");
      const theirs = join(root, "src-tauri/src/theirs.rs");
      writeFileSync(ours, "// JsonSchema the PR's tool\n");
      writeFileSync(theirs, "// JsonSchema another PR's tool\n");
      writeFileSync(join(root, CATALOG), JSON.stringify(readCatalog(), null, 2) + "\n");
      sealReference(root);
      generateReference(root);
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      // The PR edits its tool and re-exports, so it changes the sealed export.
      git("switch", "-q", "-c", "pr");
      writeFileSync(ours, "// JsonSchema the PR's tool, changed\n");
      sealReference(root);
      git("commit", "-q", "-am", "pr");
      // Meanwhile main changes another tool; the check runs on the merge, as CI does.
      git("switch", "-q", "main");
      writeFileSync(theirs, "// JsonSchema another PR's tool, changed\n");
      git("commit", "-q", "-am", "main");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      git("switch", "-q", "pr");
      git("merge", "-q", "--no-edit", "main");
      const notices: string[] = [];
      const tolerant = () =>
        generateReference(root, {
          check: true,
          allowStaleExport: true,
          warn: (line) => notices.push(line),
        });
      expect(tolerant()).not.toBeNull();
      expect(notices.join("\n")).toMatch(/NOTICE: Stale MCP registry export.*theirs\.rs/);
      // The strict check (the refresh check) still asks for the refresh.
      expect(() => generateReference(root, { check: true })).toThrow(/theirs\.rs/);
      // Drift in an input the PR changed is the PR's own: strict.
      writeFileSync(ours, "// JsonSchema the PR's tool, changed after its export\n");
      expect(tolerant).toThrow(/Stale MCP registry export.*ours\.rs/);
      git("checkout", "-q", "--", "src-tauri/src/ours.rs");
      // So is a hand-edited manifest, whatever drifted.
      const output = join(root, `${CONTENT}/generated/mcp-tools.json`);
      writeFileSync(output, readFileSync(output, "utf8").replace("pane_write", "pane_edit"));
      expect(tolerant).toThrow(/stale .*mcp-tools\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a stale export in write mode and the PR gate", () => {
  it("leaves a catalog tool the export lacks out, with a notice, and the gate accepts it", async () => {
    // Main added records_read to handler.rs, META and the catalog without re-exporting.
    const { root, mod } = await staleScratch("mcp-reference-pending-", (root) => {
      for (const path of PAYLOAD_PATHS)
        editJson(join(root, path), (payload) => {
          payload.tools = payload.tools.filter((t: { name: string }) => t.name !== "records_read");
        });
    });
    try {
      const notices: string[] = [];
      expect(() =>
        mod.generateReference(root, { strict: false, warn: (line) => notices.push(line) }),
      ).not.toThrow();
      expect(notices.join("\n")).toMatch(/NOTICE: records_read is not in the committed export yet/);
      expect(notices.find((line) => line.includes("records_read"))).toContain(REFRESH_ROUTE);
      const written = JSON.parse(readFileSync(join(root, mod.OUTPUT), "utf8"));
      expect(written.tools.map((t: { name: string }) => t.name)).not.toContain("records_read");
      commitAsMain(root);
      expect(
        mod.generateReference(root, { check: true, allowStaleExport: true, warn: () => {} }),
      ).not.toBeNull();
      expect(() => mod.generateReference(root, { check: true })).toThrow(/Stale MCP registry/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("takes a family's Docs pointer from the catalog, not the stale payload", async () => {
    const { root, mod } = await staleScratch("mcp-reference-docs-");
    try {
      const moved = "arc-f-inboxes-and-triage/index.html";
      const movePointer = () =>
        editJson(join(root, mod.CATALOG), (catalog) => {
          catalog.families.find((f: { id: string }) => f.id === "inbox-messages").docs = moved;
        });
      // The catalog is not a seal input, so with a fresh seal the edit alone drifts nothing.
      mod.sealReference(root);
      const catalogBefore = readFileSync(join(root, mod.CATALOG), "utf8");
      movePointer();
      expect(() => mod.generateReference(root, { strict: false, warn: () => {} })).not.toThrow();
      writeFileSync(join(root, mod.CATALOG), catalogBefore);
      writeFileSync(join(root, "src-tauri/src/nested.rs"), "// JsonSchema nested DTO, main's\n");
      commitAsMain(root);
      movePointer();
      expect(() => mod.generateReference(root, { strict: false, warn: () => {} })).not.toThrow();
      const written = JSON.parse(readFileSync(join(root, mod.OUTPUT), "utf8"));
      const tool = written.tools.find((t: { name: string }) => t.name === "read_messages");
      expect(tool.docs).toBe(moved);
      expect(tool.description).toMatch(new RegExp(`\nDocs: ${moved}$`));
      expect(tool.description.match(/^Docs: /gm)).toHaveLength(1);
      expect(
        mod.generateReference(root, { check: true, allowStaleExport: true, warn: () => {} }),
      ).not.toBeNull();
      // Strict, the served pointer must already match.
      expect(() => mod.buildManifest(root, META, mod.readCatalog(root))).toThrow(
        /: missing final Docs pointer/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops a tool the PR removed from META or the catalog, with a notice", async () => {
    const { root, mod } = await staleScratch("mcp-reference-removed-");
    try {
      const catalog = mod.readCatalog(root);
      const records = catalog.families.find((f: { id: string }) => f.id === "records");
      records.tools = records.tools.filter((t: string) => t !== "records_search");
      records.calls = records.calls.filter((c: { tool: string }) => c.tool !== "records_search");
      const metadata = { ...META };
      delete metadata.records_read;
      const notices: string[] = [];
      const doc = mod.buildManifest(root, metadata, catalog, [], (line: string) =>
        notices.push(line),
      );
      const names = doc.tools.map((t: { name: string }) => t.name);
      expect(names).not.toContain("records_search");
      expect(names).not.toContain("records_read");
      expect(notices.join("\n")).toMatch(/NOTICE: records_search: .*no family/);
      expect(notices.join("\n")).toMatch(/NOTICE: records_read: .*no META entry/);
      expect(() => mod.buildManifest(root, metadata, mod.readCatalog(root))).toThrow(
        /records_read: missing META entry/,
      );
      expect(() => mod.buildManifest(root, META, catalog)).toThrow(
        /records_search: missing family/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("notes, not fails, an example that uses a param the stale export lacks", async () => {
    const { root, mod } = await staleScratch("mcp-reference-param-");
    try {
      const catalog = mod.readCatalog(root);
      const call = catalog.families.find((f: { id: string }) => f.id === "discovery").calls[0];
      call.arguments = { ...call.arguments, brand_new_param: 1 };
      const notices: string[] = [];
      const doc = mod.buildManifest(root, META, catalog, [], (line: string) => notices.push(line));
      expect(notices.join("\n")).toMatch(
        /NOTICE: codesense_search_tools: unknown example input brand_new_param/,
      );
      const tool = doc.tools.find((t: { name: string }) => t.name === "codesense_search_tools");
      expect(tool.examples[0].arguments).toHaveProperty("brand_new_param", 1);
      expect(() => mod.buildManifest(root, META, catalog)).toThrow(
        /codesense_search_tools: unknown example input brand_new_param/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
