import { existsSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildWorkerEnv, discoverGrok, signalPidTree } from "./grok-cli.js";
import { jobDiagnosticRedactor, redactDeviceCode, type PathRedactor } from "./redact.js";
import { summarizeGrokOutput } from "./result-parser.js";
import {
  GrokPluginError,
  type JobKind,
  type JobOutputSummary,
  type JobRecord,
  type PublicJob
} from "./types.js";

export { summarizeGrokOutput } from "./result-parser.js";

export type JobStoreOptions = {
  stateDir?: string;
  workerPath?: string;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_TIMEOUT_MS = 600_000;
const WORKER_STARTUP_GRACE_MS = 5_000;
const WORKER_HEARTBEAT_STALE_MS = 5_000;
const MAX_RESULT_CHARS = 100_000;
const WORKER_LOG_TAIL_CHARS = 4_000;
const SUMMARY_READ_CHARS = 1_000_000;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const JOB_LOCK_STALE_MS = 2_000;
const JOB_LOCK_WAIT_MS = 5_000;
const PROCESS_KILL_GRACE_MS = 2_000;
const TERMINAL_STATUSES = new Set<JobRecord["status"]>(["succeeded", "failed", "cancelled"]);
const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{16,128}$/;
const PROMPT_SOURCE_ARGS = new Set(["-p", "--single", "--prompt-file", "--prompt-json"]);
const STATE_MARKER_CONTENT = "grok-plugin-codex-state-v2\n";
/** The kinds this plugin has always started with `--permission-mode plan --no-subagents`. */
const READ_ONLY_KINDS = new Set<JobKind>(["review", "adversarial_review", "rescue"]);
const execFileAsync = promisify(execFile);

/**
 * GPC-M2: `readOnly` is new in 0.3.0, so every record written before it — including the retained
 * seven days of jobs that actually carry a `grokSessionId` — has the field absent. Reading a missing
 * field as `false` would resolve a real adversarial-review session to a mutable origin and skip both
 * the inheritance and the "could not be verified" warning, which is the one case the item exists for.
 * The record still names its `kind`, and the kind is what decided the flags in the first place.
 */
function recordWasReadOnly(record: JobRecord): boolean {
  return record.readOnly ?? READ_ONLY_KINDS.has(record.kind);
}

export function defaultJobStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GROK_PLUGIN_STATE_DIR) return resolve(env.GROK_PLUGIN_STATE_DIR);
  const home = env.HOME ?? homedir();
  const stateHome = env.XDG_STATE_HOME ? resolve(env.XDG_STATE_HOME) : join(home, ".local", "state");
  return join(stateHome, "grok-plugin-codex");
}

function defaultWorkerPath(env: NodeJS.ProcessEnv): string {
  if (env.GROK_PLUGIN_WORKER_PATH) return resolve(env.GROK_PLUGIN_WORKER_PATH);
  const alongsideBundle = fileURLToPath(new URL("./job-worker.js", import.meta.url));
  if (existsSync(alongsideBundle)) return alongsideBundle;
  return fileURLToPath(new URL("../dist/job-worker.js", import.meta.url));
}

function assertJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new GrokPluginError("invalid_job_id", "Invalid background job ID.");
  }
}

function assertPromptFreeArgs(args: string[]): void {
  for (const arg of args) {
    if (
      PROMPT_SOURCE_ARGS.has(arg) ||
      arg.startsWith("--prompt-file=") ||
      arg.startsWith("--prompt-json=") ||
      arg.startsWith("--single=")
    ) {
      throw new GrokPluginError("invalid_job_arguments", "Background job arguments must not contain prompt sources.");
    }
  }
}

async function readTail(path: string, maxChars: number): Promise<string> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return "";
  try {
    const metadata = await handle.stat();
    const bytesToRead = Math.min(metadata.size, Math.max(maxChars * 4, 4_096));
    if (!bytesToRead) return "";
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, metadata.size - bytesToRead);
    return buffer.subarray(0, bytesRead).toString("utf8").slice(-maxChars);
  } finally {
    await handle.close();
  }
}

function validateRecord(value: unknown, jobId: string): JobRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GrokPluginError("job_corrupt", "Background job record is not a JSON object.");
  }
  const record = value as Partial<JobRecord>;
  if (
    record.id !== jobId ||
    typeof record.cwd !== "string" ||
    typeof record.command !== "string" ||
    !Array.isArray(record.args) ||
    !record.args.every((arg) => typeof arg === "string") ||
    typeof record.createdAt !== "string" ||
    typeof record.timeoutMs !== "number" ||
    !["queued", "running", "succeeded", "failed", "cancelled"].includes(String(record.status))
  ) {
    throw new GrokPluginError("job_corrupt", "Background job record failed validation.");
  }
  assertPromptFreeArgs(record.args);
  return record as JobRecord;
}

async function isRecognizedPreMarkerStateDir(stateDir: string, stateMode: number): Promise<boolean> {
  if ((stateMode & 0o077) !== 0) return false;
  const stateEntries = await readdir(stateDir, { withFileTypes: true });
  if (stateEntries.length !== 1 || stateEntries[0]?.name !== "jobs" || !stateEntries[0].isDirectory()) return false;
  const jobsDir = join(stateDir, "jobs");
  const jobsMetadata = await lstat(jobsDir).catch(() => null);
  if (!jobsMetadata?.isDirectory() || jobsMetadata.isSymbolicLink() || (jobsMetadata.mode & 0o077) !== 0) return false;

  const jobEntries = await readdir(jobsDir, { withFileTypes: true });
  const validJobIds = new Set<string>();
  for (const entry of jobEntries) {
    const match = entry.name.match(/^(job_[A-Za-z0-9_-]{16,128})\.json$/);
    if (!match?.[1]) continue;
    const path = join(jobsDir, entry.name);
    const metadata = await lstat(path).catch(() => null);
    if (!entry.isFile() || !metadata?.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) return false;
    try {
      validateRecord(JSON.parse(await readFile(path, "utf8")), match[1]);
      validJobIds.add(match[1]);
    } catch {
      return false;
    }
  }

  for (const entry of jobEntries) {
    const match = entry.name.match(
      /^(job_[A-Za-z0-9_-]{16,128})(?:\.json|\.stdout\.log|\.stderr\.log|\.worker\.log|\.heartbeat|\.cancel|\.input|\.lock)$/
    );
    if (!match?.[1] || !validJobIds.has(match[1])) return false;
    const metadata = await lstat(join(jobsDir, entry.name)).catch(() => null);
    if (!entry.isFile() || !metadata?.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) return false;
  }
  return true;
}

export function toPublicJob(record: JobRecord): PublicJob {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    timeoutMs: record.timeoutMs,
    grokSessionId: record.grokSessionId,
    waitingForAuth: record.waitingForAuth,
    exitCode: record.exitCode,
    signal: record.signal,
    error: record.error,
    outputTruncated: record.outputTruncated
  };
}

export class JobStore {
  readonly stateDir: string;
  readonly workerPath: string;
  readonly env: NodeJS.ProcessEnv;
  /** Applied to every free-form diagnostic before it is persisted; see src/redact.ts. */
  readonly redactDiagnostics: PathRedactor;

  constructor(options: string | JobStoreOptions = {}) {
    const normalized = typeof options === "string" ? { stateDir: options } : options;
    this.env = { ...process.env, ...(normalized.env ?? {}) };
    this.stateDir = resolve(normalized.stateDir ?? defaultJobStateDir(this.env));
    this.workerPath = normalized.workerPath ?? defaultWorkerPath(this.env);
    this.redactDiagnostics = jobDiagnosticRedactor({
      stateDir: this.stateDir,
      workerPath: this.workerPath,
      env: this.env
    });
  }

  private jobsDir(): string {
    return join(this.stateDir, "jobs");
  }

  private stateMarkerPath(): string {
    return join(this.stateDir, ".grok-plugin-state-v2");
  }

  private jobPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.json`);
  }

  private cancelPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.cancel`);
  }

  private lockPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.lock`);
  }

  stdoutPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.stdout.log`);
  }

  stderrPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.stderr.log`);
  }

  inputPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.input`);
  }

  heartbeatPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.heartbeat`);
  }

  /** Private capture of the worker process's own stderr; without it a hard crash is unreadable. */
  workerLogPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.worker.log`);
  }

  async ensure(): Promise<void> {
    const stateMetadata = await stat(this.stateDir).catch(() => null);
    if (stateMetadata && !stateMetadata.isDirectory()) {
      throw new GrokPluginError("unsafe_state_dir", "The configured state path is not a directory.");
    }
    if (stateMetadata) {
      const marker = await readFile(this.stateMarkerPath(), "utf8").catch(() => null);
      if (marker === null) {
        const entries = await readdir(this.stateDir);
        if (entries.length > 0 && !(await isRecognizedPreMarkerStateDir(this.stateDir, stateMetadata.mode))) {
          throw new GrokPluginError(
            "unsafe_state_dir",
            "The configured path is not an empty or plugin-owned state directory. Choose a dedicated directory."
          );
        }
      } else if (marker !== STATE_MARKER_CONTENT) {
        throw new GrokPluginError("unsafe_state_dir", "The configured state directory has an invalid ownership marker.");
      }
    } else {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    }
    await writeFile(this.stateMarkerPath(), STATE_MARKER_CONTENT, { mode: 0o600, flag: "wx" }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    await mkdir(this.jobsDir(), { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700);
    await chmod(this.stateMarkerPath(), 0o600);
    await chmod(this.jobsDir(), 0o700);
  }

  private async cancellationTimestamp(jobId: string): Promise<string | undefined> {
    try {
      const value = (await readFile(this.cancelPath(jobId), "utf8")).trim();
      return value || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async isCancellationRequested(jobId: string): Promise<boolean> {
    return Boolean(await this.cancellationTimestamp(jobId));
  }

  private async hasFreshHeartbeat(jobId: string): Promise<boolean> {
    const metadata = await stat(this.heartbeatPath(jobId)).catch(() => null);
    return Boolean(metadata && Date.now() - metadata.mtimeMs <= WORKER_HEARTBEAT_STALE_MS);
  }

  private async withJobLock<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = this.lockPath(jobId);
    const deadline = Date.now() + JOB_LOCK_WAIT_MS;
    const ownerToken = randomUUID();
    const ownerContent = `${process.pid}\n${ownerToken}\n`;
    const candidatePath = `${lockPath}.${ownerToken}.candidate`;
    while (true) {
      try {
        await writeFile(candidatePath, ownerContent, { mode: 0o600, flag: "wx" });
        try {
          await link(candidatePath, lockPath);
        } finally {
          await rm(candidatePath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        await rm(candidatePath, { force: true }).catch(() => undefined);
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        const metadata = await stat(lockPath).catch(() => null);
        if (metadata && Date.now() - metadata.mtimeMs > JOB_LOCK_STALE_MS) {
          const staleOwner = await readFile(lockPath, "utf8").catch(() => null);
          const stalePid = Number(staleOwner?.split("\n", 1)[0]);
          let ownerAlive = false;
          if (Number.isSafeInteger(stalePid) && stalePid > 0) {
            try {
              process.kill(stalePid, 0);
              ownerAlive = true;
            } catch (ownerError) {
              ownerAlive = (ownerError as NodeJS.ErrnoException).code !== "ESRCH";
            }
          }
          if (!ownerAlive) {
            const currentOwner = await readFile(lockPath, "utf8").catch(() => null);
            if (currentOwner === staleOwner) await rm(lockPath, { force: true }).catch(() => undefined);
            continue;
          }
        }
        if (Date.now() >= deadline) {
          throw new GrokPluginError("job_lock_timeout", "The job state is busy. Retry the request.", true);
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        continue;
      }
      try {
        return await operation();
      } finally {
        const currentOwner = await readFile(lockPath, "utf8").catch(() => null);
        if (currentOwner === ownerContent) await rm(lockPath, { force: true }).catch(() => undefined);
      }
    }
  }

  private async processCommand(pid: number): Promise<string | null> {
    try {
      const result = await execFileAsync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 256 * 1_024
      });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private processGroupAlive(pid: number): boolean {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      return true;
    }
  }

  private processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      return true;
    }
  }

  private async terminateOwnedWorker(record: JobRecord): Promise<boolean> {
    if (!record.workerPid) return false;
    const commandLine = await this.processCommand(record.workerPid);
    if (
      !commandLine ||
      !commandLine.includes(this.workerPath) ||
      !commandLine.includes(record.id) ||
      commandLine.includes("--launch-grok")
    ) return false;
    signalPidTree(record.workerPid, "SIGTERM");
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      if (!this.processAlive(record.workerPid)) return true;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    signalPidTree(record.workerPid, "SIGKILL");
    return true;
  }

  async terminateOwnedProcessTree(record: JobRecord): Promise<boolean> {
    if (
      !record.pid ||
      !record.processToken ||
      (process.platform !== "darwin" && process.platform !== "linux")
    ) return false;
    const commandLine = await this.processCommand(record.pid);
    if (
      !commandLine ||
      !commandLine.includes(this.workerPath) ||
      !commandLine.includes("--launch-grok") ||
      !commandLine.includes(record.id) ||
      !commandLine.includes(record.processToken)
    ) return false;
    signalPidTree(record.pid, "SIGTERM");
    const deadline = Date.now() + PROCESS_KILL_GRACE_MS;
    while (Date.now() < deadline) {
      if (!this.processGroupAlive(record.pid)) return true;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    signalPidTree(record.pid, "SIGKILL");
    return true;
  }

  async write(record: JobRecord): Promise<void> {
    await this.ensure();
    assertJobId(record.id);
    assertPromptFreeArgs(record.args);
    await this.withJobLock(record.id, async () => {
      const existing = await this.read(record.id).catch((error) => {
        if (error instanceof GrokPluginError && error.code === "job_not_found") return null;
        throw error;
      });
      if (existing && TERMINAL_STATUSES.has(existing.status)) return;

      let normalized = { ...record };
      if (normalized.status !== "cancelled") {
        const cancelRequestedAt = await this.cancellationTimestamp(record.id);
        if (cancelRequestedAt) {
          normalized = {
            ...normalized,
            status: "cancelled",
            cancelRequestedAt,
            finishedAt: cancelRequestedAt
          };
        }
      }
      const target = this.jobPath(record.id);
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        await chmod(temp, 0o600);
        await rename(temp, target);
        await chmod(target, 0o600);
      } finally {
        await rm(temp, { force: true }).catch(() => undefined);
      }
    });
  }

  async read(jobId: string): Promise<JobRecord> {
    assertJobId(jobId);
    try {
      const raw = await readFile(this.jobPath(jobId), "utf8");
      return validateRecord(JSON.parse(raw), jobId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GrokPluginError("job_not_found", "Background job was not found.");
      }
      if (error instanceof SyntaxError) {
        throw new GrokPluginError("job_corrupt", "Background job record is not valid JSON.");
      }
      throw error;
    }
  }

  async status(jobId: string): Promise<JobRecord> {
    let record = await this.read(jobId);
    if (TERMINAL_STATUSES.has(record.status)) return record;
    if (record.status === "queued") {
      const createdAtMs = Date.parse(record.createdAt);
      if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs <= WORKER_STARTUP_GRACE_MS) return record;
    }
    if (await this.hasFreshHeartbeat(jobId)) return record;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    record = await this.read(jobId);
    if (TERMINAL_STATUSES.has(record.status) || (await this.hasFreshHeartbeat(jobId))) return record;
    await this.terminateOwnedProcessTree(record);
    record = await this.read(jobId);
    if (TERMINAL_STATUSES.has(record.status) || (await this.hasFreshHeartbeat(jobId))) return record;
    await this.terminateOwnedWorker(record);
    record = await this.read(jobId);
    if (TERMINAL_STATUSES.has(record.status) || (await this.hasFreshHeartbeat(jobId))) return record;
    // Raw Node stderr from the worker names the state directory and the install path; the tail is a
    // public field, so it is redacted before it is written into the record.
    const workerLogTail = this.redactDiagnostics(await readTail(this.workerLogPath(jobId), WORKER_LOG_TAIL_CHARS));
    record.status = "failed";
    record.error = {
      code: "worker_unavailable",
      message: "The Grok background worker exited without recording a terminal result.",
      retryable: true,
      details: { phase: "worker_liveness", ...(workerLogTail.trim() ? { workerLogTail } : {}) }
    };
    record.finishedAt = new Date().toISOString();
    await rm(this.inputPath(jobId), { force: true });
    await this.write(record);
    return await this.read(jobId);
  }

  /**
   * GPC-M2: what a session is allowed to do is decided by the job that created it, not by the
   * arguments of the call that resumes it. A session touched by any enforced read-only job stays
   * read-only, so an adversarial-review session cannot be continued with write permissions.
   */
  async findSessionOrigin(
    grokSessionId: string
  ): Promise<{ jobId: string; kind: JobKind; readOnly: boolean } | undefined> {
    await this.ensure();
    const entries = await readdir(this.jobsDir(), { withFileTypes: true }).catch(() => []);
    let creator: { jobId: string; kind: JobKind; createdAt: number } | undefined;
    let earliest: { jobId: string; kind: JobKind; createdAt: number } | undefined;
    let readOnly = false;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const jobId = entry.name.slice(0, -5);
      if (!JOB_ID_PATTERN.test(jobId)) continue;
      const record = await this.read(jobId).catch(() => null);
      if (!record || record.grokSessionId !== grokSessionId) continue;
      readOnly ||= recordWasReadOnly(record);
      const candidate = { jobId, kind: record.kind, createdAt: Date.parse(record.createdAt) };
      if (!earliest || !Number.isFinite(earliest.createdAt) || candidate.createdAt <= earliest.createdAt) {
        earliest = candidate;
      }
      // Only a job that started the session says how it was created. A `continue` job takes its mode
      // from this same lookup, so accepting one as the origin would let a single unverified
      // continuation launder an unknown session into a "known mutable" one for every later call.
      if (record.kind === "continue") continue;
      if (!creator || !Number.isFinite(creator.createdAt) || candidate.createdAt <= creator.createdAt) {
        creator = candidate;
      }
    }
    const origin = creator ?? (readOnly ? earliest : undefined);
    return origin ? { jobId: origin.jobId, kind: origin.kind, readOnly } : undefined;
  }

  /**
   * GPC-M2: `continueLatest: true` names no session, so `findSessionOrigin` cannot run and the
   * read-only inheritance was skipped entirely — `alwaysApprove` was one parameter away from
   * resuming an enforced read-only session with write permissions. The plugin does hold cheap
   * evidence about what the CLI is about to resume: the session it started most recently in this
   * workspace. That is a heuristic, not a fact, so it is used to fail closed and it says so; naming
   * an explicit `sessionId` remains the way to continue some other session.
   */
  async findLatestSessionOrigin(
    cwd: string
  ): Promise<{ jobId: string; kind: JobKind; readOnly: boolean; grokSessionId: string } | undefined> {
    await this.ensure();
    const workspace = resolve(cwd);
    const entries = await readdir(this.jobsDir(), { withFileTypes: true }).catch(() => []);
    let latest: { grokSessionId: string; createdAt: number } | undefined;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const jobId = entry.name.slice(0, -5);
      if (!JOB_ID_PATTERN.test(jobId)) continue;
      const record = await this.read(jobId).catch(() => null);
      if (!record?.grokSessionId || resolve(record.cwd) !== workspace) continue;
      const createdAt = Date.parse(record.createdAt);
      if (!latest || !Number.isFinite(latest.createdAt) || createdAt >= latest.createdAt) {
        latest = { grokSessionId: record.grokSessionId, createdAt };
      }
    }
    if (!latest) return undefined;
    // Resolve through the session lookup so "any job on this session was read-only" still holds.
    const origin = await this.findSessionOrigin(latest.grokSessionId);
    return origin ? { ...origin, grokSessionId: latest.grokSessionId } : undefined;
  }

  async startGrokJob(params: {
    kind: JobKind;
    cwd: string;
    args: string[];
    prompt: string;
    timeoutMs?: number;
    grokSessionId?: string;
    readOnly?: boolean;
  }): Promise<JobRecord> {
    await this.ensure();
    await this.cleanupExpiredJobs();
    assertPromptFreeArgs(params.args);
    const discovered = await discoverGrok({ env: this.env });
    if (!discovered.ok || !discovered.bin) {
      throw new GrokPluginError("grok_not_found", "Grok CLI was not found in the configured trusted locations.", false, {
        tried: discovered.tried
      });
    }
    if (!existsSync(this.workerPath)) {
      throw new GrokPluginError("worker_missing", "Grok background worker is missing. Rebuild the plugin before retrying.");
    }

    const id = `job_${randomUUID().replaceAll("-", "")}`;
    const record: JobRecord = {
      id,
      kind: params.kind,
      status: "queued",
      cwd: params.cwd,
      command: discovered.bin,
      args: [...params.args],
      grokSessionId: params.grokSessionId,
      readOnly: params.readOnly ?? false,
      createdAt: new Date().toISOString(),
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      processToken: randomUUID()
    };
    await this.write(record);
    // Keep the worker's own stderr instead of discarding it: a crashed worker used to leave nothing
    // behind but a bare `worker_unavailable`, which cost a full log audit to diagnose.
    const workerLog = await open(this.workerLogPath(id), "a", 0o600).catch(() => null);
    let worker;
    try {
      if (workerLog) await chmod(this.workerLogPath(id), 0o600).catch(() => undefined);
      worker = spawn(process.execPath, [this.workerPath, id], {
        cwd: params.cwd,
        detached: true,
        stdio: ["ignore", "ignore", workerLog ? workerLog.fd : "ignore"],
        env: buildWorkerEnv({ ...this.env, GROK_PLUGIN_STATE_DIR: this.stateDir })
      });
    } finally {
      await workerLog?.close().catch(() => undefined);
    }
    if (!worker.pid) {
      record.status = "failed";
      record.error = { code: "worker_spawn_error", message: "Failed to start the Grok background worker.", retryable: true };
      record.finishedAt = new Date().toISOString();
      await this.write(record);
      throw new GrokPluginError("worker_spawn_error", record.error.message, true);
    }
    record.workerPid = worker.pid;
    await this.write(record);
    worker.unref();
    try {
      await writeFile(this.inputPath(id), params.prompt, { mode: 0o600, flag: "wx" });
      await chmod(this.inputPath(id), 0o600);
    } catch (error) {
      try {
        process.kill(worker.pid, "SIGTERM");
      } catch {
        // The failed worker may already have exited.
      }
      record.status = "failed";
      record.error = {
        code: "prompt_store_error",
        message: "Failed to store the private prompt for the Grok worker.",
        retryable: true
      };
      record.finishedAt = new Date().toISOString();
      await this.write(record);
      throw new GrokPluginError(record.error.code, record.error.message, record.error.retryable);
    }
    const startupDeadline = Date.now() + WORKER_STARTUP_GRACE_MS;
    while (Date.now() < startupDeadline) {
      if (!existsSync(this.inputPath(id))) return await this.read(id);
      const latest = await this.read(id);
      if (TERMINAL_STATUSES.has(latest.status)) {
        await rm(this.inputPath(id), { force: true });
        const error = latest.error ?? {
          code: "worker_startup_error",
          message: "The Grok worker failed before consuming the private prompt.",
          retryable: true
        };
        throw new GrokPluginError(error.code, error.message, error.retryable);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    try {
      process.kill(worker.pid, "SIGTERM");
    } catch {
      // The worker may already have exited.
    }
    await rm(this.inputPath(id), { force: true });
    record.status = "failed";
    record.error = {
      code: "worker_startup_timeout",
      message: "The Grok worker did not acquire the private prompt before the startup deadline.",
      retryable: true
    };
    record.finishedAt = new Date().toISOString();
    await this.write(record);
    throw new GrokPluginError(record.error.code, record.error.message, record.error.retryable);
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const record = await this.read(jobId);
    if (TERMINAL_STATUSES.has(record.status)) return record;
    const cancelRequestedAt = new Date().toISOString();
    await writeFile(this.cancelPath(jobId), cancelRequestedAt, { mode: 0o600 });
    await chmod(this.cancelPath(jobId), 0o600);
    record.status = "cancelled";
    record.cancelRequestedAt = cancelRequestedAt;
    record.finishedAt = cancelRequestedAt;
    await this.write(record);
    await this.terminateOwnedProcessTree(record);
    await this.terminateOwnedWorker(record);
    await rm(this.inputPath(jobId), { force: true }).catch(() => undefined);
    return await this.read(jobId);
  }

  async result(
    jobId: string,
    maxChars = 20_000
  ): Promise<{ record: JobRecord; stdout: string; stderr: string; outputSummary: JobOutputSummary }> {
    const record = await this.status(jobId);
    const boundedMaxChars = Math.min(Math.max(maxChars, 1), MAX_RESULT_CHARS);
    const [stdout, stderr, summaryStdout, summaryStderr] = await Promise.all([
      readTail(this.stdoutPath(jobId), boundedMaxChars),
      readTail(this.stderrPath(jobId), boundedMaxChars),
      readTail(this.stdoutPath(jobId), SUMMARY_READ_CHARS),
      readTail(this.stderrPath(jobId), SUMMARY_READ_CHARS)
    ]);
    // The one-time OAuth device code never leaves the private log; the sign-in URL around it does.
    return {
      record,
      stdout,
      stderr: redactDeviceCode(stderr),
      outputSummary: summarizeGrokOutput(
        record,
        summaryStdout,
        redactDeviceCode(summaryStderr),
        record.outputTruncated,
        // `filesInspected` names paths Grok chose, including locations under the home directory that
        // no caller asked about; it leaves this process through the same redactor as every other
        // free-form diagnostic field.
        this.redactDiagnostics
      )
    };
  }

  async cleanupExpiredJobs(now = Date.now()): Promise<void> {
    await this.ensure();
    const entries = await readdir(this.jobsDir(), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const jobId = entry.name.slice(0, -5);
      if (!JOB_ID_PATTERN.test(jobId)) continue;
      const record = await this.read(jobId).catch(() => null);
      if (!record || !TERMINAL_STATUSES.has(record.status)) continue;
      const finishedAt = Date.parse(record.finishedAt ?? record.createdAt);
      if (!Number.isFinite(finishedAt) || now - finishedAt < TERMINAL_RETENTION_MS) continue;
      await Promise.all([
        rm(this.jobPath(jobId), { force: true }),
        rm(this.stdoutPath(jobId), { force: true }),
        rm(this.stderrPath(jobId), { force: true }),
        rm(this.workerLogPath(jobId), { force: true }),
        rm(this.inputPath(jobId), { force: true }),
        rm(this.heartbeatPath(jobId), { force: true }),
        rm(this.cancelPath(jobId), { force: true }),
        rm(this.lockPath(jobId), { force: true })
      ]);
    }
    const prompts = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".input"));
    for (const entry of prompts) {
      const path = join(this.jobsDir(), entry.name);
      const jobId = entry.name.slice(0, -".input".length);
      if (JOB_ID_PATTERN.test(jobId)) {
        let record = await this.read(jobId).catch(() => null);
        if (record && !TERMINAL_STATUSES.has(record.status)) {
          const existing = record;
          record = await this.status(jobId).catch(() => existing);
          if (record && !TERMINAL_STATUSES.has(record.status)) continue;
        }
      }
      const metadata = await stat(path).catch(() => null);
      if (metadata && now - metadata.mtimeMs >= TERMINAL_RETENTION_MS) await rm(path, { force: true });
    }
    const lockCandidates = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".candidate"));
    for (const entry of lockCandidates) {
      const path = join(this.jobsDir(), entry.name);
      const metadata = await stat(path).catch(() => null);
      if (metadata && now - metadata.mtimeMs >= JOB_LOCK_STALE_MS) await rm(path, { force: true });
    }
  }
}
