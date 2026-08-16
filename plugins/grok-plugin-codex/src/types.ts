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
  /** Non-fatal observations that must survive onto the `ok: false` envelope, never be swallowed. */
  readonly warnings: string[];

  constructor(
    code: string,
    message: string,
    retryable = false,
    details?: Record<string, unknown>,
    warnings: string[] = []
  ) {
    super(message);
    this.name = "GrokPluginError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.warnings = warnings;
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
  /** True when the job ran under enforced `--permission-mode plan --no-subagents`. */
  readOnly?: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutMs: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: PluginErrorInfo;
  cancelRequestedAt?: string;
  outputTruncated?: boolean;
  /** True only when the capture window evicted `text`-event characters, i.e. answer text was lost. */
  textTruncated?: boolean;
  /** Characters of `text`-event payload retained for this job. */
  textChars?: number;
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
  /** The shared capture window overflowed; most of that window is tool echo. */
  outputTruncated: boolean;
  /** Answer text was actually evicted. Only this vetoes completeness. */
  textTruncated: boolean;
  /** Interactive skill/persona files Grok opened during a headless delegation (X1). */
  skillsLoaded: string[];
  /** Tool calls observed in the stream; 0 means the delegate inspected nothing (X2). */
  toolCallCount: number;
  /** File paths named by tool events, bounded and de-duplicated. */
  filesInspected: string[];
  /** Turn count reported by the `end` event, when the CLI provides one. */
  turnsUsed?: number;
  /** none = no tool call at all; thin = tools but no files or a very short answer. */
  evidenceLevel: "none" | "thin" | "substantive";
  eventCounts: Record<string, number>;
  grokSessionId?: string;
  requestId?: string;
  /** Raw stopReason exactly as the Grok CLI emitted it. */
  stopReason?: string;
  /** Case- and separator-insensitive form used for every completion decision. */
  stopReasonNormalized?: string;
  /** False when the plugin did not recognise the stop reason and had to fail open. */
  stopReasonRecognised: boolean;
  sawEnd: boolean;
  thoughtEventCount: number;
  textEventCount: number;
  textPreview?: string;
  streamError?: PluginErrorInfo;
  guidance: string;
  /** Non-fatal parser observations that callers should surface, never swallow. */
  warnings: string[];
};
