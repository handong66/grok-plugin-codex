import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { buildGrokProcessEnv, discoverGrok } from "./grok-cli.js";
import type { JobKind, JobOutputSummary, JobRecord } from "./types.js";

const running = new Map<string, ChildProcess>();
const terminalStatuses = new Set<JobRecord["status"]>(["succeeded", "failed", "cancelled"]);
export const JOB_ID_PATTERN = /^job_\d+_[0-9a-f]{8}$/;

function validateJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`jobId must match ${JOB_ID_PATTERN.source}, got ${JSON.stringify(jobId)}.`);
  }
}

function previewText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 500 ? `${singleLine.slice(0, 497)}...` : singleLine;
}

export function summarizeGrokOutput(record: JobRecord, stdout: string, stderr = ""): JobOutputSummary {
  const eventCounts: Record<string, number> = {};
  const textChunks: string[] = [];
  let grokSessionId: string | undefined;
  let requestId: string | undefined;
  let stopReason: string | undefined;
  let sawEnd = false;
  let thoughtEventCount = 0;
  let textEventCount = 0;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!event || typeof event !== "object") continue;
    const typedEvent = event as {
      type?: string;
      data?: unknown;
      sessionId?: string;
      requestId?: string;
      stopReason?: string;
    };
    const eventType = typedEvent.type ?? "unknown";
    eventCounts[eventType] = (eventCounts[eventType] ?? 0) + 1;

    if (eventType === "thought") {
      thoughtEventCount += 1;
    }
    if (eventType === "text" && typeof typedEvent.data === "string") {
      textEventCount += 1;
      textChunks.push(typedEvent.data);
    }
    if (eventType === "end") {
      sawEnd = true;
      grokSessionId = typedEvent.sessionId ?? grokSessionId;
      requestId = typedEvent.requestId ?? requestId;
      stopReason = typedEvent.stopReason ?? stopReason;
    }
  }

  const finalText = textChunks.join("");
  let state: JobOutputSummary["state"];
  if (record.status === "succeeded") {
    state = finalText.trim() && sawEnd ? "succeeded_with_text" : "succeeded_without_text";
  } else if (record.status === "failed") {
    state = "failed_partial";
  } else if (record.status === "cancelled") {
    state = "cancelled_partial";
  } else if (record.status === "queued") {
    state = "queued_partial";
  } else {
    state = "running_partial";
  }

  const resultComplete = record.status === "succeeded" && Boolean(finalText.trim()) && sawEnd;
  let guidance: string;
  if (resultComplete) {
    guidance = "Grok produced final text and an end event. Codex must still verify findings against the workspace before acting on them.";
  } else if (record.status === "running" || record.status === "queued") {
    guidance = "Grok is still running. Poll status/result later or cancel and rerun with a narrower target; do not treat current stdout as final.";
  } else if (record.status === "cancelled") {
    guidance = "Grok was cancelled. stdout/stderr are partial logs only; do not treat them as a final review or implementation result.";
  } else if (record.status === "failed") {
    guidance = stderr.trim()
      ? "Grok failed. Inspect stderr and rerun with a narrower prompt or corrected environment."
      : "Grok failed without stderr. Rerun with a narrower prompt and inspect the Grok session directly if needed.";
  } else {
    guidance = "Grok exited successfully but a complete text plus end event was not observed. Rerun with a narrower target and an explicit output contract.";
  }

  return {
    resultComplete,
    state,
    eventCounts,
    grokSessionId,
    requestId,
    stopReason,
    sawEnd,
    thoughtEventCount,
    textEventCount,
    textPreview: finalText ? previewText(finalText) : undefined,
    guidance
  };
}

export class JobStore {
  constructor(private readonly rootDir: string) {}

  private jobsDir(): string {
    return join(this.rootDir, ".grok-plugin-codex", "jobs");
  }

  private jobPath(jobId: string): string {
    validateJobId(jobId);
    return join(this.jobsDir(), `${jobId}.json`);
  }

  async ensure(): Promise<void> {
    await mkdir(this.jobsDir(), { recursive: true });
  }

  async write(record: JobRecord): Promise<void> {
    await this.ensure();
    await writeFile(this.jobPath(record.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  async read(jobId: string): Promise<JobRecord> {
    const raw = await readFile(this.jobPath(jobId), "utf8");
    return JSON.parse(raw) as JobRecord;
  }

  async startGrokJob(params: {
    kind: JobKind;
    cwd: string;
    args: string[];
    grokBin?: string;
    grokSessionId?: string;
  }): Promise<JobRecord> {
    await this.ensure();
    const discovered = await discoverGrok({ grokBin: params.grokBin });
    if (!discovered.ok || !discovered.bin) {
      throw new Error(`Grok CLI not found. Tried: ${discovered.tried.join(", ")}`);
    }

    const id = `job_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const stdoutPath = join(this.jobsDir(), `${id}.stdout.log`);
    const stderrPath = join(this.jobsDir(), `${id}.stderr.log`);
    const record: JobRecord = {
      id,
      kind: params.kind,
      status: "queued",
      cwd: params.cwd,
      command: discovered.bin,
      args: params.args,
      grokSessionId: params.grokSessionId,
      createdAt: new Date().toISOString(),
      stdoutPath,
      stderrPath
    };
    await this.write(record);

    const child = spawn(discovered.bin, params.args, {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildGrokProcessEnv()
    });
    running.set(id, child);

    child.stdout.pipe(createWriteStream(stdoutPath, { flags: "a" }));
    child.stderr.pipe(createWriteStream(stderrPath, { flags: "a" }));

    record.status = "running";
    record.pid = child.pid;
    record.startedAt = new Date().toISOString();
    await this.write(record);

    child.on("close", async (exitCode, signal) => {
      running.delete(id);
      const latest = await this.read(id).catch(() => record);
      if (latest.status === "cancelled") return;
      latest.status = exitCode === 0 ? "succeeded" : "failed";
      latest.exitCode = exitCode;
      latest.signal = signal;
      latest.finishedAt = new Date().toISOString();
      await this.write(latest).catch(() => undefined);
    });

    child.on("error", async (error) => {
      running.delete(id);
      record.status = "failed";
      record.errorMessage = error.message;
      record.finishedAt = new Date().toISOString();
      await this.write(record).catch(() => undefined);
    });

    return record;
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const record = await this.read(jobId);
    if (terminalStatuses.has(record.status)) {
      return record;
    }

    const child = running.get(jobId);
    if (child) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (running.has(jobId)) child.kill("SIGKILL");
      }, 2_000).unref();
      running.delete(jobId);
    }

    record.status = "cancelled";
    record.finishedAt = new Date().toISOString();
    await this.write(record);
    return record;
  }

  async result(
    jobId: string,
    maxChars = 20_000
  ): Promise<{ record: JobRecord; stdout: string; stderr: string; outputSummary: JobOutputSummary }> {
    const record = await this.read(jobId);
    const stdout = await readFile(record.stdoutPath, "utf8").catch(() => "");
    const stderr = await readFile(record.stderrPath, "utf8").catch(() => "");
    return {
      record,
      stdout: stdout.slice(-maxChars),
      stderr: stderr.slice(-maxChars),
      outputSummary: summarizeGrokOutput(record, stdout, stderr)
    };
  }
}
