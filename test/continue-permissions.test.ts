import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grokContinue, grokReview, grokRun } from "../plugins/grok-plugin-codex/src/tools.js";
import { makeExecutable, tempDir } from "./helpers.js";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

function envelope(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

async function withEnv<T>(values: Record<string, string | undefined>, operation: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Records its own argv so the test can prove which permission flags reached the CLI. */
async function grokRecordingArgv(dir: string, name: string): Promise<{ bin: string; argvPath: string }> {
  const argvPath = join(dir, `${name}.argv.log`);
  const bin = await makeExecutable(
    join(dir, name),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then
  echo "--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search"
  echo "  -s, --session-id <SESSION_ID>"
  exit 0
fi
printf '%s\\n' "$@" > ${JSON.stringify(argvPath)}
printf '%s\\n' '{"type":"tool_call","toolCallId":"t1","toolName":"read_file","rawInput":{"path":"/repo/src/index.ts"}}' '{"type":"text","data":"done"}' '{"type":"end","stopReason":"end_turn"}'
`
  );
  return { bin, argvPath };
}

/** Rewrites the persisted job records the way 0.2.x wrote them: without the `readOnly` field. */
async function stripReadOnlyField(stateDir: string): Promise<void> {
  const jobsDir = join(stateDir, "jobs");
  for (const entry of await readdir(jobsDir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(jobsDir, entry);
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete record.readOnly;
    await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
}

async function sessionIdOf(stateDir: string): Promise<string> {
  const entries = await readdir(join(stateDir, "jobs"));
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const record = JSON.parse(await readFile(join(stateDir, "jobs", entry), "utf8")) as Record<string, any>;
    if (record.grokSessionId) return record.grokSessionId as string;
  }
  throw new Error("No job recorded a Grok session id.");
}

describe("continue inherits the read-only constraint (GPC-M2)", () => {
  it("resumes a review session in enforced plan mode", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const review = await grokRecordingArgv(dir, "grok-review");
    const resume = await grokRecordingArgv(dir, "grok-resume");

    const reviewed = envelope(
      await withEnv({ GROK_BIN: review.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokReview({ cwd: dir, _workspaceRoots: [dir], target: "src/index.ts", background: false, timeoutMs: 20_000 })
      )
    );
    const sessionId = await sessionIdOf(stateDir);
    const continued = envelope(
      await withEnv({ GROK_BIN: resume.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({ cwd: dir, _workspaceRoots: [dir], prompt: "finish the review", sessionId })
      )
    );
    const resumeArgv = await readFile(resume.argvPath, "utf8");

    expect(reviewed.ok).toBe(true);
    expect(continued.ok).toBe(true);
    // 40/40 recorded continues ran without plan mode, including one that resumed an adversarial
    // review session; README, SKILL.md, and the tool descriptions all promise enforced read-only.
    expect(resumeArgv).toContain("--permission-mode\nplan\n");
    expect(resumeArgv).toContain("--no-subagents\n");
    expect(resumeArgv).toContain(`--resume=${sessionId}\n`);
  }, 40_000);

  it("refuses to resume a read-only session with alwaysApprove, before starting any Grok process", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const review = await grokRecordingArgv(dir, "grok-review");
    const resume = await grokRecordingArgv(dir, "grok-resume");

    await withEnv({ GROK_BIN: review.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokReview({ cwd: dir, _workspaceRoots: [dir], target: "src/index.ts", background: false, timeoutMs: 20_000 })
    );
    const sessionId = await sessionIdOf(stateDir);
    const escalated = envelope(
      await withEnv({ GROK_BIN: resume.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({
          cwd: dir,
          _workspaceRoots: [dir],
          prompt: "now fix it",
          sessionId,
          alwaysApprove: true
        })
      )
    );

    expect(escalated.ok).toBe(false);
    expect(escalated.error.code).toBe("readonly_session_escalation");
    expect(escalated.error.retryable).toBe(false);
    expect(escalated.error.details.originKind).toBe("review");
    await expect(access(resume.argvPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 40_000);

  it("does not restrict a session that was created mutable", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const run = await grokRecordingArgv(dir, "grok-run");
    const resume = await grokRecordingArgv(dir, "grok-resume");

    await withEnv({ GROK_BIN: run.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "mutable work", background: false, timeoutMs: 20_000 })
    );
    const sessionId = await sessionIdOf(stateDir);
    const continued = envelope(
      await withEnv({ GROK_BIN: resume.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({ cwd: dir, _workspaceRoots: [dir], prompt: "keep going", sessionId, alwaysApprove: true })
      )
    );
    const resumeArgv = await readFile(resume.argvPath, "utf8");

    expect(continued.ok).toBe(true);
    expect(resumeArgv).not.toContain("--permission-mode\nplan\n");
    expect(resumeArgv).toContain("--always-approve\n");
  }, 40_000);

  it("treats a record written before readOnly existed as read-only when its kind was read-only", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const review = await grokRecordingArgv(dir, "grok-review");
    const resume = await grokRecordingArgv(dir, "grok-resume");

    await withEnv({ GROK_BIN: review.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokReview({ cwd: dir, _workspaceRoots: [dir], target: "src/index.ts", background: false, timeoutMs: 20_000 })
    );
    const sessionId = await sessionIdOf(stateDir);
    // The seven-day retention window still holds 0.2.x records, and those are exactly the ones that
    // carry a session id today; reading their missing `readOnly` as `false` resolved a real
    // adversarial-review session to a mutable origin, with neither inheritance nor a warning.
    await stripReadOnlyField(stateDir);

    const escalated = envelope(
      await withEnv({ GROK_BIN: resume.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({ cwd: dir, _workspaceRoots: [dir], prompt: "now fix it", sessionId, alwaysApprove: true })
      )
    );
    expect(escalated.ok).toBe(false);
    expect(escalated.error.code).toBe("readonly_session_escalation");
    await expect(access(resume.argvPath)).rejects.toMatchObject({ code: "ENOENT" });

    const continued = envelope(
      await withEnv({ GROK_BIN: resume.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({ cwd: dir, _workspaceRoots: [dir], prompt: "finish the review", sessionId })
      )
    );
    const resumeArgv = await readFile(resume.argvPath, "utf8");

    expect(continued.ok).toBe(true);
    expect(resumeArgv).toContain("--permission-mode\nplan\n");
    expect(resumeArgv).toContain("--no-subagents\n");
  }, 40_000);

  it("does not read a pre-0.3.0 mutable run as read-only", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const run = await grokRecordingArgv(dir, "grok-run");
    const resume = await grokRecordingArgv(dir, "grok-resume");

    await withEnv({ GROK_BIN: run.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "mutable work", background: false, timeoutMs: 20_000 })
    );
    const sessionId = await sessionIdOf(stateDir);
    await stripReadOnlyField(stateDir);

    const continued = envelope(
      await withEnv({ GROK_BIN: resume.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({ cwd: dir, _workspaceRoots: [dir], prompt: "keep going", sessionId, alwaysApprove: true })
      )
    );
    const resumeArgv = await readFile(resume.argvPath, "utf8");

    expect(continued.ok).toBe(true);
    expect(resumeArgv).toContain("--always-approve\n");
    expect(resumeArgv).not.toContain("--permission-mode\nplan\n");
  }, 40_000);

  it("refuses alwaysApprove on continueLatest when the newest session here was read-only", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const review = await grokRecordingArgv(dir, "grok-review");
    const resume = await grokRecordingArgv(dir, "grok-resume");

    await withEnv({ GROK_BIN: review.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokReview({ cwd: dir, _workspaceRoots: [dir], target: "src/index.ts", background: false, timeoutMs: 20_000 })
    );
    const sessionId = await sessionIdOf(stateDir);

    const escalated = envelope(
      await withEnv({ GROK_BIN: resume.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({
          cwd: dir,
          _workspaceRoots: [dir],
          prompt: "now fix it",
          continueLatest: true,
          alwaysApprove: true
        })
      )
    );

    expect(escalated.ok).toBe(false);
    expect(escalated.error.code).toBe("readonly_session_escalation");
    expect(escalated.error.details.inferredFromLatestJob).toBe(true);
    expect(escalated.error.details.sessionId).toBe(sessionId);
    await expect(access(resume.argvPath)).rejects.toMatchObject({ code: "ENOENT" });

    const continued = envelope(
      await withEnv({ GROK_BIN: resume.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({ cwd: dir, _workspaceRoots: [dir], prompt: "finish the review", continueLatest: true })
      )
    );
    const resumeArgv = await readFile(resume.argvPath, "utf8");

    expect(continued.ok).toBe(true);
    expect(resumeArgv).toContain("--permission-mode\nplan\n");
    expect(continued.warnings.join(" ")).toContain("explicit sessionId");
  }, 40_000);

  it("still says continueLatest is unverified when the newest session in this workspace was mutable", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const run = await grokRecordingArgv(dir, "grok-run");
    const resume = await grokRecordingArgv(dir, "grok-resume");

    await withEnv({ GROK_BIN: run.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "mutable work", background: false, timeoutMs: 20_000 })
    );

    const continued = envelope(
      await withEnv({ GROK_BIN: resume.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({
          cwd: dir,
          _workspaceRoots: [dir],
          prompt: "keep going",
          continueLatest: true,
          alwaysApprove: true
        })
      )
    );
    const resumeArgv = await readFile(resume.argvPath, "utf8");

    expect(continued.ok).toBe(true);
    expect(resumeArgv).toContain("--always-approve\n");
    expect(resumeArgv).not.toContain("--permission-mode\nplan\n");
    // The inference only tightens permissions. `--continue` resumes whatever session the CLI saw
    // last — possibly one this plugin never created — so a mutable newest session must not silently
    // certify the target as known; the GPC-M2 degradation stays on every inferred target.
    expect(continued.warnings.join(" ")).toContain("could not be verified");
    expect(continued.warnings.join(" ")).toContain("explicit sessionId");
  }, 40_000);

  it("warns instead of guessing when the session is unknown to this plugin", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const resume = await grokRecordingArgv(dir, "grok-resume");

    const continued = envelope(
      await withEnv({ GROK_BIN: resume.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({
          cwd: dir,
          _workspaceRoots: [dir],
          prompt: "keep going",
          sessionId: "00000000-0000-4000-8000-00000000dead"
        })
      )
    );
    const latest = envelope(
      await withEnv({ GROK_BIN: resume.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({ cwd: dir, _workspaceRoots: [dir], prompt: "keep going", continueLatest: true })
      )
    );

    expect(continued.ok).toBe(true);
    expect(continued.warnings.join(" ")).toContain("read-only mode");
    expect(latest.warnings.join(" ")).toContain("read-only mode");
  }, 40_000);
});
