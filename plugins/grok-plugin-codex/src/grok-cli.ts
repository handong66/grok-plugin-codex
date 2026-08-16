import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { normalizeStopReason } from "./result-parser.js";
import type { GrokModelsSummary, ProcessResult } from "./types.js";

export type DiscoverGrokOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  extraCandidates?: string[];
};

export type DiscoverGrokResult = {
  ok: boolean;
  bin?: string;
  version?: string;
  tried: string[];
  errors: string[];
};

export type GrokCapabilities = {
  promptFile: boolean;
  streamingJson: boolean;
  permissionModePlan: boolean;
  noSubagents: boolean;
  disableWebSearch: boolean;
  reasoningEffort: boolean;
  /** `-s, --session-id <SESSION_ID>`: lets the plugin choose the resume handle before the run starts. */
  sessionId: boolean;
};

export type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  maxOutputChars?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;
const GROK_ENV_ALLOWLIST = [
  "GROK_BIN",
  "HOME",
  "PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS"
] as const;

export function buildGrokProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const key of GROK_ENV_ALLOWLIST) {
    if (env[key] !== undefined) filtered[key] = env[key];
  }
  return filtered;
}

export function buildWorkerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const filtered = buildGrokProcessEnv(env);
  // GROK_PLUGIN_RAW_CAPTURE is a plugin-development escape hatch that must reach the worker, which
  // is the process that decides whether to elide oversized tool payloads.
  for (const key of ["GROK_PLUGIN_STATE_DIR", "GROK_PLUGIN_WORKER_PATH", "GROK_PLUGIN_RAW_CAPTURE"] as const) {
    if (env[key] !== undefined) filtered[key] = env[key];
  }
  return filtered;
}

export function expandHome(value: string, homeDir = homedir()): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function getGrokCandidates(options: DiscoverGrokOptions = {}): string[] {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? homedir();
  const pathCandidates = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "grok"));

  return unique([
    env.GROK_BIN ? expandHome(env.GROK_BIN, home) : "",
    join(home, ".grok", "bin", "grok"),
    join(home, ".local", "bin", "grok"),
    "/opt/homebrew/bin/grok",
    "/usr/local/bin/grok",
    ...(options.extraCandidates ?? []).map((candidate) => expandHome(candidate, home)),
    ...pathCandidates
  ]);
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function appendOutputTail(current: string, chunk: string, maxChars: number): { value: string; truncated: boolean } {
  const combined = current + chunk;
  if (combined.length <= maxChars) return { value: combined, truncated: false };
  return { value: combined.slice(-maxChars), truncated: true };
}

export function signalPidTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export function signalProcessTree(child: ChildProcess | null, signal: NodeJS.Signals): void {
  signalPidTree(child?.pid, signal);
}

export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {}
): Promise<ProcessResult> {
  const startedAt = Date.now();

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: buildGrokProcessEnv({ ...process.env, ...(options.env ?? {}) }),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    const maxOutputChars = Math.max(options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS, 1);
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      signalProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) signalProcessTree(child, "SIGKILL");
      }, 2_000);
      forceKillTimer.unref();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const appended = appendOutputTail(stdout, chunk, maxOutputChars);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: string) => {
      const appended = appendOutputTail(stderr, chunk, maxOutputChars);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        command,
        args,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        stdoutTruncated,
        stderrTruncated,
        timedOut
      });
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}

export async function discoverGrok(options: DiscoverGrokOptions = {}): Promise<DiscoverGrokResult> {
  const tried: string[] = [];
  const errors: string[] = [];

  for (const candidate of getGrokCandidates(options)) {
    tried.push(candidate);
    if (!(await isExecutable(candidate))) {
      errors.push(`${candidate}: not executable or not found`);
      continue;
    }

    try {
      const result = await runProcess(candidate, ["--version"], {
        env: options.env,
        timeoutMs: 5_000
      });
      if (result.exitCode === 0 && !result.timedOut) {
        return {
          ok: true,
          bin: candidate,
          version: result.stdout.trim() || result.stderr.trim(),
          tried,
          errors
        };
      }
      errors.push(`${candidate}: --version exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`);
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ok: false, tried, errors };
}

export async function probeGrokCapabilities(
  bin: string,
  options: Pick<RunProcessOptions, "env" | "timeoutMs"> = {}
): Promise<{ capabilities: GrokCapabilities; rawHelp: string; exitCode: number | null }> {
  const result = await runProcess(bin, ["--help"], {
    env: options.env,
    timeoutMs: options.timeoutMs ?? 5_000
  });
  const rawHelp = result.stdout || result.stderr;
  return {
    capabilities: {
      promptFile: rawHelp.includes("--prompt-file"),
      streamingJson: rawHelp.includes("streaming-json"),
      permissionModePlan: rawHelp.includes("--permission-mode") && rawHelp.includes("plan"),
      noSubagents: rawHelp.includes("--no-subagents"),
      disableWebSearch: rawHelp.includes("--disable-web-search"),
      reasoningEffort: rawHelp.includes("--reasoning-effort"),
      sessionId: rawHelp.includes("--session-id")
    },
    rawHelp,
    exitCode: result.exitCode
  };
}

export type GrokInvocationProbe = {
  modelInvocationTested: boolean;
  callable: boolean;
  observedStopReason?: string;
  observedStopReasonNormalized?: string;
  observedEventTypes: string[];
  exitCode: number | null;
  failureReason?: string;
};

export const INVOCATION_PROBE_PROMPT = "Reply with exactly: OK";
export const INVOCATION_PROBE_TIMEOUT_MS = 30_000;

/**
 * One deliberately tiny live call that proves the stream vocabulary, not just the flag names.
 * It spends real quota, so every caller must opt in explicitly (`probeInvocation: true`).
 */
export async function probeGrokInvocation(
  bin: string,
  options: { cwd: string; model?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; promptFile: string }
): Promise<GrokInvocationProbe> {
  const args = [
    "--cwd",
    options.cwd,
    ...(options.model ? ["-m", options.model] : []),
    "--output-format",
    "streaming-json",
    "--permission-mode",
    "plan",
    "--no-subagents",
    "--max-turns",
    "1",
    "--prompt-file",
    options.promptFile
  ];
  const result = await runProcess(bin, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: Math.min(options.timeoutMs ?? INVOCATION_PROBE_TIMEOUT_MS, INVOCATION_PROBE_TIMEOUT_MS)
  });

  const observedEventTypes: string[] = [];
  let observedStopReason: string | undefined;
  let sawText = false;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const event = parsed as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "unknown";
    if (!observedEventTypes.includes(type)) observedEventTypes.push(type);
    if (type === "text") sawText = true;
    if (type === "end" && typeof event.stopReason === "string") observedStopReason = event.stopReason;
  }

  const observedStopReasonNormalized = normalizeStopReason(observedStopReason);
  const sawNormalEnd = observedEventTypes.includes("end") && observedStopReasonNormalized === "endturn";
  const callable = result.exitCode === 0 && !result.timedOut && sawText && sawNormalEnd;
  const failureReason = callable
    ? undefined
    : result.timedOut
      ? "The invocation probe exceeded its 30s budget."
      : result.exitCode !== 0
        ? `The invocation probe exited ${result.exitCode}.`
        : !sawText
          ? "The invocation probe produced no text event."
          : `The invocation probe ended with stopReason "${observedStopReason ?? "(absent)"}" instead of a normal end turn.`;

  return {
    modelInvocationTested: true,
    callable,
    observedStopReason,
    observedStopReasonNormalized: observedStopReason === undefined ? undefined : observedStopReasonNormalized,
    observedEventTypes,
    exitCode: result.exitCode,
    failureReason
  };
}

export async function runGrok(
  args: string[],
  options: RunProcessOptions & DiscoverGrokOptions = {}
): Promise<ProcessResult & { bin: string }> {
  const discovered = await discoverGrok(options);
  if (!discovered.ok || !discovered.bin) {
    throw new Error(`Grok CLI not found. Tried: ${discovered.tried.join(", ")}`);
  }

  const result = await runProcess(discovered.bin, args, options);
  return { ...result, bin: discovered.bin };
}

export function parseModelsOutput(raw: string): GrokModelsSummary {
  const lines = raw.split(/\r?\n/);
  const lower = raw.toLowerCase();
  const hasPositiveAuthentication = /\b(?:you are )?logged in(?:\s+with\b|\b)/i.test(raw);
  const hasNegativeAuthentication = /\b(?:not logged in|not authenticated|login required|please log in|authentication required|unauthorized)\b/i.test(raw);
  const loggedIn = hasPositiveAuthentication && !hasNegativeAuthentication;
  const authMessage = lines.find((line) => /logged in|not logged in|login|required|auth/i.test(line.trim()));
  const defaultModel = lines
    .map((line) => line.match(/^\s*Default model:\s*(.+?)\s*$/i)?.[1]?.trim())
    .find((value): value is string => Boolean(value));
  const availableModels = lines
    .map((line) => {
      const match = line.match(/^\s*[*-]\s+(\S+)(?:\s+\((default)\))?\s*$/i);
      if (!match?.[1]) return undefined;
      const id = match[1];
      return { id, default: Boolean(match[2]) || id === defaultModel };
    })
    .filter((model): model is { id: string; default: boolean } => Boolean(model));

  if (defaultModel && !availableModels.some((model) => model.id === defaultModel) && !lower.includes("available models")) {
    availableModels.push({ id: defaultModel, default: true });
  }

  return { loggedIn, authMessage, defaultModel, availableModels, raw };
}

export function classifyGrokFailure(result: ProcessResult): string {
  if (result.timedOut) return "timeout";
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return classifyGrokErrorText(text, result);
}

/**
 * Paid-balance exhaustion. Numeric and vendor-slug signals lead; prose is the fallback. Note that
 * none of these patterns may contain an ASCII apostrophe — the CLI writes U+2019.
 */
const PAID_QUOTA_MARKERS = [
  "402 payment required",
  "balance exhausted",
  "quota exhausted",
  "usage limit exceeded",
  "run out of credits",
  "spending-limit",
  "personal-team-blocked"
];

/** Free-tier exhaustion: a different operator action (wait, upgrade, or route elsewhere). */
const FREE_TIER_QUOTA_MARKERS = [
  "reached your free",
  "usage limit for now",
  "need a grok subscription",
  "get supergrok"
];

/**
 * Auth needs positive evidence of a sign-in problem. Bare `forbidden` / `unauthorized` used to be
 * enough, which turned any security review that discussed 403 handling into `auth_required`.
 */
const AUTH_MARKERS = [
  "not logged in",
  "not authenticated",
  "login required",
  "log in required",
  "please log in",
  "authentication required",
  "authentication failed",
  "invalid api key",
  "missing api key",
  "grok login"
];

export function classifyGrokErrorText(textValue: string, result?: Pick<ProcessResult, "signal" | "exitCode">): string {
  const text = textValue.toLowerCase();
  if (text.includes("max_turns_reached") || text.includes("max turns reached")) return "max_turns_reached";
  // Quota is checked before auth: the recorded 403 spending-limit failure was reported as
  // `auth_required` purely because its text contains the word "forbidden".
  if (PAID_QUOTA_MARKERS.some((marker) => text.includes(marker))) return "quota_exhausted";
  if (FREE_TIER_QUOTA_MARKERS.some((marker) => text.includes(marker))) return "quota_free_tier";
  if (text.includes("429") || text.includes("rate limit")) return "rate_limited";
  if (AUTH_MARKERS.some((marker) => text.includes(marker))) return "auth_required";
  if (text.includes("401") && (text.includes("unauthorized") || text.includes("authentication") || text.includes("token"))) {
    return "auth_required";
  }
  if (text.includes("session") && (text.includes("not found") || text.includes("does not exist"))) return "session_not_found";
  if (text.includes("model") && (text.includes("not found") || text.includes("unavailable") || text.includes("not authorized"))) {
    return "model_unavailable";
  }
  if (text.includes("unknown argument") || text.includes("unexpected argument") || text.includes("unrecognized option")) {
    return "cli_incompatible";
  }
  if (text.includes("does not support reasoning effort")) return "unsupported_reasoning_effort";
  if (text.includes("econnrefused") || text.includes("enotfound") || text.includes("timeout")) return "network_error";
  if (result?.signal) return "terminated";
  if (result?.exitCode !== 0) return "grok_failed";
  return "unknown";
}

export function isRetryableGrokFailure(code: string): boolean {
  return ["network_error", "rate_limited", "timeout", "terminated", "max_turns_reached", "grok_failed", "unknown"].includes(code);
}

/**
 * One remedy sentence, used by every partial-result code. Continuing the same session with
 * `maxTurns: 1` and an explicit no-tools instruction is the only recovery observed to turn a
 * stalled run into a complete answer, and it costs seconds rather than a full rerun.
 */
export function CONTINUE_WITHOUT_TOOLS_REMEDY(cause: string): string {
  return (
    `${cause} Call grok_finalize with this jobId — one turn, no tools, complete answer — or do the ` +
    "same by hand with grok_continue, maxTurns: 1, and a prompt that says to stop using tools and emit " +
    "the complete final answer now; do not use any tools. Do not rerun the whole task, and do not raise " +
    "the budget first — the partial answer is still available from grok_result with the returned jobId."
  );
}

/** Extra, non-sensitive fields a code can contribute to `error.details`. */
export function grokFailureDetails(code: string): Record<string, unknown> | undefined {
  switch (code) {
    case "quota_free_tier":
      return {
        retryAfterHint:
          "Wait for the free-tier window to reset, upgrade the account, or route this task to another provider. Do not retry in this session."
      };
    case "quota_exhausted":
      return { retryAfterHint: "Restore the account balance or switch accounts before retrying." };
    default:
      return undefined;
  }
}

export function grokFailureMessage(code: string): string {
  switch (code) {
    case "quota_exhausted":
      return "Grok usage balance is exhausted. Replenish the account balance or use another authorized account before retrying. Do not retry with the same account.";
    case "quota_free_tier":
      return (
        "The free Grok usage limit for this account is exhausted for now. Do not retry: wait for the limit " +
        "to reset, upgrade the account, or route this task to another provider."
      );
    case "auth_required":
      return "Grok authentication is required. Log in with the Grok CLI before retrying.";
    case "rate_limited":
      return "Grok rate-limited the request. Retry after the provider limit resets.";
    case "session_not_found":
      return (
        "The Grok CLI no longer has that session. error.details.candidateSessions lists the sessions this " +
        "plugin started in the same workspace, newest first; or retry with fallbackToLatest: true to " +
        "continue the latest session in this workspace."
      );
    case "model_unavailable":
      return "The requested Grok model is unavailable or unauthorized. Verify it with the current account.";
    case "cli_incompatible":
      return "The installed Grok CLI does not support the required arguments. Upgrade or select a compatible CLI version.";
    case "network_error":
      return "Grok could not reach its service. Check network, proxy, and certificate configuration before retrying.";
    case "unsupported_reasoning_effort":
      return "The selected Grok model does not support reasoning effort. Remove that option or choose a compatible model.";
    case "max_turns_reached":
      // The recovery that actually worked in the recorded window was a one-turn, tool-free
      // continuation of the same session, not a wider budget or a narrower target.
      return CONTINUE_WITHOUT_TOOLS_REMEDY(
        "Grok reached the configured turn limit before producing a final result."
      );
    case "timeout":
      return CONTINUE_WITHOUT_TOOLS_REMEDY("Grok ran out of wall-clock budget before producing a final result.");
    case "terminated":
      return CONTINUE_WITHOUT_TOOLS_REMEDY("Grok was terminated before producing a final result.");
    default:
      return "Grok CLI exited without a usable final result.";
  }
}
