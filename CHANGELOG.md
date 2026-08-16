# Changelog

All notable user-visible and contract changes to `grok-plugin-codex`.

## Unreleased → 0.3.0

### Fixed

- **GPC-01 — stop-reason vocabulary (contract).** Completion detection compared `stopReason` against the exact
  strings `"EndTurn"` / `"Cancelled"`, but Grok 1.0.x emits `end_turn` / `cancelled`, so `resultComplete` was
  false for every real run and complete answers were returned as `incomplete_output` with `data: null`.
  Stop reasons are now normalised case- and separator-insensitively (`normalizeStopReason`), and `canceled` is
  accepted alongside `cancelled`. Callers must not string-match the raw value.

### Added

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

### Changed

- `npm run smoke:live-grok` is now a **required** release gate rather than an optional one. It remains outside
  `npm test` and `npm run check`: unit tests never call the real API.
- Error messages and bundled documentation no longer name a single literal stop reason;
  `incomplete_output` now reads "without … a normal end event".
