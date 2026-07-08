export type ProcessResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
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
  args: string[];
  pid?: number;
  grokSessionId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  errorMessage?: string;
  stdoutPath: string;
  stderrPath: string;
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
  eventCounts: Record<string, number>;
  grokSessionId?: string;
  requestId?: string;
  stopReason?: string;
  sawEnd: boolean;
  thoughtEventCount: number;
  textEventCount: number;
  textPreview?: string;
  guidance: string;
};
