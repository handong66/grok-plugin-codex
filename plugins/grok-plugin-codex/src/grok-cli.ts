import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { GrokModelsSummary, ProcessResult } from "./types.js";

export type DiscoverGrokOptions = {
  grokBin?: string;
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

export type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const GROK_ENV_ALLOWLIST = ["GROK_BIN", "HOME", "PATH"] as const;

export function buildGrokProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const key of GROK_ENV_ALLOWLIST) {
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

function isBareCommand(candidate: string): boolean {
  return !candidate.includes("/");
}

export function getGrokCandidates(options: DiscoverGrokOptions = {}): string[] {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? homedir();
  const pathCandidates = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "grok"));

  return unique([
    options.grokBin ? expandHome(options.grokBin, home) : "",
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
  if (isBareCommand(candidate)) return true;
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
      env: buildGrokProcessEnv({ ...process.env, ...(options.env ?? {}) }),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000).unref();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      settled = true;
      clearTimeout(timeout);
      resolve({
        command,
        args,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
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
      if (result.exitCode === 0) {
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
  const loggedIn = !/(not logged in|login required|please log in|authentication required|unauthorized)/i.test(raw);
  const authMessage = lines.find((line) => /logged in|not logged in|login|required|auth/i.test(line.trim()));
  const defaultModel = lines
    .map((line) => line.match(/^\s*Default model:\s*(.+?)\s*$/i)?.[1]?.trim())
    .find((value): value is string => Boolean(value));
  const availableModels = lines
    .map((line) => {
      const match = line.match(/^\s*[*-]\s+(\S+)(?:\s+\((default)\))?\s*$/i);
      if (!match?.[1]) return undefined;
      const id = match[1];
      return {
        id,
        default: Boolean(match[2]) || id === defaultModel
      };
    })
    .filter((model): model is { id: string; default: boolean } => Boolean(model));

  if (defaultModel && !availableModels.some((model) => model.id === defaultModel) && !lower.includes("available models")) {
    availableModels.push({ id: defaultModel, default: true });
  }

  return {
    loggedIn,
    authMessage,
    defaultModel,
    availableModels,
    raw
  };
}

export function classifyGrokFailure(result: ProcessResult): string {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (text.includes("not logged in") || text.includes("login") || text.includes("unauthorized") || text.includes("forbidden")) {
    return "auth_required";
  }
  if (text.includes("does not support reasoning effort")) {
    return "unsupported_reasoning_effort";
  }
  if (text.includes("econnrefused") || text.includes("enotfound") || text.includes("timeout")) {
    return "network_error";
  }
  if (result.signal) return "terminated";
  if (result.exitCode !== 0) return "grok_failed";
  return "unknown";
}
