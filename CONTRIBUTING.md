# Contributing

Thanks for improving `grok-plugin-codex`.

## Development Setup

```bash
npm install
npm run check
git diff --check
```

`npm run check` builds the bundled MCP server, runs tests, validates plugin metadata, and runs the MCP smoke test.

Optional live verification requires an installed and authenticated Grok CLI:

```bash
npm run smoke:live-grok
```

## Change Guidelines

- Keep tool behavior, docs, tests, and MCP smoke coverage aligned.
- Do not copy Codex hidden context, system/developer messages, tool outputs, hidden reasoning, secrets, or private runtime paths into prompts.
- Keep background job records inside `.grok-plugin-codex/jobs`.
- Treat partial Grok output as partial evidence, not as a finished review or implementation result.
- Add or update tests for behavior changes.

## Pull Requests

Before opening a pull request, run:

```bash
npm run check
npm audit --omit=dev
npm pack --dry-run
git diff --check
```

Include a short summary of what changed, why it changed, and which checks passed.
