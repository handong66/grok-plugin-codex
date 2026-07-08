#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const requiredTools = [
  "grok_check",
  "grok_models",
  "grok_run",
  "grok_continue",
  "grok_rescue",
  "grok_review",
  "grok_adversarial_review",
  "grok_sessions",
  "grok_export",
  "grok_status",
  "grok_result",
  "grok_cancel"
];

const expectedProperties = {
  grok_check: ["cwd", "grokBin", "includeModels", "timeoutMs"],
  grok_models: ["cwd", "grokBin", "timeoutMs"]
};

const expectedPatterns = {
  grok_status: { jobId: "^job_\\d+_[0-9a-f]{8}$" },
  grok_result: { jobId: "^job_\\d+_[0-9a-f]{8}$" },
  grok_cancel: { jobId: "^job_\\d+_[0-9a-f]{8}$" }
};

function localGrokCandidate() {
  const candidates = [
    process.env.GROK_BIN,
    join(homedir(), ".grok", "bin", "grok"),
    join(homedir(), ".local", "bin", "grok"),
    "/opt/homebrew/bin/grok",
    "/usr/local/bin/grok"
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["plugins/grok-plugin-codex/dist/server.js"],
  cwd: process.cwd(),
  env: process.env,
  stderr: "pipe"
});

let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

const client = new Client({ name: "grok-plugin-codex-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools({}, { timeout: 5_000 });
  const names = tools.map((tool) => tool.name).sort();
  const missing = requiredTools.filter((tool) => !names.includes(tool));
  if (missing.length) {
    throw new Error(`Missing MCP tools: ${missing.join(", ")}`);
  }

  for (const [toolName, expected] of Object.entries(expectedProperties)) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    const properties = Object.keys(tool?.inputSchema?.properties ?? {}).sort();
    const sortedExpected = [...expected].sort();
    if (JSON.stringify(properties) !== JSON.stringify(sortedExpected)) {
      throw new Error(`Unexpected ${toolName} schema properties: ${properties.join(", ")}`);
    }
  }

  for (const [toolName, expected] of Object.entries(expectedPatterns)) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    for (const [property, pattern] of Object.entries(expected)) {
      const actual = tool?.inputSchema?.properties?.[property]?.pattern;
      if (actual !== pattern) {
        throw new Error(`Unexpected ${toolName}.${property} pattern: ${actual}`);
      }
    }
  }

  const grokBin = localGrokCandidate();
  if (grokBin) {
    const result = await client.callTool(
      {
        name: "grok_check",
        arguments: {
          grokBin
        }
      },
      undefined,
      { timeout: 30_000 }
    );
    if (result.isError) throw new Error(`grok_check returned MCP error: ${JSON.stringify(result)}`);
    const text = result.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text);
    if (!parsed.ok) throw new Error(`grok_check failed: ${text}`);
  }

  console.log(`MCP smoke passed: ${names.length} tools available`);
} finally {
  await client.close();
  if (stderr.trim()) process.stderr.write(stderr);
}
