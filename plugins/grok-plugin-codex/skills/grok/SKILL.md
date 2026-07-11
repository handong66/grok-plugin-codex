---
name: grok
description: Use when Codex must directly operate or troubleshoot the installed grok-plugin-codex MCP capability surface, including CLI/model checks, literal prompt runs or continuations, session inspection or export, and known background-job control. Do not use for bounded repository delegation, implementation, review, adversarial review, or rescue orchestration; use $grok-codex-collaboration.
---

# Grok Capability Layer

Operate the installed `grok_*` tools according to their current schemas. Codex owns scope, workspace state, verification, git, and final judgment.

## Required contract

- Use `grok_check` when CLI discovery, compatibility, login, or model listing is uncertain. Treat `cliDiscovered`, `authenticated`, `modelsListed`, and `callable` as separate facts.
- Configure a custom executable through trusted MCP environment variable `GROK_BIN`; never accept a binary path from a task prompt or tool argument.
- Pass an explicit `cwd` for workspace, session, and export operations. Review and adversarial-review calls also require an explicit non-empty `target` and are forced into read-only plan mode without subagents.
- A background start returns `data.job.id`. Call status, result, or cancel with that `jobId` only; job state is private and independent of workspace `cwd`.
- Accept a background answer only when `data.resultComplete === true` and `data.outputTruncated === false`. Use `data.finalText`, not previews or raw log tails.
- Continue only a known `sessionId` or explicitly request the latest session. Export returns Markdown; the plugin does not write a caller-selected output file.

## Safety and recovery

- Never send hidden Codex context, system/developer messages, reasoning, credentials, arbitrary tool output, or private paths such as `~/.codex`.
- Treat `{ ok: false, error: { code, message, retryable } }` as a machine-readable business failure. Narrow the target before retrying partial, timed-out, or truncated work.
- Do not assume capabilities or tools that the current MCP server does not advertise.

For bounded Codex↔Grok delegation, implementation, review gates, rescue, or handoff records, use `$grok-codex-collaboration` as the primary skill. This skill owns only the installed tool contract and is loaded alongside it only when direct capability details are needed.
