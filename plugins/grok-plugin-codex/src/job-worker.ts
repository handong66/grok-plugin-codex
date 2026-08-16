#!/usr/bin/env node
import { closeSync } from "node:fs";
import { appendFile, chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  buildGrokProcessEnv,
  buildWorkerEnv,
  classifyGrokFailure,
  grokFailureDetails,
  grokFailureMessage,
  isAlreadyGoneKillError,
  isRetryableGrokFailure,
  signalPidTree,
  signalProcessTree
} from "./grok-cli.js";
import { JobStore, STREAM_SUMMARY_VERSION } from "./job-store.js";
import { exemptWorkspacePaths, type PathRedactor } from "./redact.js";
import {
  createStreamFacts,
  errorEventText,
  freezeStreamFacts,
  observeStreamLine,
  sessionIdFromStderr,
  summarizeGrokOutput,
  NO_EVIDENCE_REVIEW_REMEDY,
  SHELL_APPROVAL_REMEDY,
  type MutableStreamFacts,
  type StreamFacts
} from "./result-parser.js";
import { StreamCapture, type CaptureWrite } from "./stream-capture.js";
import type { JobRecord } from "./types.js";

const MAX_CAPTURE_CHARS = 1_000_000;
/** The answer ledger is append-only, so it carries its own ceiling; past it, result() re-parses. */
const MAX_FINAL_TEXT_LEDGER_CHARS = 4_000_000;
const MAX_ERROR_MESSAGE_CHARS = 500;
const MAX_STACK_TAIL_CHARS = 1_000;
/**
 * GK1: an expired device authorization makes the CLI print a sign-in URL and then wait. Three
 * recorded jobs sat in that state — one burned all 600000ms of its budget — during an unattended
 * overnight run, while status still said `running`. A prompt this early means the run never began.
 */
const DEVICE_AUTH_PATTERN = /accounts\.x\.ai\/oauth2\/device|Waiting for authorization/i;
const DEVICE_AUTH_WINDOW_MS = 5_000;
const DEVICE_AUTH_MESSAGE =
  "Grok is not signed in: the CLI printed an OAuth device-authorization prompt for accounts.x.ai and " +
  "then waited for a browser sign-in that a headless job can never complete. Sign in with the Grok CLI " +
  "in an interactive terminal and retry. The one-time device code is deliberately not repeated here.";
const execFileAsync = promisify(execFile);

function boundedText(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/**
 * A worker that dies with `stdio: "ignore"` loses its exception text for good, so every failure
 * carries enough structure to name one session instead of forcing another log audit. These fields
 * reach public MCP envelopes, so the free-form ones go through the store's redactor first: an
 * `ENOENT ... open '<state>/jobs/<id>.json'` still says which artifact broke without publishing the
 * caller's home directory or the plugin's install path.
 */
function describeFailure(
  phase: string,
  error: unknown,
  options: { redact: PathRedactor; teardownError?: string }
): Record<string, unknown> {
  const asError = error instanceof Error ? error : undefined;
  const stack = asError?.stack ?? "";
  return {
    phase,
    errorName: asError?.name ?? typeof error,
    errorMessage: options.redact(boundedText(asError?.message ?? String(error), MAX_ERROR_MESSAGE_CHARS)),
    errnoCode: (error as NodeJS.ErrnoException | undefined)?.code,
    stackTail: stack ? options.redact(stack.slice(-MAX_STACK_TAIL_CHARS)) : undefined,
    ...(options.teardownError ? { teardownError: options.teardownError } : {})
  };
}

/**
 * GPC-03b: an append-only account of the answer, kept as the stream arrives.
 *
 * The raw log is a bounded *window*, so the only way to answer `grok_result` from it is to re-parse
 * up to 4MB and rebuild the 3.31% of it that is answer text — 656 times in the recorded window, and
 * once per foreground poll before GPC-09. This records the same facts once, incrementally, using the
 * very same `observeStreamLine` the fallback re-parse uses, so the two cannot drift.
 */
class StreamLedger {
  private readonly facts: MutableStreamFacts = createStreamFacts();
  private readonly redactInspectedPath: PathRedactor;
  private pendingLine = "";
  private pendingText = "";
  private writtenTextChars = 0;
  private diskWriteFailed = false;
  /** The ledger is unbounded on disk, unlike the window, so it needs its own ceiling. */
  ledgerTruncated = false;

  constructor(redact: PathRedactor, cwd: string) {
    this.redactInspectedPath = exemptWorkspacePaths(redact, cwd);
  }

  append(chunk: string): void {
    this.pendingLine += chunk;
    const parts = this.pendingLine.split("\n");
    this.pendingLine = parts.pop() ?? "";
    for (const line of parts) this.observe(line);
  }

  finish(): void {
    if (!this.pendingLine) return;
    const pending = this.pendingLine;
    this.pendingLine = "";
    this.observe(pending);
  }

  private observe(line: string): void {
    if (!line.trim()) return;
    const text = observeStreamLine(line, this.facts, this.redactInspectedPath);
    this.facts.lastEventAt = new Date().toISOString();
    if (text === undefined) return;
    if (this.writtenTextChars + this.pendingText.length + text.length > MAX_FINAL_TEXT_LEDGER_CHARS) {
      this.ledgerTruncated = true;
      return;
    }
    this.pendingText += text;
  }

  takeText(): string {
    const text = this.pendingText;
    this.pendingText = "";
    this.writtenTextChars += text.length;
    return text;
  }

  /**
   * The mirror of `StreamCapture.markDirty`: `takeText()` consumed the delta before the write was
   * known to succeed, so a failed append must put it back or that much answer text is gone for good
   * while `sawEnd`/`stopReason` still report a clean `end_turn` — a silent truncation published as
   * `resultComplete: true`, the one way the ledger and the fallback re-parse can drift.
   *
   * The retry cannot prove what a partial append already wrote, so the on-disk ledger is also marked
   * unusable: readers fall back to re-parsing the raw window instead of trusting a file that may be
   * short a chunk or hold one twice. The in-memory facts are untouched and stay complete.
   */
  restoreText(text: string): void {
    this.diskWriteFailed = true;
    if (!text) return;
    this.pendingText = text + this.pendingText;
    this.writtenTextChars -= text.length;
  }

  snapshot(): StreamFacts {
    return freezeStreamFacts(this.facts);
  }

  serialize(): string {
    return `${JSON.stringify(
      {
        version: STREAM_SUMMARY_VERSION,
        // Both mean the same thing to a reader: the answer in `<id>.final.txt` cannot be trusted to
        // match `textChars`, so `readStreamProgress` rejects the summary and the re-parse takes over.
        ledgerTruncated: this.ledgerTruncated || this.diskWriteFailed,
        ledgerWriteFailed: this.diskWriteFailed,
        ...this.snapshot(),
        finalText: undefined
      },
      null,
      2
    )}\n`;
  }
}

function newCapture(lineOriented: boolean): StreamCapture {
  return new StreamCapture({
    maxChars: MAX_CAPTURE_CHARS,
    lineOriented,
    // Escape hatch for plugin development: keep the vendor stream byte-for-byte.
    raw: process.env.GROK_PLUGIN_RAW_CAPTURE === "1"
  });
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

/**
 * GPC-03a: the previous flush rewrote both whole log files every 25ms, so a 1MB stream cost tens of
 * gigabytes of writes. Only the delta is written unless the bounded window evicted something.
 */
async function applyCaptureWrite(path: string, write: CaptureWrite): Promise<void> {
  if (write.mode === "rewrite") {
    await writeLog(path, write.value);
    return;
  }
  if (!write.value) return;
  await appendFile(path, write.value, { mode: 0o600 });
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
    // Same rule as signalPidTree: a descendant we may no longer signal (EPERM) is as good as gone,
    // and letting it escape here only turns a completed teardown into a teardownError.
    if (!isAlreadyGoneKillError(error)) throw error;
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
  const ledger = new StreamLedger(store.redactDiagnostics, record.cwd);
  const stdoutCapture = newCapture(true);
  const stderrCapture = newCapture(false);
  let promptDeliveryError: Error | undefined;
  let teardownError: string | undefined;
  let timedOut = false;
  let cancelRequested = false;
  let waitingForAuth = false;
  let deviceAuthBlocked = false;
  let authFlagChain = Promise.resolve();
  let forceKillTimer: NodeJS.Timeout | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let cancelPollTimer: NodeJS.Timeout | undefined;
  let cancelPollActive = false;
  let flushChain = Promise.resolve();
  let heartbeatChain = Promise.resolve();
  let cancelPollPromise = Promise.resolve();

  const flushCapture = async (capture: StreamCapture, path: string): Promise<void> => {
    const write = capture.takeWrite();
    if (!write) return;
    try {
      await applyCaptureWrite(path, write);
    } catch (error) {
      // The delta was already consumed; without this the failed bytes would be lost for good.
      capture.markDirty();
      throw error;
    }
  };
  const writeLedgerSummary = async (): Promise<void> => {
    await writeFile(store.summaryPath(jobId), ledger.serialize(), { mode: 0o600 });
    await chmod(store.summaryPath(jobId), 0o600);
  };
  const flushLedger = async (): Promise<void> => {
    const text = ledger.takeText();
    if (!text) {
      await writeLedgerSummary();
      return;
    }
    try {
      await appendFile(store.finalTextPath(jobId), text, { mode: 0o600 });
    } catch (error) {
      // The delta was already consumed; without this the answer would lose it for good and still be
      // reported complete. The summary is written before rethrowing because the "do not trust this
      // ledger" marker it now carries is what keeps result() from serving the short file.
      ledger.restoreText(text);
      try {
        await writeLedgerSummary();
      } catch {
        // Neither the text nor the marker reached disk. Drop the stale summary so the reader falls
        // back to the re-parse rather than believing a summary that no longer describes the file.
        await rm(store.summaryPath(jobId), { force: true }).catch(() => undefined);
      }
      throw error;
    }
    await writeLedgerSummary();
  };
  const flushLogs = () => {
    flushChain = flushChain.catch(() => undefined).then(async () => {
      await Promise.all([
        flushCapture(stdoutCapture, store.stdoutPath(jobId)),
        flushCapture(stderrCapture, store.stderrPath(jobId)),
        flushLedger()
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
    await Promise.all([
      writeLog(store.stdoutPath(jobId), ""),
      writeLog(store.stderrPath(jobId), ""),
      writeLog(store.finalTextPath(jobId), ""),
      writeLog(store.summaryPath(jobId), ledger.serialize())
    ]);

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
      stdoutCapture.append(chunk);
      ledger.append(chunk);
      scheduleFlush();
    });
    const runStartedAt = Date.now();
    child.stderr?.on("data", (chunk: string) => {
      stderrCapture.append(chunk);
      if (!waitingForAuth && DEVICE_AUTH_PATTERN.test(chunk)) {
        waitingForAuth = true;
        // Also on the in-memory record, so the pending `record.pid` write cannot clobber the flag.
        record.waitingForAuth = true;
        // Publish the flag immediately: grok_status is the cheap path an unattended orchestrator polls.
        authFlagChain = authFlagChain.catch(() => undefined).then(async () => {
          // Flush first: the flag sends the caller to the sign-in URL, which lives in the stderr tail
          // that is otherwise still sitting in the 25 ms buffer when the flag becomes readable.
          await flushLogs().catch(() => undefined);
          const latest = await store.read(jobId);
          if (!["succeeded", "failed", "cancelled"].includes(latest.status)) {
            latest.waitingForAuth = true;
            await store.write(latest);
          }
        });
        void authFlagChain.catch(() => undefined);
        if (Date.now() - runStartedAt <= DEVICE_AUTH_WINDOW_MS) {
          // Nothing has run yet, so waiting out timeoutMs can only waste the whole budget.
          deviceAuthBlocked = true;
          signalProcessTree(child, "SIGTERM");
          forceKillTimer ??= setTimeout(() => signalProcessTree(child, "SIGKILL"), 2_000);
          forceKillTimer.unref();
        }
      }
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
      stdoutCapture.finish();
      stderrCapture.finish();
      ledger.finish();
      await flushLogs();
    } catch (error) {
      teardownError = store.redactDiagnostics(
        boundedText(
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          MAX_ERROR_MESSAGE_CHARS
        )
      );
    } finally {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (flushTimer) clearTimeout(flushTimer);
    }

    const stdout = stdoutCapture.value;
    const stderr = stderrCapture.value;
    const outputTruncated = stdoutCapture.truncated || stderrCapture.truncated;
    const latest = await store.read(jobId);
    latest.exitCode = outcome.exitCode;
    latest.signal = outcome.signal;
    latest.outputTruncated = outputTruncated;
    // GPC-03a: only evicted *answer* text can hide a complete result. Tool echo overflowing the
    // capture window used to force `resultComplete: false` on four otherwise complete answers.
    latest.textTruncated = stdoutCapture.droppedTextChars > 0;
    latest.textChars = stdoutCapture.textChars;
    latest.finishedAt = new Date().toISOString();
    latest.waitingForAuth = waitingForAuth;
    // X3 / SPEC §D M8: the plugin assigns the session id itself when the CLI advertises
    // `--session-id`, but an older CLI and every `continueLatest`-derived job leave the record with
    // no handle at all — and `grok_finalize(jobId)`, the recovery this release made canonical, can
    // only resolve through the record. The `end` event is the primary source; the `session_id=<uuid>`
    // the CLI prints to stderr on a tool error is the free fallback for the runs that never emit one.
    latest.grokSessionId ??= ledger.snapshot().grokSessionId ?? sessionIdFromStderr(stderr);
    if (latest.status === "cancelled" || latest.cancelRequestedAt || cancelRequested) {
      latest.status = "cancelled";
    } else if (deviceAuthBlocked) {
      latest.status = "failed";
      latest.error = {
        code: "auth_required",
        message: DEVICE_AUTH_MESSAGE,
        retryable: false,
        details: {
          phase: "device_authorization",
          waitingForAuth: true,
          ...(teardownError ? { teardownError } : {})
        }
      };
    } else if (timedOut) {
      latest.status = "failed";
      latest.error = {
        // GK4 / GPC-05.4: a wall-clock timeout is the largest recorded failure class, so its message
        // must be the shared remedy that names grok_finalize — not a restatement of the budget the
        // caller already set. The budget itself stays machine-readable in `details.timeoutMs`.
        code: "timeout",
        message: grokFailureMessage("timeout"),
        retryable: true,
        details: { phase: "run", timeoutMs: latest.timeoutMs, ...(teardownError ? { teardownError } : {}) }
      };
    } else if (promptDeliveryError) {
      latest.status = "failed";
      latest.error = {
        code: "prompt_delivery_error",
        message: "The complete prompt could not be delivered to the Grok CLI.",
        retryable: true,
        details: describeFailure("prompt_delivery", promptDeliveryError, { redact: store.redactDiagnostics, teardownError })
      };
    } else if (outcome.error) {
      latest.status = "failed";
      latest.error = {
        code: "spawn_error",
        message: "The Grok CLI process could not be started.",
        retryable: true,
        details: describeFailure("spawn", outcome.error, { redact: store.redactDiagnostics, teardownError })
      };
    } else {
      const parsed = summarizeGrokOutput(
        { ...latest, status: outcome.exitCode === 0 ? "succeeded" : "failed" },
        stdout,
        stderr,
        outputTruncated,
        store.redactDiagnostics,
        ledger.ledgerTruncated ? undefined : ledger.snapshot()
      );
      if (parsed.streamError) {
        latest.status = "failed";
        latest.error = parsed.streamError;
      } else if (parsed.state === "cancelled_partial") {
        // X2: a vendor `cancelled` stop reason must not be stored as `succeeded`. 24 of 64 recorded
        // jobs were, and downstream read them as completed work.
        latest.status = "cancelled";
        // GK5 / X2: `permission_denied_headless` used to exist only on the foreground wait path,
        // while review/adversarial_review/rescue now default to background — so on the default path
        // a refused shell command reached the caller as a generic cancel with no `error.code` to
        // branch on. The classification belongs on the record, where grok_status and grok_result
        // both read it. `shellApprovalBlocked` already requires an enforced read-only job (X1).
        if (parsed.shellApprovalBlocked) {
          latest.error = {
            code: "permission_denied_headless",
            message: SHELL_APPROVAL_REMEDY,
            retryable: false,
            details: {
              phase: "run",
              deniedToolCalls: parsed.deniedToolCalls,
              ...(teardownError ? { teardownError } : {})
            }
          };
        }
      } else {
        latest.status = outcome.exitCode === 0 ? "succeeded" : "failed";
        if (
          latest.status === "succeeded" &&
          !parsed.resultComplete &&
          parsed.state === "succeeded_with_text" &&
          parsed.evidenceLevel === "none"
        ) {
          // Same gap as above: the zero-evidence verdict was only ever a foreground code. The job
          // stays `succeeded` — the text is real and reachable — but the record now says why it is
          // not a review.
          // X10: an identical rerun buys the same opinion for another full budget, and the text is
          // already readable through grok_result — the foreground code says the same.
          latest.error = {
            code: "no_evidence_review",
            message: NO_EVIDENCE_REVIEW_REMEDY,
            retryable: false,
            details: { phase: "run", toolCallCount: parsed.toolCallCount, evidenceLevel: parsed.evidenceLevel }
          };
        }
        if (latest.status === "failed") {
          const code = classifyGrokFailure({
            command: latest.command,
            args: latest.args,
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            // Never the whole stream: only vendor error events, so Grok's own review prose cannot
            // decide the error code (GPC-04).
            stdout: errorEventText(stdout),
            stderr,
            durationMs: Date.now() - Date.parse(latest.startedAt ?? latest.createdAt),
            stdoutTruncated: outputTruncated,
            stderrTruncated: outputTruncated,
            timedOut: false
          });
          const codeDetails = grokFailureDetails(code);
          // GK8: the caller's session id is often its only handle, so the failure carries the ids
          // this plugin actually started in the same workspace instead of telling it to go looking.
          const candidateSessions =
            code === "session_not_found" ? await store.listRecentSessionIds(latest.cwd).catch(() => []) : [];
          latest.error = {
            code,
            message: grokFailureMessage(code),
            retryable: isRetryableGrokFailure(code),
            ...(teardownError || codeDetails || candidateSessions.length
              ? {
                  details: {
                    phase: "run",
                    ...codeDetails,
                    ...(candidateSessions.length ? { candidateSessions } : {}),
                    ...(teardownError ? { teardownError } : {})
                  }
                }
              : {})
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
      const details = describeFailure("worker", error, { redact: store.redactDiagnostics, teardownError });
      record.finishedAt = new Date().toISOString();
      if (timedOut) {
        record.status = "failed";
        record.error = {
          // Same remedy as the normal timeout path; that teardown also failed is a diagnostic
          // (`details.phase: "worker"`, `details.teardownError`), not a different recovery.
          code: "timeout",
          message: grokFailureMessage("timeout"),
          retryable: true,
          details: { ...details, timeoutMs: record.timeoutMs, teardownFailed: true }
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
    await Promise.allSettled([flushChain, heartbeatChain, cancelPollPromise, authFlagChain]);
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
