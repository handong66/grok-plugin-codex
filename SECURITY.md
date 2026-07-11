# Security Policy

## Supported Versions

Security fixes are handled on the `main` branch. Until this project publishes stable releases, report issues against the latest commit on `main`.

## Reporting A Vulnerability

Please report sensitive security issues through GitHub security advisories for this repository when available.

Do not include secrets, exploit details, private logs, or account data in public issues. If advisories are unavailable, open a minimal public issue that says a private security report is needed, without sensitive details.

## Scope

In scope:

- Prompt or path handling that can expose Codex private runtime context without explicit user authorization.
- Environment leakage beyond the documented Grok child-process allowlist.
- Job-state handling that can escape the plugin-owned private state directory or bypass the authorized workspace boundary.
- Process-tree, cancellation, timeout, or prompt-cleanup failures on supported macOS/Linux hosts that can leave Grok work running after a terminal result.
- MCP tool behavior that misrepresents incomplete Grok output as a final result.

Out of scope:

- Vulnerabilities in the Grok CLI, xAI services, Node.js, npm, Codex, or the user's local operating system.
- User-provided prompts that intentionally include secrets or sensitive data.
- Social engineering or attacks against maintainers or users.

## Security Design Notes

The plugin is designed to avoid copying Codex hidden context, system/developer messages, hidden reasoning, tool outputs, secrets, and private runtime paths into Grok prompts unless the user explicitly authorizes that risk.
