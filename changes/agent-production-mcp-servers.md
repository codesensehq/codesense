---
type: added
---

**Production MCP servers per agent.** An agent's new `mcp.production` declares remote HTTPS MCP servers that only that agent reaches, read-only by default. The declaration holds header names, never values: a person binds the credential to that one agent in the app, and the server stays pending until then. macOS only.
