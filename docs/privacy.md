# Privacy Policy

Effective date: July 10, 2026

`grok-plugin-codex` is a local Codex plugin. This project operates no hosted service and collects no telemetry, analytics, account data, or payment data.

## What runs locally

The plugin starts a local Node.js MCP server. Foreground and background requests both use a detached local worker so execution and cleanup can survive MCP-server exit. The Grok CLI may send prompt and workspace-derived content to Grok/xAI according to the user's CLI configuration and xAI terms. This project does not control that processing.

## Prompt handling

Prompt text is staged briefly in a private `0600` file so the detached worker can acquire it. The worker reads and removes that file before starting Grok, then sends the prompt through inherited file descriptor 3 with `--prompt-file /dev/fd/3`. Prompt text is not placed in process arguments or persisted job arguments. A crash before worker acquisition is reconciled by job status/result or the next opportunistic cleanup.

The plugin cannot redact arbitrary text intentionally supplied in `prompt`, `problem`, or `target`. Do not send secrets, credentials, private tool output, or sensitive file contents.

## Background state

Background state lives under `$GROK_PLUGIN_STATE_DIR`, otherwise `$XDG_STATE_HOME/grok-plugin-codex`, otherwise `~/.local/state/grok-plugin-codex`. A configured override that overlaps any active workspace root in either direction is rejected before directories are created or permissions changed. An existing override must be empty, carry the plugin ownership marker, or match the strict private pre-marker job layout, preventing accidental `chmod` or job creation in a shared directory. Directories use `0700`; job records, logs, heartbeats, cancellation markers, cross-process locks, prompt staging files, and the ownership marker use `0600`. The per-job `<id>.worker.log` capture of the worker process's own stderr follows the same permissions and the same seven-day terminal retention as every other job artifact; it holds Node diagnostics for the plugin's own worker, never prompt text or Grok output. Records are written atomically and terminal status cannot be overwritten by a late worker.

Private job records can contain the selected workspace path, Grok executable path, non-prompt CLI arguments, timestamps, process identifiers, a random process-group ownership token, and typed error metadata. Public MCP results remove command paths, internal arguments, PIDs, ownership tokens, and state-file paths; unexpected internal errors use a stable sanitized message. Raw stdout/stderr tails may still contain content produced by Grok.

Typed failure diagnostics are the one place where operating-system text reaches a caller verbatim, so they are rewritten before they are written to disk: in `error.details`, the free-form fields `errorMessage`, `stackTail`, `teardownError`, and `workerLogTail` have the state directory replaced by `<state>`, the plugin's installation directory by `<plugin>`, and the home directory by `<home>`. A failure therefore still names its phase, errno, artifact, and stack frames without disclosing where this machine keeps them. Filesystem locations chosen by the caller — the workspace `cwd` and paths the caller wrote into a prompt — are not rewritten.

`outputSummary.filesInspected` passes through that same rewriting. The paths in it are chosen by Grok rather than by the caller: a delegate that opens `~/.grok/skills/pua/SKILL.md` or `~/.claude/skills/using-superpowers/SKILL.md` puts a home-directory location outside the workspace into a public result, so the roots above are replaced there too. Files the delegate read inside the caller's own workspace stay verbatim, because that location is the caller's choice — including the normal case where the workspace itself lives under the home directory, since a collected path is tested against the job's workspace before the roots are applied. `outputSummary.skillsLoaded` holds extracted skill names only, never a path.

One credential can appear in Grok's own stderr: when device authorization expires, the CLI prints an OAuth sign-in URL carrying a one-time `user_code`. Every stderr the plugin returns — the foreground `stderrTail`, `grok_result` with `includeRawTail: true`, and the parsed summary — has `user_code=<value>` rewritten to `user_code=<redacted>`. The sign-in URL itself is kept because it is the actionable part, and the private `0600` log keeps the original for local debugging.

Terminal artifacts are retained for seven days and cleaned opportunistically. Version 0.2 does not scan or remove legacy workspace-local state created by 0.1.

## Environment

Grok child processes receive only documented variables needed for executable discovery and common network configuration: `GROK_BIN`, `HOME`, `PATH`, proxy variables, `SSL_CERT_FILE`, `SSL_CERT_DIR`, and `NODE_EXTRA_CA_CERTS`. Worker state paths and job ownership tokens are not passed to Grok; the token identifies the private local launcher instead.

## Codex boundary

The plugin does not automatically copy hidden Codex context, system/developer messages, reasoning, credentials, or arbitrary tool output into Grok prompts. Private Codex paths such as `~/.codex` are blocked by default.

## Contact

Use GitHub security advisories for sensitive privacy or security reports when available. Never include secrets in public issues.
