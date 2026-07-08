import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("MCP server smoke", () => {
  it("lists every expected tool through the bundled server", () => {
    expect(existsSync("plugins/grok-plugin-codex/dist/server.js")).toBe(true);
    const result = spawnSync(process.execPath, ["scripts/smoke-mcp.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      timeout: 40_000
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("MCP smoke passed");
  });
});
