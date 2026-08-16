import type { JobOutputSummary, JobRecord, PluginErrorInfo } from "./types.js";
import {
  CONTINUE_WITHOUT_TOOLS_REMEDY,
  classifyGrokErrorText,
  grokFailureDetails,
  grokFailureMessage,
  isRetryableGrokFailure
} from "./grok-cli.js";

/** Grok has shipped both `EndTurn` and `end_turn`; compare on a case/separator-free form. */
export function normalizeStopReason(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

const NORMAL_COMPLETION_STOP_REASONS = new Set(["endturn"]);
const CANCELLED_STOP_REASONS = new Set(["cancelled", "canceled"]);
/** 26 of 64 recorded "successful" answers were shorter than this. */
const THIN_EVIDENCE_TEXT_CHARS = 400;

/**
 * stdout only carries the session id inside the `end` event, which is exactly the event a killed or
 * timed-out run never emits. Grok also prints `session_id=<uuid>` to stderr on tool errors, so that
 * channel is a free fallback for the runs that most need a continuation handle.
 */
export function sessionIdFromStderr(stderr: string): string | undefined {
  return /session_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(stderr)?.[1];
}

/**
 * GPC-04: the failure classifier is a substring matcher, so feeding it up to 1MB of Grok's own
 * review prose made "forbidden", "unauthorized", and "not logged in" — ordinary words in a security
 * review — decide the error code. Only vendor-emitted error events belong on that input face.
 */
export function errorEventText(stdout: string): string {
  const messages: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = nestedRecord(parsed);
    if (!event) continue;
    const type = stringValue(event.type);
    if (type !== "error" && type !== "max_turns_reached" && event.error === undefined) continue;
    if (type === "max_turns_reached") {
      messages.push("max_turns_reached");
      continue;
    }
    const raw = event.error ?? event.message ?? event.data;
    if (raw === undefined) continue;
    messages.push(typeof raw === "string" ? raw : JSON.stringify(raw));
  }
  return messages.join("\n");
}

/**
 * X1: a headless delegation that spends its first turns reading `~/.grok/skills/pua/SKILL.md` is
 * burning the budget the task needed. 57 of 128 recorded runs did exactly that, so the loads are
 * counted and surfaced instead of being invisible.
 */
const SKILL_LOAD_PATTERNS = [
  /(?:\.grok|\.claude|\.codex|opencode)\/skills\/([A-Za-z0-9_.:-]+)/g,
  /([A-Za-z0-9_.:-]+)\/SKILL\.md/g
];

function collectSkillLoads(line: string, into: Set<string>): void {
  for (const pattern of SKILL_LOAD_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
      const name = match[1];
      if (name && name !== "skills") into.add(name);
    }
  }
}

/**
 * X2: 30 of 64 `succeeded` review jobs made zero tool calls — a verdict from a reviewer that never
 * opened a file. Recorded streams give every tool event a `toolCallId`, so unique ids are the
 * count; a stream that only carries anonymous tool events still proves the calls happened, so the
 * event count is the fallback. Either way the zero/non-zero distinction is exact.
 */
function toolCallIdOf(event: Record<string, unknown>): string | undefined {
  const data = nestedRecord(event.data);
  return (
    stringValue(event.toolCallId) ??
    stringValue(event.tool_call_id) ??
    stringValue(event.id) ??
    stringValue(data?.toolCallId) ??
    stringValue(data?.id)
  );
}

const FILE_PATH_KEYS = new Set(["path", "file", "file_path", "filePath", "filename", "fileName", "uri"]);

function collectInspectedFiles(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 6 || into.size > 200) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectInspectedFiles(entry, into, depth + 1);
    return;
  }
  const record = nestedRecord(value);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    if (FILE_PATH_KEYS.has(key)) {
      const path = stringValue(entry);
      if (path && path.length <= 4_096) into.add(path);
      continue;
    }
    collectInspectedFiles(entry, into, depth + 1);
  }
}

function turnCountOf(event: Record<string, unknown>): number | undefined {
  const data = nestedRecord(event.data);
  const usage = nestedRecord(event.usage) ?? nestedRecord(data?.usage);
  for (const candidate of [
    event.num_turns,
    event.numTurns,
    data?.num_turns,
    data?.numTurns,
    usage?.num_turns,
    usage?.numTurns
  ]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function previewText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 500 ? `${singleLine.slice(0, 497)}...` : singleLine;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function eventText(event: Record<string, unknown>): string | undefined {
  const data = nestedRecord(event.data);
  return stringValue(event.data) ?? stringValue(data?.text) ?? stringValue(event.text);
}

function eventMetadata(event: Record<string, unknown>, key: string): string | undefined {
  const data = nestedRecord(event.data);
  return stringValue(event[key]) ?? stringValue(data?.[key]);
}

function streamErrorFrom(event: Record<string, unknown>): PluginErrorInfo | undefined {
  if (event.type !== "error" && event.type !== "max_turns_reached" && event.error === undefined) return undefined;
  if (event.type === "max_turns_reached") {
    return {
      code: "max_turns_reached",
      message: grokFailureMessage("max_turns_reached"),
      retryable: true
    };
  }
  const raw = event.error ?? event.data ?? event.message ?? "Grok emitted a streaming error event.";
  const message = typeof raw === "string" ? raw : JSON.stringify(raw);
  const code = classifyGrokErrorText(message);
  const publicCode = code === "unknown" ? "cli_stream_error" : code;
  const details = grokFailureDetails(code);
  return {
    code: publicCode,
    message: code === "unknown" ? "Grok emitted an unclassified streaming error event." : grokFailureMessage(code),
    retryable: code === "unknown" || isRetryableGrokFailure(code),
    ...(details ? { details } : {})
  };
}

export function summarizeGrokOutput(
  record: JobRecord,
  stdout: string,
  stderr = "",
  outputTruncated = record.outputTruncated ?? false
): JobOutputSummary {
  const eventCounts: Record<string, number> = {};
  const textChunks: string[] = [];
  let grokSessionId: string | undefined;
  let requestId: string | undefined;
  let stopReason: string | undefined;
  let sawEnd = false;
  let thoughtEventCount = 0;
  let textEventCount = 0;
  let streamError: PluginErrorInfo | undefined;
  const skillsLoaded = new Set<string>();
  const toolCallIds = new Set<string>();
  const filesInspected = new Set<string>();
  let toolEventCount = 0;
  let turnsUsed: number | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = nestedRecord(parsed);
    if (!event) continue;

    const eventType = stringValue(event.type) ?? "unknown";
    eventCounts[eventType] = (eventCounts[eventType] ?? 0) + 1;
    streamError ??= streamErrorFrom(event);

    if (eventType.startsWith("tool_call") || eventType === "tool_use") {
      collectSkillLoads(line, skillsLoaded);
      toolEventCount += 1;
      const id = toolCallIdOf(event);
      if (id) toolCallIds.add(id);
      collectInspectedFiles(event, filesInspected);
    }
    if (eventType === "thought") thoughtEventCount += 1;
    if (eventType === "text") {
      const text = eventText(event);
      if (text !== undefined) {
        textEventCount += 1;
        textChunks.push(text);
      }
    }
    if (eventType === "end") {
      sawEnd = true;
      grokSessionId = eventMetadata(event, "sessionId") ?? grokSessionId;
      requestId = eventMetadata(event, "requestId") ?? requestId;
      stopReason = eventMetadata(event, "stopReason") ?? stopReason;
      turnsUsed = turnCountOf(event) ?? turnsUsed;
    }
  }

  const finalText = textChunks.join("");
  const warnings: string[] = [];
  // GPC-03a: `outputTruncated` means the shared capture window overflowed, and 84.6% of that window
  // is tool echo. Only `textTruncated` — set by the worker when evicted characters actually came
  // from `text` events — can hide the answer, so only it may veto completeness.
  const textTruncated = record.textTruncated ?? outputTruncated;
  const stopReasonNormalized = normalizeStopReason(stopReason);
  const stopReasonRecognised =
    NORMAL_COMPLETION_STOP_REASONS.has(stopReasonNormalized) || CANCELLED_STOP_REASONS.has(stopReasonNormalized);
  grokSessionId ??= sessionIdFromStderr(stderr);

  let state: JobOutputSummary["state"];
  if (record.status === "failed" || streamError) state = "failed_partial";
  else if (record.status === "succeeded") {
    if (CANCELLED_STOP_REASONS.has(stopReasonNormalized)) state = "cancelled_partial";
    else {
      // Fail open on an unfamiliar vocabulary: a stream that ended with real text is a
      // completion, and 0.2.1's exact-match rule silently destroyed those answers. The
      // raw value plus stopReasonRecognised lets a strict caller still reject it.
      const endedWithText = Boolean(sawEnd && finalText.trim() && !textTruncated);
      state = endedWithText ? "succeeded_with_text" : "succeeded_without_text";
      if (endedWithText && !stopReasonRecognised) {
        warnings.push(`unrecognised stopReason "${stopReason ?? ""}"; treated as normal completion`);
      }
    }
  } else if (record.status === "cancelled") state = "cancelled_partial";
  else if (record.status === "queued") state = "queued_partial";
  else state = "running_partial";

  const toolCallCount = toolCallIds.size || toolEventCount;
  const evidenceLevel: JobOutputSummary["evidenceLevel"] =
    toolCallCount === 0
      ? "none"
      : filesInspected.size === 0 || finalText.trim().length < THIN_EVIDENCE_TEXT_CHARS
        ? "thin"
        : "substantive";
  // X2: a review verdict from a reviewer that opened nothing is an opinion. 30 of 64 succeeded jobs
  // made zero tool calls, and the orchestrator counted those as a vote.
  const zeroEvidenceVerdict =
    state === "succeeded_with_text" &&
    toolCallCount === 0 &&
    (record.kind === "review" || record.kind === "adversarial_review");
  if (zeroEvidenceVerdict) {
    warnings.push("verdict produced with 0 tool calls — treat as opinion, not review");
  }

  const resultComplete = state === "succeeded_with_text" && !zeroEvidenceVerdict;
  let guidance: string;
  if (resultComplete) {
    guidance = "Grok produced complete final text. Codex must still verify findings against the workspace before acting on them.";
  } else if (zeroEvidenceVerdict) {
    guidance =
      "Grok returned a verdict without making a single tool call, so nothing in the workspace was inspected. " +
      "Do not count it as a review: inline the evidence (diff, file excerpts, command output) into the target " +
      "and rerun, or continue the session asking for the file:line evidence behind each claim.";
  } else if (textTruncated) {
    guidance = "Grok output exceeded the capture limit and answer text was dropped. Returned text is incomplete and must not be treated as a final result.";
  } else if (record.status === "running" || record.status === "queued") {
    guidance = "Grok is still running. Poll result later or cancel and rerun with a narrower target.";
  } else if (streamError?.code === "max_turns_reached") {
    guidance = CONTINUE_WITHOUT_TOOLS_REMEDY("Grok reached maxTurns before producing a final result.");
  } else if (record.status === "failed" || streamError) {
    guidance = stderr.trim()
      ? "Grok failed. Inspect the bounded stderr tail and correct the environment or prompt."
      : "Grok failed without stderr. Rerun with a narrower prompt and inspect the structured error.";
  } else if (state === "cancelled_partial") {
    guidance = CONTINUE_WITHOUT_TOOLS_REMEDY(
      "Grok was cancelled before a final result; any returned text is partial."
    );
  } else {
    guidance = "Grok exited successfully but did not emit non-empty text with a normal end event.";
  }

  if (outputTruncated && !textTruncated) {
    warnings.push("capture window overflowed, but only non-answer stream payload was dropped");
  }
  if (skillsLoaded.size) {
    warnings.push(
      `Grok loaded ${skillsLoaded.size} interactive skill file(s) (${[...skillsLoaded].join(", ")}) during a ` +
        "headless delegation; that spends turn and time budget on repository bootstrap instructions."
    );
  }

  return {
    resultComplete,
    state,
    finalText: finalText || undefined,
    outputTruncated,
    textTruncated,
    skillsLoaded: [...skillsLoaded],
    toolCallCount,
    filesInspected: [...filesInspected],
    turnsUsed,
    evidenceLevel,
    eventCounts,
    grokSessionId,
    requestId,
    stopReason,
    stopReasonNormalized: stopReason === undefined ? undefined : stopReasonNormalized,
    stopReasonRecognised,
    sawEnd,
    thoughtEventCount,
    textEventCount,
    textPreview: finalText ? previewText(finalText) : undefined,
    streamError,
    guidance,
    warnings
  };
}
