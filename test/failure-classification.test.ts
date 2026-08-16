import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyGrokErrorText,
  grokFailureDetails,
  grokFailureMessage,
  isRetryableGrokFailure
} from "../plugins/grok-plugin-codex/src/grok-cli.js";
import { errorEventText } from "../plugins/grok-plugin-codex/src/result-parser.js";
import { grokRun } from "../plugins/grok-plugin-codex/src/tools.js";
import { makeExecutable, tempDir } from "./helpers.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function envelope(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

async function withEnv<T>(values: Record<string, string | undefined>, operation: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Verbatim vendor strings from the recorded window. Note the U+2019 apostrophe in "You’ve": an
 * ASCII-apostrophe pattern would never have matched, which is how 10 free-limit failures were
 * reported as retryable `grok_failed`.
 */
const FREE_TIER_STDERR =
  "You’ve reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok?referrer=grok-build";
const SPENDING_LIMIT_STDERR =
  "Error: 403 Forbidden: personal-team-blocked:spending-limit: You have run out of credits";
const PAYMENT_REQUIRED_STDERR = "HTTP 402 Payment Required: usage balance exhausted";

describe("quota and auth classification (GPC-04)", () => {
  it("classifies the real free-tier limit text as its own non-retryable code", () => {
    const code = classifyGrokErrorText(FREE_TIER_STDERR);

    expect(code).toBe("quota_free_tier");
    expect(isRetryableGrokFailure(code)).toBe(false);
    expect(grokFailureMessage(code).toLowerCase()).toContain("do not retry");
    expect(grokFailureDetails(code)?.retryAfterHint).toBeTruthy();
  });

  it("classifies a 403 spending-limit as exhausted balance rather than an auth problem", () => {
    const code = classifyGrokErrorText(SPENDING_LIMIT_STDERR);

    expect(code).toBe("quota_exhausted");
    expect(isRetryableGrokFailure(code)).toBe(false);
  });

  it("still classifies 402 Payment Required as exhausted balance", () => {
    expect(classifyGrokErrorText(PAYMENT_REQUIRED_STDERR)).toBe("quota_exhausted");
  });

  it("no longer calls every 'forbidden' or 'unauthorized' an auth failure", () => {
    // These are ordinary words in a security review, and the classifier is a substring matcher.
    expect(classifyGrokErrorText("Finding: the endpoint returns 403 Forbidden for unauthorized callers.")).not.toBe(
      "auth_required"
    );
    expect(classifyGrokErrorText("unauthorized access is possible")).not.toBe("auth_required");
    expect(classifyGrokErrorText("Grok CLI: you are not logged in")).toBe("auth_required");
    expect(classifyGrokErrorText("HTTP 401 Unauthorized: token expired")).toBe("auth_required");
  });

  it("does not read a tool error's session_id as a missing session (X5)", () => {
    // The recorded stderr line. `session_id=<uuid>` contains the bare substring the old rule matched
    // on, and the worker feeds the classifier the whole stderr — so a Read that failed on a path that
    // does not exist came back as a non-retryable `session_not_found`, which can also drive
    // grok_continue's fallbackToLatest onto an unrelated session.
    const toolError =
      'ERROR tool_error: tool_output_error session_id=019f436e-b14c-7c23-b7f4-505e81ef1f3b tool_name="Read" ' +
      'error="File does not exist: /repo/src/missing.ts"';

    expect(classifyGrokErrorText(toolError)).toBe("model_tool_incompatible");
    expect(isRetryableGrokFailure(classifyGrokErrorText(toolError))).toBe(false);
  });

  it("still classifies the real missing-session texts as session_not_found (X5)", () => {
    // GK8's recorded failure, plus the phrases a bounded matcher must keep.
    expect(classifyGrokErrorText("Failed to restore session from remote: 404 Not Found")).toBe("session_not_found");
    expect(classifyGrokErrorText("Session 01a00152-52ee-7252-9e7c-9682d567a118 not found")).toBe("session_not_found");
    expect(classifyGrokErrorText("that session does not exist")).toBe("session_not_found");
    // A tool payload that merely mentions a session id is not one of them.
    expect(classifyGrokErrorText("session_id=019f436e read failed: file not found")).not.toBe("session_not_found");
  });

  it("extracts only vendor error events from a stream, never the answer text", async () => {
    const fixture = await readFile(
      fileURLToPath(new URL("./fixtures/grok-1.0.x/free-tier-quota-error.jsonl", import.meta.url)),
      "utf8"
    );
    const answer = [
      JSON.stringify({ type: "text", data: "Finding 1: callers are not logged in when the token expires." }),
      JSON.stringify({ type: "thought", data: "403 forbidden everywhere" }),
      JSON.stringify({ type: "end", stopReason: "end_turn" })
    ].join("\n");

    expect(errorEventText(fixture)).toContain("reached your free");
    expect(errorEventText(answer)).toBe("");
    expect(classifyGrokErrorText(errorEventText(fixture))).toBe("quota_free_tier");
  });

  it("reports a free-tier exhaustion job as non-retryable with actionable text", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search"; exit 0; fi
echo ${JSON.stringify(FREE_TIER_STDERR)} >&2
exit 1
`
    );

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "quota", background: false, timeoutMs: 20_000 })
      )
    );

    expect(parsed.error.code).toBe("quota_free_tier");
    expect(parsed.error.retryable).toBe(false);
    expect(parsed.error.details.retryAfterHint).toBeTruthy();
  }, 30_000);

  it("does not read Grok's own review body as an authentication failure", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    // A security review whose findings mention login and 403 handling, with no vendor error at all.
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search"; exit 0; fi
printf '%s\\n' '{"type":"text","data":"Finding 1: unauthorized callers get 403 Forbidden; the client is not logged in and authentication required is never surfaced."}'
exit 1
`
    );

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "review auth handling", background: false, timeoutMs: 20_000 })
      )
    );

    expect(parsed.error.code).not.toBe("auth_required");
    expect(parsed.error.code).toBe("grok_failed");
  }, 30_000);
});
