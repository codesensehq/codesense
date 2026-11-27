---
type: changed
---

**The team starter page is now the team landing page.** The file menus, the nav mark, Settings → Teams and the toasts call the page a team opens by default its landing page, so "starter" means only a group's starter. The new `set_team_landing_page` MCP tool sets it and replies with `landingPage`; `set_team_starter_page` still works as an alias, keeps its `starterPage` reply key, and its `ok` reply says it is an alias.
