# Verification

Offline gate, 0.3.0: verified 2026-08-16 — `npm run check` green on macOS 26.6.1 (darwin 25.6.0),
Node v25.9.0. This records that the deterministic gate passed on one machine. It observed no Grok CLI
and therefore says nothing about CLI compatibility.

Live gate, 0.3.0: **not run**. `npm run smoke:live-grok` has not been executed for this release, so
nothing in this file establishes that 0.3.0 works against any Grok CLI version. It is required before
publishing (see below), and the line recording it must name the CLI version it ran against.

Previous dated record: 0.2.1 was verified on 2026-07-11 against Grok CLI 1.0.3 on macOS.

Every release must add both lines: a dated offline line, and a dated live line naming the CLI version
it was verified against. An offline line never substitutes for the live one, and a record without a
date and a CLI version cannot be used to answer "did this ever work with that CLI".

The everyday checks are local and deterministic. Authenticated model calls are a separate gate — kept out of `npm test` and `npm run check`, and required at release — because CLI discovery, login, model listing, and successful invocation are different facts.

## Required gate

```bash
npm run check
git diff --check
```

CI runs the same gate on `ubuntu-latest` and `macos-latest`
([.github/workflows/pull-request-ci.yml](../.github/workflows/pull-request-ci.yml)) and fails if the
committed bundles differ from a fresh build. Release candidates additionally run
`GROK_PLUGIN_RELEASE=1 npm run validate:plugin`, which rejects a manifest still carrying the local
`+codex.<cachebuster>` suffix.

`npm run check` performs:

1. TypeScript typecheck.
2. Bundling of `server.js` and `job-worker.js`.
3. Unit and cross-process lifecycle tests.
4. Plugin/marketplace validation.
5. MCP tool-list and schema smoke testing.

The lifecycle suite covers MCP restart, natural completion, cancel markers, process-tree cancellation, timeout, forced worker death with verified orphan reaping, foreground MCP exit, monotonic terminal state, private permissions, prompt-descriptor handoff/cleanup, final-text parsing, truncation, symlink boundaries, and workspace state pollution in both containment directions.

Validate both skills with the current `skill-creator` validator:

```bash
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/grok-plugin-codex/skills/grok
python3 /path/to/skill-creator/scripts/quick_validate.py /path/to/Dong-skills/skills/grok-codex-collaboration
```

## Required live gate (release only)

```bash
npm run smoke:live-grok
```

The live smoke uses an explicit workspace, disables web search and subagents, requests one exact sentinel, and verifies `data.finalText`. Set `GROK_SMOKE_MODEL` only when an explicit model must be tested; otherwise Grok's configured default is used.

Status for 0.3.0: not run. The release is blocked on it, and its output belongs in the dated live line
at the top of this file.

This is **required before publishing a release**, not optional. It is the only gate that observes the real Grok stream vocabulary: the 0.2.1 stop-reason regression (`EndTurn` vs `end_turn`) passed every offline gate for a month because no mandatory check ever saw a live `end` event. It stays out of `npm run check` and out of `npm test` on purpose — unit tests must never call the real API, and the account behind this plugin has repeatedly exhausted its free tier.

`grok_check { probeInvocation: true }` is the same evidence on demand: one bounded call (`--max-turns 1`, 30s cap) that asserts a `text` event and an `end` event normalising to `endturn`, reported as `modelInvocationTested` / `callable` / `observedStopReason`. It is opt-in for the same quota reason and must never be wired into a routine health check.

## Release and installed-path gate

Before publishing:

```bash
npm run check
npm run smoke:live-grok
npm audit --omit=dev
npm pack --dry-run
```

Then update the plugin cachebuster, reinstall from the confirmed local marketplace, start a new Codex task, and verify:

- installed version and cache path correspond to the new manifest;
- `listTools` has no removed arguments and all tools have output schemas;
- `grok_check(includeModels:false)` proves discovery/capabilities only;
- `grok_check()` separately reports authentication/model listing;
- one safe live invocation proves actual callability;
- repo source, marketplace source, installed bundle, and generated `dist` hashes match where expected.

Leave the single cachebuster suffix in the source manifest while a configured local marketplace points directly at that repository. If a new Codex Desktop task sees the new skill but not the new MCP tools while `codex mcp list` shows the server enabled, restart Codex Desktop and repeat the new-task check; Desktop can retain a process-level MCP registry across reinstall.

Record fresh outputs for the release under review; do not reuse a previous release ledger.
