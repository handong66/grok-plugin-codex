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
- `src/job-worker.ts` owns foreground/background CLI process lifetime, heartbeat, timeout, tree termination, logs, prompt handoff/cleanup, and terminal classification.
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
- A continuation inherits the read-only mode of the session's creating job; `continueLatest` infers that job from
  the newest session this plugin started in the same `cwd`. The inference may only tighten permissions: it refuses
  `alwaysApprove` (`readonly_session_escalation`, `details.inferredFromLatestJob`) and inherits plan mode, but it
  never removes the "could not be verified" warning, which every inferred target keeps. SKILL.md and the
  `grok_continue` description must state that rule and the explicit-`sessionId` escape hatch.
- Discovery uses trusted `GROK_BIN`; there is no per-call executable path.
- Required safety flags are capability-probed from the installed `grok --help` and fail closed when absent.
- `missingRunCapabilities` is that gate and has one caller list: every path that starts a real Grok process, including
  the opt-in `grok_check` invocation probe. A CLI missing the read-only flags gets `cli_incompatible`, never a live call.
- Process-tree lifecycle is supported on macOS and Linux; package metadata and runtime checks reject other platforms.

## Background finality

Streaming lines may contain non-JSON diagnostics. The parser accepts JSON events, collects complete text, recognizes structured error events, and requires:

1. process status `succeeded`;
2. non-empty text;
3. an `end` event whose normalised stop reason is not a cancellation;
4. no structured stream error;
5. no *text* truncation: `record.textTruncated`, set only when the capture window evicted characters
   that came from `text` events. `outputTruncated` alone — the shared window overflowing, which is
   normally the 84.6 % of a stream that is tool echo — only adds a warning and cannot veto a result;
6. for `kind: review` and `kind: adversarial_review`, at least one tool call. A verdict with
   `toolCallCount === 0` inspected nothing, so it is reported as `no_evidence_review` with
   `evidenceLevel: "none"` and never as a completed review (X2).

`normalizeStopReason` lowercases the raw value and strips every non-letter, so `EndTurn`, `end_turn`, and `END-TURN` are one fact; `cancelled` and `canceled` are accepted spellings of the other. An unrecognised stop reason on a stream that ended with non-empty text fails **open**: the result is complete, `stopReasonRecognised` is false, and `outputSummary.warnings` names the raw value. The exact-match rule that shipped in 0.2.1 is what made every real Grok 1.0.x completion look incomplete.

Only then is `resultComplete` true. Codex still verifies the result against real workspace files.

An end event whose normalised stop reason is a cancellation remains `cancelled_partial` and foreground tools return `cancelled_output`; a vendor `cancelled` stop reason is stored as a `cancelled` job, never as `succeeded`. A `max_turns_reached` stream event is a typed retryable failure. The remedy the runtime prints (`CONTINUE_WITHOUT_TOOLS_REMEDY`) is to continue the same session with `maxTurns: 1` and a prompt to stop using tools and emit the final answer — not to narrow the target or raise `maxTurns` — and it is reachable as the `recovery.suggested` call on every non-complete envelope. Both paths retain the Grok session ID, request ID, stop reason, bounded stderr, and partial text for diagnosis or continuation. Guidance text lives in `grok-cli.ts` / `result-parser.ts`; the READMEs and `skills/grok/SKILL.md` must not tell a caller something the error message contradicts.

## Failure classification

Process teardown after the Grok CLI exits — killing the launcher tree, awaiting prompt delivery and
stream close, flushing logs — is wrapped in its own `try`/`catch`. A teardown exception is recorded as
`error.details.teardownError` and never replaces the outcome, because the normal path is the only place
that knows the run hit its wall clock. Skipping it is what turned 29 recorded timeouts into
`worker_error` with `exitCode: null` and `signal: null`.

If something still throws, the worker classifies from its own scope flags rather than defaulting:
`timedOut` gives `timeout` (message ends `(teardown failed).`), `cancelRequested` gives `cancelled`,
and only an otherwise unexplained failure stays `worker_error`. Every one of those carries
`details: { phase, errorName, errorMessage, errnoCode, stackTail, teardownError }`, bounded to 500 and
1,000 characters.

The worker's own stderr goes to `<id>.worker.log` (`0600`) instead of `/dev/null`, so a worker that dies
outright still leaves evidence; `JobStore.status()` attaches its tail to `worker_unavailable`. The file
is in the strict pre-marker layout allowlist and in `cleanupExpiredJobs` — a new artifact name missing
from either would make `ensure()` reject a real state directory.

These diagnostics are OS text that `toPublicJob` copies straight into public envelopes, so every
free-form field (`errorMessage`, `stackTail`, `teardownError`, `workerLogTail`) passes through
`JobStore.redactDiagnostics` (`src/redact.ts`) **before it is persisted**: the state directory becomes
`<state>`, the install directory `<plugin>`, the home directory `<home>`. Any new free-form diagnostic
field must go through the same redactor, or docs/privacy.md stops being true.

`outputSummary.filesInspected` is such a field: the paths in it are chosen by Grok, and the recorded
delegates opened `~/.grok/skills/pua/SKILL.md`, so `summarizeGrokOutput` takes a `PathRedactor` and
applies it as each path is collected. `JobStore.result()` and the worker pass their store's redactor;
a direct parser caller gets the home-directory fallback (`defaultDiagnosticRedactor`). `skillsLoaded`
needs no redaction because it stores the extracted skill name, not the path it came from.

That redactor is wrapped in `exemptWorkspacePaths(redact, record.cwd)` first, so a path inside the job's
own workspace is returned verbatim. Without it, `<home>` rewrites the caller's files as soon as the
workspace sits under the home directory — the normal layout — and `filesInspected` stops being usable as
the evidence record it exists to be. The exemption matches a whole-path prefix and is therefore only for
collected path values, never for free-form prose; the free-form diagnostics keep the unwrapped redactor.

## Local upgrade loop

Codex caches local plugins by manifest version. During local iteration, update the manifest cachebuster with the `plugin-creator` helper when available, keep that single `+codex.<cachebuster>` suffix in the source manifest while the local marketplace points at the working repository, reinstall from the confirmed local marketplace, and start a new Codex task. The package and MCP server continue to advertise the base release version. Do not hand-edit Codex cache contents.

Codex Desktop may retain its process-level MCP registry after a reinstall even when a newly created task can already see the updated skill. If `codex mcp list` shows the new enabled server but a new Desktop task cannot discover its tools, restart Codex Desktop and create another task before diagnosing the plugin server. A genuinely fresh Codex CLI process is a useful read-only control.
