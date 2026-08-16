# Changelog

All notable user-visible and contract changes to `grok-plugin-codex`.

## 0.3.0 — 2026-08-16

Contract changes in this release: `background` defaults to `true` for dispatch tools; `timeoutMs`
defaults per kind instead of `600000`; `grok_result` omits raw log tails unless `includeRawTail: true`;
`grok_review` / `grok_adversarial_review` / `grok_rescue` require `cwd` only, with the target passed as
`target`/`problem` or the sibling spelling `prompt`; `grok_check` reports `authenticated` / `entitled`
as `true` / `false` / `"unknown"` rather than `null`; new tool `grok_finalize`; new codes
`quota_free_tier`, `no_evidence_review`, `permission_denied_headless`, `readonly_session_escalation`,
`foreground_wait_timeout`, `model_tool_incompatible`, `target_required`, `finalize_target_unknown`;
`workspace_unavailable` is now retryable; the recovery handle's `suggested.tool` is `grok_finalize`
(the `grok_continue` spelling moved to `recovery.fallback`); `grok_models`' `parsed.loggedIn` is
`true` / `false` / `"unknown"`; `grok_check` / `grok_models` / `grok_sessions` / `grok_export` report
`retryable` from the failure classifier instead of always `true`.

### Fixed

- **X1 — a plan-mode permission verdict on a run that was never in plan mode.**
  `outputSummary.shellApprovalBlocked` only checked that a cancelled turn's last tool activity looked
  like a shell command, never that the job actually ran under enforced `--permission-mode plan`. A
  mutable `grok_run` that used `run_terminal_command` successfully and then ended with a vendor
  `cancelled` stop reason was therefore reported as `permission_denied_headless` (non-retryable) with
  the plan-mode remedy — the inverse of what GK5 exists for. The flag now requires a read-only job
  (`record.readOnly`, or the kind for records written before 0.3.0), and the bare last-tool-name guess
  is used only when the stream carried no parsable denial at all.
- **X2 — the two evidence codes were unreachable on the default path.** `permission_denied_headless`
  and `no_evidence_review` were raised only inside the foreground wait branch, while
  `review` / `adversarial_review` / `rescue` now default to `background: true`. The worker stored a
  refused-shell run as a bare `cancelled` job with no `error` at all, so a default `grok_review` gave
  callers nothing to branch on. Both classifications are now written onto the job record, so
  `grok_status` and `grok_result` expose `job.error.code` on the background path as well.
- **X3 / X4 — a learned Grok session id never reached the job record.** `record.grokSessionId` was
  written only when the plugin could assign it up front (`--session-id`); an id learned from the `end`
  event or from the `session_id=` the CLI prints to stderr stayed in the stream summary. So
  `grok_finalize(jobId)` — the recovery every partial-result message names — threw
  `finalize_target_unknown`, and `findSessionOrigin` resolved such a read-only session to "unknown",
  which let `alwaysApprove` through with only a warning. The worker now persists the learned id at
  completion (SPEC §D M8), and both lookups fall back to the stream summary for older records.
- **X5 — a tool error classified as a missing session.** `classifyGrokErrorText` matched the bare
  substring `session` plus `not found` / `does not exist`, and the recorded tool-error line is
  `ERROR tool_error: tool_output_error session_id=<uuid> tool_name="Read" …`. A failed `Read` whose
  payload also said a path does not exist became a non-retryable `session_not_found` — and could drive
  `grok_continue`'s `fallbackToLatest` onto an unrelated session. `tool_output_error` is now classified
  first, and the session rule matches bounded phrases (`session … not found`, `does not exist`,
  `failed to restore session`) instead of the bare word.
- **X6 — the machine-readable recovery handle contradicted the published recovery contract.**
  `recovery.suggested` named `grok_continue` with the prompt "…give the final answer now, under 400
  words", while `grok_check.data.contract.recoveryTool`, `CONTINUE_WITHOUT_TOOLS_REMEDY` and every
  typed timeout / max-turns / cancelled message name `grok_finalize` and promise a *complete* answer.
  A caller that executed the handle therefore skipped `grok_finalize` and asked Grok to truncate.
  `suggested` now names `grok_finalize`; the literal `grok_continue` shape survives as
  `recovery.fallback` with `maxTurns: 1` and the `grok_finalize` prompt, and the word cap is gone.
- **X7 — discovery failures still advertised retry.** `grok_check`, `grok_models`, `grok_sessions` and
  `grok_export` passed a hard-coded `retryable: true` for whatever the classifier returned, so a
  caller obeying the flag looped `grok models` against a logged-out or quota-exhausted CLI — the exact
  advice GPC-04 removed from the execution path. All four now report `isRetryableGrokFailure(code)`.
- **X8 — a silent model listing published as "not authenticated".** `parseModelsOutput` returned a
  two-state `loggedIn = hasPositive && !hasNegative`, and `grok_check` wrote it straight into
  `authenticated`; a successful listing that never mentions login was therefore published as `false`,
  which a gate decision reads as a negative. The fact is now three-state (SPEC §B GK1 item 3):
  positive evidence → `true`, an explicit negative → `false`, silence → `"unknown"`. Only positive
  evidence still counts as signed in.
- **X9 — a failed continuation shadowed the real latest session.** `findLatestSessionOrigin` did not
  filter by outcome, so a `grok_continue` that died with `session_not_found` still carried the id it
  had asked for and the newest timestamp. Because a `continue` job can never be an origin, the lookup
  then returned nothing and `continueLatest` + `alwaysApprove` fell into the "this plugin started no
  session here" branch — a warning only — while the genuinely latest read-only session was resumed
  unguarded. Such records are now skipped, and the newest id that actually resolves to an origin wins.

- **GPC-06 — read-only prompts never said shell execution was unavailable.** All three enforced
  read-only prompts run under `--permission-mode plan --no-subagents`, which auto-refuses shell
  execution; 24 of the 56 recorded plan-mode jobs each carry one
  `User cancelled the execution for tool run_terminal_command`, and one continuation reported
  `Verdict: FAIL` for a diff it had never been allowed to load. `grok_review`,
  `grok_adversarial_review`, and `grok_rescue` now open with an explicit notice that only
  `read_file`, `grep`, and `list_dir` are available, that `run_terminal_command` must not be called,
  and that missing command output must be requested rather than guessed or failed. Refusals are
  counted in the new **`outputSummary.deniedToolCalls: { name, count }[]`**, raise a warning, and
  replace the guidance with "inline the required command output into the target".
- **GK5 — `cancelled_output` blamed the target width for a permission refusal.** A run that ends
  `Cancelled` right after a shell command was auto-refused in plan mode (13 recorded
  `cancelled_output`) now returns the new non-retryable code **`permission_denied_headless`**, whose
  message says the turn was cancelled because a shell command needed approval in plan mode and that
  the remedy is to inline the command output or continue with "do not use tools". Narrowing the
  target never addressed this shape.

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
  saying the original mode could not be verified. Job records carry `readOnly` for this lookup; a record
  written before that field existed (the retained 0.2.x jobs are exactly the ones holding session ids today)
  is read as read-only when its `kind` is `review`, `adversarial_review`, or `rescue`. `continueLatest: true`
  names no session and so skipped the lookup entirely; it now resolves the newest session this plugin started
  in the same workspace and fails closed on it — `alwaysApprove` is refused with
  `error.details.inferredFromLatestJob: true`, and the inherited plan mode says in a warning that an explicit
  `sessionId` is the way to continue a different session. That inference can only tighten permissions, never
  certify them: **every** `continueLatest` call keeps a warning saying the resumed session could not be
  verified, including the case where the newest session here was mutable, because `--continue` may resume a
  session this plugin never created. A session known only from continuations likewise stays "unverified"
  rather than becoming "known mutable".

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
  (with `details.teardownFailed: true` and `details.phase: "worker"`), `cancelRequested` → `cancelled`,
  otherwise `worker_error`. Both timeout paths carry the shared `timeout` remedy as their message —
  the budget stays machine-readable in `details.timeoutMs`.

### Added

- **X9 — the same rules were re-read 175 times.** Codex opened the bundled `SKILL.md` 175 times across
  58 sessions to recover the same facts. `grok_check` now returns them as `data.contract`: the
  per-kind `background` and `timeoutMs` defaults, that there is no `maxTurns` default, what counts as a
  complete answer, that a zero-tool-call review is `no_evidence_review`, which kinds are read-only and
  that shell execution is disabled in them, and that `grok_finalize` is the recovery. `contractVersion`
  is `3`. The bundled skill keeps only contract facts; orchestration rhythm lives in the tool
  descriptions and the README.

- **X8 / X7 — no CI, undated verification, cancel-too-early.** The repository had no `.github` at all:
  every gate ran on the author's macOS machine, while the 0.2 audit asked for a macOS/Linux matrix and
  the user's expectation was "push, open a PR, wait for CI". `pull-request-ci.yml` now runs
  `npm run check` on `ubuntu-latest` and `macos-latest` and fails if the committed bundles differ from
  a fresh build. `docs/verification.md` now keeps two dated records per release and requires both: an
  offline line for `npm run check`, and a live line naming the Grok CLI version `npm run smoke:live-grok`
  ran against. Neither substitutes for the other, and the live line for 0.3.0 is still open — the offline
  gate observes no CLI, so it cannot answer "does this work with that CLI".
  Both records are now machine-checked rather than merely stated: `npm run validate:plugin` requires a
  dated record of each kind for the version in `package.json`, and with `GROK_PLUGIN_RELEASE=1` it fails
  while the live record is missing, undated, still "not run", or naming no `Grok CLI <x.y.z>`. **0.3.0
  therefore cannot be published as it stands** — the branch is mergeable, and the release build stays red
  until the live smoke has run and its record replaces the open one. `npm run smoke:live-grok` prints the
  record to paste on success.
  Tool descriptions state the typical wall time per kind (continue ~62 s, run ~129 s,
  review ~171 s, adversarial_review ~223 s median) and say not to cancel before `timeoutMs` unless
  `waitingForAuth` is set or the event counters have not moved for 45 s — 26 of 43 recorded cancels
  fired before the median completion time. `outputSummary.guidance` on an in-flight job carries the
  same rule; it used to say "cancel and rerun with a narrower target", which is the behaviour X7
  exists to stop, and it is the field a caller reading the envelope actually sees.

- **GPC-10 / GK1(3) / X10 — `grok_check` was unavailable when it was needed and reported facts it had
  not established.** `workspace_unavailable` used to kill the diagnostic itself: recorded once, with
  the caller reading the plugin's source to understand the message. `grok_check` and `grok_models` now
  degrade — with an explicit `cwd` and no workspace roots they run without the boundary check and warn
  — while every execution and session tool keeps failing closed. `authenticated` and the new
  **`entitled`** are `true`, `false`, or the string **`"unknown"`**, never `null`, because a recorded
  gate decision read `null` as "not authenticated" and let the next job start anyway; `entitled: false`
  separates "logged in but out of quota" from "not logged in". `pluginVersion` is injected from
  package.json at build time instead of being a `"0.2.1"` literal, and `validate:plugin` fails a
  source that hard-codes a version. A requested `model` missing from the CLI's own list now warns. The
  check also warns when a 0.1-era `.grok-plugin-codex/` or `.opencode-plugin-codex/` directory is still
  sitting in the workspace, without touching it (X10).

- **X3 — an adversarial review interrupted the user's own task.** Attack-framed review prose tripped
  the host's cybersecurity filter mid-run; the user's response that evening was "I am building a film
  system for local use, so network security does not apply. Please stop interrupting my task."
  `grok_adversarial_review` accepts **`threatModel`** (the operating scope to judge against), states it
  in the prompt, and requires every finding to be labelled in-model or out-of-model, with out-of-model
  findings advisory only — never a blocker, never NO_GO. When no scope is given the prompt says so
  rather than inventing one. The prompt asks for neutral engineering vocabulary (failure mode,
  breakage path, robustness gap) instead of attack narrative.

- **GK9(a) — `tool_output_error` was unclassified.** A recorded run with `grok-composer-2.5-fast`
  failed because the model could not consume its own `Read` output; it landed in the generic bucket.
  New code **`model_tool_incompatible`** (non-retryable) says so and says to rerun with a full model,
  and selecting a fast composer model for read-only repository work now warns up front.
- **GK9(c) — model capabilities are derived, not hard-coded.** The `--reasoning-effort` exclusion was
  the literal `grok-composer-2.5-fast`. It is now derived from `grok models` (cached per CLI version),
  with the literal only as the fallback for a CLI that cannot be asked. A model the installed CLI does
  not list now warns before the run instead of failing at the provider (GPC-10.5).
- **GK9(d) — cancel had one shape for two outcomes.** `grok_cancel` returns
  **`data.outcome: "cancel_requested" | "already_terminal"`**, so a caller can tell a real
  cancellation from a job that had already finished. Unexpected internal failures keep the generic
  `internal_error` message but now carry `error.details.cause` and `errnoCode` — the failure class,
  never a path or a message. Signalling an owned process tree now treats `EPERM` exactly like
  `ESRCH`: when the group has been reaped or is no longer ours to signal there is nothing left to
  kill, so a successful cancel no longer escapes as a retryable `internal_error` (the recorded
  intermittent failure of the cross-process cancel test). Any other `kill` errno still surfaces.
- **GK9(e) — release cadence.** CONTRIBUTING and SECURITY now state that correctness fixes must be
  mirrored publicly in the session that lands them (0.2.1 was private for five weeks while the public
  marketplace served 0.2.0, which reported a cancelled run as complete). `npm run validate:plugin`
  with `GROK_PLUGIN_RELEASE=1` fails a release build whose manifest still carries `+codex.` (X8).

- **GK6 — `private_path_blocked` did not say what matched, or what to do instead.** Three recorded
  refusals each forced a full rewrite of the target. `error.details.blockedPath` now names the matched
  path (only the path — never the surrounding prompt), and the message points at `~/.grok/skills` as
  the Grok-native alternative, matching the remedy the sibling opencode plugin already gave.
- **GK7 — `workspace_unavailable` was non-retryable, and retrying fixed it.** Codex supplies workspace
  roots per turn; a turn without them failed every workspace tool as a permanent error, and the
  recorded incident shows the identical call succeeding moments later — after the caller had gone
  round the plugin and run the CLI directly. It is now **`retryable: true`**, its message says the
  roots arrive per turn and that the fix is to retry (restart the server only if it persists), and
  `error.details` carries `listRootsSupported`, `listRootsCount`, `codexMetaRootsCount`,
  `requestedCwd`. The server also remembers the last non-empty root set in-process and reuses it for a
  turn that carries none, with a warning; installing a new roots provider clears it.
- **GK8 — `session_not_found` had no fallback.** `grok_continue` accepts **`fallbackToLatest`**, which
  retries once against the latest session in the same `cwd` and warns that the answer may belong to
  other work (foreground only — a background start returns before the failure exists). The failure's
  `error.details.candidateSessions` now lists the sessions this plugin started in that workspace,
  newest first, instead of telling the caller to go and list sessions.

- **GPC-11 — sibling-plugin field name accepted (contract).** The recorded schema failure was
  `expected string, received undefined`: the field was missing, because one script fanned the same
  review out to two sibling plugins and used the opencode plugin's name, `prompt`, for both.
  `grok_review` and `grok_adversarial_review` now accept **`target` or `prompt`**, and `grok_rescue`
  **`problem` or `prompt`** — exactly one, enforced in the handler as the typed `target_required`
  (both fields are optional in the schema, so `cwd` is now the only required field on those three
  tools). A string array is joined into a bulleted block, with the length limit applied after the
  join. Both descriptions name the sibling plugin's spelling.
- **GK9(b) — `Review ` was prefixed unconditionally.** A target that already began with "Review"
  produced `Review Review the current working tree diff…`. The three read-only prompts now end with a
  `Target:` / `Problem:` block, the same shape `grok_adversarial_review` already used.

- **GK4 — `grok_finalize`, the recovery that worked, as one call.** "Stop using tools and answer now"
  was the most effective recovery in the recorded window (21 of 26 `--max-turns 1|2` jobs succeeded,
  none hit the turn limit), yet 71 of 196 observed `grok_continue` prompts reinvented it in their own
  words. The new **`grok_finalize`** tool resumes the session behind a `jobId` (or an explicit
  `sessionId`, or the latest session in `cwd`) with `maxTurns: 1` and a fixed prompt: stop using tools,
  emit the complete answer now, mark anything unverified as `UNVERIFIED`. It inherits the read-only
  mode of the session it resumes. Every partial-result message — `timeout`, `terminated`,
  `max_turns_reached`, `cancelled_output` — now names it, and so does the other human-readable field
  of the same envelope: `outputSummary.guidance` for a `timeout`, `terminated` or `max_turns_reached`
  job is now exactly the typed error's remedy, instead of falling through to a generic failed branch
  that said "rerun with a narrower prompt". A wall-clock timeout is the largest recorded failure
  class (29 of 64), and it emits no stream event at all, so its guidance is derived from the stored
  `error.code`. The remaining generic failure text no longer suggests narrowing either: it points at
  `error.code` / `error.details` and the recovery handle.

- **GPC-08 / GK3 / SPEC §D M3 — the budget is now stated to the delegate, and defaults per kind.**
  A turn or wall-clock limit with no answer used to be a total loss; plugin-built prompts
  (`grok_review`, `grok_adversarial_review`, `grok_rescue`) now tell Grok its turn budget and its
  wall-clock budget, and instruct it to stop calling tools and emit a complete answer — naming what it
  could not inspect — before the budget runs out. Every envelope echoes **`effectiveTimeoutMs`** and
  **`effectiveMaxTurns`**. **Omitted `timeoutMs` now defaults per kind** (run/continue `180000`,
  review/rescue `240000`, adversarial_review `300000`) instead of a single `600000`: the original
  rejection rested on a one-week sample of persisted jobs, while across the whole window 466 of 655
  execution calls (71 %) reached the default. **Explicit values are never clamped, in either
  direction**, and there is no `maxTurns` floor — `maxTurns` 1-2 is a deliberate answer-immediately
  technique with 21 of 26 recorded successes. Two warn-only checks were added: `timeoutMs` under
  `30000` quotes the observed cost of a success (median 31 s, p90 111 s, max 402 s), and `maxTurns >= 3`
  with a target over 8 000 characters warns that the exploration is unlikely to converge.

- **GPC-03b — final-text ledger and a result path that does not re-parse.** `JobStore.result()` read
  up to 4 MB of raw stream and re-parsed up to 1 M characters on every call, 656 times in the recorded
  window, to rebuild the 3.31 % of the stream that is answer text. The worker now records the answer
  into `<id>.final.txt` (`0600`, append-only) and the stream facts into `<id>.summary.json` — event
  counts, session/request id, stop reason, `sawEnd`, `textChars`, `lastEventAt`, tool-call count,
  `filesInspected`, `skillsLoaded`, `deniedToolCalls`, `turnsUsed` — as the stream arrives, using the
  same per-line observer as the fallback parse, so ledger and re-parse cannot drift. `result()` reads
  the ledger; a record written before 0.3.0, or an answer past the 4 M-character ledger ceiling, still
  falls back to the full re-parse. A failed append to `<id>.final.txt` re-queues the delta it had
  already consumed and marks the ledger untrusted (`ledgerWriteFailed`), so the same re-parse answers
  instead of a file that is short a chunk; a write error can no longer shorten an answer that is still
  reported as complete. Both new artifacts are in the strict pre-marker layout allowlist and in
  `cleanupExpiredJobs`.

- **GPC-07 — status could not say how far a run had got, and result could not be paged.**
  `toPublicJob` carried lifecycle fields only, so 730 recorded `grok_status` calls were followed by
  656 expensive `grok_result` calls just to learn something. `grok_status` now returns
  **`textChars`, `eventCounts`, `lastEventAt`, `toolCallCount`, `deniedToolCalls`** and the session id
  from the worker's ledger (one small read, no stream re-parse), and accepts **`waitMs`** (cap
  `30000`) to block server-side until the job is terminal, reporting **`data.waited`**. It shares the
  staleness rules of a plain status call, so a run whose worker is gone can still be reaped by it.
  `grok_result` accepts **`finalTextOffset` / `finalTextMaxChars`** and returns `finalTextChars` plus
  `finalTextNextOffset`; the window applies to `outputSummary.finalText` as well as to `finalText`, so
  a paged call no longer ships the whole answer alongside the page it asked for. (Both fields still
  carry the same window, so an unpaged call still serialises the answer twice; use
  `finalTextMaxChars` when that matters.) The `includeRawTail: false` default is the one shared with
  GPC-03a, implemented once.

- **GPC-M3 — `JobStore.status()` could kill a healthy job.** `status()` terminates the process tree of
  a job whose heartbeat is stale, and both `grok_status` and `grok_result` go through it — up to 20 Hz
  before GPC-09. The threshold was 5 s, about two flush cycles from a busy worker. It is now 10 s, a
  stale reading must be confirmed a second time after a full second, and stream progress observed in
  between vetoes the reap outright. The `grok_status` description now says the tool can reap a job.
  (No `worker_unavailable` was ever recorded, so this is hardening, not a fix.)

- **GK1 — device-authorization hang.** When the CLI's device authorization has expired it prints a sign-in
  URL to stderr and waits for a browser that a headless job can never open, while `grok_status` still said
  `running`; three recorded jobs sat there, one for the full 600 000 ms, during an unattended overnight run.
  The worker now matches `accounts.x.ai/oauth2/device` / `Waiting for authorization` on stderr and, when it
  appears in the first five seconds (before anything can have run), terminates the process tree and records
  the non-retryable `auth_required` with `details.phase: "device_authorization"` instead of burning the
  budget. `job.waitingForAuth` exposes the state on the cheap `grok_status` path, and the one-time
  `user_code` is redacted out of every stderr the plugin returns — the actionable sign-in URL stays.

- **X2 / GK2 — zero-evidence verdicts (contract change).** 30 of 64 `succeeded` Grok jobs made no tool call
  at all: a reviewer that never opened a file, whose "GO" was counted as a vote. `outputSummary` now reports
  `toolCallCount`, `filesInspected`, `turnsUsed`, and a derived `evidenceLevel` of `none` / `thin` /
  `substantive`. For `kind: review` and `kind: adversarial_review`, `toolCallCount === 0` makes
  `resultComplete` false with the warning `verdict produced with 0 tool calls — treat as opinion, not review`,
  and the foreground call returns the new **`no_evidence_review`** code. The answer itself is never destroyed:
  `grok_result` still returns the complete text. Plain `grok_run` is unaffected. `filesInspected` holds paths
  Grok chose rather than the caller — the recorded delegates opened `~/.grok/skills/pua/SKILL.md` — so it goes
  through the same path redactor as the other free-form diagnostics: the state directory reads `<state>`, the
  install directory `<plugin>`, the home directory `<home>`, while files inside the caller's workspace stay
  verbatim — including a workspace that lives under the home directory, which is the normal layout.
- **X2 — a cancelled stop reason is no longer stored as `succeeded`.** 24 of 64 recorded jobs ended with
  `stopReason: cancelled` and were persisted as `succeeded`; the worker now records them as `cancelled`.
- **X2 — review output contract.** `grok_adversarial_review` no longer asks for "at most 5 findings", which
  silently truncated adversarial coverage; it asks for all findings sorted by severity with the first five
  marked primary. Both review prompts now require exact `file:line` evidence per finding and, for a passing
  verdict, an explicit list of what was actually read or run.

- **X1 — headless delegation preamble.** 57 of 128 recorded runs opened `~/.grok/skills/pua/SKILL.md` or a
  Superpowers skill before starting the task, because the repository's own `AGENTS.md` tells every agent to;
  12 of the 18 `max_turns_reached` jobs spent one of their first three reads on a `SKILL.md`. The prompts
  built by `grok_review`, `grok_adversarial_review`, and `grok_rescue` now open by saying the run is a
  headless, single-purpose delegation, that repository bootstrap instructions about interactive skills and
  personas do not apply, and that the only text output is the final answer.
- `outputSummary.skillsLoaded` lists the skill/persona files the delegate opened anyway, with a warning when
  the list is non-empty.

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
