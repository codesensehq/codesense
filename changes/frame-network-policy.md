---
type: privacy
---

**Frame network policy.** Dashboards, panes and HTML messages block outside loads unless the dashboard or pane declares the host in `allowed_hosts`. Blocked loads and asset load failures appear separately in the page's problems without immediately failing a pane. A pane that never becomes live still fails at its startup deadline; uncaught runtime errors keep their immediate startup failure behavior, and Inbox pictures wait for your tap by default. Self-navigation, DNS hints, WebRTC and browser handoff remain possible.
