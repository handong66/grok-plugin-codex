# Grok Plugin Codex

`grok-plugin-codex` exposes a locally installed Grok CLI to Codex through a bundled Node/TypeScript MCP server. Codex remains responsible for scope, workspace state, verification, git, and final judgment; Grok is a bounded second surface.

Version `0.2.1` is the current bug-fix release. It requires a normal Grok `EndTurn` before reporting a complete result, exposes cancellation and turn exhaustion as typed incomplete outcomes, and avoids false-positive authentication reports. Version 0.2 introduced the private central worker architecture and typed MCP envelopes.

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

- `grok_check`, `grok_models`: CLI/capability and model diagnostics.
- `grok_run`, `grok_continue`: explicit prompt execution and known-session continuation.
- `grok_rescue`, `grok_review`, `grok_adversarial_review`: enforced read-only, no-subagent second passes. Review tools require an explicit `target`.
- `grok_sessions`, `grok_export`: explicit-workspace session inspection and Markdown export.
- `grok_status`, `grok_result`, `grok_cancel`: private central background-job lifecycle by `jobId` only.

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

Prompts are staged briefly in private `0600` files so a detached worker can survive MCP-server exit. The worker reads and deletes the staging file before Grok runs, then supplies the prompt through file descriptor 3 with Grok's native `--prompt-file /dev/fd/3`. Prompt text is not placed in the child-process argument list or job record. `GROK_BIN` is the only supported custom executable configuration and must come from the trusted MCP environment.

## Background jobs

Background jobs run in a detached worker and survive MCP-server restarts. State lives under:

1. `$GROK_PLUGIN_STATE_DIR`, when explicitly configured;
2. `$XDG_STATE_HOME/grok-plugin-codex`;
3. `~/.local/state/grok-plugin-codex`.

An explicit state directory must be disjoint from every active workspace root: neither inside a root nor an ancestor of one. It must be empty, carry the plugin's ownership marker, or match the strict private pre-marker job layout; the plugin will not claim or `chmod` an existing shared directory. These checks fail closed before creating or changing repository-local state.

Directories use `0700`; records, logs, prompt staging files, cancel markers, heartbeats, and owner-token cross-process locks use `0600`. Record writes are atomic and terminal status is monotonic. Cancellation is linearized by a marker consumed by the owning worker. Each process group is led by a private launcher whose command identity includes the job ID and random job token; stale-worker reconciliation terminates a persisted group only when all three match, and the launcher removes residual descendants before exiting.

Dispatch tools (`grok_run`, `grok_review`, `grok_adversarial_review`, `grok_rescue`) default to `background: true`; `grok_continue` defaults to foreground. Save `data.job.id`, then call job tools with `jobId`. A foreground call (`background: false`) blocks for at most `timeoutMs` plus a 10 s grace and then returns `foreground_wait_timeout` with that job id. Only this combination is final:

```text
data.resultComplete === true
```

Internally, completeness also requires non-empty final text and a normal end event. Stop reasons are normalised case- and separator-insensitively (`end_turn` and `EndTurn` are the same fact), the raw value is preserved in `outputSummary.stopReason`, and callers must not string-match it themselves. A cancelled end is returned as `cancelled_output`; `max_turns_reached` asks the caller to narrow the target or increase `maxTurns`. An unrecognised stop reason after real text is accepted with `stopReasonRecognised: false` plus a warning instead of being discarded. All paths preserve bounded recovery metadata without promoting partial text to a conclusion.

`resultComplete` accounts for truncation itself: `outputTruncated` only says the shared capture window overflowed, which is normally tool-call echo, while `textTruncated` says answer text was dropped and is the flag that vetoes completeness. Oversized tool payloads are elided at capture time and `available_commands` payloads are dropped; set `GROK_PLUGIN_RAW_CAPTURE=1` to keep the vendor stream verbatim for plugin development.

Use `data.finalText`. Partial states are diagnostics only, and the raw per-token log tails are returned only when `grok_result` is called with `includeRawTail: true`. Terminal job artifacts are retained for seven days and cleaned opportunistically.

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
