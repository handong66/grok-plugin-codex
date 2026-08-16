import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobStore } from "../plugins/grok-plugin-codex/src/job-store.js";
import { runJobWorker } from "../plugins/grok-plugin-codex/src/job-worker.js";
import type { JobRecord } from "../plugins/grok-plugin-codex/src/types.js";
import { makeExecutable, tempDir } from "./helpers.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

async function waitForTerminal(store: JobStore, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const record = await store.read(jobId);
    if (TERMINAL.has(record.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Job ${jobId} never reached a terminal state.`);
}

function fakeGrok(): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents"; exit 0; fi
printf '%s\\n' '{"type":"tool_call","toolCallId":"t1","name":"read_file","data":{"path":"/tmp/a.ts"}}' '{"type":"text","data":"first "}' '{"type":"text","data":"second"}' '{"type":"end","stopReason":"end_turn","sessionId":"ledger-session","requestId":"ledger-request"}'
`;
}

async function startJob(): Promise<{ store: JobStore; jobId: string }> {
  const workspace = await tempDir();
  const stateDir = await tempDir();
  const grokBin = await makeExecutable(join(workspace, "grok"), fakeGrok());
  const store = new JobStore({ stateDir, env: { ...process.env, GROK_BIN: grokBin } });
  const job = await store.startGrokJob({
    kind: "run",
    cwd: workspace,
    args: ["--cwd", workspace, "--output-format", "streaming-json"],
    prompt: "ledger",
    timeoutMs: 30_000
  });
  await waitForTerminal(store, job.id);
  return { store, jobId: job.id };
}

describe("GPC-03b final-text ledger", () => {
  it("persists the answer text and a stream summary alongside the raw log", async () => {
    const { store, jobId } = await startJob();

    const finalText = await readFile(store.finalTextPath(jobId), "utf8");
    const summary = JSON.parse(await readFile(store.summaryPath(jobId), "utf8"));

    expect(finalText).toBe("first second");
    expect(summary.stopReason).toBe("end_turn");
    expect(summary.grokSessionId).toBe("ledger-session");
    expect(summary.requestId).toBe("ledger-request");
    expect(summary.sawEnd).toBe(true);
    expect(summary.textChars).toBe("first second".length);
    expect(summary.eventCounts.text).toBe(2);
    expect(summary.toolCallCount).toBe(1);
    expect(typeof summary.lastEventAt).toBe("string");

    for (const path of [store.finalTextPath(jobId), store.summaryPath(jobId)]) {
      expect((await stat(path)).mode & 0o077).toBe(0);
    }
  });

  it("answers grok_result from the ledger instead of re-parsing the raw stream", async () => {
    const { store, jobId } = await startJob();

    // The ledger is the source of truth for a terminal job: emptying the 4MB-scale raw log must not
    // change the answer, which is exactly the re-parse this item removes from the 656 result calls.
    await writeFile(store.stdoutPath(jobId), "", { mode: 0o600 });
    const result = await store.result(jobId);

    expect(result.outputSummary.finalText).toBe("first second");
    expect(result.outputSummary.resultComplete).toBe(true);
    expect(result.outputSummary.stopReason).toBe("end_turn");
    expect(result.outputSummary.toolCallCount).toBe(1);
  });

  it("falls back to a full re-parse for records written before the ledger existed", async () => {
    const { store, jobId } = await startJob();

    // A 0.2.x record has no summary file; the raw log is all there is.
    await writeFile(store.summaryPath(jobId), "", { mode: 0o600 });
    const result = await store.result(jobId);

    expect(result.outputSummary.finalText).toBe("first second");
    expect(result.outputSummary.resultComplete).toBe(true);
  });

  it("accepts a pre-marker state directory that already holds ledger artifacts", async () => {
    const stateDir = await tempDir();
    const jobsDir = join(stateDir, "jobs");
    await mkdir(jobsDir, { recursive: true, mode: 0o700 });
    const jobId = "job_premarkerledger00000000";
    const record = {
      id: jobId,
      kind: "run",
      status: "succeeded",
      cwd: "/tmp",
      command: "/usr/bin/grok",
      args: [],
      createdAt: new Date().toISOString(),
      timeoutMs: 1_000
    };
    await writeFile(join(jobsDir, `${jobId}.json`), JSON.stringify(record), { mode: 0o600 });
    await writeFile(join(jobsDir, `${jobId}.final.txt`), "hello", { mode: 0o600 });
    await writeFile(join(jobsDir, `${jobId}.summary.json`), "{}", { mode: 0o600 });

    const store = new JobStore({ stateDir });

    await expect(store.ensure()).resolves.toBeUndefined();
  });
});

const LEDGER_JOB_ID = "job_1700000000001_beefcafe";

/**
 * Points `<id>.final.txt` at a path *under* a file, so the append fails with ENOTDIR. The failing
 * writes are chosen by call number rather than by the clock: call 1 is the worker creating the empty
 * ledger, and every later call is one append of one consumed delta.
 */
class BrokenLedgerStore extends JobStore {
  ledgerPathCalls = 0;
  breakCall: (call: number) => boolean = () => false;

  override finalTextPath(jobId: string): string {
    const path = super.finalTextPath(jobId);
    this.ledgerPathCalls += 1;
    return this.breakCall(this.ledgerPathCalls) ? join(path, "unwritable") : path;
  }
}

/** Streams the answer in three parts, so the run really does flush more than once. */
async function pacedGrok(dir: string): Promise<string> {
  return await makeExecutable(
    join(dir, "paced-grok.mjs"),
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('grok fake 1.0.3'); process.exit(0); }",
      "if (args[0] === '--help') { console.log('--prompt-file --output-format streaming-json --permission-mode plan --no-subagents'); process.exit(0); }",
      "const emit = (event) => console.log(JSON.stringify(event));",
      "emit({ type: 'text', data: 'first ' });",
      "setTimeout(() => {",
      "  emit({ type: 'text', data: 'LOSTCHUNK' });",
      "  setTimeout(() => {",
      "    emit({ type: 'text', data: ' last' });",
      "    emit({ type: 'end', stopReason: 'end_turn', sessionId: 'ledger-session', requestId: 'ledger-request' });",
      "  }, 200);",
      "}, 200);"
    ].join("\n")
  );
}

async function seedLedgerJob(store: JobStore, command: string, cwd: string): Promise<void> {
  const record: JobRecord = {
    id: LEDGER_JOB_ID,
    kind: "run",
    status: "queued",
    cwd,
    command,
    args: ["--cwd", cwd, "--output-format", "streaming-json"],
    createdAt: new Date().toISOString(),
    timeoutMs: 15_000,
    processToken: randomUUID(),
    workerPid: process.pid
  };
  await store.write(record);
  await writeFile(store.inputPath(LEDGER_JOB_ID), "ledger append failure", { mode: 0o600 });
}

/**
 * GPC-03b's invariant is that the ledger and the fallback re-parse cannot disagree. A failed append
 * is the one way they can: `takeText()` has already consumed the delta by the time the write throws.
 */
describe("GPC-03b ledger append failures", () => {
  it("does not answer from a ledger whose append failed", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const store = new BrokenLedgerStore({ stateDir, env: { GROK_PLUGIN_STATE_DIR: stateDir } });
    const grokBin = await pacedGrok(dir);
    await seedLedgerJob(store, grokBin, dir);

    // Every append fails, so the answer on disk stays short for the whole run.
    store.breakCall = (call) => call > 1;
    try {
      await runJobWorker(LEDGER_JOB_ID, store);
    } finally {
      store.breakCall = () => false;
    }

    // The on-disk answer really is short, and the summary must say so instead of letting a reader
    // serve a chunk-less answer with `sawEnd`/`stopReason` still claiming a clean end_turn.
    expect(await readFile(store.finalTextPath(LEDGER_JOB_ID), "utf8")).not.toContain("LOSTCHUNK");
    expect(await store.readStreamFacts(LEDGER_JOB_ID)).toBeUndefined();

    const result = await store.result(LEDGER_JOB_ID);
    expect(result.outputSummary.finalText).toBe("first LOSTCHUNK last");
    expect(result.outputSummary.resultComplete).toBe(true);
  }, 20_000);

  it("re-queues the consumed delta so a transient append failure loses nothing", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const store = new BrokenLedgerStore({ stateDir, env: { GROK_PLUGIN_STATE_DIR: stateDir } });
    const grokBin = await pacedGrok(dir);
    await seedLedgerJob(store, grokBin, dir);

    // Only the first append fails; the delta it consumed must come back on a later flush.
    store.breakCall = (call) => call === 2;
    try {
      await runJobWorker(LEDGER_JOB_ID, store);
    } finally {
      store.breakCall = () => false;
    }

    expect(await readFile(store.finalTextPath(LEDGER_JOB_ID), "utf8")).toBe("first LOSTCHUNK last");
  }, 20_000);
});
