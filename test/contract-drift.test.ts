import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

async function text(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

describe("published contract drift", () => {
  test("manifest cachebusters preserve the package and MCP base version", async () => {
    const packageJson = JSON.parse(await text("package.json"));
    const manifest = JSON.parse(await text("plugins/grok-plugin-codex/.codex-plugin/plugin.json"));
    const server = await text("plugins/grok-plugin-codex/src/server.ts");

    expect(packageJson.version).toBe("0.2.1");
    expect(manifest.version).toMatch(/^0\.2\.1(?:\+codex\.[0-9A-Za-z.-]+)?$/);
    expect(manifest.version.split("+")[0]).toBe(packageJson.version);
    expect(server).toContain(`version: "${packageJson.version}"`);
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

  test("MCP configuration declares the trusted binary and private-state overrides", async () => {
    const mcp = JSON.parse(await text("plugins/grok-plugin-codex/.mcp.json"));
    const envVars = mcp.mcpServers["grok-plugin-codex"].env_vars as string[];

    expect(envVars).toContain("GROK_BIN");
    expect(envVars).toContain("GROK_PLUGIN_STATE_DIR");
    expect(envVars).toContain("XDG_STATE_HOME");
  });
});
