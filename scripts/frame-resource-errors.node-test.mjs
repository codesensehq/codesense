// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../src-tauri/src/http/routes/viewer.rs", import.meta.url),
  "utf8",
);
const shim = source.match(/const LINK_INTERCEPTOR_JS: &str = r#"([\s\S]*?)"#;/)[1];
const reporters = shim.slice(
  shim.indexOf("// Report observed failures"),
  shim.indexOf("\n(function(){", shim.indexOf("// Report observed failures")),
);

function harness() {
  const listeners = new Map(),
    messages = [],
    tasks = [];
  const window = {
    parent: { postMessage: (message) => messages.push(message) },
    addEventListener: (type, callback) => listeners.set(type, callback),
  };
  const baseURI = "http://f-test.localhost:9123/viewer/board.html";
  vm.runInNewContext(reporters, {
    window,
    document: { baseURI, addEventListener: (type, callback) => listeners.set(type, callback) },
    location: new URL(baseURI),
    URL,
    setTimeout: (callback) => tasks.push(callback),
  });
  return {
    messages,
    emit: (type, event) => listeners.get(type)(event),
    flush: () => {
      while (tasks.length) tasks.shift()();
    },
    resource: (tagName, uri, rel, as) => ({
      target: {
        tagName,
        ...(tagName === "LINK" ? { href: uri } : { src: uri }),
        getAttribute: (name) =>
          ({ src: tagName === "LINK" ? null : uri, href: uri, rel, as })[name] ?? null,
      },
    }),
    violation: (uri, directive, disposition = "enforce") => ({
      disposition,
      blockedURI: uri,
      effectiveDirective: directive,
    }),
  };
}

for (const [tag, directive, rel, as] of [
  ["IMG", "img-src"],
  ["SCRIPT", "script-src-elem"],
  ["LINK", "style-src-elem", "stylesheet"],
  ["LINK", "style-src-elem", "alternate stylesheet"],
  ["LINK", "font-src", "preload", "font"],
  ["LINK", "script-src-elem", "modulepreload"],
]) {
  for (const order of ["resource-first", "csp-first"]) {
    test(`optional ${tag} ${rel ?? ""} reports separate resource and CSP observations before live, ${order}`, () => {
      const h = harness(),
        uri = "https://assets.example.com/optional?cache=1";
      const error = () => h.emit("error", h.resource(tag, uri, rel, as));
      // Cross-origin violations can name only the origin, rather than the resource path.
      const csp = () =>
        h.emit("securitypolicyviolation", h.violation("https://assets.example.com", directive));
      if (order === "resource-first") {
        error();
        csp();
      } else {
        csp();
        error();
      }
      h.flush();
      assert.equal(h.messages.length, 2);
      assert.equal(h.messages[0].type, "codesense:doc-error");
      assert.deepEqual(h.messages.map((m) => m.kind).sort(), ["csp", "resource"]);
    });
  }
}

test("runtime exceptions and rejections keep their ordinary error kinds", () => {
  const h = harness();
  h.emit("error", { message: "initialization failed", filename: "board.js", lineno: 12 });
  h.emit("unhandledrejection", { reason: new Error("query failed") });
  assert.deepEqual(
    h.messages.map((m) => m.kind),
    ["error", "rejection"],
  );
  assert.equal(h.messages[0].line, 12);
});

test("missing local resources remain visible diagnostics beside a blocked local resource", () => {
  const h = harness(),
    base = "http://f-test.localhost:9123/viewer/";
  h.emit("securitypolicyviolation", h.violation(`${base}blocked.js`, "script-src-elem"));
  h.emit("error", h.resource("SCRIPT", `${base}blocked.js`));
  h.emit("error", h.resource("SCRIPT", `${base}missing.js`));
  h.flush();
  assert.deepEqual(
    h.messages.map((m) => m.kind),
    ["csp", "resource", "resource"],
  );
  assert.match(h.messages[2].message, /missing.js/);
});

test("a real remote failure and a different directive are not suppressed", () => {
  const h = harness(),
    uri = "https://assets.example.com/asset";
  h.emit("securitypolicyviolation", h.violation(uri, "img-src"));
  h.emit("error", h.resource("SCRIPT", uri));
  h.emit("error", h.resource("IMG", "https://other.example.com/missing"));
  h.flush();
  assert.deepEqual(
    h.messages.map((m) => m.kind),
    ["csp", "resource", "resource"],
  );
});

test("report-only CSP does not hide failures; enforced reports still redact and deduplicate", () => {
  const h = harness(),
    uri = "https://assets.example.com/image?private=1#fragment";
  h.emit("securitypolicyviolation", h.violation(uri, "img-src", "report"));
  h.emit("error", h.resource("IMG", uri));
  h.flush();
  assert.deepEqual(
    h.messages.map((m) => m.kind),
    ["resource"],
  );
  h.emit("securitypolicyviolation", h.violation(uri, "img-src"));
  h.emit("securitypolicyviolation", h.violation("https://assets.example.com/other", "img-src"));
  assert.equal(h.messages.length, 2);
  assert.doesNotMatch(h.messages[1].message, /private=1|fragment/);
});

test("same-CDN failures survive earlier CSP and object data is only diagnostic text", () => {
  const h = harness();
  h.emit(
    "securitypolicyviolation",
    h.violation("https://assets.example.com/blocked.js", "script-src-elem"),
  );
  h.emit("error", h.resource("SCRIPT", "https://assets.example.com/permitted-404.js"));
  h.emit("error", {
    target: {
      tagName: "OBJECT",
      getAttribute: (name) => (name === "data" ? "https://assets.example.com/fallback.html" : null),
    },
  });
  assert.deepEqual(
    h.messages.map((m) => m.kind),
    ["csp", "resource", "resource"],
  );
  assert.match(h.messages[1].message, /permitted-404/);
  assert.match(h.messages[2].message, /fallback.html/);
});
