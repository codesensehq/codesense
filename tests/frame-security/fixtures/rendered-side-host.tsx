// SPDX-License-Identifier: MIT
import { createRoot } from "react-dom/client";
import { SideFrame } from "../../../src/shared/lib/side-frame";

// A side read from another machine that tries to reach this Mac's loopback API,
// its disk and a file beside it. `probe` is a loopback server that counts hits.
const probe = new URLSearchParams(location.search).get("probe");
const remote = `<!doctype html><title>remote</title>
<h1 id="marker">remote side</h1>
<script>
  window.violations = [];
  document.addEventListener("securitypolicyviolation", (e) => violations.push(e.blockedURI));
  window.fetched = "pending";
  fetch("http://127.0.0.1:${probe}/fetch").then(
    () => (window.fetched = "answered"),
    () => (window.fetched = "refused"),
  );
  document.getElementById("marker").dataset.ran = "yes";
</script>
<img src="file:///etc/hosts">
<img src="http://127.0.0.1:${probe}/img">
<link rel="stylesheet" href="../x.css">`;

createRoot(document.getElementById("root")!).render(
  <SideFrame html={remote} title="Remote side" />,
);
