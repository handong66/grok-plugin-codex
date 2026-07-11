# Grok for Codex

`grok-plugin-codex` is the macOS/Linux Codex capability adapter for a locally installed Grok CLI. Version 0.2 provides explicit workspace scoping, typed MCP results, enforced read-only review tools, session operations, and restart-safe background jobs.

## Runtime contract

- Configure a nonstandard executable with the trusted MCP environment variable `GROK_BIN`.
- `grok_check` reports CLI discovery, authentication/model listing, and actual model-call evidence separately. Listing a model is not proof that it can complete a request.
- Workspace operations require an explicit `cwd` inside an active MCP workspace root. Symlinks are resolved before the boundary check.
- `grok_review`, `grok_adversarial_review`, and `grok_rescue` run with Grok plan permissions and no subagents.
- Prompts are staged in private `0600` files, consumed and deleted by the worker, then passed to Grok through `--prompt-file /dev/fd/3`; prompt text never enters process arguments.
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

Start a run with `background: true`, save `data.job.id`, then call `grok_status`, `grok_result`, or `grok_cancel` with `jobId` only. A usable final answer requires both:

```text
data.resultComplete === true
data.outputTruncated === false
```

Use `data.finalText` for the captured answer. `stdoutTail`, `stderrTail`, partial states, and previews are diagnostics only.

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
