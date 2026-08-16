import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BACKGROUND_DEFAULT_BY_KIND, grokResult } from "../plugins/grok-plugin-codex/src/tools.js";
import { envelope, tempDir } from "./helpers.js";

async function text(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

/** A terminal job on disk, so `grok_result` can be exercised without starting a process. */
async function finishedJob(): Promise<{ stateDir: string; jobId: string }> {
  const stateDir = await tempDir();
  const jobsDir = join(stateDir, "jobs");
  await mkdir(jobsDir, { recursive: true, mode: 0o700 });
  const jobId = "job_contractdrift0000000000";
  await writeFile(
    join(jobsDir, `${jobId}.json`),
    JSON.stringify({
      id: jobId,
      kind: "run",
      status: "succeeded",
      cwd: "/repo",
      command: "/usr/bin/grok",
      args: [],
      exitCode: 0,
      createdAt: "2026-08-16T00:00:00.000Z",
      finishedAt: "2026-08-16T00:00:01.000Z",
      timeoutMs: 30_000
    }),
    { mode: 0o600 }
  );
  await writeFile(
    join(jobsDir, `${jobId}.stdout.log`),
    [
      JSON.stringify({ type: "text", data: "the answer" }),
      JSON.stringify({ type: "end", stopReason: "end_turn" })
    ].join("\n"),
    { mode: 0o600 }
  );
  await writeFile(join(jobsDir, `${jobId}.stderr.log`), "a stderr line\n", { mode: 0o600 });
  return { stateDir, jobId };
}

describe("published contract drift", () => {
  test("manifest cachebusters preserve the package and MCP base version", async () => {
    const packageJson = JSON.parse(await text("package.json"));
    const manifest = JSON.parse(await text("plugins/grok-plugin-codex/.codex-plugin/plugin.json"));
    const server = await text("plugins/grok-plugin-codex/src/server.ts");
    const dist = await text("plugins/grok-plugin-codex/dist/server.js");

    expect(packageJson.version).toBe("0.3.0");
    expect(manifest.version).toMatch(/^0\.3\.0(?:\+codex\.[0-9A-Za-z.-]+)?$/);
    expect(manifest.version.split("+")[0]).toBe(packageJson.version);
    // GPC-10.2: the version is injected at build time, so the source must carry no literal and the
    // built bundle must carry exactly the package version.
    expect(server).toContain("version: PLUGIN_VERSION");
    expect(server).not.toMatch(/version:\s*"\d+\.\d+\.\d+/);
    expect(dist).toContain(`"${packageJson.version}"`);
  });

  test("the package declares the operating systems whose process-tree lifecycle is supported", async () => {
    const packageJson = JSON.parse(await text("package.json"));

    expect(packageJson.os).toEqual(["darwin", "linux"]);
  });

  test("bundled user guidance does not publish removed 0.1 arguments or storage paths", async () => {
    const bundledReadme = await text("plugins/grok-plugin-codex/README.md");
    const skill = await text("plugins/grok-plugin-codex/skills/grok/SKILL.md");
    const published = `${bundledReadme}\n${skill}`;

    expect(published).not.toContain("grokBin");
    expect(published).not.toContain("outputFile");
    expect(published).not.toContain("<cwd>/.grok-plugin-codex/jobs");
    expect(published).not.toMatch(/grok_(?:status|result|cancel)\([^)]*cwd/);
    expect(published).not.toContain("Foreground requests invoke the user's Grok CLI directly");
    // 0.2.1 told callers to match stopReason === "EndTurn"; Grok 1.0.x emits end_turn.
    expect(published).not.toMatch(/stopReason: "EndTurn"/);
    expect(published).toContain("normalis");
    expect(published).toContain("/dev/fd/3");
    expect(published).toContain("resultComplete");
    expect(published).toContain("cancelled_output");
    expect(published).toContain("max_turns_reached");
    expect(published).toContain("GROK_BIN");
  });

  /**
   * FINAL Review M6. Three defaults changed in 0.3.0 and nothing locked them: a silent revert would
   * break callers exactly the way the 0.2.1 `EndTurn` regression did — quietly, and only in
   * production. Each is asserted against the runtime, not only against the prose.
   */
  test("the background default per kind matches what the published guidance promises", async () => {
    const published = `${await text("README.md")}\n${await text("plugins/grok-plugin-codex/README.md")}\n${await text(
      "plugins/grok-plugin-codex/skills/grok/SKILL.md"
    )}`;

    expect(BACKGROUND_DEFAULT_BY_KIND).toEqual({
      run: true,
      review: true,
      adversarial_review: true,
      rescue: true,
      continue: false
    });
    expect(published).toContain("default to `background: true`");
    expect(published).toContain("to `false` for `grok_continue`");
  });

  test("grok_result omits the raw log tails unless they are asked for", async () => {
    const { stateDir, jobId } = await finishedJob();
    const previous = process.env.GROK_PLUGIN_STATE_DIR;
    process.env.GROK_PLUGIN_STATE_DIR = stateDir;
    try {
      const quiet = envelope(await grokResult({ jobId }));
      const verbose = envelope(await grokResult({ jobId, includeRawTail: true }));

      expect(quiet.data.finalText).toBe("the answer");
      expect(quiet.data.stdoutTail).toBeUndefined();
      expect(quiet.data.stderrTail).toBeUndefined();
      expect(verbose.data.stdoutTail).toContain("end_turn");
      expect(verbose.data.stderrTail).toContain("a stderr line");
      // Finality is `resultComplete` alone; `outputTruncated` is reported but never decides it.
      expect(quiet.data.resultComplete).toBe(true);
      expect(quiet.data).toHaveProperty("outputTruncated");
    } finally {
      if (previous === undefined) delete process.env.GROK_PLUGIN_STATE_DIR;
      else process.env.GROK_PLUGIN_STATE_DIR = previous;
    }
  });

  test("MCP configuration declares the trusted binary and private-state overrides", async () => {
    const mcp = JSON.parse(await text("plugins/grok-plugin-codex/.mcp.json"));
    const envVars = mcp.mcpServers["grok-plugin-codex"].env_vars as string[];

    expect(envVars).toContain("GROK_BIN");
    expect(envVars).toContain("GROK_PLUGIN_STATE_DIR");
    expect(envVars).toContain("XDG_STATE_HOME");
  });
});
