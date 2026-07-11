#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  configureWorkspaceRootsProvider,
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

const server = new McpServer(
  { name: "grok-plugin-codex", version: "0.2.0" },
  {
    instructions:
      "Use these tools to operate Grok CLI without transferring hidden Codex context, secrets, system/developer messages, tool output, or private runtime paths. Codex owns scope, verification, git, and final judgment."
  }
);

configureWorkspaceRootsProvider(async () => {
  return await server.server
    .listRoots()
    .then(({ roots }) =>
      roots.flatMap((root) => {
        const url = new URL(root.uri);
        return url.protocol === "file:" ? [fileURLToPath(url)] : [];
      })
    )
    .catch(() => []);
});

function codexWorkspaceRoots(meta: unknown): string[] {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return [];
  const turnMetadata = (meta as Record<string, unknown>)["x-codex-turn-metadata"];
  if (!turnMetadata || typeof turnMetadata !== "object" || Array.isArray(turnMetadata)) return [];
  const workspaces = (turnMetadata as Record<string, unknown>).workspaces;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) return [];
  return Object.keys(workspaces).filter((root) => root.length <= 4_096 && isAbsolute(root));
}

function withCodexWorkspaceRoots<T extends Record<string, unknown>>(
  args: T,
  meta: unknown
): T & { _workspaceRoots: string[] } {
  return { ...args, _workspaceRoots: codexWorkspaceRoots(meta) };
}

const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional()
});
const outputSchema = {
  ok: z.boolean(),
  data: z.record(z.string(), z.unknown()).nullable(),
  error: errorSchema.nullable(),
  warnings: z.array(z.string())
};

const cwdRequired = z.string().trim().min(1).max(4_096).describe("Existing working directory inside an active MCP workspace root.");
const cwdOptional = z.string().trim().min(1).max(4_096).optional();
const timeoutSchema = z.number().int().positive().max(86_400_000).optional();
const jobIdSchema = z.string().min(20).max(132).regex(/^job_[A-Za-z0-9_-]+$/);

const executionShape = {
  cwd: cwdRequired,
  model: z.string().trim().min(1).max(512).optional(),
  timeoutMs: timeoutSchema,
  background: z.boolean().optional(),
  disableWebSearch: z.boolean().optional(),
  maxTurns: z.number().int().positive().max(10_000).optional(),
  reasoningEffort: z.string().trim().min(1).max(128).optional(),
  allowCodexPrivatePaths: z.boolean().optional()
};

const mutableExecutionShape = {
  ...executionShape,
  noSubagents: z.boolean().optional(),
  alwaysApprove: z.boolean().optional()
};

server.registerTool(
  "grok_check",
  {
    title: "Check Grok",
    description: "Separate Grok CLI discovery, capability compatibility, authentication/model listing, and actual model-call evidence.",
    inputSchema: { cwd: cwdOptional, includeModels: z.boolean().optional(), timeoutMs: timeoutSchema },
    outputSchema
  },
  (args, extra) => grokCheck(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "grok_models",
  {
    title: "List Grok Models",
    description: "List models without claiming that any model has completed a real invocation.",
    inputSchema: { cwd: cwdOptional, timeoutMs: timeoutSchema },
    outputSchema
  },
  (args, extra) => grokModels(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "grok_run",
  {
    title: "Run Grok",
    description: "Run one explicit Grok prompt in the named workspace.",
    inputSchema: {
      ...mutableExecutionShape,
      prompt: z.string().min(1).max(250_000)
    },
    outputSchema
  },
  (args, extra) => grokRun(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "grok_continue",
  {
    title: "Continue Grok Session",
    description: "Continue a known Grok session or explicitly continue the latest session.",
    inputSchema: {
      ...mutableExecutionShape,
      sessionId: z.string().trim().min(1).max(256).optional(),
      continueLatest: z.boolean().optional(),
      prompt: z.string().min(1).max(250_000)
    },
    outputSchema
  },
  (args, extra) => grokContinue(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "grok_rescue",
  {
    title: "Grok Rescue",
    description: "Ask Grok for an independent, enforced read-only diagnosis.",
    inputSchema: { ...executionShape, problem: z.string().min(1).max(250_000) },
    outputSchema
  },
  (args, extra) => grokRescue(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "grok_review",
  {
    title: "Grok Review",
    description: "Run an enforced read-only review of one explicit target.",
    inputSchema: { ...executionShape, target: z.string().trim().min(1).max(16_384) },
    outputSchema
  },
  (args, extra) => grokReview(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "grok_adversarial_review",
  {
    title: "Grok Adversarial Review",
    description: "Run an enforced read-only failure-mode review of one explicit target.",
    inputSchema: { ...executionShape, target: z.string().trim().min(1).max(16_384) },
    outputSchema
  },
  (args, extra) => grokAdversarialReview(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "grok_sessions",
  {
    title: "Grok Sessions",
    description: "List or search Grok sessions for an explicit workspace.",
    inputSchema: {
      cwd: cwdRequired,
      timeoutMs: timeoutSchema,
      query: z.string().max(4_096).optional(),
      limit: z.number().int().positive().max(1_000).optional()
    },
    outputSchema
  },
  (args, extra) => grokSessions(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "grok_export",
  {
    title: "Export Grok Session",
    description: "Return a Grok session transcript as Markdown without writing a caller-selected file.",
    inputSchema: { cwd: cwdRequired, timeoutMs: timeoutSchema, sessionId: z.string().trim().min(1).max(256) },
    outputSchema
  },
  (args, extra) => grokExport(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "grok_status",
  {
    title: "Grok Job Status",
    description: "Read a background Grok job from the private central state store.",
    inputSchema: { jobId: jobIdSchema },
    outputSchema
  },
  grokStatus
);

server.registerTool(
  "grok_result",
  {
    title: "Grok Job Result",
    description: "Return bounded logs plus full captured final text; only resultComplete=true is final.",
    inputSchema: { jobId: jobIdSchema, maxChars: z.number().int().positive().max(100_000).optional() },
    outputSchema
  },
  grokResult
);

server.registerTool(
  "grok_cancel",
  {
    title: "Cancel Grok Job",
    description: "Cancel a background Grok job and its process tree by job ID.",
    inputSchema: { jobId: jobIdSchema },
    outputSchema
  },
  grokCancel
);

await server.connect(new StdioServerTransport());
