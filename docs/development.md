# Development

## Repository Layout

- Root package: Node/TypeScript build, tests, scripts, docs, license, and marketplace metadata.
- Plugin package: `plugins/grok-plugin-codex`.
- MCP server source: `plugins/grok-plugin-codex/src`.
- Bundled server: `plugins/grok-plugin-codex/dist/server.js`.
- Runtime job logs: `.grok-plugin-codex/jobs`, ignored by git and npm packaging.
- OpenCode review cache: `.opencode-plugin-codex/`, ignored by git and npm packaging.

## Commands

```bash
npm install
npm run typecheck
npm run build
npm test
npm run validate:plugin
npm run smoke:mcp
npm run check
git diff --check
```

Optional authenticated live smoke:

```bash
npm run smoke:live-grok
```

## Tool Governance

When changing tool behavior, update all of these together:

- `README.md`
- `plugins/grok-plugin-codex/README.md`
- `plugins/grok-plugin-codex/skills/grok/SKILL.md`
- `plugins/grok-plugin-codex/src/tools.ts`
- `plugins/grok-plugin-codex/src/job-store.ts`
- `plugins/grok-plugin-codex/src/grok-cli.ts`
- `plugins/grok-plugin-codex/src/server.ts`
- `scripts/smoke-mcp.mjs`
- Relevant tests under `test/`

## Command Construction Rules

- Foreground runs use `--output-format json`.
- Background runs use `--output-format streaming-json`.
- Prompts are passed with `-p <prompt>` and are never treated as file paths.
- `alwaysApprove` is only passed when explicitly true.
- `continueLatest` must be explicit before using `--continue`.
- `reasoningEffort` is not passed for `grok-composer-2.5-fast` or when the model is omitted.

## Background Output Contract

Grok streaming output can include non-JSON warning/log lines. The parser skips those lines and reads JSON events shaped like:

```json
{"type":"thought","data":"..."}
{"type":"text","data":"..."}
{"type":"end","stopReason":"EndTurn","sessionId":"...","requestId":"..."}
```

A background job is complete only when:

1. The process status is `succeeded`.
2. At least one `text` event exists.
3. An `end` event exists.

Codex must still verify Grok's result against the workspace before acting on it.
