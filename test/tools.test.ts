import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildContinueArgs,
  buildRunArgs,
  grokCheck,
  grokContinue,
  grokExport,
  grokModels,
  grokRescue,
  grokRun,
  grokSessions
} from "../plugins/grok-plugin-codex/src/tools.js";
import { fakeGrokScript, makeExecutable, tempDir } from "./helpers.js";

function parseToolText(result: Awaited<ReturnType<typeof grokRun>>): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("Grok tool handlers", () => {
  it("grok_check succeeds with a local fake Grok and parses available models", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript());

    const result = await grokCheck({ grokBin, cwd: dir });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.version).toBe("grok fake 1.0.0");
    expect(parsed.models.defaultModel).toBe("grok-composer-2.5-fast");
    expect(parsed.models.availableModels.map((model: { id: string }) => model.id)).toEqual([
      "grok-composer-2.5-fast",
      "grok-build"
    ]);
  });

  it("grok_check reports not ready when model discovery fails", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "grok fake 1.0.0"
  exit 0
fi
if { [ "$1" = "models" ]; } || { [ "$1" = "--cwd" ] && [ "$3" = "models" ]; }; then
  echo "not logged in" >&2
  exit 7
fi
exit 0
`
    );

    const result = await grokCheck({ grokBin, cwd: dir });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(false);
    expect(parsed.version).toBe("grok fake 1.0.0");
    expect(parsed.modelsExitCode).toBe(7);
    expect(parsed.modelsErrorClass).toBe("auth_required");
    expect(parsed.models.loggedIn).toBe(false);
  });

  it("grok_check skips model discovery when includeModels is false", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "grok fake 1.0.0"
  exit 0
fi
if [ "$1" = "models" ]; then
  echo "models should not be called" >&2
  exit 99
fi
exit 0
`
    );

    const result = await grokCheck({ grokBin, cwd: dir, includeModels: false });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.version).toBe("grok fake 1.0.0");
    expect(parsed.models).toBeUndefined();
    expect(parsed.modelsExitCode).toBeUndefined();
  });

  it("grok_run builds prompt arguments and does not treat prompt text as a path", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript());

    const result = await grokRun({
      grokBin,
      cwd: dir,
      model: "grok-build",
      prompt: "review this diff",
      background: false,
      disableWebSearch: true,
      noSubagents: true,
      maxTurns: 1
    });
    const parsed = parseToolText(result);
    const stdout = String(parsed.stdout);

    expect(stdout).toContain("--cwd\n");
    expect(stdout).toContain(`${dir}\n`);
    expect(stdout).toContain("-m\ngrok-build\n");
    expect(stdout).toContain("--output-format\njson\n");
    expect(stdout).toContain("--disable-web-search\n");
    expect(stdout).toContain("--no-subagents\n");
    expect(stdout).toContain("--max-turns\n1\n");
    expect(stdout).toContain("-p\nreview this diff\n");
    expect(stdout).not.toContain("--always-approve");
  });

  it("does not forward unrelated environment variables to Grok CLI child processes", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "grok fake 1.0.0"
  exit 0
fi
if [ "$GROK_PLUGIN_CODEX_SECRET_TEST" = "should-not-leak" ]; then
  echo "LEAKED"
else
  echo "CLEAN"
fi
exit 0
`
    );
    const previous = process.env.GROK_PLUGIN_CODEX_SECRET_TEST;
    process.env.GROK_PLUGIN_CODEX_SECRET_TEST = "should-not-leak";

    try {
      const result = await grokRun({ grokBin, cwd: dir, prompt: "env check", background: false });
      const parsed = parseToolText(result);

      expect(String(parsed.stdout)).toContain("CLEAN");
      expect(String(parsed.stdout)).not.toContain("LEAKED");
    } finally {
      if (previous === undefined) {
        delete process.env.GROK_PLUGIN_CODEX_SECRET_TEST;
      } else {
        process.env.GROK_PLUGIN_CODEX_SECRET_TEST = previous;
      }
    }
  });

  it("passes --always-approve only when the tool arg is true", () => {
    const withoutApprove = buildRunArgs({
      cwd: "/repo",
      prompt: "x",
      outputFormat: "json",
      alwaysApprove: false
    });
    const withApprove = buildRunArgs({
      cwd: "/repo",
      prompt: "x",
      outputFormat: "json",
      alwaysApprove: true
    });

    expect(withoutApprove.args).not.toContain("--always-approve");
    expect(withApprove.args).toContain("--always-approve");
  });

  it("warns instead of passing reasoningEffort for grok-composer-2.5-fast", () => {
    const built = buildRunArgs({
      cwd: "/repo",
      prompt: "x",
      outputFormat: "json",
      model: "grok-composer-2.5-fast",
      reasoningEffort: "high"
    });

    expect(built.args).not.toContain("--reasoning-effort");
    expect(built.warnings.join("\n")).toContain("does not support --reasoning-effort");
  });

  it("warns instead of passing reasoningEffort when model is omitted", () => {
    const built = buildRunArgs({
      cwd: "/repo",
      prompt: "x",
      outputFormat: "json",
      reasoningEffort: "high"
    });

    expect(built.args).not.toContain("--reasoning-effort");
    expect(built.warnings.join("\n")).toContain("no model was specified");
  });

  it("rejects prompts that ask Grok to read Codex private runtime paths by default", async () => {
    await expect(grokRun({ prompt: "Read ~/.codex/config.toml and summarize it." })).rejects.toThrow(
      "Prompt asks Grok to read Codex private runtime paths"
    );
  });

  it("allows Codex private runtime paths only when explicitly authorized", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript());

    const result = await grokRun({
      grokBin,
      cwd: dir,
      prompt: "Read ~/.codex/config.toml and summarize it.",
      allowCodexPrivatePaths: true
    });
    const parsed = parseToolText(result);

    expect(parsed.ok).toBe(true);
    expect(String(parsed.stdout)).toContain("~/.codex/config.toml");
  });

  it("grok_rescue does not reject its own private-path safety instruction", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript());

    const result = await grokRescue({
      grokBin,
      cwd: dir,
      problem: "diagnose this failure",
      background: false
    });
    const parsed = parseToolText(result);

    expect(parsed.ok).toBe(true);
    expect(String(parsed.stdout)).toContain("-p\n");
    expect(String(parsed.stdout)).toContain("diagnose this failure\n");
  });

  it("grok_continue requires sessionId or explicit continueLatest true", async () => {
    await expect(grokContinue({ prompt: "continue" })).rejects.toThrow("requires sessionId or explicit continueLatest");
  });

  it("rejects session IDs that look like CLI flags", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript());

    await expect(grokContinue({ grokBin, cwd: dir, prompt: "continue", sessionId: "--help" })).rejects.toThrow("sessionId");
    await expect(grokExport({ grokBin, cwd: dir, sessionId: "--help" })).rejects.toThrow("sessionId");
  });

  it("grok_continue builds resume and continue-latest arguments explicitly", () => {
    const resume = buildContinueArgs({
      cwd: "/repo",
      outputFormat: "json",
      prompt: "next",
      sessionId: "session-1"
    });
    const latest = buildContinueArgs({
      cwd: "/repo",
      outputFormat: "json",
      prompt: "next",
      continueLatest: true
    });

    expect(resume.args).toContain("--resume=session-1");
    expect(latest.args).toContain("--continue");
  });

  it("rejects export output paths outside the working directory", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript());

    await expect(
      grokExport({
        grokBin,
        cwd: dir,
        sessionId: "019f4258-2c1b-7960-ab1e-ca295e23533d",
        outputFile: "../escape.md"
      })
    ).rejects.toThrow("outputFile must stay inside cwd");
  });

  it("allows export output paths inside cwd when the basename starts with dots", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript());

    const result = await grokExport({
      grokBin,
      cwd: dir,
      sessionId: "019f4258-2c1b-7960-ab1e-ca295e23533d",
      outputFile: "..inside.md"
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.outputFile).toBe("..inside.md");
  });

  it("passes cwd as a global Grok argument for discovery-style subcommands", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "grok fake 1.0.0"
  exit 0
fi
for arg in "$@"; do
  printf '%s\\n' "$arg"
done
`
    );

    const models = JSON.parse((await grokModels({ grokBin, cwd: dir })).content[0].text);
    const sessions = JSON.parse((await grokSessions({ grokBin, cwd: dir, limit: 2 })).content[0].text);
    const exported = JSON.parse(
      (
        await grokExport({
          grokBin,
          cwd: dir,
          sessionId: "019f4258-2c1b-7960-ab1e-ca295e23533d"
        })
      ).content[0].text
    );

    expect(models.raw).toBe(`--cwd\n${dir}\nmodels\n`);
    expect(sessions.stdout).toBe(`--cwd\n${dir}\nsessions\nlist\n--limit\n2\n`);
    expect(exported.markdown).toBe(`--cwd\n${dir}\nexport\n--\n019f4258-2c1b-7960-ab1e-ca295e23533d\n`);
  });

  it("separates grok_sessions query text from CLI flags", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript());

    const result = await grokSessions({ grokBin, cwd: dir, query: "--help" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.stdout).toContain("sessions\nsearch\n--\n--help\n");
  });
});
