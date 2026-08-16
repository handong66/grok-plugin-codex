import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  classifyGrokFailure,
  discoverGrok,
  parseModelsOutput,
  probeGrokCapabilities,
  runGrok,
  grokFailureMessage,
  isRetryableGrokFailure,
  type GrokCapabilities
} from "./grok-cli.js";
import { JobStore, toPublicJob } from "./job-store.js";
import {
  GrokPluginError,
  type JobKind,
  type ToolEnvelope
} from "./types.js";

export type CommonArgs = {
  cwd: string;
  model?: string;
  timeoutMs?: number;
  background?: boolean;
  disableWebSearch?: boolean;
  noSubagents?: boolean;
  maxTurns?: number;
  alwaysApprove?: boolean;
  reasoningEffort?: string;
  allowCodexPrivatePaths?: boolean;
  /** Trusted roots injected by the MCP server, never exposed in the public schema. */
  _workspaceRoots?: string[];
};

type WorkspaceRootsProvider = () => Promise<string[]>;
let workspaceRootsProvider: WorkspaceRootsProvider = async () => [process.cwd()];

const COMPOSER_FAST_MODEL = "grok-composer-2.5-fast";
const DEFAULT_RUN_TIMEOUT_MS = 600_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;

export function configureWorkspaceRootsProvider(provider: WorkspaceRootsProvider): void {
  workspaceRootsProvider = provider;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

async function canonicalWorkspaceRoots(requestRoots: string[] = []): Promise<string[]> {
  const provided = [...new Set([...(await workspaceRootsProvider()), ...requestRoots])];
  const roots: string[] = [];
  for (const root of provided) {
    try {
      const candidate = await realpath(root);
      if ((await stat(candidate)).isDirectory()) roots.push(candidate);
    } catch {
      // Ignore stale client roots; a valid root is still required below.
    }
  }
  return [...new Set(roots)];
}

async function resolveWorkspaceCwd(
  cwd: string,
  requestRoots: string[] = [],
  allowCodexPrivatePaths = false
): Promise<string> {
  const roots = await canonicalWorkspaceRoots(requestRoots);
  if (!roots.length) {
    throw new GrokPluginError("workspace_unavailable", "The MCP client did not provide a valid filesystem workspace root.");
  }
  let candidate: string;
  try {
    candidate = await realpath(resolve(cwd));
  } catch {
    throw new GrokPluginError("workspace_not_found", "The requested working directory does not exist.");
  }
  if (!(await stat(candidate)).isDirectory()) {
    throw new GrokPluginError("workspace_invalid", "The requested working directory is not a directory.");
  }
  if (!roots.some((root) => isWithin(root, candidate))) {
    throw new GrokPluginError("workspace_outside_roots", "The requested working directory is outside the active MCP workspace roots.");
  }
  if (!allowCodexPrivatePaths) {
    const codexHome = await realpath(process.env.CODEX_HOME ?? join(homedir(), ".codex")).catch(() => null);
    if (codexHome && isWithin(codexHome, candidate)) {
      throw new GrokPluginError("private_path_blocked", "The requested working directory is inside the private Codex runtime directory.");
    }
  }
  return candidate;
}

async function resolveDiscoveryCwd(cwd?: string, requestRoots: string[] = []): Promise<string> {
  if (cwd) return await resolveWorkspaceCwd(cwd, requestRoots);
  const roots = await canonicalWorkspaceRoots(requestRoots);
  return roots[0] ?? process.cwd();
}

async function canonicalProspectivePath(path: string): Promise<string> {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    const resolved = await realpath(cursor).catch(() => null);
    if (resolved) return resolve(resolved, ...suffix);
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(path);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
}

async function assertStateOutsideWorkspace(store: JobStore, cwd: string, requestRoots: string[] = []): Promise<void> {
  const stateDir = await canonicalProspectivePath(store.stateDir);
  const workspaceRoots = [...new Set([...(await canonicalWorkspaceRoots(requestRoots)), cwd])];
  if (workspaceRoots.some((root) => isWithin(root, stateDir) || isWithin(stateDir, root))) {
    throw new GrokPluginError(
      "state_dir_in_workspace",
      "GROK_PLUGIN_STATE_DIR must be isolated from every active workspace root. Use a private user state directory."
    );
  }
}

function toolResult<T extends Record<string, unknown>>(envelope: ToolEnvelope<T>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    ...(isError ? { isError: true } : {})
  };
}

function success<T extends Record<string, unknown>>(data: T, warnings: string[] = []) {
  return toolResult<T>({ ok: true, data, error: null, warnings });
}

function asPluginError(error: unknown): GrokPluginError {
  if (error instanceof GrokPluginError) return error;
  return new GrokPluginError(
    "internal_error",
    "The plugin encountered an internal error. Retry or run grok_check for diagnostics.",
    true
  );
}

function failure(error: unknown, warnings: string[] = []) {
  const pluginError = asPluginError(error);
  return toolResult(
    { ok: false, data: null, error: pluginError.toInfo(), warnings },
    true
  );
}

async function guarded<T>(operation: () => Promise<T>): Promise<T | ReturnType<typeof failure>> {
  try {
    return await operation();
  } catch (error) {
    return failure(error);
  }
}

function privateCodexPathMessage(): string {
  return (
    "Prompt asks Grok to read Codex private runtime paths such as ~/.codex. " +
    "Inline only visible task context or explicitly authorize the private path risk."
  );
}

export function validatePromptBoundary(prompt: string, allowCodexPrivatePaths?: boolean): void {
  if (allowCodexPrivatePaths) return;
  const pattern = /(?:^|[\s"'`(])(?:~|\$HOME|\/[^\s"'`)]+)\/\.codex(?:\/|\b)/;
  if (pattern.test(prompt)) throw new GrokPluginError("private_path_blocked", privateCodexPathMessage());
}

function validateSessionId(sessionId: string): void {
  if (
    !sessionId ||
    sessionId !== sessionId.trim() ||
    /[\0\r\n]/.test(sessionId) ||
    sessionId.length > 256 ||
    sessionId.startsWith("-")
  ) {
    throw new GrokPluginError("invalid_session_id", "sessionId must be a non-empty identifier and must not begin with a flag prefix.");
  }
}

function withGlobalCwd(cwd: string, args: string[]): string[] {
  return ["--cwd", cwd, ...args];
}

function addCommonCommandArgs(
  params: CommonArgs & { readOnly?: boolean; capabilities?: GrokCapabilities }
): { args: string[]; warnings: string[] } {
  const args = ["--cwd", params.cwd];
  const warnings: string[] = [];
  if (params.model) args.push("-m", params.model);
  args.push("--output-format", "streaming-json");
  if (params.disableWebSearch) args.push("--disable-web-search");
  if (params.readOnly) {
    args.push("--permission-mode", "plan", "--no-subagents");
  } else if (params.noSubagents) {
    args.push("--no-subagents");
  }
  if (params.maxTurns !== undefined) args.push("--max-turns", String(params.maxTurns));
  if (!params.readOnly && params.alwaysApprove === true) args.push("--always-approve");

  if (params.reasoningEffort) {
    if (params.capabilities && !params.capabilities.reasoningEffort) {
      warnings.push("The installed Grok CLI does not advertise --reasoning-effort; the option was not passed.");
    } else if (!params.model) {
      warnings.push("reasoningEffort was not passed because no explicit model was selected.");
    } else if (params.model === COMPOSER_FAST_MODEL) {
      warnings.push(`${COMPOSER_FAST_MODEL} does not support --reasoning-effort; the option was not passed.`);
    } else {
      args.push("--reasoning-effort", params.reasoningEffort);
    }
  }
  return { args, warnings };
}

export function buildRunArgs(
  params: CommonArgs & { readOnly?: boolean; capabilities?: GrokCapabilities }
): { args: string[]; warnings: string[] } {
  return addCommonCommandArgs(params);
}

export function buildContinueArgs(
  params: CommonArgs & {
    sessionId?: string;
    continueLatest?: boolean;
    capabilities?: GrokCapabilities;
  }
): { args: string[]; warnings: string[] } {
  if (params.sessionId && params.continueLatest) {
    throw new GrokPluginError("invalid_continue_target", "grok_continue accepts either sessionId or continueLatest, not both.");
  }
  if (!params.sessionId && params.continueLatest !== true) {
    throw new GrokPluginError("continue_target_required", "grok_continue requires sessionId or explicit continueLatest: true.");
  }
  const built = addCommonCommandArgs(params);
  if (params.sessionId) {
    validateSessionId(params.sessionId);
    built.args.push(`--resume=${params.sessionId}`);
  } else {
    built.args.push("--continue");
  }
  return built;
}

async function requiredRunCapabilities(params: CommonArgs & { readOnly: boolean }): Promise<GrokCapabilities> {
  const discovered = await discoverGrok();
  if (!discovered.ok || !discovered.bin) {
    throw new GrokPluginError("grok_not_found", "Grok CLI was not found in the configured trusted locations.", false, {
      tried: discovered.tried
    });
  }
  const probe = await probeGrokCapabilities(discovered.bin);
  const missing = [
    !probe.capabilities.promptFile ? "--prompt-file" : "",
    !probe.capabilities.streamingJson ? "streaming-json" : "",
    params.readOnly && !probe.capabilities.permissionModePlan ? "--permission-mode plan" : "",
    params.readOnly && !probe.capabilities.noSubagents ? "--no-subagents" : "",
    params.disableWebSearch && !probe.capabilities.disableWebSearch ? "--disable-web-search" : ""
  ].filter(Boolean);
  if (probe.exitCode !== 0 || missing.length) {
    throw new GrokPluginError("cli_incompatible", "The installed Grok CLI lacks required safe execution capabilities.", false, {
      missing
    });
  }
  return probe.capabilities;
}

async function runOrStartJob(params: CommonArgs & {
  kind: JobKind;
  prompt: string;
  sessionId?: string;
  continueLatest?: boolean;
  readOnly?: boolean;
}) {
  return await guarded(async () => {
    const cwd = await resolveWorkspaceCwd(params.cwd, params._workspaceRoots, params.allowCodexPrivatePaths);
    validatePromptBoundary(params.prompt, params.allowCodexPrivatePaths);
    const readOnly = params.readOnly ?? false;
    const store = new JobStore();
    await assertStateOutsideWorkspace(store, cwd, params._workspaceRoots);
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new GrokPluginError(
        "platform_unsupported",
        "Grok process-tree lifecycle management is supported only on macOS and Linux."
      );
    }
    if (params.kind === "continue") {
      if (params.sessionId && params.continueLatest) {
        throw new GrokPluginError("invalid_continue_target", "grok_continue accepts either sessionId or continueLatest, not both.");
      }
      if (!params.sessionId && params.continueLatest !== true) {
        throw new GrokPluginError("continue_target_required", "grok_continue requires sessionId or explicit continueLatest: true.");
      }
      if (params.sessionId) validateSessionId(params.sessionId);
    }
    const capabilities = await requiredRunCapabilities({ ...params, cwd, readOnly });
    const built =
      params.kind === "continue"
        ? buildContinueArgs({ ...params, cwd, capabilities })
        : buildRunArgs({ ...params, cwd, capabilities, readOnly });
    const job = await store.startGrokJob({
      kind: params.kind,
      cwd,
      args: built.args,
      prompt: params.prompt,
      timeoutMs: params.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      grokSessionId: params.sessionId
    });
    if (params.background) {
      return success({ background: true, job: toPublicJob(job) }, built.warnings);
    }

    let result = await store.result(job.id);
    while (!["succeeded", "failed", "cancelled"].includes(result.record.status)) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      result = await store.result(job.id);
    }
    const durationMs = Math.max(
      0,
      Date.parse(result.record.finishedAt ?? new Date().toISOString()) -
        Date.parse(result.record.startedAt ?? result.record.createdAt)
    );
    const diagnosticDetails = {
      outputState: result.outputSummary.state,
      outputTruncated: result.outputSummary.outputTruncated,
      stopReason: result.outputSummary.stopReason,
      grokSessionId: result.outputSummary.grokSessionId,
      requestId: result.outputSummary.requestId,
      textPreview: result.outputSummary.textPreview,
      streamError: result.outputSummary.streamError,
      guidance: result.outputSummary.guidance,
      stderrTail: result.stderr.slice(-4_000)
    };
    if (result.record.status === "cancelled") {
      throw new GrokPluginError("cancelled", "The Grok request was cancelled before completion.", false);
    }
    if (result.record.status === "failed") {
      const error = result.record.error ?? {
        code: "grok_failed",
        message: grokFailureMessage("grok_failed"),
        retryable: true
      };
      throw new GrokPluginError(error.code, error.message, error.retryable, {
        exitCode: result.record.exitCode,
        ...diagnosticDetails
      });
    }
    if (!result.outputSummary.resultComplete) {
      if (result.outputSummary.streamError) {
        const streamError = result.outputSummary.streamError;
        throw new GrokPluginError(streamError.code, streamError.message, streamError.retryable, diagnosticDetails);
      }
      const cancelled = result.outputSummary.state === "cancelled_partial";
      throw new GrokPluginError(
        cancelled ? "cancelled_output" : "incomplete_output",
        cancelled
          ? "Grok ended with stopReason=Cancelled before producing a final result."
          : "Grok exited without non-empty final text and a normal EndTurn event.",
        true,
        diagnosticDetails
      );
    }
    return success(
      {
        background: false,
        exitCode: result.record.exitCode,
        durationMs,
        finalText: result.outputSummary.finalText,
        outputSummary: result.outputSummary,
        stderrTail: result.stderr.slice(-4_000)
      },
      built.warnings
    );
  });
}

export async function grokCheck(args: { cwd?: string; timeoutMs?: number; includeModels?: boolean; _workspaceRoots?: string[] }) {
  return await guarded(async () => {
    const discovered = await discoverGrok();
    if (!discovered.ok || !discovered.bin) {
      throw new GrokPluginError("grok_not_found", "Grok CLI was not found in the configured trusted locations.", false, {
        cliDiscovered: false,
        tried: discovered.tried
      });
    }
    const probe = await probeGrokCapabilities(discovered.bin, { timeoutMs: args.timeoutMs ?? 5_000 });
    const base = {
      pluginVersion: "0.2.1",
      contractVersion: "2",
      cliDiscovered: true,
      version: discovered.version,
      capabilities: probe.capabilities,
      authenticated: null as boolean | null,
      modelsListed: false,
      modelInvocationTested: false,
      callable: null as boolean | null
    };
    if (probe.exitCode !== 0) {
      throw new GrokPluginError("cli_incompatible", "Grok --help failed, so capability compatibility could not be established.", false, base);
    }
    if (args.includeModels === false) return success(base);

    const cwd = await resolveDiscoveryCwd(args.cwd, args._workspaceRoots);
    const models = await runGrok(withGlobalCwd(cwd, ["models"]), {
      cwd,
      timeoutMs: args.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
    });
    const parsed = parseModelsOutput(models.stdout || models.stderr);
    if (models.exitCode !== 0) {
      throw new GrokPluginError(classifyGrokFailure(models), "Grok model discovery failed.", true, {
        ...base,
        authenticated: parsed.loggedIn,
        modelsListed: false,
        exitCode: models.exitCode
      });
    }
    return success({
      ...base,
      authenticated: parsed.loggedIn,
      modelsListed: true,
      models: parsed
    });
  });
}

export async function grokModels(args: { cwd?: string; timeoutMs?: number; _workspaceRoots?: string[] }) {
  return await guarded(async () => {
    const cwd = await resolveDiscoveryCwd(args.cwd, args._workspaceRoots);
    const result = await runGrok(withGlobalCwd(cwd, ["models"]), {
      cwd,
      timeoutMs: args.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
    });
    if (result.exitCode !== 0) {
      throw new GrokPluginError(classifyGrokFailure(result), "Grok model discovery failed.", true, {
        exitCode: result.exitCode
      });
    }
    return success({ raw: result.stdout || result.stderr, parsed: parseModelsOutput(result.stdout || result.stderr) });
  });
}

export async function grokRun(args: CommonArgs & { prompt: string }) {
  return await runOrStartJob({ ...args, kind: "run" });
}

export async function grokContinue(args: CommonArgs & { prompt: string; sessionId?: string; continueLatest?: boolean }) {
  return await runOrStartJob({ ...args, kind: "continue" });
}

export async function grokRescue(args: CommonArgs & { problem: string }) {
  const prompt = [
    "You are Grok acting as an independent rescue reviewer for a Codex task.",
    "Stay read-only. Do not edit files, commit, push, deploy, or run destructive commands.",
    "Do not read Codex private runtime directories.",
    "Return: Diagnosis, Minimal path forward, Commands to verify, Risks.",
    "",
    args.problem
  ].join("\n");
  return await runOrStartJob({ ...args, kind: "rescue", prompt, readOnly: true });
}

export async function grokReview(args: CommonArgs & { target: string }) {
  const prompt = [
    "You are Grok acting as a bounded second reviewer for Codex.",
    `Review only this explicit target: ${args.target}`,
    "Stay read-only. Do not edit files, commit, push, deploy, or run destructive commands.",
    "Do not spawn subagents or expand into a broad security scan.",
    "Return Findings first with exact file:line evidence, then Open questions and Test gaps."
  ].join("\n");
  return await runOrStartJob({ ...args, kind: "review", prompt, readOnly: true });
}

export async function grokAdversarialReview(args: CommonArgs & { target: string }) {
  const prompt = [
    "You are Grok acting as a bounded failure-mode reviewer for Codex.",
    `Inspect only this explicit target: ${args.target}`,
    "Stay read-only. Do not edit files, commit, push, deploy, or run destructive commands.",
    "Do not spawn subagents or perform repo-wide discovery unless the target is explicitly repo-wide.",
    "Return at most 5 findings with exact file:line evidence, then Highest-risk assumption, Recommended verification, and Scope not inspected."
  ].join("\n");
  return await runOrStartJob({ ...args, kind: "adversarial_review", prompt, readOnly: true });
}

export async function grokSessions(args: { cwd: string; timeoutMs?: number; query?: string; limit?: number; _workspaceRoots?: string[] }) {
  return await guarded(async () => {
    const cwd = await resolveWorkspaceCwd(args.cwd, args._workspaceRoots);
    const commandArgs = withGlobalCwd(cwd, ["sessions", args.query ? "search" : "list"]);
    if (args.limit !== undefined) commandArgs.push("--limit", String(args.limit));
    if (args.query) commandArgs.push("--", args.query);
    const result = await runGrok(commandArgs, { cwd, timeoutMs: args.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new GrokPluginError(classifyGrokFailure(result), "Grok session discovery failed.", true, {
        exitCode: result.exitCode
      });
    }
    return success({ stdout: result.stdout, stderr: result.stderr });
  });
}

export async function grokExport(args: { cwd: string; timeoutMs?: number; sessionId: string; _workspaceRoots?: string[] }) {
  return await guarded(async () => {
    const cwd = await resolveWorkspaceCwd(args.cwd, args._workspaceRoots);
    validateSessionId(args.sessionId);
    const result = await runGrok(withGlobalCwd(cwd, ["export", "--", args.sessionId]), {
      cwd,
      timeoutMs: args.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
    });
    if (result.exitCode !== 0) {
      throw new GrokPluginError(classifyGrokFailure(result), "Grok session export failed.", true, {
        exitCode: result.exitCode
      });
    }
    return success({ markdown: result.stdout, stderr: result.stderr });
  });
}

export async function grokStatus(args: { jobId: string }) {
  return await guarded(async () => success({ job: toPublicJob(await new JobStore().status(args.jobId)) }));
}

export async function grokResult(args: { jobId: string; maxChars?: number }) {
  return await guarded(async () => {
    const result = await new JobStore().result(args.jobId, args.maxChars);
    return success({
      job: toPublicJob(result.record),
      stdoutTail: result.stdout,
      stderrTail: result.stderr,
      outputSummary: result.outputSummary,
      finalText: result.outputSummary.finalText,
      resultComplete: result.outputSummary.resultComplete,
      outputTruncated: result.outputSummary.outputTruncated
    });
  });
}

export async function grokCancel(args: { jobId: string }) {
  return await guarded(async () => success({ job: toPublicJob(await new JobStore().cancel(args.jobId)) }));
}
