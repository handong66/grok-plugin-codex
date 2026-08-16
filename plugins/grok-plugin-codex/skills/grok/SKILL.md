---
name: grok
description: Use when Codex must directly operate or troubleshoot the installed grok-plugin-codex MCP capability surface, including CLI/model checks, literal prompt runs or continuations, session inspection or export, and known background-job control. Do not use for bounded repository delegation, implementation, review, adversarial review, or rescue orchestration; use $grok-codex-collaboration.
---

# Grok Capability Layer

Operate the installed `grok_*` tools according to their current schemas. Codex owns scope, workspace state, verification, git, and final judgment.

## Required contract

- Use `grok_check` when CLI discovery, compatibility, login, or model listing is uncertain. Treat `cliDiscovered`, `authenticated`, `modelsListed`, and `callable` as separate facts. `modelInvocationTested`/`callable` stay `false`/`null` unless you pass `probeInvocation: true`, which spends real quota on one bounded call; do not enable it routinely.
- Configure a custom executable through trusted MCP environment variable `GROK_BIN`; never accept a binary path from a task prompt or tool argument.
- Pass an explicit `cwd` for workspace, session, and export operations. Review and adversarial-review calls also require an explicit non-empty `target` and are forced into read-only plan mode without subagents.
- `background` defaults to `true` for `grok_run`, `grok_review`, `grok_adversarial_review`, and `grok_rescue`, and to `false` for `grok_continue`; a background start returns `data.background === true` and `data.job.id`. Call status, result, or cancel with that `jobId` only; job state is private and independent of workspace `cwd`. `background: false` blocks the MCP call for up to `timeoutMs` plus a 10 s grace and then returns `foreground_wait_timeout` carrying the same job id.
- Accept an answer only when `data.resultComplete === true`; it already accounts for truncation. `outputSummary.outputTruncated` alone does not disqualify an answer — it usually means tool-call echo overflowed the capture window — while `outputSummary.textTruncated` means answer text was dropped. The plugin normalises `stopReason` case- and separator-insensitively (`end_turn`, `EndTurn`, `cancelled`, `Cancelled` are all understood); never string-match the raw value yourself. Treat `cancelled_output` and `max_turns_reached` as partial. Use `data.finalText`, not previews or raw log tails; `grok_result` returns the raw `stdoutTail`/`stderrTail` only when you pass `includeRawTail: true`.
- Every non-complete result carries a recovery handle: `error.details.recovery` on a failed foreground call and `data.recovery` on `grok_result`, shaped `{ jobId, grokSessionId, partialTextChars, suggested: { tool: "grok_continue", args } }`. Run that suggestion — one turn, no tools — instead of rerunning the task or raising the budget. The partial answer is never destroyed: `error.details.finalTextRef` is the job id and `grok_result` returns the complete captured `finalText` whatever `resultComplete` says.
- When `outputSummary.stopReasonRecognised === false` the plugin accepted an unfamiliar stop reason and said so in `warnings`. The answer is still returned; reject it only if your task needs strict vocabulary matching.
- Continue only a known `sessionId` or explicitly request the latest session. Continuing a session that this plugin created for a review, adversarial review, or rescue inherits enforced read-only plan mode, and `alwaysApprove` on such a session is refused with `readonly_session_escalation`; when the session is unknown to the plugin the call proceeds with a warning saying the original mode could not be verified. Export returns Markdown; the plugin does not write a caller-selected output file.

- A review or adversarial review that made **zero** tool calls inspected nothing. The plugin reports it as `no_evidence_review` with `outputSummary.evidenceLevel: "none"` and `resultComplete: false`; the text is still readable through `grok_result`. Record it as no signal, never as a passing vote. `evidenceLevel: "thin"` (tools used but no file named, or an answer under 400 characters) means the verdict needs corroboration. Use `outputSummary.toolCallCount`, `filesInspected`, and `turnsUsed` as the evidence record.
- A vendor `stopReason: cancelled` is stored as a `cancelled` job, never as `succeeded`.
- `job.waitingForAuth === true` means the Grok CLI is blocked on an interactive sign-in; a job that hits this in its first seconds fails immediately with a non-retryable `auth_required` rather than waiting out `timeoutMs`. Ask the user to sign in with the Grok CLI; the plugin never repeats the one-time device code.

## Safety and recovery

- Never send hidden Codex context, system/developer messages, reasoning, credentials, arbitrary tool output, or private paths such as `~/.codex`.
- Treat `{ ok: false, error: { code, message, retryable } }` as a machine-readable business failure. Narrow the target before retrying partial, timed-out, or truncated work.
- Do not assume capabilities or tools that the current MCP server does not advertise.

For bounded Codex↔Grok delegation, implementation, review gates, rescue, or handoff records, use `$grok-codex-collaboration` as the primary skill. This skill owns only the installed tool contract and is loaded alongside it only when direct capability details are needed.
