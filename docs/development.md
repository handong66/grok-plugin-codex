# Development

## Repository layout

- Root package: build, tests, release scripts, policy documents, and marketplace metadata.
- Plugin archive: `plugins/grok-plugin-codex`.
- MCP source: `plugins/grok-plugin-codex/src`.
- Bundles: `plugins/grok-plugin-codex/dist/server.js` and `job-worker.js`.
- Runtime state: private user state directory selected by `GROK_PLUGIN_STATE_DIR`, `XDG_STATE_HOME`, or `~/.local/state`.

Runtime state must never be written into a user workspace.

## Required commands

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

Optional authenticated invocation:

```bash
npm run smoke:live-grok
```

## Contract ownership

- `src/server.ts` owns MCP names and input/output schemas.
- `src/tools.ts` owns workspace validation, command construction, envelopes, and foreground polling behavior.
- `src/job-store.ts` owns private state, owner-checked locks, atomic/monotonic persistence, process-group ownership verification, cancellation markers, cleanup, and public-job sanitization.
- `src/job-worker.ts` owns foreground/background CLI process lifetime, heartbeat, timeout, tree termination, logs, and prompt handoff/cleanup.
- `src/result-parser.ts` owns streaming finality.
- `scripts/smoke-mcp.mjs` and `test/contract-drift.test.ts` lock the published contract.
- Bundled README and skill files explain the installed contract; the root README is developer and release documentation.

Adding, removing, or renaming a tool or argument must change the source schema and its contract test in the same patch. Dong-skills orchestration documentation must not duplicate the low-level schema.

## Command rules

- Foreground and background prompts both use `streaming-json`; the worker removes the staging file before passing the prompt through native `--prompt-file /dev/fd/3`.
- Prompt text never appears in persisted job arguments or process argv.
- Inherited prompt delivery must reach fd3 `finish`; premature close is a typed failure even if Grok prints a syntactically complete response.
- Read-only review/rescue tools force `--permission-mode plan` and `--no-subagents`.
- Mutable runs pass `--always-approve` only when explicitly requested.
- Continuation requires `sessionId` or explicit `continueLatest: true`.
- Discovery uses trusted `GROK_BIN`; there is no per-call executable path.
- Required safety flags are capability-probed from the installed `grok --help` and fail closed when absent.
- Process-tree lifecycle is supported on macOS and Linux; package metadata and runtime checks reject other platforms.

## Background finality

Streaming lines may contain non-JSON diagnostics. The parser accepts JSON events, collects complete text, recognizes structured error events, and requires:

1. process status `succeeded`;
2. non-empty text;
3. an `end` event;
4. no structured stream error;
5. no output truncation.

Only then is `resultComplete` true. Codex still verifies the result against real workspace files.

## Local upgrade loop

Codex caches local plugins by manifest version. During local iteration, update the manifest cachebuster with the `plugin-creator` helper when available, keep that single `+codex.<cachebuster>` suffix in the source manifest while the local marketplace points at the working repository, reinstall from the confirmed local marketplace, and start a new Codex task. The package and MCP server continue to advertise the base release version. Do not hand-edit Codex cache contents.

Codex Desktop may retain its process-level MCP registry after a reinstall even when a newly created task can already see the updated skill. If `codex mcp list` shows the new enabled server but a new Desktop task cannot discover its tools, restart Codex Desktop and create another task before diagnosing the plugin server. A genuinely fresh Codex CLI process is a useful read-only control.
