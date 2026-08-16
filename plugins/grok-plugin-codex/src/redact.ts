import { homedir } from "node:os";
import { dirname, isAbsolute, sep } from "node:path";

/**
 * GPC-02's failure diagnostics (`errorMessage`, `stackTail`, `teardownError`, `workerLogTail`) are
 * copied verbatim into public MCP envelopes, where docs/privacy.md promises no state-file paths and
 * no local command paths. Replacing the known roots with fixed labels keeps every diagnostic fact —
 * which artifact, which errno, which frame — while dropping where this machine keeps it.
 */
export type PathRedactor = (value: string) => string;

export type RedactionRoot = { path: string; label: string };

export const IDENTITY_REDACTOR: PathRedactor = (value) => value;

/** Anything that is not followed by a path-name character, so `/root` never eats `/rootfs`. */
const ROOT_BOUNDARY = "(?![A-Za-z0-9_.-])";

function normaliseRoot(path: string | undefined): string {
  let value = path ?? "";
  while (value.length > 1 && value.endsWith(sep)) value = value.slice(0, -1);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createPathRedactor(roots: RedactionRoot[]): PathRedactor {
  const ordered = roots
    .map((root) => ({ label: root.label, path: normaliseRoot(root.path) }))
    // `/` would rewrite every absolute path in a message, so a root must name at least one segment.
    .filter((root) => isAbsolute(root.path) && root.path.split(sep).filter(Boolean).length >= 1)
    // Longest first: the state directory normally lives inside the home directory.
    .sort((left, right) => right.path.length - left.path.length);
  if (!ordered.length) return IDENTITY_REDACTOR;
  const patterns = ordered.map((root) => ({
    label: root.label,
    pattern: new RegExp(`${escapeRegExp(root.path)}${ROOT_BOUNDARY}`, "g")
  }));
  return (value) => patterns.reduce((current, { label, pattern }) => current.replace(pattern, label), value);
}

/**
 * GK1: a stalled Grok prints its OAuth device flow to stderr, including a one-time `user_code` that
 * grants access to the account. The sign-in URL is the actionable part and stays; the code is a
 * credential and must not travel into an orchestrator's context or transcript.
 */
export function redactDeviceCode(value: string): string {
  return value.replace(/user_code=[A-Za-z0-9-]+/gi, "user_code=<redacted>");
}

/**
 * X2: `outputSummary.filesInspected` is a public field holding paths **Grok** chose, not the caller —
 * the recorded delegates opened `~/.grok/skills/pua/SKILL.md` and `~/.claude/skills/…/SKILL.md`, home
 * locations outside the workspace — so it is a free-form diagnostic and goes through the redactor like
 * the others. A summary built without a `JobStore` (direct parser callers) has no state or install
 * directory to name, so the fallback covers the home directory only.
 */
export function defaultDiagnosticRedactor(env: NodeJS.ProcessEnv = process.env): PathRedactor {
  return createPathRedactor([{ path: env.HOME ?? homedir(), label: "<home>" }]);
}

/**
 * The roots a job diagnostic can plausibly name: the private state directory, the directory the
 * plugin is installed in (stack frames), and the user's home directory (everything else).
 */
export function jobDiagnosticRedactor(options: {
  stateDir: string;
  workerPath?: string;
  env?: NodeJS.ProcessEnv;
}): PathRedactor {
  const env = options.env ?? process.env;
  return createPathRedactor([
    { path: options.stateDir, label: "<state>" },
    ...(options.workerPath ? [{ path: dirname(options.workerPath), label: "<plugin>" }] : []),
    { path: env.HOME ?? homedir(), label: "<home>" }
  ]);
}
