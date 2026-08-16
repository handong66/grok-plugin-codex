import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grokResult, grokRun } from "../plugins/grok-plugin-codex/src/tools.js";
import { makeExecutable, tempDir } from "./helpers.js";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function onlyRecord(stateDir: string): Promise<Record<string, any>> {
  const entries = await readdir(join(stateDir, "jobs"));
  const record = entries.find((entry) => entry.endsWith(".json"));
  if (!record) throw new Error("No job record was written.");
  return JSON.parse(await readFile(join(stateDir, "jobs", record), "utf8")) as Record<string, any>;
}

/**
 * The 2026-08 window shows `sessionId` only ever appears in the `end` event, which is exactly the
 * event a timed-out or killed run never emits: 88/128 jobs had `grokSessionId: undefined` forever.
 * A CLI that advertises `--session-id` lets the plugin choose the id up front instead.
 */
function grokWithSessionIdSupport(body: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then
  echo "--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search"
  echo "  -s, --session-id <SESSION_ID>  Use a specific session UUID for a new conversation"
  exit 0
fi
${body}
`;
}

describe("recovery handles (GPC-05)", () => {
  it("assigns the session id itself before the worker starts", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const argsFile = join(dir, "argv.log");
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      grokWithSessionIdSupport(
        `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
printf '%s\\n' '{"type":"text","data":"partial"}'`
      )
    );

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "no end event", background: false, timeoutMs: 20_000 })
      )
    );
    const argv = (await readFile(argsFile, "utf8")).trim().split("\n");
    const record = await onlyRecord(stateDir);
    const assigned = argv[argv.indexOf("--session-id") + 1];

    expect(argv).toContain("--session-id");
    expect(assigned).toMatch(UUID);
    // The run never emitted an `end` event, so this handle exists only because the plugin chose it.
    expect(record.grokSessionId).toBe(assigned);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.details.recovery.grokSessionId).toBe(assigned);
    expect(parsed.error.details.recovery.suggested.tool).toBe("grok_continue");
    expect(parsed.error.details.recovery.suggested.args.sessionId).toBe(assigned);
    expect(parsed.error.details.recovery.suggested.args.maxTurns).toBe(1);
    expect(parsed.error.details.recovery.suggested.args.prompt).toContain("Stop using tools");
    expect(parsed.error.details.recovery.jobId).toBe(record.id);
    expect(parsed.error.details.finalTextRef).toBe(record.id);
    expect(parsed.error.details.recovery.partialTextChars).toBe("partial".length);
  }, 30_000);

  it("degrades to continueLatest with an explicit ambiguity warning when the CLI cannot take a session id", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 0.2.93"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search"; exit 0; fi
printf '%s\\n' '{"type":"text","data":"partial"}'
`
    );

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "legacy cli", background: false, timeoutMs: 20_000 })
      )
    );
    const record = await onlyRecord(stateDir);

    expect(record.args).not.toContain("--session-id");
    expect(record.grokSessionId).toBeUndefined();
    expect(parsed.error.details.recovery.suggested.args.continueLatest).toBe(true);
    expect(parsed.error.details.recovery.suggested.args.sessionId).toBeUndefined();
    expect(parsed.warnings.join(" ")).toContain("latest session");
  }, 30_000);

  it("never destroys the partial answer: grok_result returns full text and a handle for an incomplete job", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      grokWithSessionIdSupport(
        `printf '%s\\n' '{"type":"text","data":"a long partial answer that must survive"}' '{"type":"end","stopReason":"cancelled","sessionId":"vendor-session"}'`
      )
    );

    const started = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "cancelled run", background: false, timeoutMs: 20_000 })
      )
    );
    const jobId = started.error.details.recovery.jobId as string;
    const fetched = envelope(await withEnv({ GROK_PLUGIN_STATE_DIR: stateDir }, () => grokResult({ jobId })));

    expect(started.error.code).toBe("cancelled_output");
    expect(fetched.ok).toBe(true);
    expect(fetched.data.resultComplete).toBe(false);
    expect(fetched.data.finalText).toBe("a long partial answer that must survive");
    expect(fetched.data.recovery.jobId).toBe(jobId);
    expect(fetched.data.recovery.suggested.args.cwd).toBeTruthy();
    expect(fetched.data.recovery.partialTextChars).toBe("a long partial answer that must survive".length);
  }, 30_000);

  it("points max_turns_reached at a tool-free continuation instead of a wider budget", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      grokWithSessionIdSupport(
        `printf '%s\\n' '{"type":"text","data":"ran out of turns"}' '{"type":"max_turns_reached"}'
exit 1`
      )
    );

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "turn budget", background: false, timeoutMs: 20_000 })
      )
    );

    expect(parsed.error.code).toBe("max_turns_reached");
    expect(parsed.error.message.toLowerCase()).toContain("do not use any tools");
    expect(parsed.error.details.guidance.toLowerCase()).toContain("do not use any tools");
    expect(parsed.error.details.recovery.suggested.args.sessionId).toMatch(UUID);
  }, 30_000);
});
