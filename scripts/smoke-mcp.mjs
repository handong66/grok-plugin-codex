#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
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

const expectedSchemas = {
  grok_check: {
    properties: ["cwd", "includeModels", "model", "probeInvocation", "timeoutMs"],
    required: []
  },
  grok_models: {
    properties: ["cwd", "timeoutMs"],
    required: []
  },
  grok_run: {
    properties: [
      "allowCodexPrivatePaths",
      "alwaysApprove",
      "background",
      "cwd",
      "disableWebSearch",
      "maxTurns",
      "model",
      "noSubagents",
      "prompt",
      "reasoningEffort",
      "timeoutMs"
    ],
    required: ["cwd", "prompt"]
  },
  grok_continue: {
    properties: [
      "allowCodexPrivatePaths",
      "alwaysApprove",
      "background",
      "continueLatest",
      "cwd",
      "disableWebSearch",
      "maxTurns",
      "model",
      "noSubagents",
      "prompt",
      "reasoningEffort",
      "sessionId",
      "timeoutMs"
    ],
    required: ["cwd", "prompt"]
  },
  grok_rescue: {
    properties: [
      "allowCodexPrivatePaths",
      "background",
      "cwd",
      "disableWebSearch",
      "maxTurns",
      "model",
      "problem",
      "reasoningEffort",
      "timeoutMs"
    ],
    required: ["cwd", "problem"]
  },
  grok_review: {
    properties: [
      "allowCodexPrivatePaths",
      "background",
      "cwd",
      "disableWebSearch",
      "maxTurns",
      "model",
      "reasoningEffort",
      "target",
      "timeoutMs"
    ],
    required: ["cwd", "target"]
  },
  grok_adversarial_review: {
    properties: [
      "allowCodexPrivatePaths",
      "background",
      "cwd",
      "disableWebSearch",
      "maxTurns",
      "model",
      "reasoningEffort",
      "target",
      "timeoutMs"
    ],
    required: ["cwd", "target"]
  },
  grok_sessions: {
    properties: ["cwd", "limit", "query", "timeoutMs"],
    required: ["cwd"]
  },
  grok_export: {
    properties: ["cwd", "sessionId", "timeoutMs"],
    required: ["cwd", "sessionId"]
  },
  grok_status: {
    properties: ["jobId", "waitMs"],
    required: ["jobId"]
  },
  grok_result: {
    properties: ["finalTextMaxChars", "finalTextOffset", "includeRawTail", "jobId", "maxChars"],
    required: ["jobId"]
  },
  grok_cancel: {
    properties: ["jobId"],
    required: ["jobId"]
  }
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

const stateDir = await mkdtemp(join(tmpdir(), "grok-plugin-codex-smoke-state-"));
const transport = new StdioClientTransport({
  command: "node",
  args: ["plugins/grok-plugin-codex/dist/server.js"],
  cwd: process.cwd(),
  env: { ...process.env, GROK_PLUGIN_STATE_DIR: stateDir },
  stderr: "pipe"
});

let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

const client = new Client({ name: "grok-plugin-codex-smoke", version: "0.2.1" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools({}, { timeout: 5_000 });
  const names = tools.map((tool) => tool.name).sort();
  const missing = requiredTools.filter((tool) => !names.includes(tool));
  if (missing.length) {
    throw new Error(`Missing MCP tools: ${missing.join(", ")}`);
  }

  for (const [toolName, expected] of Object.entries(expectedSchemas)) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    const properties = Object.keys(tool?.inputSchema?.properties ?? {}).sort();
    const sortedExpected = [...expected.properties].sort();
    if (JSON.stringify(properties) !== JSON.stringify(sortedExpected)) {
      throw new Error(`Unexpected ${toolName} schema properties: ${properties.join(", ")}`);
    }
    const required = [...(tool?.inputSchema?.required ?? [])].sort();
    const sortedRequired = [...expected.required].sort();
    if (JSON.stringify(required) !== JSON.stringify(sortedRequired)) {
      throw new Error(`Unexpected ${toolName} required fields: ${required.join(", ")}`);
    }
    if (!tool?.outputSchema) {
      throw new Error(`Missing ${toolName} output schema.`);
    }
    const outputProperties = Object.keys(tool.outputSchema.properties ?? {}).sort();
    const expectedOutputProperties = ["data", "error", "ok", "warnings"];
    if (tool.outputSchema.type !== "object" || JSON.stringify(outputProperties) !== JSON.stringify(expectedOutputProperties)) {
      throw new Error(`Unexpected ${toolName} output schema shape: ${JSON.stringify(tool.outputSchema)}`);
    }
    const outputRequired = [...(tool.outputSchema.required ?? [])].sort();
    if (JSON.stringify(outputRequired) !== JSON.stringify(expectedOutputProperties)) {
      throw new Error(`Unexpected ${toolName} output required fields: ${outputRequired.join(", ")}`);
    }
  }

  const protocolError = await client.callTool(
    { name: "grok_review", arguments: { cwd: process.cwd() } },
    undefined,
    { timeout: 5_000 }
  );
  if (!protocolError.isError || !String(protocolError.content?.[0]?.text ?? "").includes("Input validation error")) {
    throw new Error(`Missing MCP input validation error for grok_review.target: ${JSON.stringify(protocolError)}`);
  }

  const businessError = await client.callTool(
    { name: "grok_status", arguments: { jobId: "job_smokeunknown000000000000" } },
    undefined,
    { timeout: 5_000 }
  );
  const businessText = businessError.content?.[0]?.text ?? "";
  const businessEnvelope = JSON.parse(businessText);
  if (!businessError.isError || businessEnvelope.error?.code !== "job_not_found") {
    throw new Error(`Missing typed job_not_found business error: ${businessText}`);
  }
  if (JSON.stringify(businessEnvelope) !== JSON.stringify(businessError.structuredContent)) {
    throw new Error("Business error text does not mirror structuredContent.");
  }

  if (localGrokCandidate()) {
    const result = await client.callTool(
      {
        name: "grok_check",
        arguments: { includeModels: false }
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
  await rm(stateDir, { recursive: true, force: true });
  if (stderr.trim()) process.stderr.write(stderr);
}
