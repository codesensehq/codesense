# Security and privacy

_What leaves your Mac, and how each safety claim works._

## What leaves your Mac

The app has no account and no telemetry: CodeSense sends no usage data or crash reports. Sharing a dashboard is the exception to the account part: owners and viewers sign in on share.codesense.ai. Code and context stay on your machines and your git host.

| What | Where it goes | When |
|---|---|---|
| Your code and context | Your git host, when you or your agents push | Only when you push |
| Agent traffic | Each CLI talks to its own vendor on your login | When an agent runs; CodeSense isn’t in the path |
| A published dashboard | share.codesense.ai, to the viewers you invite. Each invitee's email address goes there too, and the CodeSense operator reviews it before the invite is sent | Only when you publish or invite |
| The daily update check | dl.codesense.ai | About once a day: it reads a static file that names the latest version, and sends no key, install ID, app version or anything from your repos. [What leaves your Mac](https://codesense.ai/open-source#what-leaves) has the summary |
| A picture an agent sends to your Inbox | The host that serves the picture: GIPHY, KLIPY, or any other HTTPS host the sender used. It sees your IP address and the picture's URL | By default, only when you tap Load. With `media: {remote: auto}` in the team's `config/inbox.yml`, pictures on `*.giphy.com` or `static.klipy.com` from agents on your own machines load without a tap; `remote: off` turns remote pictures off |
| Attribution notes | Nowhere | Unless you choose to share them |

## No model calls, no tokens

CodeSense never calls a model. Agents run the unmodified official CLIs on each person’s own login, and CodeSense never reads, stores or forwards their credentials.

When you launch an agent, CodeSense starts the vendor’s CLI in a terminal with the files you assigned, the way you would by hand. The CLI signs in with your account and talks to its vendor directly. CodeSense watches its status and usage from your Mac.

## Your keys stay home

Your remote boxes never get your git keys: CodeSense seeds each clone from your Mac over SSH, and commits come back the same way.

A box holds the clone, the files its agents were given, and the CLIs signed in with your logins there. It never holds your GitHub credentials. See [Remote machines](remote-machines.md#your-keys-stay-home).

## Panes are fenced in

Each page runs in an isolated frame with its own capability token. Dashboards are your own files, so open only ones you trust; see [How CodeSense trusts agents](https://github.com/codesensehq/codesense/blob/main/SECURITY.md#how-codesense-trusts-agents). A guard keeps credential files out of managed Claude sessions’ ordinary reads; it is not a sandbox.

A page can only call the verbs `window.codesense` exposes, and every action goes through the same gate: a page can open a workspace, message an agent or type into one, and create, move or delete team content files. Moves and deletes run without a confirm sheet unless you set `files.move` or `files.delete` to prompt for that dashboard. A dashboard published to share.codesense.ai is checked before upload: an allowlist of files, size limits, and no app calls in its pages.

## Pages block outside loads unless they say so

Dashboards, panes and agent HTML messages in the app load no remote content unless the dashboard or pane names the host. A remote image, font, script, style, video, `fetch` or WebSocket is blocked before its request leaves your Mac. Most blocked loads are listed in the problems of the pane, tab or message that tried it; loads blocked inside a worker or a nested SVG, or in a change’s before-and-after view, aren’t listed. Popups are off: a web link a page opens goes to your browser.

A dashboard or pane that needs an outside service names it with `allowed_hosts`: in the nearest `dashboard.yml` at or above the page, in a pane’s `pane-manifest.yaml`, or in a pane’s `<meta name="codesense:allowed-hosts">` tag. Only exact `https://` origins with a dotted host name are accepted, such as `https://api.example.com`: no wildcards, no IP addresses, no single-label names such as `localhost` or `intranet`, no names ending in `.localhost`, and no paths. These are spelling checks, not checks of resolved addresses: an allowed name can resolve to a private address, including a service on your Mac or network. A bad entry opens nothing and shows what’s wrong. A named host is trusted with scripts and frames, not only with data: its scripts run in the page, and a page of its that the dashboard frames can load from anywhere. Those hosts, and whatever their framed pages load, see the requests and your IP address. Agent HTML messages and the Inbox can’t name hosts; pictures there come only through the Inbox fetch above.

What isn’t covered yet:

- A page can navigate its own frame to another site, with a script or with markup alone (`<meta http-equiv="refresh">`), and a script can open a WebRTC connection. Either could reveal your IP address to a host the page chooses, so an HTML message can still tell its sender you opened it.
- DNS prefetch and preconnect hints: a page’s markup can make your Mac look up, or connect to, a host name without loading anything from it.
- A page’s script can ask the app to open a web address in your browser without a click. Your browser then visits it as it would any link.
- You can’t yet override the hosts a dashboard names, and the app’s own window has no content policy of its own: this protection covers the frames that dashboards, panes and messages run in.

## Updates are verified

Every update carries a signature the app checks before it installs.
