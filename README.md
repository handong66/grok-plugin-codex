# Grok Plugin Codex

`grok-plugin-codex` is a Codex plugin that exposes the local Grok CLI through a bundled Node/TypeScript stdio MCP server.

It lets Codex ask Grok for bounded repo work, reviews, rescue analysis, adversarial failure-mode checks, session listing/export, and background job management while keeping Codex hidden runtime context out of scope.

Repository: https://github.com/handong66/grok-plugin-codex

## Tools

- `grok_check`: discover Grok CLI, run `grok --version`, and check login/model availability with `grok models`. `ok: true` means both CLI discovery and `grok models` succeeded.
- `grok_models`: return raw and parsed `grok models` output.
- `grok_run`: run `grok --cwd <cwd> -p <prompt> --output-format json` in foreground or `streaming-json` in background.
- `grok_continue`: continue with `--resume <sessionId>` or with `--continue` only when `continueLatest: true`.
- `grok_rescue`: read-only independent diagnosis prompt wrapper.
- `grok_review`: bounded findings-first review prompt wrapper.
- `grok_adversarial_review`: bounded failure-mode review prompt wrapper that asks Grok for at most 5 findings. The cap is prompt-level guidance, not output truncation.
- `grok_sessions`: wrap `grok sessions list/search`.
- `grok_export`: wrap `grok export <sessionId>` and return Markdown from stdout by default.
- `grok_status`, `grok_result`, `grok_cancel`: manage background Grok jobs.

There is no `grok_transfer` tool in v1. Grok has `import`, but this repository does not claim a verified Codex rollout JSONL to Grok import schema.

## Requirements

- Node.js `>=22`
- npm
- Codex local plugin marketplace support
- Grok CLI installed and logged in

Check Grok directly:

```bash
grok --version
grok models
```

## Install

From the repository root:

```bash
npm install
npm run check
codex plugin marketplace add .
codex plugin add grok-plugin-codex --marketplace grok-plugin-codex
```

Then start a new Codex thread so the MCP tools and `grok` skill are loaded.

`npm run check` builds `plugins/grok-plugin-codex/dist/server.js`; the installed MCP server runs that bundle from the plugin directory.

## Usage Notes

Use the Grok tools as a second-agent surface. Codex remains responsible for scope, workspace state, verification, git, and final judgment.

Pass `cwd` whenever Grok should inspect a specific workspace. If `cwd` is omitted, the plugin falls back to the MCP server process directory, which is normally the installed plugin directory rather than the user's active repo.

For long tasks, pass `background: true` to use `--output-format streaming-json`, then poll:

```text
grok_status -> grok_result -> grok_cancel if needed
```

Use the same `cwd` when polling or cancelling a background job that was used when the job was started; job records live under `<cwd>/.grok-plugin-codex/jobs`.

`grok_result` treats a background job as complete only when the process succeeded, at least one `text` event was observed, and an `end` event was observed. Partial logs are process evidence, not a finished review.

Use very low `maxTurns` values only for sentinel checks or prompts that do not need file/tool work. Repo reviews and rescue analysis usually need enough turns for Grok to inspect the requested files and produce a final answer.

## Shared Arguments

Run, continue, rescue, review, and adversarial-review tools accept:

- `cwd`
- `grokBin`
- `model`
- `timeoutMs`
- `background`
- `disableWebSearch`
- `noSubagents`
- `maxTurns`
- `alwaysApprove`
- `reasoningEffort`
- `allowCodexPrivatePaths`

`grok_check` accepts `cwd`, `grokBin`, `timeoutMs`, and optional `includeModels`. `grok_models` accepts `cwd`, `grokBin`, and `timeoutMs`.

`grok_sessions` accepts `cwd`, `grokBin`, `timeoutMs`, `query`, and `limit`. Search queries are separated from Grok CLI flags before execution. `grok_export` accepts `cwd`, `grokBin`, `timeoutMs`, `sessionId`, and optional `outputFile`; `outputFile` must resolve inside `cwd`. Discovery-style subcommands pass `cwd` as Grok's global `--cwd` option. Job tools accept `cwd` plus a `jobId` in the generated `job_<timestamp>_<8-hex>` format; `grok_result` also accepts `maxChars`.

`grok_check` also accepts `includeModels: false` to skip `grok models` and verify only CLI discovery/version. With the default behavior, `grok_check` runs `grok models` and `ok: true` means both discovery and model probing succeeded.

`alwaysApprove` defaults to false and is only passed when explicitly true.

`reasoningEffort` is passed through only when the plugin does not know it is unsupported. The local default model `grok-composer-2.5-fast` does not support `--reasoning-effort`; the plugin warns and does not pass that flag for that model. If no model is specified, the plugin also warns and does not pass `--reasoning-effort`, because the local default may be `grok-composer-2.5-fast`.

## Privacy Boundary

This plugin does not copy Codex hidden context, system/developer messages, tool outputs, hidden reasoning, secrets, or Grok auth tokens into prompts.

Grok CLI child processes receive only the plugin-declared environment allowlist: `GROK_BIN`, `HOME`, and `PATH`.

Prompts that ask Grok to read Codex private runtime paths such as `~/.codex` are rejected by default. Set `allowCodexPrivatePaths: true` only when the user explicitly asks for that risk and understands it.

This boundary does not redact arbitrary user-provided text. If a caller pastes secrets, private tool output, or sensitive file contents into `prompt`, `problem`, or `target`, that text is passed to Grok.

## Development

```bash
npm install
npm run check
git diff --check
```

Optional authenticated live smoke:

```bash
npm run smoke:live-grok
```

Keep these files aligned whenever tools change:

- `README.md`
- `plugins/grok-plugin-codex/README.md`
- `plugins/grok-plugin-codex/skills/grok/SKILL.md`
- `plugins/grok-plugin-codex/src/tools.ts`
- `plugins/grok-plugin-codex/src/server.ts`
- `scripts/smoke-mcp.mjs`

See [docs/development.md](docs/development.md) and [docs/verification.md](docs/verification.md).

## Project Policies

- [Privacy Policy](docs/privacy.md)
- [Terms of Use](docs/terms.md)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
