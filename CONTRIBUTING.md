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
- Keep job state in the plugin-owned private user-state directory; never write runtime state into a user workspace.
- Preserve the macOS/Linux process-tree lifecycle contract, monotonic terminal records, and prompt cleanup when changing worker behavior.
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

## Release cadence and mirroring

Correctness fixes must reach the public repository in the same working session that lands them
privately. 0.2.1 was merged privately on 2026-07-11 and installed locally the same day, but the public
repository did not receive it until 2026-08-15 — for five weeks anyone installing from the public
marketplace got 0.2.0, the version that reported a vendor `Cancelled` stop reason as a completed
result. A fix that only exists privately does not protect anyone.

- Land the fix, then mirror the branch publicly before the session ends.
- Tag and release from the public repository, never from a local-only manifest.
- Release commits must carry a clean semver version: `npm run validate:plugin` fails a release build
  whose `plugin.json` still has the local `+codex.<cachebuster>` suffix. Set `GROK_PLUGIN_RELEASE=1`
  when validating a release candidate.
