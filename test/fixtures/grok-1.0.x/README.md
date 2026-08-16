# Recorded Grok 1.0.x stream fixtures

Redacted excerpts of real `--output-format streaming-json` captures produced by Grok CLI 1.0.x
(recorded 2026-08, `~/.local/state/grok-plugin-codex/jobs/*.stdout.log`).

Only **event shapes** and vendor-emitted control values are preserved:

- `type`, event ordering, `status` on tool events;
- `stopReason` exactly as the CLI emitted it (`end_turn`, `cancelled` — snake_case);
- numeric `usage` counters;
- the vendor product message on `error` events.

Everything else is removed before the fixture is written: every `text`/`thought` payload is
replaced with `[redacted … chunk N]`, tool inputs/outputs/locations/titles are emptied,
`available_commands` payloads are dropped, and session/request IDs are replaced with synthetic
UUIDs. No prompt text, workspace path, file content, or user data is present.

These fixtures exist so the parser can be regression-tested against the **real** stop-reason
vocabulary without calling the Grok API. Unit tests must never invoke the live CLI.
