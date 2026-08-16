import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grokResult, grokRun, grokStatus } from "../plugins/grok-plugin-codex/src/tools.js";
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

const USER_CODE = "DKEE-54RK";
/** The recorded shape: the CLI prints the device flow to stderr and then waits, forever. */
const DEVICE_AUTH_GROK = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search"; exit 0; fi
{
  echo ""
  echo "To sign in, open this URL in your browser:"
  echo ""
  echo "  https://accounts.x.ai/oauth2/device?user_code=${USER_CODE}"
  echo ""
  echo "Waiting for authorization..."
} >&2
sleep 120
`;

describe("device authorization fast-fail (GK1)", () => {
  it("fails a waiting-for-authorization job in seconds instead of burning the whole budget", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), DEVICE_AUTH_GROK);

    const startedAt = Date.now();
    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "unattended work", background: false, timeoutMs: 60_000 })
      )
    );
    const elapsed = Date.now() - startedAt;

    // The recorded incident burned the full 600000ms during an unattended overnight run.
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("auth_required");
    expect(parsed.error.retryable).toBe(false);
    expect(elapsed).toBeLessThan(30_000);
    // The message must be actionable without echoing the one-time device code.
    expect(parsed.error.message).toContain("accounts.x.ai");
    expect(parsed.error.message).not.toContain(USER_CODE);
    expect(JSON.stringify(parsed)).not.toContain(USER_CODE);
  }, 60_000);

  it("exposes waitingForAuth on the cheap status path and keeps the code out of raw tails", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), DEVICE_AUTH_GROK);

    const started = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "unattended work", timeoutMs: 60_000 })
      )
    );
    const jobId = started.data.job.id as string;
    const waited = await withEnv({ GROK_PLUGIN_STATE_DIR: stateDir }, async () => {
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const parsed = envelope(await grokStatus({ jobId }));
        if (parsed.data?.job.waitingForAuth) return parsed;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      throw new Error("waitingForAuth was never reported.");
    });
    const fetched = envelope(
      await withEnv({ GROK_PLUGIN_STATE_DIR: stateDir }, () => grokResult({ jobId, includeRawTail: true }))
    );

    expect(waited.data.job.waitingForAuth).toBe(true);
    expect(fetched.data.stderrTail).toContain("accounts.x.ai");
    expect(fetched.data.stderrTail).toContain("user_code=<redacted>");
    expect(fetched.data.stderrTail).not.toContain(USER_CODE);
  }, 60_000);
});
