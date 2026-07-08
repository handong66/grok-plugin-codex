import { access } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  classifyGrokFailure,
  discoverGrok,
  parseModelsOutput,
  runGrok
} from "./grok-cli.js";
import { JobStore } from "./job-store.js";

export type CommonArgs = {
  cwd?: string;
  grokBin?: string;
  model?: string;
  timeoutMs?: number;
  background?: boolean;
  disableWebSearch?: boolean;
  noSubagents?: boolean;
  maxTurns?: number;
  alwaysApprove?: boolean;
  reasoningEffort?: string;
  allowCodexPrivatePaths?: boolean;
};

type OutputFormat = "json" | "streaming-json";

const COMPOSER_FAST_MODEL = "grok-composer-2.5-fast";

function cwdOrDefault(cwd?: string): string {
  return resolve(cwd ?? process.cwd());
}

function withGlobalCwd(cwd: string, args: string[]): string[] {
  return ["--cwd", cwd, ...args];
}

function jsonText(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

function privateCodexPathMessage(): string {
  return (
    "Prompt asks Grok to read Codex private runtime paths such as ~/.codex. " +
    "Inline only the visible task context in prompt. Set allowCodexPrivatePaths only when the user explicitly asked for that risk."
  );
}

export function validatePromptBoundary(prompt: string, allowCodexPrivatePaths?: boolean): void {
  if (allowCodexPrivatePaths) return;

  const codexPrivatePathPattern = /(?:^|[\s"'`(])(?:~|\$HOME|\/[^\s"'`)]+)\/\.codex(?:\/|\b)/;
  if (codexPrivatePathPattern.test(prompt)) {
    throw new Error(privateCodexPathMessage());
  }
}

function describeFileValue(file: string): string {
  const singleLine = file.replace(/\s+/g, " ").trim();
  return JSON.stringify(singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine);
}

async function validateOptionalOutputPath(outputFile: string | undefined, cwd: string): Promise<void> {
  if (!outputFile) return;
  if (outputFile !== outputFile.trim() || /[\r\n]/.test(outputFile) || outputFile.length > 1_024) {
    throw new Error(`outputFile must be a filesystem path, got ${describeFileValue(outputFile)}.`);
  }
  const resolvedOutput = resolve(cwd, outputFile);
  const relativeOutput = relative(cwd, resolvedOutput);
  if (relativeOutput === ".." || relativeOutput.startsWith(`..${sep}`) || isAbsolute(relativeOutput)) {
    throw new Error("outputFile must stay inside cwd.");
  }
  const parent = dirname(resolvedOutput);
  await access(parent);
}

function validateSessionId(sessionId: string): void {
  if (
    !sessionId ||
    sessionId !== sessionId.trim() ||
    /[\0\r\n]/.test(sessionId) ||
    sessionId.length > 256 ||
    sessionId.startsWith("-")
  ) {
    throw new Error(`sessionId must be a non-empty session identifier, got ${describeFileValue(sessionId)}.`);
  }
}

function addCommonCommandArgs(params: CommonArgs & { cwd: string; outputFormat?: OutputFormat }): { args: string[]; warnings: string[] } {
  const args = ["--cwd", params.cwd];
  const warnings: string[] = [];

  if (params.model) args.push("-m", params.model);
  if (params.outputFormat) args.push("--output-format", params.outputFormat);
  if (params.disableWebSearch) args.push("--disable-web-search");
  if (params.noSubagents) args.push("--no-subagents");
  if (params.maxTurns !== undefined) args.push("--max-turns", String(params.maxTurns));
  if (params.alwaysApprove === true) args.push("--always-approve");

  if (params.reasoningEffort) {
    if (!params.model) {
      warnings.push(
        `reasoningEffort=${params.reasoningEffort} was not passed because no model was specified and the local default may not support --reasoning-effort.`
      );
    } else if (params.model === COMPOSER_FAST_MODEL) {
      warnings.push(
        `${COMPOSER_FAST_MODEL} does not support --reasoning-effort in local Grok CLI checks; not passing reasoningEffort=${params.reasoningEffort}.`
      );
    } else {
      args.push("--reasoning-effort", params.reasoningEffort);
    }
  }

  return { args, warnings };
}

export function buildRunArgs(params: CommonArgs & { prompt: string; cwd: string; outputFormat: OutputFormat }): {
  args: string[];
  warnings: string[];
} {
  const built = addCommonCommandArgs(params);
  built.args.push("-p", params.prompt);
  return built;
}

export function buildContinueArgs(
  params: CommonArgs & { prompt: string; cwd: string; outputFormat: OutputFormat; sessionId?: string; continueLatest?: boolean }
): { args: string[]; warnings: string[] } {
  if (params.sessionId && params.continueLatest) {
    throw new Error("grok_continue accepts either sessionId or continueLatest, not both.");
  }
  if (!params.sessionId && params.continueLatest !== true) {
    throw new Error("grok_continue requires sessionId or explicit continueLatest: true. It never silently continues the latest session.");
  }

  const built = addCommonCommandArgs(params);
  if (params.sessionId) {
    validateSessionId(params.sessionId);
    built.args.push(`--resume=${params.sessionId}`);
  } else {
    built.args.push("--continue");
  }
  built.args.push("-p", params.prompt);
  return built;
}

async function runOrStartJob(params: CommonArgs & {
  kind: "run" | "continue" | "rescue" | "review" | "adversarial_review";
  prompt: string;
  sessionId?: string;
  continueLatest?: boolean;
}) {
  const cwd = cwdOrDefault(params.cwd);
  validatePromptBoundary(params.prompt, params.allowCodexPrivatePaths);
  const outputFormat: OutputFormat = params.background ? "streaming-json" : "json";
  const built =
    params.kind === "continue"
      ? buildContinueArgs({ ...params, cwd, outputFormat })
      : buildRunArgs({ ...params, cwd, outputFormat });

  if (params.background) {
    const store = new JobStore(cwd);
    const job = await store.startGrokJob({
      kind: params.kind,
      cwd,
      args: built.args,
      grokBin: params.grokBin,
      grokSessionId: params.sessionId
    });
    return jsonText({
      ok: true,
      background: true,
      job,
      warnings: built.warnings
    });
  }

  const result = await runGrok(built.args, {
    cwd,
    grokBin: params.grokBin,
    timeoutMs: params.timeoutMs ?? 600_000
  });
  return jsonText({
    ok: result.exitCode === 0,
    background: false,
    bin: result.bin,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    warnings: built.warnings,
    errorClass: result.exitCode === 0 ? undefined : classifyGrokFailure(result)
  });
}

export async function grokCheck(args: CommonArgs & { includeModels?: boolean }) {
  const discovered = await discoverGrok({ grokBin: args.grokBin });
  const warnings: string[] = [];
  const data: Record<string, unknown> = {
    ok: discovered.ok,
    grokBin: discovered.bin,
    version: discovered.version,
    tried: discovered.tried,
    errors: discovered.errors
  };

  if (!discovered.ok) return jsonText({ ...data, warnings });
  if (args.includeModels === false) return jsonText({ ...data, warnings });

  const cwd = cwdOrDefault(args.cwd);
  const models = await runGrok(withGlobalCwd(cwd, ["models"]), {
    cwd,
    grokBin: discovered.bin,
    timeoutMs: args.timeoutMs ?? 30_000
  }).catch((error) => {
    warnings.push(`grok models failed: ${error instanceof Error ? error.message : String(error)}`);
    data.ok = false;
    return null;
  });
  if (models) {
    data.ok = models.exitCode === 0;
    data.models = parseModelsOutput(models.stdout || models.stderr);
    data.modelsExitCode = models.exitCode;
    data.modelsErrorClass = models.exitCode === 0 ? undefined : classifyGrokFailure(models);
  }

  return jsonText({ ...data, warnings });
}

export async function grokModels(args: CommonArgs) {
  const cwd = cwdOrDefault(args.cwd);
  const result = await runGrok(withGlobalCwd(cwd, ["models"]), {
    cwd,
    grokBin: args.grokBin,
    timeoutMs: args.timeoutMs ?? 30_000
  });
  return jsonText({
    ok: result.exitCode === 0,
    bin: result.bin,
    exitCode: result.exitCode,
    raw: result.stdout || result.stderr,
    parsed: parseModelsOutput(result.stdout || result.stderr),
    errorClass: result.exitCode === 0 ? undefined : classifyGrokFailure(result)
  });
}

export async function grokRun(args: CommonArgs & { prompt: string }) {
  return runOrStartJob({ ...args, kind: "run" });
}

export async function grokContinue(args: CommonArgs & { prompt: string; sessionId?: string; continueLatest?: boolean }) {
  return runOrStartJob({ ...args, kind: "continue" });
}

export async function grokRescue(args: CommonArgs & { problem: string }) {
  const prompt = [
    "You are Grok acting as an independent rescue reviewer for a Codex task.",
    "Stay read-only unless the user explicitly requested changes.",
    "Do not ask to read Codex private runtime directories.",
    "Return: Diagnosis, Minimal path forward, Commands to verify, Risks.",
    "",
    args.problem
  ].join("\n");
  return runOrStartJob({ ...args, kind: "rescue", prompt });
}

export async function grokReview(args: CommonArgs & { target?: string }) {
  const target = args.target ?? "current working tree";
  const prompt = [
    "You are Grok acting as a bounded second reviewer for Codex.",
    `Review ${target}.`,
    "This is not a broad security scan.",
    "Do not spawn subagents for this bounded review.",
    "Inspect only the named target and directly relevant files; if the scope is too broad, ask for a narrower target instead of expanding.",
    "Prioritize correctness bugs, regressions, risk-sensitive failure modes, and missing tests.",
    "Return Findings first, then Open questions, then Test gaps. Keep it concise. Stay read-only."
  ].join("\n");
  return runOrStartJob({ ...args, kind: "review", prompt });
}

export async function grokAdversarialReview(args: CommonArgs & { target?: string }) {
  const target = args.target ?? "current working tree";
  const prompt = [
    "You are Grok acting as a bounded failure-mode reviewer for Codex.",
    `Target: ${target}.`,
    "This is not a broad security scan.",
    "Do not spawn subagents for this bounded review.",
    "Do not perform repo-wide discovery unless the target is explicitly repo-wide.",
    "Inspect only the named target and directly relevant files; if more scope is needed, say what is missing instead of expanding.",
    "Find hidden breakage paths, bad assumptions, permission/path/platform issues, and failure modes.",
    "Return at most 5 findings, then Highest-risk assumption, Recommended verification, and Scope not inspected. Stay read-only."
  ].join("\n");
  return runOrStartJob({ ...args, kind: "adversarial_review", prompt });
}

export async function grokSessions(args: CommonArgs & { query?: string; limit?: number }) {
  const cwd = cwdOrDefault(args.cwd);
  const commandArgs = withGlobalCwd(cwd, ["sessions", args.query ? "search" : "list"]);
  if (args.limit !== undefined) commandArgs.push("--limit", String(args.limit));
  if (args.query) commandArgs.push("--", args.query);

  const result = await runGrok(commandArgs, {
    cwd,
    grokBin: args.grokBin,
    timeoutMs: args.timeoutMs ?? 30_000
  });
  return jsonText({
    ok: result.exitCode === 0,
    bin: result.bin,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    errorClass: result.exitCode === 0 ? undefined : classifyGrokFailure(result)
  });
}

export async function grokExport(args: CommonArgs & { sessionId: string; outputFile?: string }) {
  const cwd = cwdOrDefault(args.cwd);
  validateSessionId(args.sessionId);
  await validateOptionalOutputPath(args.outputFile, cwd);
  const commandArgs = withGlobalCwd(cwd, ["export", "--", args.sessionId]);
  if (args.outputFile) commandArgs.push(args.outputFile);
  const result = await runGrok(commandArgs, {
    cwd,
    grokBin: args.grokBin,
    timeoutMs: args.timeoutMs ?? 30_000
  });
  return jsonText({
    ok: result.exitCode === 0,
    bin: result.bin,
    exitCode: result.exitCode,
    markdown: args.outputFile ? undefined : result.stdout,
    outputFile: args.outputFile,
    stderr: result.stderr,
    errorClass: result.exitCode === 0 ? undefined : classifyGrokFailure(result)
  });
}

export async function grokStatus(args: { cwd?: string; jobId: string }) {
  const store = new JobStore(cwdOrDefault(args.cwd));
  return jsonText({ ok: true, job: await store.read(args.jobId) });
}

export async function grokResult(args: { cwd?: string; jobId: string; maxChars?: number }) {
  const store = new JobStore(cwdOrDefault(args.cwd));
  return jsonText({ ok: true, ...(await store.result(args.jobId, args.maxChars)) });
}

export async function grokCancel(args: { cwd?: string; jobId: string }) {
  const store = new JobStore(cwdOrDefault(args.cwd));
  return jsonText({ ok: true, job: await store.cancel(args.jobId) });
}
