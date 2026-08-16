import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyGrokFailure,
  discoverGrok,
  getGrokCandidates,
  parseModelsOutput,
  runProcess
} from "../plugins/grok-plugin-codex/src/grok-cli.js";
import { fakeGrokScript, makeExecutable, tempDir } from "./helpers.js";

describe("Grok CLI discovery", () => {
  it("prefers trusted GROK_BIN configuration before PATH candidates", async () => {
    const dir = await tempDir();
    const envBin = await makeExecutable(join(dir, "env-grok"), fakeGrokScript({ version: "grok env" }));

    const discovered = await discoverGrok({
      env: {
        ...process.env,
        GROK_BIN: envBin,
        PATH: ""
      }
    });

    expect(discovered.ok).toBe(true);
    expect(discovered.bin).toBe(envBin);
    expect(discovered.version).toBe("grok env");
    expect(discovered.tried[0]).toBe(envBin);
  });

  it("orders candidates according to the documented discovery chain", () => {
    const candidates = getGrokCandidates({
      env: {
        GROK_BIN: "~/env/grok",
        HOME: "/Users/example",
        PATH: "/x/bin:/y/bin"
      }
    });

    expect(candidates.slice(0, 5)).toEqual([
      "/Users/example/env/grok",
      "/Users/example/.grok/bin/grok",
      "/Users/example/.local/bin/grok",
      "/opt/homebrew/bin/grok",
      "/usr/local/bin/grok"
    ]);
    expect(candidates).toContain("/x/bin/grok");
    expect(candidates).toContain("/y/bin/grok");
  });

  it("parses default and available models from grok models output", () => {
    const parsed = parseModelsOutput(
      [
        "You are logged in with grok.com.",
        "",
        "Default model: grok-composer-2.5-fast",
        "",
        "Available models:",
        "  * grok-composer-2.5-fast (default)",
        "  - grok-build"
      ].join("\n")
    );

    expect(parsed.loggedIn).toBe(true);
    expect(parsed.defaultModel).toBe("grok-composer-2.5-fast");
    expect(parsed.availableModels).toEqual([
      { id: "grok-composer-2.5-fast", default: true },
      { id: "grok-build", default: false }
    ]);
  });

  it("requires explicit positive authentication evidence", () => {
    const unauthenticated = parseModelsOutput(
      [
        "You are not authenticated.",
        "",
        "Default model: grok-4.5",
        "",
        "Available models:",
        "  * grok-4.5 (default)"
      ].join("\n")
    );
    const unknown = parseModelsOutput("Default model: grok-4.5");

    expect(unauthenticated.loggedIn).toBe(false);
    expect(unknown.loggedIn).toBe(false);
  });

  it("classifies max-turn exhaustion separately from generic CLI failure", () => {
    const code = classifyGrokFailure({
      command: "grok",
      args: [],
      exitCode: 1,
      signal: null,
      stdout: '{"type":"max_turns_reached"}',
      stderr: "Error: max turns reached",
      durationMs: 1,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false
    });

    expect(code).toBe("max_turns_reached");
  });

  it("does not classify an unrelated login attempt as missing Grok authentication", () => {
    const code = classifyGrokFailure({
      command: "grok",
      args: [],
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "Failed to login to remote server: ECONNREFUSED",
      durationMs: 1,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false
    });

    expect(code).toBe("network_error");
  });

  it("kills the foreground process tree on timeout", async () => {
    const dir = await tempDir();
    const marker = join(dir, "grandchild-finished.txt");
    const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'finished'), 500)`;
    const command = await makeExecutable(
      join(dir, "hang.sh"),
      `#!/bin/sh
${JSON.stringify(process.execPath)} -e ${JSON.stringify(childCode)} &
while true; do sleep 1; done
`
    );

    const result = await runProcess(command, [], { cwd: dir, timeoutMs: 50 });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));

    expect(result.timedOut).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("classifies HTTP 402 balance exhaustion as quota_exhausted", () => {
    const code = classifyGrokFailure({
      command: "grok",
      args: [],
      exitCode: 1,
      signal: null,
      stdout: '{"type":"error","data":"Payment Required"}',
      stderr: "API error (status 402 Payment Required): Grok Build usage balance exhausted",
      durationMs: 1,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false
    });

    expect(code).toBe("quota_exhausted");
  });
});
