/**
 * Bounded capture of one child stream.
 *
 * GPC-03a. Three facts drove this file. (1) 84.6% of the 40.9MB of captured Grok stdout in the
 * 2026-08 window was `tool_call_update` echo and 3.16% was `available_commands`, against 3.31% of
 * actual answer text — one capture even held a base64 PNG. (2) `outputTruncated` was set by *any*
 * overflow of that shared window and forced `resultComplete: false`, so tool echo could bury a
 * complete answer. (3) The old flush rewrote both entire log files every 25ms, which is write
 * amplification proportional to the square of the stream length.
 *
 * So the capture is line-oriented: oversized tool payloads are elided as they arrive, the window
 * accounts separately for characters contributed by `text` events, and disk writes are appended
 * deltas — a full rewrite happens only when the window actually evicted something.
 */

const DEFAULT_MAX_CHARS = 1_000_000;
const MAX_TOOL_FIELD_CHARS = 2_048;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Same shape rule as the result parser: `data` as string, `data.text`, or `text`. */
function textEventChars(event: Record<string, unknown>): number {
  const data = nestedRecord(event.data);
  return (stringValue(event.data) ?? stringValue(data?.text) ?? stringValue(event.text) ?? "").length;
}

function elideLargeStrings(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    if (value.length <= MAX_TOOL_FIELD_CHARS) return { value, changed: false };
    return { value: `<elided ${Buffer.byteLength(value, "utf8")} bytes>`, changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((entry) => {
      const result = elideLargeStrings(entry);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? mapped : value, changed };
  }
  const record = nestedRecord(value);
  if (!record) return { value, changed: false };
  let changed = false;
  const mapped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const result = elideLargeStrings(entry);
    changed ||= result.changed;
    mapped[key] = result.value;
  }
  return { value: changed ? mapped : value, changed };
}

export type SanitizedLine = { text: string; textChars: number };

/**
 * Rewrites one streaming-JSON line for storage. `text` events are never touched — they are the
 * answer. Anything unparseable is stored verbatim so a malformed stream stays diagnosable.
 */
export function sanitizeStreamLine(line: string, raw = false): SanitizedLine {
  if (!line.trim()) return { text: line, textChars: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { text: line, textChars: 0 };
  }
  const event = nestedRecord(parsed);
  if (!event) return { text: line, textChars: 0 };
  const type = stringValue(event.type) ?? "";
  if (type === "text") return { text: line, textChars: textEventChars(event) };
  if (raw) return { text: line, textChars: 0 };
  if (type === "available_commands") {
    return { text: JSON.stringify({ type, elided: "available_commands payload" }), textChars: 0 };
  }
  if (type.startsWith("tool_call")) {
    const elided = elideLargeStrings(event);
    return { text: elided.changed ? JSON.stringify(elided.value) : line, textChars: 0 };
  }
  return { text: line, textChars: 0 };
}

export type CaptureWrite = { mode: "append" | "rewrite"; value: string };

export class StreamCapture {
  private readonly maxChars: number;
  private readonly lineOriented: boolean;
  private readonly raw: boolean;
  private readonly separator: string;
  private segments: SanitizedLine[] = [];
  private chars = 0;
  private pending = "";
  private flushedSegments = 0;
  private needsRewrite = false;
  private finished = false;
  /** True once the bounded window evicted anything at all, answer text or tool echo. */
  truncated = false;
  /** Characters of `text`-event payload evicted by the window — the only loss that hides an answer. */
  droppedTextChars = 0;
  /** Characters of `text`-event payload still inside the window. */
  textChars = 0;

  constructor(options: { maxChars?: number; lineOriented?: boolean; raw?: boolean } = {}) {
    this.maxChars = Math.max(options.maxChars ?? DEFAULT_MAX_CHARS, 1);
    this.lineOriented = options.lineOriented ?? true;
    this.raw = options.raw ?? false;
    this.separator = this.lineOriented ? "\n" : "";
  }

  append(chunk: string): void {
    if (!chunk) return;
    if (!this.lineOriented) {
      this.push({ text: chunk, textChars: 0 });
      return;
    }
    this.pending += chunk;
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    for (const part of parts) this.push(sanitizeStreamLine(part, this.raw));
  }

  /**
   * Promotes the trailing partial line and forces one final full rewrite, so the terminal on-disk
   * log is exactly the retained window even if an intermediate append failed and was swallowed.
   */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.needsRewrite = true;
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = "";
    this.push(sanitizeStreamLine(pending, this.raw));
  }

  /** Call when a write failed: the next flush rewrites the whole window instead of losing the delta. */
  markDirty(): void {
    this.needsRewrite = true;
  }

  private push(segment: SanitizedLine): void {
    let stored = segment;
    if (stored.text.length > this.maxChars) {
      // One pathological line — a base64 payload outside a tool event — must not outgrow the window.
      const overflow = stored.text.length - this.maxChars;
      stored = {
        text: stored.text.slice(-this.maxChars),
        textChars: Math.max(0, stored.textChars - overflow)
      };
      this.droppedTextChars += Math.min(overflow, segment.textChars);
      this.truncated = true;
      this.needsRewrite = true;
    }
    this.segments.push(stored);
    this.chars += stored.text.length + this.separator.length;
    this.textChars += stored.textChars;
    while (this.chars > this.maxChars && this.segments.length > 1) {
      const evicted = this.segments.shift();
      if (!evicted) break;
      this.chars -= evicted.text.length + this.separator.length;
      this.textChars -= evicted.textChars;
      this.droppedTextChars += evicted.textChars;
      this.truncated = true;
      this.needsRewrite = true;
      this.flushedSegments = Math.max(0, this.flushedSegments - 1);
    }
  }

  /** Complete segments only; a partial trailing line is never written until `finish()`. */
  private writableValue(): string {
    return this.segments.map((segment) => segment.text + this.separator).join("");
  }

  /** Everything retained, including the partial trailing line. */
  get value(): string {
    return this.writableValue() + this.pending;
  }

  /**
   * The next disk write, or `undefined` when the file is already current. Appends the delta unless
   * the window evicted something, which is the only case that requires rewriting from the front.
   */
  takeWrite(): CaptureWrite | undefined {
    if (this.needsRewrite) {
      this.needsRewrite = false;
      this.flushedSegments = this.segments.length;
      return { mode: "rewrite", value: this.writableValue() };
    }
    if (this.flushedSegments >= this.segments.length) return undefined;
    const appended = this.segments.slice(this.flushedSegments);
    this.flushedSegments = this.segments.length;
    return { mode: "append", value: appended.map((segment) => segment.text + this.separator).join("") };
  }
}
