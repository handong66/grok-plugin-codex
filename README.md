# Grok Plugin Codex

`grok-plugin-codex` exposes a locally installed Grok CLI to Codex through a bundled Node/TypeScript MCP server. Codex remains responsible for scope, workspace state, verification, git, and final judgment; Grok is a bounded second surface.

Version `0.3.0` is the current release. It normalises the Grok stop-reason vocabulary (`end_turn` and `EndTurn` are one fact), classifies timeouts and quota exhaustion correctly, defaults dispatch tools to background with per-kind time budgets, returns a recovery handle on every non-complete result, refuses to report a verdict reached without a single tool call as a completed review, and adds `grok_finalize` — the one-turn, tool-free way to recover an answer that already exists. See [CHANGELOG.md](CHANGELOG.md) for the full contract changes. Version 0.2 introduced the private central worker architecture and typed MCP envelopes.

Repository: https://github.com/handong66/grok-plugin-codex
Write-up: https://han-dong.link/en/work/grok-plugin-codex

## Requirements

- Node.js `>=22`
- npm
- macOS or Linux
- Codex local plugin marketplace support
- Grok CLI installed and authenticated

Check the three runtime layers separately:

```bash
grok --version   # CLI can be discovered
grok --help      # installed flags/capabilities
grok models      # authentication and model listing
```

A listed model has not necessarily completed a real invocation. `grok_check` preserves that distinction.

## Install

```bash
npm install
npm run check
codex plugin marketplace add .
codex plugin add grok-plugin-codex --marketplace grok-plugin-codex
```

Start a new Codex task after installation or upgrade. Existing tasks retain the MCP server and skill snapshot with which they started. If a new Codex Desktop task sees the updated skill but not the updated MCP tools, restart Codex Desktop and create another task; the Desktop process can retain its MCP registry across reinstall.

The installed bundle contains both:

```text
plugins/grok-plugin-codex/dist/server.js
plugins/grok-plugin-codex/dist/job-worker.js
```

## Capability surface

- `grok_check`, `grok_models`: CLI/capability, authentication, entitlement, and model diagnostics. `authenticated` and `entitled` are `true`, `false`, or `"unknown"` — never `null`.
- `grok_run`, `grok_continue`: explicit prompt execution and known-session continuation.
- `grok_finalize`: one turn, no tools, complete answer — the recovery for a timed-out, turn-limited, cancelled, or permission-blocked run.
- `grok_rescue`, `grok_review`, `grok_adversarial_review`: enforced read-only, no-subagent second passes. Each needs a `target` (or `problem`), for which the sibling plugin's name `prompt` is also accepted. `grok_adversarial_review` takes an optional `threatModel`; findings outside it are advisory and may not block.
- `grok_sessions`, `grok_export`: explicit-workspace session inspection and Markdown export.
- `grok_status`, `grok_result`, `grok_cancel`: private central background-job lifecycle by `jobId` only. `grok_status` returns cheap progress (`textChars`, `eventCounts`, `lastEventAt`, `toolCallCount`, `deniedToolCalls`) and takes an optional `waitMs` (≤ 30 s) server-side wait; `grok_result` pages `finalText` with `finalTextOffset` / `finalTextMaxChars`.

The current MCP `listTools` schema is authoritative for exact arguments. The repository smoke test locks the published surface and rejects drift.

## Result contract

Successful operations return:

```json
{ "ok": true, "data": {}, "error": null, "warnings": [] }
```

Business failures set MCP `isError: true` and return:

```json
{
  "ok": false,
  "data": null,
  "error": { "code": "typed_code", "message": "actionable message", "retryable": false },
  "warnings": []
}
```

Input schema violations are SDK-generated tool errors (`isError: true`) without the plugin business envelope; clients must inspect the resolved tool result rather than relying only on promise rejection. Every tool publishes an output schema, and plugin-handled JSON text mirrors `structuredContent`.

## Workspace and prompt boundaries

Workspace operations require `cwd`. The server canonicalizes symlinks and requires the resolved directory to remain inside an active MCP workspace root. Private Codex paths such as `~/.codex` are blocked unless the user explicitly authorizes that risk.

Prompts are staged briefly in private `0600` files so a detached worker can survive MCP-server exit. The worker reads and deletes the staging file before Grok runs, then supplies the prompt through a `0600` FIFO inside a random `0700` directory. Grok receives only that private pathname through native `--prompt-file`; the launcher unlinks it as soon as Grok opens it, before writing any prompt bytes. Prompt text is not placed in the child-process argument list or job record. `GROK_BIN` is the only supported custom executable configuration and must come from the trusted MCP environment.

## Background jobs

Background jobs run in a detached worker and survive MCP-server restarts. State lives under:

1. `$GROK_PLUGIN_STATE_DIR`, when explicitly configured;
2. `$XDG_STATE_HOME/grok-plugin-codex`;
3. `~/.local/state/grok-plugin-codex`.

An explicit state directory must be disjoint from every active workspace root: neither inside a root nor an ancestor of one. It must be empty, carry the plugin's ownership marker, or match the strict private pre-marker job layout; the plugin will not claim or `chmod` an existing shared directory. These checks fail closed before creating or changing repository-local state.

Directories use `0700`; records, logs, prompt staging files, cancel markers, heartbeats, and owner-token cross-process locks use `0600`. Record writes are atomic and terminal status is monotonic. Cancellation is linearized by a marker consumed by the owning worker. Each process group is led by a private launcher whose command identity includes the job ID and random job token; stale-worker reconciliation terminates a persisted group only when all three match, and the launcher removes residual descendants before exiting.

Dispatch tools (`grok_run`, `grok_review`, `grok_adversarial_review`, `grok_rescue`) default to `background: true`; `grok_continue` defaults to foreground. Save `data.job.id`, then call job tools with `jobId`. A foreground call (`background: false`) blocks for at most `timeoutMs` plus a 10 s grace and then returns `foreground_wait_timeout` with that job id. An omitted `timeoutMs` defaults per kind — run/continue `180000`, review/rescue `240000`, adversarial_review `300000` — and an explicit value is never clamped in either direction; both effective values come back as `effectiveTimeoutMs` / `effectiveMaxTurns`. The recommended rhythm for a background job is one `grok_status` with `waitMs`, then one `grok_result`, rather than a polling loop. Only this combination is final:

```text
data.resultComplete === true
```

Internally, completeness also requires non-empty final text and a normal end event, and — for `grok_review` and `grok_adversarial_review` — at least one tool call, since a verdict from a reviewer that opened nothing is an opinion (`no_evidence_review`). The read-only kinds run in plan mode, where shell execution is refused automatically: inline the diff or command output the review needs into the target, and a run that was cancelled because a shell command needed approval is reported as `permission_denied_headless` rather than as a target that was too wide. Stop reasons are normalised case- and separator-insensitively (`end_turn` and `EndTurn` are the same fact), the raw value is preserved in `outputSummary.stopReason`, and callers must not string-match it themselves. A cancelled end is returned as `cancelled_output`. An unrecognised stop reason after real text is accepted with `stopReasonRecognised: false` plus a warning instead of being discarded.

Every non-complete result carries a recovery handle — `error.details.recovery` on a failed foreground call, `data.recovery` on `grok_result` — shaped `{ jobId, grokSessionId, partialTextChars, suggested: { tool: "grok_finalize", args }, fallback: { tool: "grok_continue", args } }`. The handle is executable as given: `suggested` is the one-call recovery, and `fallback` is the same thing spelled out for a caller that only speaks `grok_continue` (`maxTurns: 1` plus the `grok_finalize` prompt). Neither asks for a shortened answer. The remedy for `max_turns_reached` and for a cancelled or timed-out run is `grok_finalize` with that job id, or the same call by hand: continue the same session with `maxTurns: 1` and a prompt telling Grok to stop using tools and emit the final answer now. Do not narrow the target, raise `maxTurns`, or rerun the task — the partial answer is never destroyed, `error.details.finalTextRef` is the job id, and `grok_result` returns the complete captured text whatever `resultComplete` says.

`resultComplete` accounts for truncation itself: `outputTruncated` only says the shared capture window overflowed, which is normally tool-call echo, while `textTruncated` says answer text was dropped and is the flag that vetoes completeness. Oversized tool payloads are elided at capture time and `available_commands` payloads are dropped; set `GROK_PLUGIN_RAW_CAPTURE=1` to keep the vendor stream verbatim for plugin development.

Use `data.finalText`. Partial states are diagnostics only, and the raw per-token log tails are returned only when `grok_result` is called with `includeRawTail: true`. The worker keeps the answer in an append-only `<id>.final.txt` ledger and the stream facts in `<id>.summary.json`, so `grok_result` answers from that ledger instead of re-parsing the raw stream, and `grok_status` reads progress from the same file. Terminal job artifacts are retained for seven days and cleaned opportunistically.

## Upgrading from 0.1

- Finish or cancel 0.1 background jobs before upgrading.
- 0.2 does not scan or trust old `<workspace>/.grok-plugin-codex/jobs` records.
- Old workspace directories are not automatically removed because they belong to the user's workspace.
- Per-call executable selection, caller-selected export files, implicit review targets, and job-control `cwd` are removed.

## Privacy boundary

The plugin does not copy hidden Codex context, system/developer messages, reasoning, arbitrary tool output, secrets, or credentials into prompts. It cannot redact sensitive text that a caller explicitly supplies. See [docs/privacy.md](docs/privacy.md).

## Development

```bash
npm install
npm run check
git diff --check
```

Optional authenticated invocation:

```bash
npm run smoke:live-grok
```

Runtime schemas and tests are authoritative. Bundled README/skill files are the installed user contract; [test/contract-drift.test.ts](test/contract-drift.test.ts) and the MCP smoke prevent removed arguments or mismatched versions from reappearing.

See [docs/development.md](docs/development.md) and [docs/verification.md](docs/verification.md).

## Project policies

- [Privacy Policy](docs/privacy.md)
- [Terms of Use](docs/terms.md)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
