# Changelog

All notable user-visible and contract changes to `grok-plugin-codex`.

## Unreleased → 0.3.0

### Fixed

- **GPC-01 — stop-reason vocabulary (contract).** Completion detection compared `stopReason` against the exact
  strings `"EndTurn"` / `"Cancelled"`, but Grok 1.0.x emits `end_turn` / `cancelled`, so `resultComplete` was
  false for every real run and complete answers were returned as `incomplete_output` with `data: null`.
  Stop reasons are now normalised case- and separator-insensitively (`normalizeStopReason`), and `canceled` is
  accepted alongside `cancelled`. Callers must not string-match the raw value.

- **GPC-02 — timeouts misreported as `worker_error`.** Every recorded wall-clock timeout that failed
  during teardown (killing the launcher tree, awaiting stream close, flushing logs) skipped the
  classification path and was stored as `worker_error` with `exitCode: null` and `signal: null` — 29 of
  64 failures. Teardown now runs in its own `try`/`catch`, so the normal classification always runs, and
  a teardown exception is reported as `error.details.teardownError` instead of replacing the outcome.
  If a later step still throws, the worker classifies from its own scope: `timedOut` → `timeout`
  (`Grok exceeded timeoutMs=<n> (teardown failed).`), `cancelRequested` → `cancelled`, otherwise
  `worker_error`.

### Added

- Typed failure diagnostics on worker-recorded errors:
  `error.details = { phase, errorName, errorMessage (≤500 chars), errnoCode, stackTail, teardownError }`,
  plus `timeoutMs` on timeouts. Foreground tools merge them into the error envelope.
- The worker's own stderr is captured to a private `jobs/<id>.worker.log` (`0600`) instead of being
  discarded, is included in the strict state-directory layout check and in seven-day cleanup, and its
  tail is attached to `worker_unavailable` as `error.details.workerLogTail`.
- `sessionIdFromStderr` (§D M8): when stdout carries no `end` event — exactly the timed-out and killed
  runs — the session id is recovered from Grok's `session_id=<uuid>` stderr line, so
  `outputSummary.grokSessionId` is populated where it was previously always undefined.
- `outputSummary.stopReasonNormalized` (the compared form; raw `stopReason` is unchanged), and
  `outputSummary.stopReasonRecognised`.
- `outputSummary.warnings`, surfaced in the `warnings` array of `grok_run` / `grok_continue` / `grok_review` /
  `grok_adversarial_review` / `grok_rescue` / `grok_result` envelopes.
- Unrecognised stop reasons now **fail open**: a stream that ended with non-empty, untruncated text is reported
  complete with `stopReasonRecognised: false` and the warning
  `unrecognised stopReason "<raw>"; treated as normal completion`. Callers needing strict vocabulary matching can
  still reject on that flag.
- `grok_check` accepts `probeInvocation: true` (default **false**) plus an optional `model`. When enabled it makes
  one bounded live call (`--permission-mode plan --no-subagents --max-turns 1`, 30s cap, fixed prompt delivered
  through a private `0600` prompt file) and reports `modelInvocationTested`, `callable`, `observedStopReason`,
  `observedStopReasonNormalized`, and `observedEventTypes`. It spends real quota, so it must stay opt-in.
  The probe passes through the same fail-closed capability gate as a read-only run: if the installed CLI does not
  advertise `--prompt-file`, `streaming-json`, `--permission-mode plan`, and `--no-subagents`, `grok_check` returns
  `cli_incompatible` with the missing flags and makes no live call at all.

### Changed

- `npm run smoke:live-grok` is now a **required** release gate rather than an optional one. It remains outside
  `npm test` and `npm run check`: unit tests never call the real API.
- Error messages and bundled documentation no longer name a single literal stop reason;
  `incomplete_output` now reads "without … a normal end event".
