# Privacy Policy

Effective date: July 8, 2026

`grok-plugin-codex` is a local Codex plugin. It does not run a hosted service operated by this project, and this project does not collect telemetry, analytics, account data, or payment data.

## What Runs Locally

The plugin starts a local Node.js MCP server and calls the Grok CLI installed on the user's machine. Tool inputs, prompts, selected working directories, command output, and background job metadata stay in the user's local environment unless the local Grok CLI or the user sends them elsewhere.

## Data Sent To Grok

When a user runs a Grok tool, the plugin passes the user-provided prompt or wrapper prompt to the local Grok CLI. The Grok CLI may send that content to Grok/xAI services according to the user's Grok CLI configuration and xAI terms. This project does not control xAI's processing.

Users should not paste secrets, credentials, private tool output, or sensitive files into prompts. The plugin does not redact arbitrary user-provided prompt text.

## Local Logs

Background jobs write local job records and stdout/stderr logs under `.grok-plugin-codex/jobs` inside the selected working directory. These paths are ignored by this repository's git and npm packaging rules, but users are responsible for their own workspaces.

## Environment

Grok child processes receive only the plugin-declared environment allowlist: `GROK_BIN`, `HOME`, and `PATH`.

## Contact

For privacy or security concerns, use GitHub security advisories for this repository when available. Do not include secrets in public issues.
