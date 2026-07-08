#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  grokAdversarialReview,
  grokCancel,
  grokCheck,
  grokContinue,
  grokExport,
  grokModels,
  grokRescue,
  grokResult,
  grokReview,
  grokRun,
  grokSessions,
  grokStatus
} from "./tools.js";
import { JOB_ID_PATTERN } from "./job-store.js";

const server = new McpServer(
  {
    name: "grok-plugin-codex",
    version: "0.1.0"
  },
  {
    instructions:
      "Use these tools to call Grok CLI from Codex. Do not transfer hidden Codex context, secrets, tool outputs, system/developer messages, or private runtime paths unless the user explicitly authorizes that risk."
  }
);

const commonShape = {
  cwd: z.string().optional().describe("Working directory for Grok. Defaults to the MCP server cwd."),
  grokBin: z
    .string()
    .optional()
    .describe("Explicit Grok binary path. Defaults to GROK_BIN, ~/.grok/bin/grok, ~/.local/bin/grok, Homebrew paths, then PATH."),
  model: z.string().optional().describe("Grok model ID to pass with -m/--model."),
  timeoutMs: z.number().int().positive().optional(),
  background: z.boolean().optional().describe("Run as a background job using --output-format streaming-json."),
  disableWebSearch: z.boolean().optional().describe("Pass --disable-web-search."),
  noSubagents: z.boolean().optional().describe("Pass --no-subagents."),
  maxTurns: z.number().int().positive().optional().describe("Pass --max-turns."),
  alwaysApprove: z.boolean().optional().describe("Pass --always-approve only when explicitly true."),
  reasoningEffort: z
    .string()
    .optional()
    .describe("Pass --reasoning-effort only for non-default models where the plugin does not know it is unsupported."),
  allowCodexPrivatePaths: z
    .boolean()
    .optional()
    .describe("Allow prompts that mention Codex private runtime paths such as ~/.codex. Default false.")
};

const discoveryShape = {
  cwd: commonShape.cwd,
  grokBin: commonShape.grokBin,
  timeoutMs: commonShape.timeoutMs
};

const runtimeCommonShape = {
  ...discoveryShape,
  includeModels: z.boolean().optional().describe("Set false to skip authenticated grok models probing and only check CLI discovery/version.")
};

const jobIdShape = z.string().regex(JOB_ID_PATTERN).describe("Background job ID returned by a Grok background tool run.");

server.registerTool(
  "grok_check",
  {
    title: "Check Grok",
    description: "Discover Grok CLI, run grok --version, and detect login/model availability with grok models.",
    inputSchema: runtimeCommonShape
  },
  grokCheck
);

server.registerTool(
  "grok_models",
  {
    title: "List Grok Models",
    description: "Return raw and parsed grok models output.",
    inputSchema: discoveryShape
  },
  grokModels
);

server.registerTool(
  "grok_run",
  {
    title: "Run Grok",
    description: "Run a Grok prompt in foreground JSON mode or background streaming-json mode.",
    inputSchema: {
      ...commonShape,
      prompt: z
        .string()
        .describe(
          "Prompt to send to Grok. Put task text here; do not ask Grok to read Codex private runtime paths such as ~/.codex unless explicitly authorized."
        )
    }
  },
  grokRun
);

server.registerTool(
  "grok_continue",
  {
    title: "Continue Grok Session",
    description: "Continue a Grok session with --resume <sessionId> or, only when explicitly requested, --continue.",
    inputSchema: {
      ...commonShape,
      sessionId: z.string().optional(),
      continueLatest: z.boolean().optional(),
      prompt: z.string().describe("Prompt to send while continuing the Grok session.")
    }
  },
  grokContinue
);

server.registerTool(
  "grok_rescue",
  {
    title: "Grok Rescue",
    description: "Ask Grok for an independent read-only diagnosis and minimal path forward.",
    inputSchema: {
      ...commonShape,
      problem: z.string().describe("Problem statement and visible context to diagnose.")
    }
  },
  grokRescue
);

server.registerTool(
  "grok_review",
  {
    title: "Grok Review",
    description: "Ask Grok for a bounded findings-first review of a target such as the current diff.",
    inputSchema: {
      ...commonShape,
      target: z.string().optional().describe("Review target. Defaults to current working tree.")
    }
  },
  grokReview
);

server.registerTool(
  "grok_adversarial_review",
  {
    title: "Grok Adversarial Review",
    description: "Ask Grok for a bounded failure-mode review with at most 5 findings.",
    inputSchema: {
      ...commonShape,
      target: z.string().optional().describe("Review target. Defaults to current working tree.")
    }
  },
  grokAdversarialReview
);

server.registerTool(
  "grok_sessions",
  {
    title: "Grok Sessions",
    description: "Wrap grok sessions list/search and return raw output.",
    inputSchema: {
      cwd: commonShape.cwd,
      grokBin: commonShape.grokBin,
      timeoutMs: commonShape.timeoutMs,
      query: z.string().optional(),
      limit: z.number().int().positive().optional()
    }
  },
  grokSessions
);

server.registerTool(
  "grok_export",
  {
    title: "Export Grok Session",
    description: "Wrap grok export <sessionId> and return Markdown from stdout by default.",
    inputSchema: {
      cwd: commonShape.cwd,
      grokBin: commonShape.grokBin,
      timeoutMs: commonShape.timeoutMs,
      sessionId: z.string(),
      outputFile: z.string().optional().describe("Optional filesystem output path. Omit to return Markdown.")
    }
  },
  grokExport
);

server.registerTool(
  "grok_status",
  {
    title: "Grok Job Status",
    description: "Read a background Grok job record.",
    inputSchema: {
      cwd: z.string().optional(),
      jobId: jobIdShape
    }
  },
  grokStatus
);

server.registerTool(
  "grok_result",
  {
    title: "Grok Job Result",
    description: "Read stdout/stderr tails and parsed outputSummary for a background Grok job.",
    inputSchema: {
      cwd: z.string().optional(),
      jobId: jobIdShape,
      maxChars: z.number().int().positive().optional()
    }
  },
  grokResult
);

server.registerTool(
  "grok_cancel",
  {
    title: "Cancel Grok Job",
    description: "Cancel a running background Grok job.",
    inputSchema: {
      cwd: z.string().optional(),
      jobId: jobIdShape
    }
  },
  grokCancel
);

const transport = new StdioServerTransport();
await server.connect(transport);
