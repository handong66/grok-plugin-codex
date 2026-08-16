#!/usr/bin/env node
import { closeSync } from "node:fs";
import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  buildGrokProcessEnv,
  buildWorkerEnv,
  classifyGrokFailure,
  grokFailureMessage,
  isRetryableGrokFailure,
  signalPidTree,
  signalProcessTree
} from "./grok-cli.js";
import { JobStore } from "./job-store.js";
import { summarizeGrokOutput } from "./result-parser.js";
import type { JobRecord } from "./types.js";

const MAX_CAPTURE_CHARS = 1_000_000;
const MAX_ERROR_MESSAGE_CHARS = 500;
const MAX_STACK_TAIL_CHARS = 1_000;
const execFileAsync = promisify(execFile);

function boundedText(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/**
 * A worker that dies with `stdio: "ignore"` loses its exception text for good, so every failure
 * carries enough structure to name one session instead of forcing another log audit.
 */
function describeFailure(
  phase: string,
  error: unknown,
  teardownError?: string
): Record<string, unknown> {
  const asError = error instanceof Error ? error : undefined;
  const stack = asError?.stack ?? "";
  return {
    phase,
    errorName: asError?.name ?? typeof error,
    errorMessage: boundedText(asError?.message ?? String(error), MAX_ERROR_MESSAGE_CHARS),
    errnoCode: (error as NodeJS.ErrnoException | undefined)?.code,
    stackTail: stack ? stack.slice(-MAX_STACK_TAIL_CHARS) : undefined,
    ...(teardownError ? { teardownError } : {})
  };
}

function appendTail(current: string, chunk: string): { value: string; truncated: boolean } {
  const combined = current + chunk;
  if (combined.length <= MAX_CAPTURE_CHARS) return { value: combined, truncated: false };
  return { value: combined.slice(-MAX_CAPTURE_CHARS), truncated: true };
}

async function waitForReadyRecord(store: JobStore, jobId: string): Promise<JobRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await store.read(jobId);
    if (record.workerPid || record.status === "cancelled") return record;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Job ${jobId} did not receive its worker PID.`);
}

async function waitForPromptInput(store: JobStore, jobId: string): Promise<string> {
  const inputPath = store.inputPath(jobId);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const inputMetadata = await stat(inputPath).catch(() => null);
    if (inputMetadata?.isFile()) return inputPath;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Private prompt input was not made available to the Grok worker.");
}

async function writeLog(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function deliverPrompt(pipe: NodeJS.WritableStream | null, prompt: string): Promise<void> {
  if (!pipe) throw new Error("The inherited prompt descriptor was not created.");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    pipe.once("error", (error) => settle(error));
    pipe.once("finish", () => settle());
    pipe.end(prompt);
  });
}

async function processGroupMembers(pgid: number): Promise<number[]> {
  try {
    const result = await execFileAsync("ps", ["-axo", "pid=,pgid="], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 64 * 1_024
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((parts) => parts.length >= 2 && parts[1] === pgid && Number.isSafeInteger(parts[0]))
      .map((parts) => parts[0]);
  } catch {
    return [];
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function terminateLauncherDescendants(): Promise<void> {
  const descendants = async () => (await processGroupMembers(process.pid)).filter((pid) => pid !== process.pid);
  for (const pid of await descendants()) signalPid(pid, "SIGTERM");
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if ((await descendants()).length === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  for (const pid of await descendants()) signalPid(pid, "SIGKILL");
}

export async function runGrokLauncher(jobId: string, processToken: string, store = new JobStore()): Promise<number> {
  const record = await store.read(jobId);
  if (!record.processToken || record.processToken !== processToken) {
    throw new Error("Grok launcher ownership token mismatch.");
  }
  const grok = spawn(record.command, [...record.args, "--prompt-file", "/dev/fd/3"], {
    cwd: record.cwd,
    detached: false,
    stdio: ["ignore", "inherit", "inherit", 3],
    env: buildGrokProcessEnv(store.env)
  });
  try {
    closeSync(3);
  } catch {
    // The descriptor may already be closed if launcher setup failed.
  }
  const outcome = await new Promise<{ exitCode: number | null; error?: Error }>((resolvePromise) => {
    let settled = false;
    const finish = (value: { exitCode: number | null; error?: Error }) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    grok.once("error", (error) => finish({ exitCode: null, error }));
    grok.once("exit", (exitCode) => finish({ exitCode }));
  });
  await terminateLauncherDescendants();
  return outcome.error ? 1 : (outcome.exitCode ?? 1);
}

export async function runJobWorker(jobId: string, store = new JobStore()): Promise<void> {
  let record = await waitForReadyRecord(store, jobId);
  const inputPath = await waitForPromptInput(store, jobId);
  if (record.status === "cancelled") {
    await rm(inputPath, { force: true });
    return;
  }
  const prompt = await readFile(inputPath, "utf8");
  await rm(inputPath, { force: true });

  let child: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";
  let outputTruncated = false;
  let promptDeliveryError: Error | undefined;
  let teardownError: string | undefined;
  let timedOut = false;
  let cancelRequested = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let cancelPollTimer: NodeJS.Timeout | undefined;
  let cancelPollActive = false;
  let flushChain = Promise.resolve();
  let heartbeatChain = Promise.resolve();
  let cancelPollPromise = Promise.resolve();

  const flushLogs = () => {
    const stdoutSnapshot = stdout;
    const stderrSnapshot = stderr;
    flushChain = flushChain.catch(() => undefined).then(async () => {
      await Promise.all([
        writeLog(store.stdoutPath(jobId), stdoutSnapshot),
        writeLog(store.stderrPath(jobId), stderrSnapshot)
      ]);
    });
    void flushChain.catch(() => undefined);
    return flushChain;
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushLogs();
    }, 25);
    flushTimer.unref();
  };
  const requestCancel = () => {
    cancelRequested = true;
    signalProcessTree(child, "SIGTERM");
    forceKillTimer ??= setTimeout(() => signalProcessTree(child, "SIGKILL"), 2_000);
    forceKillTimer.unref();
  };
  process.on("SIGTERM", requestCancel);
  process.on("SIGINT", requestCancel);

  try {
    const queueHeartbeat = () => {
      heartbeatChain = heartbeatChain.catch(() => undefined).then(async () => {
        await writeFile(store.heartbeatPath(jobId), new Date().toISOString(), { mode: 0o600 });
        await chmod(store.heartbeatPath(jobId), 0o600);
      });
      return heartbeatChain;
    };
    await queueHeartbeat();
    heartbeatTimer = setInterval(() => void queueHeartbeat().catch(() => undefined), 250);
    heartbeatTimer.unref();
    cancelPollTimer = setInterval(() => {
      if (cancelPollActive) return;
      cancelPollActive = true;
      cancelPollPromise = store
        .isCancellationRequested(jobId)
        .then((requested) => {
          if (requested) requestCancel();
        })
        .finally(() => {
          cancelPollActive = false;
        });
      void cancelPollPromise.catch(() => undefined);
    }, 50);
    cancelPollTimer.unref();

    record.status = "running";
    record.startedAt = new Date().toISOString();
    await store.write(record);
    record = await store.read(jobId);
    if (["succeeded", "failed", "cancelled"].includes(record.status)) return;
    await Promise.all([writeLog(store.stdoutPath(jobId), ""), writeLog(store.stderrPath(jobId), "")]);

    if (!record.processToken) throw new Error("Missing Grok process ownership token.");
    child = spawn(process.execPath, [store.workerPath, "--launch-grok", jobId, record.processToken], {
      cwd: record.cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: buildWorkerEnv(store.env)
    });
    const launcherPid = child.pid;
    const outcomePromise = new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolvePromise) => {
      let settled = false;
      const finish = (value: { exitCode: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
        if (settled) return;
        settled = true;
        resolvePromise(value);
      };
      child?.once("error", (error) => finish({ exitCode: null, signal: null, error }));
      child?.once("exit", (exitCode, signal) => finish({ exitCode, signal }));
    });
    const streamsClosedPromise = new Promise<void>((resolvePromise) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      };
      child?.once("error", finish);
      child?.once("close", finish);
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const promptPipe = child.stdio[3] as NodeJS.WritableStream | null;
    const promptDelivery = deliverPrompt(promptPipe, prompt).catch((error) => {
      promptDeliveryError = error instanceof Error ? error : new Error(String(error));
      signalProcessTree(child, "SIGTERM");
    });
    child.stdout?.on("data", (chunk: string) => {
      const appended = appendTail(stdout, chunk);
      stdout = appended.value;
      outputTruncated ||= appended.truncated;
      scheduleFlush();
    });
    child.stderr?.on("data", (chunk: string) => {
      const appended = appendTail(stderr, chunk);
      stderr = appended.value;
      outputTruncated ||= appended.truncated;
      scheduleFlush();
    });
    record.pid = child.pid;
    await store.write(record);

    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, "SIGTERM");
      forceKillTimer ??= setTimeout(() => signalProcessTree(child, "SIGKILL"), 2_000);
      forceKillTimer.unref();
    }, record.timeoutMs);
    timeout.unref();

    const outcome = await outcomePromise;
    // Teardown must never decide the outcome. Every recorded `worker_error` in the 2026-08 window
    // was a wall-clock timeout whose classification was skipped because one of these steps threw.
    try {
      signalPidTree(launcherPid, "SIGKILL");
      await Promise.all([promptDelivery, streamsClosedPromise]);
      await flushLogs();
    } catch (error) {
      teardownError = boundedText(
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        MAX_ERROR_MESSAGE_CHARS
      );
    } finally {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (flushTimer) clearTimeout(flushTimer);
    }

    const latest = await store.read(jobId);
    latest.exitCode = outcome.exitCode;
    latest.signal = outcome.signal;
    latest.outputTruncated = outputTruncated;
    latest.finishedAt = new Date().toISOString();
    if (latest.status === "cancelled" || latest.cancelRequestedAt || cancelRequested) {
      latest.status = "cancelled";
    } else if (timedOut) {
      latest.status = "failed";
      latest.error = {
        code: "timeout",
        message: `Grok exceeded timeoutMs=${latest.timeoutMs}.`,
        retryable: true,
        details: { phase: "run", timeoutMs: latest.timeoutMs, ...(teardownError ? { teardownError } : {}) }
      };
    } else if (promptDeliveryError) {
      latest.status = "failed";
      latest.error = {
        code: "prompt_delivery_error",
        message: "The complete prompt could not be delivered to the Grok CLI.",
        retryable: true,
        details: describeFailure("prompt_delivery", promptDeliveryError, teardownError)
      };
    } else if (outcome.error) {
      latest.status = "failed";
      latest.error = {
        code: "spawn_error",
        message: "The Grok CLI process could not be started.",
        retryable: true,
        details: describeFailure("spawn", outcome.error, teardownError)
      };
    } else {
      const parsed = summarizeGrokOutput(
        { ...latest, status: outcome.exitCode === 0 ? "succeeded" : "failed" },
        stdout,
        stderr,
        outputTruncated
      );
      if (parsed.streamError) {
        latest.status = "failed";
        latest.error = parsed.streamError;
      } else {
        latest.status = outcome.exitCode === 0 ? "succeeded" : "failed";
        if (latest.status === "failed") {
          const code = classifyGrokFailure({
            command: latest.command,
            args: latest.args,
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            stdout,
            stderr,
            durationMs: Date.now() - Date.parse(latest.startedAt ?? latest.createdAt),
            stdoutTruncated: outputTruncated,
            stderrTruncated: outputTruncated,
            timedOut: false
          });
          latest.error = {
            code,
            message: grokFailureMessage(code),
            retryable: isRetryableGrokFailure(code),
            ...(teardownError ? { details: { phase: "run", teardownError } } : {})
          };
        }
      }
    }
    await store.write(latest);
  } catch (error) {
    record = await store.read(jobId).catch(() => record);
    if (record.status !== "cancelled") {
      // `timedOut` and `cancelRequested` are locals of this same scope, so the reason the run ended
      // is still known here even when the failure happened after the Grok process was gone.
      const details = describeFailure("worker", error, teardownError);
      record.finishedAt = new Date().toISOString();
      if (timedOut) {
        record.status = "failed";
        record.error = {
          code: "timeout",
          message: `Grok exceeded timeoutMs=${record.timeoutMs} (teardown failed).`,
          retryable: true,
          details: { ...details, timeoutMs: record.timeoutMs }
        };
      } else if (cancelRequested) {
        record.status = "cancelled";
        record.cancelRequestedAt ??= record.finishedAt;
        record.error = {
          code: "cancelled",
          message: "The Grok request was cancelled before completion (worker teardown failed).",
          retryable: false,
          details
        };
      } else {
        record.status = "failed";
        record.error = {
          code: "worker_error",
          message: "The Grok worker encountered an internal error.",
          retryable: true,
          details
        };
      }
      await store.write(record).catch(() => undefined);
    }
    throw error;
  } finally {
    if (flushTimer) clearTimeout(flushTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (cancelPollTimer) clearInterval(cancelPollTimer);
    await Promise.allSettled([flushChain, heartbeatChain, cancelPollPromise]);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    process.off("SIGTERM", requestCancel);
    process.off("SIGINT", requestCancel);
    await rm(inputPath, { force: true }).catch(() => undefined);
    await rm(store.heartbeatPath(jobId), { force: true }).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--launch-grok") {
    const jobId = process.argv[3];
    const processToken = process.argv[4];
    if (!jobId || !processToken) throw new Error("Missing Grok launcher identity.");
    process.exitCode = await runGrokLauncher(jobId, processToken);
  } else {
    const jobId = process.argv[2];
    if (!jobId) throw new Error("Missing background job ID.");
    await runJobWorker(jobId);
  }
}
