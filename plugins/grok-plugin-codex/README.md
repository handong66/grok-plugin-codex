# Grok for Codex

`grok-plugin-codex` is the macOS/Linux Codex capability adapter for a locally installed Grok CLI. Version 0.3.1 makes an explicit absolute `cwd` a per-call workspace grant while retaining path validation, state isolation, and the existing operation-permission controls.

## Runtime contract

- Configure a nonstandard executable with the trusted MCP environment variable `GROK_BIN`.
- `grok_check` reports CLI discovery, authentication, entitlement, model listing, and actual model-call evidence separately. Listing a model is not proof that it can complete a request. `authenticated` and `entitled` are `true`, `false`, or the string `"unknown"`, never `null`.
- Workspace operations require an explicit absolute `cwd`. Supplying it grants that call the exact canonical directory, even when Codex advertises a different root or no roots; the grant is not remembered. Symlinks are resolved, missing/non-directory paths are rejected, and private Codex paths remain blocked by default.
- `grok_review`, `grok_adversarial_review`, and `grok_rescue` run with Grok plan permissions and no subagents, which refuses shell execution: inline the diff, test log, or command output the review needs into the target. A run cancelled because a shell command needed approval comes back as `permission_denied_headless`, and refusals are listed in `outputSummary.deniedToolCalls`.
- `target` (or `problem`) also accepts the sibling opencode plugin's name, `prompt` — exactly one of the two. `grok_adversarial_review` takes an optional `threatModel`; findings outside it are advisory and may not block.
- `grok_finalize` is the one-call recovery: one turn, no tools, complete answer, anything unverified marked `UNVERIFIED`.
- Prompts are staged in private `0600` files, consumed and deleted by the worker, then passed through a `0600` FIFO in a random `0700` directory. Grok receives only the private FIFO path through `--prompt-file`; the path is unlinked as soon as Grok opens it, before any prompt bytes are written, and prompt text never enters process arguments.
- Session export returns Markdown and never writes a caller-selected file.

Successful tools return:

```json
{ "ok": true, "data": {}, "error": null, "warnings": [] }
```

Business failures return `isError: true` plus:

```json
{
  "ok": false,
  "data": null,
  "error": { "code": "typed_code", "message": "actionable message", "retryable": false },
  "warnings": []
}
```

Input-schema failures are SDK-generated tool errors (`isError: true`) without the plugin business envelope; inspect the resolved result instead of relying only on promise rejection.

## Background jobs

Background state lives under `$GROK_PLUGIN_STATE_DIR`, otherwise `$XDG_STATE_HOME/grok-plugin-codex`, otherwise `~/.local/state/grok-plugin-codex`. An override that overlaps any active workspace root in either direction is rejected. Existing nonempty directories require the ownership marker or the strict private pre-marker job layout. Directories use `0700`; records, logs, cancel markers, heartbeats, cross-process locks, and brief prompt staging files use `0600`. The plugin writes no state into the user workspace and does not `chmod` unrelated shared directories.

`background` defaults to `true` for `grok_run`, `grok_review`, `grok_adversarial_review`, and `grok_rescue`, and to `false` for the short `grok_continue`. Save `data.job.id`, then call `grok_status`, `grok_result`, or `grok_cancel` with `jobId` only. Pass `background: false` to block this MCP call until the job is terminal; that blocks for up to `timeoutMs` plus a 10 s grace, after which the plugin returns `foreground_wait_timeout` with the job id instead of blocking further. An omitted `timeoutMs` defaults per kind (run/continue `180000`, review/rescue `240000`, adversarial_review `300000`); an explicit value is never clamped, and both effective values are echoed as `effectiveTimeoutMs` / `effectiveMaxTurns`. For a background job, one `grok_status` with `waitMs` (≤ 30 s) followed by one `grok_result` replaces a polling loop; `grok_status` also carries cheap progress (`textChars`, `eventCounts`, `lastEventAt`, `toolCallCount`, `deniedToolCalls`). A usable final answer requires both:

```text
data.resultComplete === true
```

`resultComplete` already accounts for truncation. `outputSummary.outputTruncated` means the shared capture window overflowed — usually with tool-call echo, which is 84.6 % of a typical Grok stream — and on its own it no longer disqualifies an answer. `outputSummary.textTruncated` is the flag that means answer text was actually dropped, and only that vetoes completeness.

Use `data.finalText` for the captured answer; it is returned whatever `resultComplete` says, and can be paged with `finalTextOffset` / `finalTextMaxChars` (`data.finalTextChars` is the full length). Partial states and previews are diagnostics only, and the raw per-token `stdoutTail` / `stderrTail` are returned only when `grok_result` is called with `includeRawTail: true`.

Completeness requires non-empty final text and a normal end event, and for `grok_review` / `grok_adversarial_review` at least one tool call — a verdict with `outputSummary.toolCallCount === 0` inspected nothing and comes back as `no_evidence_review`. The plugin normalises `stopReason` case- and separator-insensitively, so `end_turn` and `EndTurn` (and `cancelled`/`Cancelled`/`canceled`) are all recognised; callers must not string-match the raw value. The raw value stays in `outputSummary.stopReason`, the compared form in `stopReasonNormalized`. Cancelled output is partial and surfaces as `cancelled_output`; `max_turns_reached` is a typed retryable failure.

Every non-complete result carries a recovery handle: `error.details.recovery` on a failed foreground call and `data.recovery` on `grok_result`, shaped `{ jobId, grokSessionId, partialTextChars, suggested: { tool: "grok_finalize", args }, fallback: { tool: "grok_continue", args } }`. Run the suggestion as given, or the `fallback` — the same session with `maxTurns: 1` and the same prompt telling Grok to stop using tools and emit the complete final answer now. Neither asks for a shortened answer. Do not narrow the target, raise `maxTurns`, or rerun the task; the captured partial answer stays reachable through `grok_result` with the same `jobId` (`error.details.finalTextRef`).

An unfamiliar stop reason no longer destroys the answer: a stream that ended with non-empty text is reported complete, with `stopReasonRecognised: false` and a warning naming the raw value.

## Privacy boundary

Do not send Grok hidden Codex context, system/developer messages, reasoning, secrets, credentials, arbitrary tool output, or private Codex runtime paths. The plugin filters child-process environment variables and only passes the documented Grok, PATH, proxy, and certificate settings.

Codex remains responsible for scope, verification, git, and final judgment. Grok output is evidence to verify, not authority.

## Local installation

From the repository root:

```bash
npm install
npm run check
codex plugin marketplace add .
codex plugin add grok-plugin-codex --marketplace grok-plugin-codex
```

Start a new Codex task after installation or upgrade so the new skill and MCP schema are loaded. If Codex Desktop exposes the updated skill but not the updated MCP tools, restart Codex Desktop and create another task because the Desktop process can retain its MCP registry across reinstall.
