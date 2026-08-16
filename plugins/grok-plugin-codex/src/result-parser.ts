import type { JobOutputSummary, JobRecord, PluginErrorInfo } from "./types.js";
import { classifyGrokErrorText, grokFailureMessage, isRetryableGrokFailure } from "./grok-cli.js";

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
  return {
    code: publicCode,
    message: code === "unknown" ? "Grok emitted an unclassified streaming error event." : grokFailureMessage(code),
    retryable: code === "unknown" || isRetryableGrokFailure(code)
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
    }
  }

  const finalText = textChunks.join("");
  let state: JobOutputSummary["state"];
  if (record.status === "failed" || streamError) state = "failed_partial";
  else if (record.status === "succeeded") {
    if (stopReason === "Cancelled") state = "cancelled_partial";
    else {
      state = sawEnd && stopReason === "EndTurn" && finalText.trim() && !outputTruncated
        ? "succeeded_with_text"
        : "succeeded_without_text";
    }
  } else if (record.status === "cancelled") state = "cancelled_partial";
  else if (record.status === "queued") state = "queued_partial";
  else state = "running_partial";

  const resultComplete = state === "succeeded_with_text";
  let guidance: string;
  if (resultComplete) {
    guidance = "Grok produced complete final text. Codex must still verify findings against the workspace before acting on them.";
  } else if (outputTruncated) {
    guidance = "Grok output exceeded the capture limit. Returned text is incomplete and must not be treated as a final result.";
  } else if (record.status === "running" || record.status === "queued") {
    guidance = "Grok is still running. Poll result later or cancel and rerun with a narrower target.";
  } else if (streamError?.code === "max_turns_reached") {
    guidance = "Grok reached maxTurns before producing a final result. Narrow the target or increase maxTurns before retrying.";
  } else if (record.status === "failed" || streamError) {
    guidance = stderr.trim()
      ? "Grok failed. Inspect the bounded stderr tail and correct the environment or prompt."
      : "Grok failed without stderr. Rerun with a narrower prompt and inspect the structured error.";
  } else if (state === "cancelled_partial") {
    guidance = "Grok was cancelled. Any returned text is partial and not a final result; continue the session or rerun with a narrower target.";
  } else {
    guidance = "Grok exited successfully but did not emit non-empty text with a normal EndTurn event.";
  }

  return {
    resultComplete,
    state,
    finalText: finalText || undefined,
    outputTruncated,
    eventCounts,
    grokSessionId,
    requestId,
    stopReason,
    sawEnd,
    thoughtEventCount,
    textEventCount,
    textPreview: finalText ? previewText(finalText) : undefined,
    streamError,
    guidance
  };
}
