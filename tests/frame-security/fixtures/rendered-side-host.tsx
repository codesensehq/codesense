// SPDX-License-Identifier: MIT
import { createRoot } from "react-dom/client";
import { SideFrame } from "../../../src/shared/lib/side-frame";

// A side read from another machine. `probe` is a loopback server that counts hits;
// `case` picks what the side tries:
// - `probes` (default): reach this Mac's loopback API, its disk and a file beside it
//   through every subresource kind: fetch, image, stylesheet, nested frame, object,
//   WebSocket and a blob worker;
// - `href`, `refresh`, `click`: navigate itself to the probe (location.href, a meta
//   refresh, a link click), the one request the CSP can't stop;
// - `reopen`, `realm`: erase the page with document.open() (its own, or another
//   realm's) before navigating, so no unload listener of the old page is left.
const params = new URLSearchParams(location.search);
const probe = `http://127.0.0.1:${params.get("probe")}`;
const watch = `<script>
  window.violations = [];
  document.addEventListener("securitypolicyviolation", (e) => violations.push(e.blockedURI));
</script>`;
const SIDES: Record<string, string> = {
  probes: `<!doctype html><title>remote</title>
<h1 id="marker">remote side</h1>
${watch}
<script>
  window.fetched = "pending";
  fetch("${probe}/fetch").then(
    () => (window.fetched = "answered"),
    () => (window.fetched = "refused"),
  );
  window.socket = "pending";
  try {
    const ws = new WebSocket("ws://127.0.0.1:${params.get("probe")}/ws");
    ws.onopen = () => (window.socket = "open");
    ws.onerror = () => (window.socket = "refused");
  } catch {
    window.socket = "refused";
  }
  window.worker = "pending";
  try {
    const code = 'fetch("${probe}/worker")';
    new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    window.worker = "started";
  } catch {
    window.worker = "refused";
  }
  document.getElementById("marker").dataset.ran = "yes";
  // Even a write while the page parses is refused: no write can reopen the document.
  try {
    document.write('<p id="written">written</p>');
    window.parseWrite = "allowed";
  } catch (e) {
    window.parseWrite = e.name;
  }
</script>
<img src="file:///etc/hosts">
<img src="${probe}/img">
<link rel="stylesheet" href="../x.css">
<iframe src="${probe}/frame"></iframe>
<object data="${probe}/object"></object>`,
  href: `${watch}<h1 id="marker">navigates</h1><script>location.href = "${probe}/nav-href";</script>`,
  refresh: `<meta http-equiv="refresh" content="0; url=${probe}/nav-refresh"><h1 id="marker">navigates</h1>`,
  click: `<h1 id="marker">navigates</h1><a id="go" href="${probe}/nav-click">go</a>
<script>document.getElementById("go").click();</script>`,
  // Erase the prelude's listener with document.open(), then navigate before the load.
  reopen: `<h1 id="marker">navigates</h1><script>
  document.addEventListener("DOMContentLoaded", () => {
    try { document.open(); } catch {}
    location.href = "${probe}/nav-reopen";
  });
</script>`,
  // A write from a timer while the parser has yielded has no insertion point, so it
  // runs the document open steps natively (no call to open), then navigates.
  timerwrite: `<h1 id="marker">navigates</h1><script>
  setTimeout(() => {
    try { document.write("<p>rewritten</p>"); } catch {}
    location.href = "${probe}/nav-timerwrite";
  }, 0);
</script>${"<p>still parsing</p>".repeat(200000)}`,
  // The same through another realm's Document.prototype.open (an about:blank frame).
  realm: `<h1 id="marker">navigates</h1><script>
  document.addEventListener("DOMContentLoaded", () => {
    try {
      const other = document.body.appendChild(document.createElement("iframe"));
      other.contentWindow.Document.prototype.open.call(document);
    } catch {}
    location.href = "${probe}/nav-realm";
  });
</script>`,
};

createRoot(document.getElementById("root")!).render(
  <SideFrame html={SIDES[params.get("case") ?? "probes"]!} title="Remote side" />,
);
