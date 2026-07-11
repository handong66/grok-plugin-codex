export type PluginErrorInfo = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export class GrokPluginError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = "GrokPluginError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }

  toInfo(): PluginErrorInfo {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {})
    };
  }
}

export type ToolEnvelope<T extends Record<string, unknown> = Record<string, unknown>> =
  | {
      ok: true;
      data: T;
      error: null;
      warnings: string[];
    }
  | {
      ok: false;
      data: null;
      error: PluginErrorInfo;
      warnings: string[];
    };

export type ProcessResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
};

export type GrokModelInfo = {
  id: string;
  default: boolean;
};

export type GrokModelsSummary = {
  loggedIn: boolean;
  authMessage?: string;
  defaultModel?: string;
  availableModels: GrokModelInfo[];
  raw: string;
};

export type JobKind = "run" | "continue" | "rescue" | "review" | "adversarial_review";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type JobRecord = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  cwd: string;
  command: string;
  /** Grok CLI arguments excluding prompt text and --prompt-file. */
  args: string[];
  workerPid?: number;
  pid?: number;
  /** Private opaque token inherited by the owned Grok process group. */
  processToken?: string;
  grokSessionId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutMs: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: PluginErrorInfo;
  cancelRequestedAt?: string;
  outputTruncated?: boolean;
};

export type PublicJob = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutMs: number;
  grokSessionId?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: PluginErrorInfo;
  outputTruncated?: boolean;
};

export type JobOutputSummary = {
  resultComplete: boolean;
  state:
    | "queued_partial"
    | "running_partial"
    | "cancelled_partial"
    | "failed_partial"
    | "succeeded_with_text"
    | "succeeded_without_text";
  finalText?: string;
  outputTruncated: boolean;
  eventCounts: Record<string, number>;
  grokSessionId?: string;
  requestId?: string;
  stopReason?: string;
  sawEnd: boolean;
  thoughtEventCount: number;
  textEventCount: number;
  textPreview?: string;
  streamError?: PluginErrorInfo;
  guidance: string;
};
