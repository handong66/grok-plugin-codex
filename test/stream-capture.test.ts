import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  StreamCapture,
  sanitizeStreamLine
} from "../plugins/grok-plugin-codex/src/stream-capture.js";
import { grokResult, grokRun } from "../plugins/grok-plugin-codex/src/tools.js";
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

async function stdoutLog(stateDir: string): Promise<string> {
  const entries = await readdir(join(stateDir, "jobs"));
  const log = entries.find((entry) => entry.endsWith(".stdout.log"));
  if (!log) throw new Error("No stdout log was written.");
  return await readFile(join(stateDir, "jobs", log), "utf8");
}

/** Streams `count` tool_call_update events of `chars` each, then a short answer. */
function echoHeavyGrok(count: number, chars: number): string {
  return [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") { console.log("grok fake 1.0.3"); process.exit(0); }',
    'if (args[0] === "--help") { console.log("--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search"); process.exit(0); }',
    `const blob = "e".repeat(${chars});`,
    `for (let i = 0; i < ${count}; i += 1) {`,
    '  console.log(JSON.stringify({ type: "tool_call_update", toolCallId: "tool-" + i, rawOutput: { text: blob } }));',
    "}",
    'console.log(JSON.stringify({ type: "text", data: "FINAL ANSWER SURVIVES" }));',
    'console.log(JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "echo-session" }));'
  ].join("\n");
}

describe("stream capture (GPC-03a)", () => {
  it("elides oversized tool payloads and drops available_commands, never text", () => {
    const blob = "x".repeat(5_000);
    const toolLine = JSON.stringify({ type: "tool_call_update", toolCallId: "t1", rawOutput: { text: blob } });
    const commandsLine = JSON.stringify({ type: "available_commands", commands: [blob] });
    const textLine = JSON.stringify({ type: "text", data: blob });

    const tool = sanitizeStreamLine(toolLine);
    const commands = sanitizeStreamLine(commandsLine);
    const text = sanitizeStreamLine(textLine);

    expect(tool.text).toContain("<elided 5000 bytes>");
    expect(tool.text).not.toContain(blob);
    expect(JSON.parse(tool.text).toolCallId).toBe("t1");
    expect(commands.text).not.toContain(blob);
    expect(JSON.parse(commands.text).type).toBe("available_commands");
    // The answer is never rewritten, however large it is.
    expect(text.text).toBe(textLine);
    expect(text.textChars).toBe(5_000);
    expect(sanitizeStreamLine(toolLine, true).text).toBe(toolLine);
  });

  it("appends the delta and rewrites only when the window evicts", () => {
    // Two 29-character lines fit; the third forces an eviction.
    const capture = new StreamCapture({ maxChars: 70 });

    capture.append('{"type":"text","data":"one"}\n');
    const first = capture.takeWrite();
    capture.append('{"type":"text","data":"two"}\n');
    const second = capture.takeWrite();

    expect(first?.mode).toBe("append");
    expect(second?.mode).toBe("append");
    expect(second?.value).toBe('{"type":"text","data":"two"}\n');
    // Nothing new to write between chunks.
    expect(capture.takeWrite()).toBeUndefined();

    capture.append('{"type":"text","data":"three"}\n');
    const third = capture.takeWrite();

    expect(third?.mode).toBe("rewrite");
    expect(capture.truncated).toBe(true);
    expect(capture.droppedTextChars).toBeGreaterThan(0);
    expect(capture.value).toBe(third?.value);
  });

  it("counts only text-event characters as answer loss", () => {
    const capture = new StreamCapture({ maxChars: 200 });
    const echo = JSON.stringify({ type: "tool_call_update", toolCallId: "t", rawOutput: "y".repeat(150) });

    capture.append(`${echo}\n${echo}\n${echo}\n`);
    capture.append(`${JSON.stringify({ type: "text", data: "kept" })}\n`);
    capture.finish();

    expect(capture.truncated).toBe(true);
    expect(capture.droppedTextChars).toBe(0);
    expect(capture.textChars).toBe(4);
    expect(capture.value).toContain("kept");
  });

  it("does not mark a complete answer truncated when only tool echo overflowed the window", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    // ~700 x 1800 characters of echo: more than the 1,000,000-character capture window.
    const grokBin = await makeExecutable(join(dir, "grok"), echoHeavyGrok(700, 1_800));

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "echo heavy", background: false, timeoutMs: 60_000 })
      )
    );

    // Before GPC-03a this was `incomplete_output` with data:null: tool echo alone set
    // outputTruncated, which forced resultComplete false on a finished answer.
    expect(parsed.ok).toBe(true);
    expect(parsed.data.finalText).toBe("FINAL ANSWER SURVIVES");
    expect(parsed.data.outputSummary.resultComplete).toBe(true);
    expect(parsed.data.outputSummary.outputTruncated).toBe(true);
    expect(parsed.data.outputSummary.textTruncated).toBe(false);
  }, 60_000);

  it("keeps oversized tool payloads out of the persisted log unless raw capture is requested", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const rawStateDir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), echoHeavyGrok(3, 5_000));

    await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "elide", background: false, timeoutMs: 30_000 })
    );
    await withEnv(
      { GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: rawStateDir, GROK_PLUGIN_RAW_CAPTURE: "1" },
      () => grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "raw", background: false, timeoutMs: 30_000 })
    );
    const elided = await stdoutLog(stateDir);
    const raw = await stdoutLog(rawStateDir);

    expect(elided).toContain("<elided 5000 bytes>");
    expect(elided).not.toContain("e".repeat(5_000));
    expect(elided).toContain("FINAL ANSWER SURVIVES");
    expect(raw).toContain("e".repeat(5_000));
  }, 60_000);

  it("omits the raw per-token tails from grok_result unless they are asked for", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), echoHeavyGrok(2, 100));

    const started = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "tails", timeoutMs: 30_000 })
      )
    );
    const jobId = started.data.job.id as string;
    const quiet = await withEnv({ GROK_PLUGIN_STATE_DIR: stateDir }, async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const parsed = envelope(await grokResult({ jobId }));
        if (parsed.data?.job.status !== "queued" && parsed.data?.job.status !== "running") return parsed;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      throw new Error("Job never reached a terminal state.");
    });
    const loud = envelope(
      await withEnv({ GROK_PLUGIN_STATE_DIR: stateDir }, () => grokResult({ jobId, includeRawTail: true }))
    );

    expect(quiet.data.finalText).toBe("FINAL ANSWER SURVIVES");
    expect(quiet.data.stdoutTail).toBeUndefined();
    expect(quiet.data.stderrTail).toBeUndefined();
    expect(loud.data.stdoutTail).toContain("tool_call_update");
    expect(loud.data.stderrTail).toBeDefined();
  }, 60_000);
});
