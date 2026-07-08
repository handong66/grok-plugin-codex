---
name: grok
description: Use when the user asks Codex to call Grok, run Grok CLI, review with Grok, ask Grok for rescue analysis, inspect Grok sessions, or export a Grok session.
---

# Grok For Codex

Use the bundled `grok_*` MCP tools to delegate bounded work from Codex to Grok CLI.

## Default Workflow

1. Use `grok_check` first when Grok CLI, login, model availability, or path discovery may be uncertain.
2. Use `grok_run` for a new Grok prompt.
3. Use `grok_continue` only with a known `sessionId` or explicit `continueLatest: true`; never silently continue the latest session.
4. Use `grok_review`, `grok_adversarial_review`, or `grok_rescue` for second-agent analysis.
5. Use `grok_sessions` and `grok_export` for Grok session inspection.
6. Use `grok_status`, `grok_result`, and `grok_cancel` for background jobs. Treat `grok_result.outputSummary.resultComplete === true` as required before quoting Grok as a finished result.

## Safety Defaults

- Codex owns scope, files, verification, git, and final judgment.
- Pass `cwd` for the workspace Grok should inspect. If omitted, Grok may run in the installed plugin directory rather than the user's active repo.
- Use the same `cwd` for `grok_status`, `grok_result`, and `grok_cancel` that was used to start the background job.
- Do not expose Codex hidden context, system/developer messages, tool outputs, hidden reasoning, secrets, or auth tokens.
- Do not paste secrets or private tool output into `prompt`, `problem`, or `target`; the plugin does not redact arbitrary user-provided text.
- Do not ask Grok to read Codex private runtime paths such as `~/.codex` unless the user explicitly authorizes `allowCodexPrivatePaths: true`.
- Do not pass `alwaysApprove` unless the user explicitly asks for that permission behavior.
- Prefer `disableWebSearch: true` and `noSubagents: true` for tightly bounded review or smoke tasks.
- Use `maxTurns: 1` only for sentinel checks or prompts that do not need file/tool work. Omit `maxTurns` or set a higher limit when asking Grok to inspect repo files.
- Treat `grok_review` and `grok_adversarial_review` as bounded second-pass reviews, not broad security scans.
- For background jobs, never treat cancelled, running, failed, or no-end-event logs as final output.

## Model Notes

The known local default `grok-composer-2.5-fast` does not support `--reasoning-effort`. If a caller passes `reasoningEffort` with that model, the plugin returns a warning and does not pass the flag.

If no model is specified, the plugin also does not pass `reasoningEffort`, because the local default may be `grok-composer-2.5-fast`.

## Transfer Boundary

There is no `grok_transfer` tool in v1.

Grok CLI has an `import` command, but this plugin does not ship a Codex rollout JSONL to Grok import path until that schema is proven separately.
