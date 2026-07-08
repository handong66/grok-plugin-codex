# Verification

This repository keeps mandatory checks local and deterministic. Live Grok model calls are optional because they require user authentication, network access, and model availability.

## Required Check

```bash
npm run check
git diff --check
```

`npm run check` runs:

1. TypeScript typecheck.
2. Build of `plugins/grok-plugin-codex/dist/server.js`.
3. Vitest tests.
4. Plugin manifest validation.
5. MCP smoke test.

## Optional Live Smoke

```bash
npm run smoke:live-grok
```

The live smoke calls `grok_run` with:

- prompt: `Reply with exactly: GROK_PLUGIN_CODEX_OK`
- model: `grok-composer-2.5-fast`
- `disableWebSearch: true`
- `noSubagents: true`
- `maxTurns: 1`

It verifies the exact response text.

## Current Verification Ledger

Record fresh command output here before publishing releases.

| Date | Command | Result |
| --- | --- | --- |
| 2026-07-08 | `npm run check` | Passed: build, 28 Vitest tests, plugin validation, MCP smoke with 12 tools. |
| 2026-07-08 | `git diff --check` | Passed. |
| 2026-07-08 | `npm audit --omit=dev` | Passed: found 0 vulnerabilities. |
| 2026-07-08 | `npm pack --dry-run` | Passed: 31 files, including `plugins/grok-plugin-codex/dist/server.js` and public policy docs, excluding runtime job caches. |
| 2026-07-08 | `npm run smoke:live-grok` | Passed: exact `GROK_PLUGIN_CODEX_OK` response. |
| 2026-07-08 | Installed-path MCP preflight from Codex marketplace plugin path | Passed: 12 tools listed; job `jobId` schema pattern present; `grok_check` fast probe passed; `grok_sessions` kept `--help` as query text; foreground `grok_run` returned exact `GROK_INSTALLED_PREFLIGHT_OK`. |
