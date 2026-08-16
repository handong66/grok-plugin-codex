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
  /**
   * Three-state on purpose (X8 / SPEC §B GK1.3): `true` only on positive sign-in evidence, `false`
   * only on an explicit negative, `"unknown"` when the listing says nothing either way. A silent
   * listing published as `false` was read as a negative auth gate.
   */
  loggedIn: boolean | "unknown";
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
  /** The Grok CLI printed an OAuth device-authorization prompt instead of running (GK1). */
  waitingForAuth?: boolean;
  outputTruncated?: boolean;
  /** True only when the capture window evicted `text`-event characters, i.e. answer text was lost. */
  textTruncated?: boolean;
  /** Characters of `text`-event payload retained for this job. */
  textChars?: number;
};

/** The kinds this plugin has always started with `--permission-mode plan --no-subagents`. */
export const READ_ONLY_JOB_KINDS = new Set<JobKind>(["review", "adversarial_review", "rescue"]);

/**
 * GPC-M2: `readOnly` is new in 0.3.0, so every record written before it — including the retained
 * seven days of jobs that actually carry a `grokSessionId` — has the field absent. Reading a missing
 * field as `false` would resolve a real adversarial-review session to a mutable origin. The record
 * still names its `kind`, and the kind is what decided the flags in the first place.
 *
 * A `continue` job carries an explicit `readOnly` because its mode is inherited, not implied by the
 * kind, so it is answered by the stored field alone.
 */
export function jobWasReadOnly(record: Pick<JobRecord, "kind" | "readOnly">): boolean {
  return record.readOnly ?? READ_ONLY_JOB_KINDS.has(record.kind);
}

export type PublicJob = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutMs: number;
  grokSessionId?: string;
  /** Cheap signal that the run is blocked on an interactive sign-in, readable from grok_status. */
  waitingForAuth?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: PluginErrorInfo;
  outputTruncated?: boolean;
  /** GPC-07 progress, from the worker's ledger: cheap enough to poll, no stream re-parse. */
  textChars?: number;
  eventCounts?: Record<string, number>;
  lastEventAt?: string;
  toolCallCount?: number;
  deniedToolCalls?: { name: string; count: number }[];
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
  /**
   * Tool calls the headless permission mode refused, by name (GPC-06). 24 of the 56 recorded
   * plan-mode jobs each contain one `User cancelled the execution for tool run_terminal_command`.
   */
  deniedToolCalls: { name: string; count: number }[];
  /**
   * GK5: the run ended right after a shell command was refused in plan mode, so the cause is the
   * permission mode and not a target that was too wide.
   */
  shellApprovalBlocked: boolean;
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
