#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sentinel = "GROK_PLUGIN_CODEX_OK";

function extractJsonObject(text) {
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{") starts.push(index);
  }
  for (const index of starts.reverse()) {
    const candidate = text.slice(index).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
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

const client = new Client({ name: "grok-plugin-codex-live-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const result = await client.callTool(
    {
      name: "grok_run",
      arguments: {
        prompt: `Reply with exactly: ${sentinel}`,
        model: "grok-composer-2.5-fast",
        disableWebSearch: true,
        noSubagents: true,
        maxTurns: 1,
        background: false,
        timeoutMs: 120000
      }
    },
    undefined,
    { timeout: 130_000 }
  );
  if (result.isError) throw new Error(`grok_run returned MCP error: ${JSON.stringify(result)}`);
  const wrapper = JSON.parse(result.content?.[0]?.text ?? "{}");
  if (!wrapper.ok) throw new Error(`grok_run failed: ${JSON.stringify(wrapper, null, 2)}`);
  const grokJson = extractJsonObject(wrapper.stdout ?? "");
  const text = grokJson?.text ?? wrapper.stdout ?? "";
  if (String(text).trim() !== sentinel) {
    throw new Error(`Expected exact ${sentinel}, got: ${String(text).trim()}`);
  }
  console.log(`Live Grok smoke passed: ${sentinel}`);
} finally {
  await client.close();
  if (stderr.trim()) process.stderr.write(stderr);
}
