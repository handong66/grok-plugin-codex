import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverGrok, getGrokCandidates, parseModelsOutput } from "../plugins/grok-plugin-codex/src/grok-cli.js";
import { fakeGrokScript, makeExecutable, tempDir } from "./helpers.js";

describe("Grok CLI discovery", () => {
  it("prefers explicit grokBin before GROK_BIN and PATH candidates", async () => {
    const dir = await tempDir();
    const explicit = await makeExecutable(join(dir, "explicit-grok"), fakeGrokScript({ version: "grok explicit" }));
    const envBin = await makeExecutable(join(dir, "env-grok"), fakeGrokScript({ version: "grok env" }));

    const discovered = await discoverGrok({
      grokBin: explicit,
      env: {
        ...process.env,
        GROK_BIN: envBin,
        PATH: ""
      }
    });

    expect(discovered.ok).toBe(true);
    expect(discovered.bin).toBe(explicit);
    expect(discovered.version).toBe("grok explicit");
    expect(discovered.tried[0]).toBe(explicit);
  });

  it("orders candidates according to the documented discovery chain", () => {
    const candidates = getGrokCandidates({
      grokBin: "~/custom/grok",
      env: {
        GROK_BIN: "~/env/grok",
        HOME: "/Users/example",
        PATH: "/x/bin:/y/bin"
      }
    });

    expect(candidates.slice(0, 6)).toEqual([
      "/Users/example/custom/grok",
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
});
