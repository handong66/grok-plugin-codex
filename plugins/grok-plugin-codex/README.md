# Grok for Codex

This plugin exposes the local Grok CLI to Codex through MCP.

Use it for bounded Grok runs, reviews, rescue analysis, adversarial checks, session list/search, session export, and background job management.

Install from the repository marketplace after building:

```bash
npm install
npm run check
codex plugin marketplace add .
codex plugin add grok-plugin-codex --marketplace grok-plugin-codex
```

Then start a new Codex thread so the MCP tools and `grok` skill are loaded.

The root README is the source of truth for tool behavior, privacy boundaries, and development checks.
