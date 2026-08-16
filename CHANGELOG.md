# Changelog

All notable user-visible and contract changes to `grok-plugin-codex`.

## Unreleased → 0.3.0

### Fixed

- **GPC-04 — quota exhaustion reported as retryable, or as an auth problem.** The quota patterns matched none
  of the vendor's real texts (the CLI writes `You’ve` with U+2019, so an ASCII-apostrophe pattern never fired),
  and a bare `includes("forbidden")` turned a 403 spending-limit into `auth_required` — 11 of 64 failures
  carried the wrong code and the wrong advice. Quota is now checked before auth and matches the recorded
  strings (`run out of credits`, `spending-limit`, `personal-team-blocked`, `reached your free`,
  `usage limit for now`, `need a grok subscription`, `get supergrok`). **New code `quota_free_tier`** separates
  a free-limit stop (wait, upgrade, or route elsewhere) from `quota_exhausted` (paid balance / 402); both are
  `retryable: false` and carry `error.details.retryAfterHint`. The auth branch now needs positive evidence of a
  sign-in problem — bare `forbidden` / `unauthorized` no longer qualify, so a security review that discusses
  403 handling is not misreported.
- **GPC-04 — classifier input face.** The worker fed up to 1 MB of Grok's own answer to a substring-matching
  classifier. It now passes only stderr plus the text of vendor `error` events (`errorEventText`).

- **GPC-M2 — `grok_continue` dropped the read-only constraint (security).** `grokContinue` never set
  `readOnly`, so a continuation never received `--permission-mode plan --no-subagents`, and because it uses
  the mutable execution shape it also accepted `alwaysApprove`. All 40 recorded continues ran without plan
  mode and two carried `--always-approve`; one of them resumed a real adversarial-review session. A session
  this plugin created for a review, adversarial review, or rescue is now resumed in enforced read-only mode,
  and `alwaysApprove` on such a session is refused with the non-retryable `readonly_session_escalation`
  before any Grok process starts. When the session is unknown to the plugin the call proceeds with a warning
  saying the original mode could not be verified. Job records carry `readOnly` for this lookup.

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

- **GPC-05 — recovery handles on every non-completion.** `grokSessionId` was written only when the caller
  supplied one, so 88 of 128 recorded jobs never had a resume handle: stdout carries `sessionId` only in the
  `end` event, which timed-out and killed runs never emit. When the installed CLI advertises
  `-s, --session-id`, the plugin now generates the session UUID itself, passes it to Grok, and records it
  **before** the worker starts, so the handle exists from t=0 regardless of how the run dies. CLIs without the
  flag keep the old behaviour.
- Every non-complete result carries
  `recovery = { jobId, grokSessionId, partialTextChars, suggested: { tool: "grok_continue", args: { cwd,
  sessionId | continueLatest, maxTurns: 1, prompt } } }` — in `error.details` for a foreground failure and in
  `data.recovery` for `grok_result`. Without a known session id the suggestion degrades to
  `continueLatest: true` and says in a warning that this is ambiguous, rather than omitting the handle.
- `error.details.finalTextRef` names the job whose complete captured text is still readable, so an
  `ok: false` envelope with `data: null` no longer discards an answer that was already paid for.
- Typed failure diagnostics on worker-recorded errors:
  `error.details = { phase, errorName, errorMessage (≤500 chars), errnoCode, stackTail, teardownError }`,
  plus `timeoutMs` on timeouts. Foreground tools merge them into the error envelope. The free-form fields are
  path-redacted before they are persisted — state directory → `<state>`, plugin install directory → `<plugin>`,
  home directory → `<home>` — so the documented promise that public results carry no state-file or command paths
  still holds.
- The worker's own stderr is captured to a private `jobs/<id>.worker.log` (`0600`) instead of being
  discarded, is included in the strict state-directory layout check and in seven-day cleanup, and its
  tail is attached to `worker_unavailable` as `error.details.workerLogTail` (also path-redacted).
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

- **GPC-03a — tool echo no longer pollutes completeness, payload size, or write volume (contract change).**
  84.6 % of the 40.9 MB of recorded Grok stdout was `tool_call_update` echo and 3.16 % was
  `available_commands`, against 3.31 % of actual answer text; one capture held a base64 screenshot. Three
  consequences are fixed:
  - Completeness now keys on **`outputSummary.textTruncated`** — set only when the capture window evicted
    characters that came from `text` events — instead of `outputTruncated`, which any echo overflow could
    set. `outputTruncated` is still reported (with a warning saying only non-answer payload was dropped) but
    no longer disqualifies a finished answer. **Callers must stop treating `outputTruncated === false` as an
    acceptance criterion; use `resultComplete`.**
  - Oversized payloads are elided as they are captured: any string over 2048 characters inside a
    `tool_call*` event becomes `<elided N bytes>` and `available_commands` payloads are dropped. `text`
    events are never rewritten. `GROK_PLUGIN_RAW_CAPTURE=1` keeps the vendor stream verbatim.
  - Log flushing appends the delta instead of rewriting both whole files every 25 ms; a full rewrite happens
    only when the bounded window evicts, and once at the end.
- **GPC-03a — `grok_result` raw tails are opt-in (contract change).** `stdoutTail` and `stderrTail` were
  30–40 k characters of per-token JSON duplicating `finalText` on every one of 656 recorded calls. They are
  now returned only with `includeRawTail: true`.

- **GPC-M1 — `background` default (contract change).** `background` had no default and an omitted flag meant
  *foreground*, so an MCP call could block for the full `timeoutMs` default of 600 000 ms; 65 % of observed
  execution calls never made that choice. `background` now defaults to **`true`** for `grok_run`,
  `grok_review`, `grok_adversarial_review`, and `grok_rescue`, and to **`false`** for the short `grok_continue`.
  Callers that relied on the implicit foreground behaviour must pass `background: false` explicitly. The
  blocking semantics and the 600 000 ms default are now stated in the parameter's own `.describe()`, and a
  foreground call with `timeoutMs > 120000` returns a warning naming the block.

- **GPC-09 — foreground wait loop.** A blocking `grok_run` / `grok_review` / `grok_adversarial_review` /
  `grok_rescue` / `grok_continue` call polled the expensive result path every 50 ms; each tick re-read up to
  4 MB of logs and re-parsed up to 1 M characters of stream inside the shared MCP server process (about 2,400
  full re-parses for a 120 s job). The loop now polls the cheap `status` path starting at 100 ms with 1.5×
  backoff capped at 2 s, resets to 100 ms on the `queued → running` transition, and parses the stream exactly
  once after the job reaches a terminal state.
- A foreground call now gives up `timeoutMs + 10s` after start and returns the typed, retryable
  `foreground_wait_timeout` with `details.jobId`, instead of blocking forever on a wedged worker. The job is
  untouched and can still be read with `grok_status` / `grok_result`.

- Recovery guidance for `max_turns_reached`, `cancelled_output`, and the cancelled-partial state no longer
  says "narrow the target or increase maxTurns". It now names the recovery that actually worked in the
  recorded window: continue the same session with `maxTurns: 1` and an explicit no-tools instruction.
- A vendor-emitted cancelled stop reason is reported as `cancelled_output`; the plain `cancelled` code is now
  reserved for a job the caller actually cancelled (`cancelRequestedAt` present), and both carry the full
  diagnostic details that the cancelled branch previously dropped.
- `npm run smoke:live-grok` is now a **required** release gate rather than an optional one. It remains outside
  `npm test` and `npm run check`: unit tests never call the real API.
- Error messages and bundled documentation no longer name a single literal stop reason;
  `incomplete_output` now reads "without … a normal end event".
