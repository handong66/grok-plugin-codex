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
  grokFinalize,
  grokModels,
  grokRescue,
  grokResult,
  grokReview,
  grokRun,
  grokSessions,
  grokStatus
} from "./tools.js";

const server = new McpServer(
  { name: "grok-plugin-codex", version: "0.2.1" },
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
const timeoutSchema = z
  .number()
  .int()
  .positive()
  .max(86_400_000)
  .optional()
  .describe(
    "Wall-clock budget. Omitted, it defaults per kind: run/continue 180000, review 240000, " +
      "adversarial_review/rescue 300000/240000. An explicit value is never clamped in either direction; " +
      "below 30000 the call returns a warning quoting the observed cost of a successful run " +
      "(median 31s, p90 111s, max 402s). The effective value comes back as data.effectiveTimeoutMs and " +
      "is stated to Grok inside plugin-built prompts."
  );
const jobIdSchema = z.string().min(20).max(132).regex(/^job_[A-Za-z0-9_-]+$/);

const targetLike = z.union([z.string().trim().min(1).max(16_384), z.array(z.string().trim().min(1)).min(1).max(200)]);
const problemLike = z.union([z.string().trim().min(1).max(250_000), z.array(z.string().trim().min(1)).min(1).max(200)]);
const aliasNote =
  "The sibling opencode plugin calls this field prompt; both spellings are accepted here, but pass " +
  "exactly one. A string array is joined into a bulleted block.";

const backgroundSchema = z
  .boolean()
  .optional()
  .describe(
    "Default true for grok_run/grok_review/grok_adversarial_review/grok_rescue and false for grok_continue. " +
      "true returns data.job.id immediately; poll grok_status, then call grok_result once. " +
      "false blocks this MCP call until the job is terminal, for up to timeoutMs (per-kind default, see " +
      "timeoutMs) plus a 10s grace."
  );

const executionShape = {
  cwd: cwdRequired,
  model: z.string().trim().min(1).max(512).optional(),
  timeoutMs: timeoutSchema,
  background: backgroundSchema,
  disableWebSearch: z.boolean().optional(),
  maxTurns: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe(
      "Tool-using turn limit. There is no default and no floor: maxTurns 1-2 is a deliberate " +
        "answer-immediately technique and 21 of 26 such recorded runs succeeded. When set, plugin-built " +
        "prompts tell Grok the limit and to emit a complete answer on its final turn; the effective value " +
        "comes back as data.effectiveMaxTurns."
    ),
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
    description:
      "Separate Grok CLI discovery, capability compatibility, authentication/model listing, and actual model-call evidence. " +
      "modelInvocationTested and callable stay false/null unless probeInvocation is explicitly requested.",
    inputSchema: {
      cwd: cwdOptional,
      includeModels: z.boolean().optional(),
      timeoutMs: timeoutSchema,
      model: z.string().trim().min(1).max(512).optional().describe("Model for the opt-in invocation probe only."),
      probeInvocation: z
        .boolean()
        .optional()
        .describe(
          "Opt-in only, default false. Spends real Grok quota on one bounded call (--max-turns 1, 30s cap) to prove " +
            "the model answers and the stream still ends with a normal end turn. Never enable it for routine checks. " +
            "Fails closed with cli_incompatible, without calling Grok, when the installed CLI lacks the read-only flags."
        )
    },
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
    description:
      "Continue a known Grok session or explicitly continue the latest session. A session created by a " +
      "read-only job (review, adversarial review, rescue) is resumed in enforced plan mode without " +
      "subagents, and alwaysApprove on such a session is rejected with the non-retryable " +
      "readonly_session_escalation; an unknown sessionId proceeds with a warning that the original mode " +
      "could not be verified. continueLatest names no session, so the plugin infers the target from the " +
      "newest session it started in this cwd and uses that inference only to restrict: an inferred " +
      "read-only session rejects alwaysApprove with details.inferredFromLatestJob true, and every " +
      "continueLatest call warns that the resumed session could not be verified. Pass an explicit " +
      "sessionId to continue a known mutable session.",
    inputSchema: {
      ...mutableExecutionShape,
      sessionId: z.string().trim().min(1).max(256).optional(),
      continueLatest: z.boolean().optional(),
      fallbackToLatest: z
        .boolean()
        .optional()
        .describe(
          "When a named sessionId no longer exists in the Grok CLI, retry once against the latest session " +
            "in this cwd and warn. Only applies to a foreground call (background: false, the default for " +
            "this tool); a background start returns before the failure is known, and error.details." +
            "candidateSessions then lists the sessions this plugin started here."
        ),
      prompt: z.string().min(1).max(250_000)
    },
    outputSchema
  },
  (args, extra) => grokContinue(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "grok_finalize",
  {
    title: "Finalize Grok Answer",
    description:
      "One-turn, tool-free finish of work that already exists: resumes the session behind jobId (or an " +
      "explicit sessionId, or the latest session in cwd) with maxTurns 1 and a fixed prompt to stop using " +
      "tools, emit the complete answer now, and mark anything unverified as UNVERIFIED. This is the " +
      "remedy for timeout, max_turns_reached, cancelled_output and permission_denied_headless — it " +
      "recovers an answer in seconds instead of rerunning the task. It inherits the read-only mode of the " +
      "session it resumes.",
    inputSchema: {
      cwd: cwdRequired,
      jobId: jobIdSchema.optional(),
      sessionId: z.string().trim().min(1).max(256).optional(),
      model: z.string().trim().min(1).max(512).optional(),
      timeoutMs: timeoutSchema,
      background: backgroundSchema
    },
    outputSchema
  },
  (args, extra) => grokFinalize(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "grok_rescue",
  {
    title: "Grok Rescue",
    description: "Ask Grok for an independent, enforced read-only diagnosis.",
    inputSchema: {
      ...executionShape,
      problem: problemLike.optional().describe(`What went wrong and what was already tried. ${aliasNote}`),
      prompt: problemLike.optional().describe("Alias for problem, accepted for sibling-plugin compatibility.")
    },
    outputSchema
  },
  (args, extra) => grokRescue(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "grok_review",
  {
    title: "Grok Review",
    description:
      "Run an enforced read-only review of one explicit target. Inline the evidence (diff, file excerpts, " +
      "command output) into the target: plan mode refuses shell execution, so the delegate cannot produce " +
      "it. Typical wall time on this machine: review ~171s median.",
    inputSchema: {
      ...executionShape,
      target: targetLike.optional().describe(`The explicit review target. ${aliasNote}`),
      prompt: targetLike.optional().describe("Alias for target, accepted for sibling-plugin compatibility.")
    },
    outputSchema
  },
  (args, extra) => grokReview(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "grok_adversarial_review",
  {
    title: "Grok Adversarial Review",
    description:
      "Run an enforced read-only failure-mode review of one explicit target. Inline the evidence into the " +
      "target: plan mode refuses shell execution. Typical wall time on this machine: " +
      "adversarial_review ~223s median.",
    inputSchema: {
      ...executionShape,
      target: targetLike.optional().describe(`The explicit review target. ${aliasNote}`),
      prompt: targetLike.optional().describe("Alias for target, accepted for sibling-plugin compatibility.")
    },
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
    description:
      "Read a background Grok job from the private central state store, including cheap progress " +
      "(textChars, eventCounts, lastEventAt, toolCallCount, deniedToolCalls, grokSessionId) that needs " +
      "no grok_result call. Typical wall time on this machine: continue ~62s, run ~129s, review ~171s, " +
      "adversarial_review ~223s (median). Do not cancel before timeoutMs unless job.waitingForAuth is " +
      "true or eventCounts/lastEventAt have not moved for more than 45s. Note that reading status may " +
      "reap a job whose worker is gone: a run with no heartbeat for 10s, confirmed a second time and with no stream progress in between, is recorded as " +
      "worker_unavailable.",
    inputSchema: {
      jobId: jobIdSchema,
      waitMs: z
        .number()
        .int()
        .positive()
        .max(30_000)
        .optional()
        .describe(
          "Block server-side until the job is terminal, for at most this many milliseconds (cap 30000). " +
            "data.waited says whether the call actually blocked. One waiting status call plus one " +
            "grok_result replaces a polling loop."
        )
    },
    outputSchema
  },
  grokStatus
);

server.registerTool(
  "grok_result",
  {
    title: "Grok Job Result",
    description:
      "Return the full captured final text plus the output summary; only resultComplete=true is final. " +
      "Raw per-token log tails are omitted unless includeRawTail is true.",
    inputSchema: {
      jobId: jobIdSchema,
      maxChars: z.number().int().positive().max(100_000).optional(),
      includeRawTail: z
        .boolean()
        .optional()
        .describe(
          "Default false. true adds stdoutTail/stderrTail: tens of thousands of characters of per-token " +
            "streaming JSON that duplicate finalText. Use only for diagnosis."
        ),
      finalTextOffset: z
        .number()
        .int()
        .min(0)
        .max(10_000_000)
        .optional()
        .describe("Start of the returned finalText window. Page with data.finalTextNextOffset."),
      finalTextMaxChars: z
        .number()
        .int()
        .positive()
        .max(100_000)
        .optional()
        .describe(
          "Characters of finalText to return from finalTextOffset. data.finalTextChars is the full length; " +
            "data.finalTextNextOffset is absent once the window reaches the end."
        )
    },
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
