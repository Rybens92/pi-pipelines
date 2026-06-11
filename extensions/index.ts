/**
 * Pi Pipelines Extension
 *
 * Defines and runs multi-agent pipelines with review gates, loops, and parallel execution.
 * Powered by pi-subagents for agent delegation.
 *
 * Commands:
 *   /pipeline-<name> [task]          — Run a specific pipeline by name (auto-discovered)
 *   /run-pipeline <name> [task]      — Generic fallback to run any pipeline by name
 *   /list-pipelines                  — List all available pipelines
 *   /pipeline- prefix = group       — Tab-completion shows all pipeline commands
 *
 * Tools:
 *   run_pipeline — LLM-callable tool to execute a pipeline
 *   list_pipelines — LLM-callable tool to discover pipelines
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { fileURLToPath } from "node:url";
import { listPipelines, loadPipeline, findPipelineFile, listPipelinesFromDirs } from "./config-loader.ts";

/** Extension's own bundled pipelines directory */
const BUNDLED_PIPELINES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../pipelines",
);

/** User's global pipelines directory (~/.pi/pipelines/) */
const USER_GLOBAL_PIPELINES_DIR = path.join(os.homedir(), ".pi", "pipelines");

/**
 * Get the pipeline search directories.
 * Order: project → user global → extension bundled
 */
function getPipelineDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const projectDir = path.join(cwd, ".pi/pipelines");
  if (projectDir !== USER_GLOBAL_PIPELINES_DIR &&
      projectDir !== BUNDLED_PIPELINES_DIR) {
    dirs.push(projectDir);
  }
  if (USER_GLOBAL_PIPELINES_DIR !== BUNDLED_PIPELINES_DIR) {
    dirs.push(USER_GLOBAL_PIPELINES_DIR);
  }
  dirs.push(BUNDLED_PIPELINES_DIR);
  return dirs;
}

/**
 * Seed user's global pipelines directory with bundled pipelines
 * (copies only pipelines that don't already exist there).
 */
function seedUserPipelines(): void {
  try {
    if (!fs.existsSync(BUNDLED_PIPELINES_DIR)) return;
    fs.mkdirSync(USER_GLOBAL_PIPELINES_DIR, { recursive: true });
    for (const file of fs.readdirSync(BUNDLED_PIPELINES_DIR)) {
      const target = path.join(USER_GLOBAL_PIPELINES_DIR, file);
      if (!fs.existsSync(target)) {
        fs.copyFileSync(
          path.join(BUNDLED_PIPELINES_DIR, file),
          target,
        );
      }
    }
  } catch {
    // Best effort — user global dir might not be writable.
  }
}
import { runPipeline, formatPipelineResult, buildPipelineContextMessage, formatDuration } from "./pipeline-runner.ts";
import type { PipelineResult } from "./types.ts";

/** Widget key for the pipeline status widget */
const WIDGET_KEY = "pi-pipelines-status";

/** Internal state */
interface PipelinesState {
  currentResult: PipelineResult | null;
  lastPipelinesDir: string | null;
}

export default function registerPipelinesExtension(pi: ExtensionAPI): void {
  const state: PipelinesState = {
    currentResult: null,
    lastPipelinesDir: null,
  };

  // ========================================================================
  // Helper: resolve pipeline file from user dir + extension dir
  // ========================================================================
  function findPipeline(name: string, cwd: string): { file: string; dir: string } | null {
    const dirs = getPipelineDirs(cwd);
    for (const dir of dirs) {
      const file = findPipelineFile(dir, name);
      if (file) return { file, dir };
    }
    return null;
  }

  // ========================================================================
  // Helper: run a pipeline by name and handle result display
  // ========================================================================
  async function runAndReport(
    pipelineName: string,
    task: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    ctx.ui.setStatus(WIDGET_KEY, `🚀 Running pipeline: ${pipelineName}`);

    const found = findPipeline(pipelineName, ctx.cwd);
    const pipelinesDir = found?.dir ?? path.join(ctx.cwd, ".pi/pipelines");

    const result = await runPipeline(pi, ctx, {
      pipeline: pipelineName,
      task,
      pipelinesDir,
    });

    state.currentResult = result;
    ctx.ui.setStatus(WIDGET_KEY, "");

    if (result.success) {
      ctx.ui.notify(`✅ Pipeline "${pipelineName}" completed successfully`, "info");
    } else if (result.error) {
      ctx.ui.notify(`❌ Pipeline "${pipelineName}" failed: ${result.error}`, "error");
    }

    if (ctx.hasUI && result.stages.length > 0) {
      ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(result));
    }

    // Inject pipeline result into the main agent's context
    // so the LLM can summarize what happened.
    const contextMsg = buildPipelineContextMessage(result);
    try {
      pi.sendMessage(
        { customType: "pipeline-result", content: contextMsg, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      // Stale context after reload — result still visible via TUI widget.
    }
  }

  // ========================================================================
  // COMMAND GENERATOR: scan .pi/pipelines/ and register /pipeline-* commands
  // (runs eagerly at extension load time; uses process.cwd() for scan)
  // ========================================================================
  function scanAndRegisterPipelineCommands(): void {
    const cwd = process.cwd();
    const pipelines = listPipelinesFromDirs(getPipelineDirs(cwd));

    for (const p of pipelines) {
      const cmdName = `pipeline-${p.name}`;
      let description: string;
      try {
        const def = loadPipeline(p.file);
        description = def.description;
      } catch {
        description = `Run the ${p.name} pipeline`;
      }

      pi.registerCommand(cmdName, {
        description: `Run pipeline "${p.name}": ${description}. Usage: /${cmdName} [task description]`,
        handler: async (args: string, ctxInner: ExtensionContext) => {
          const task = args.trim() || p.name;
          await runAndReport(p.name, task, ctxInner);
        },
      });
    }
  }

  // Seed user's global pipelines directory with bundled pipelines,
  // then scan and register /pipeline-* commands.
  seedUserPipelines();
  scanAndRegisterPipelineCommands();

  // ========================================================================
  // COMMAND: /run-pipeline <name> [task] (generic fallback)
  // ========================================================================
  pi.registerCommand("run-pipeline", {
    description:
      "Run a pipeline defined in .pi/pipelines/ (project), ~/.pi/pipelines/ (global), or bundled with the extension. " +
      "Usage: /run-pipeline <name> [task description]",
    handler: async (args: string, ctx: ExtensionContext) => {
      // Parse args: first word is pipeline name, rest is task
      const parts = args.trim().split(/\s+/);
      if (parts.length === 0 || !parts[0]) {
        const available = listPipelinesFromDirs(getPipelineDirs(ctx.cwd));
        const names = available.map((p) => `  ${p.name} -> /pipeline-${p.name}`).join("\n");
        ctx.ui.notify(
          `Usage: /run-pipeline <name> [task]\nOr use named commands directly:\n${names}`,
          "warning",
        );
        return;
      }

      const pipelineName = parts[0]!;
      const task = parts.slice(1).join(" ") || pipelineName;
      await runAndReport(pipelineName, task, ctx);
    },
  });

  // ========================================================================
  // COMMAND: /list-pipelines
  // ========================================================================
  pi.registerCommand("list-pipelines", {
    description: "List all available pipeline definitions with their dedicated commands",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const dirs = getPipelineDirs(ctx.cwd);
      const pipelines = listPipelinesFromDirs(dirs);

      if (pipelines.length === 0) {
        ctx.ui.notify(
          `No pipelines found in ${dirs.join(" or ")}/`,
          "info",
        );
        return;
      }

      const lines = pipelines.map((p) => {
        try {
          const def = loadPipeline(p.file);
          const stagesInfo = def.stages
            .map((s) => (s.gate ? `${s.id} [gate]` : s.id))
            .join(" → ");
          return `  /pipeline-${p.name}\n    ${def.description}\n    Stages: ${stagesInfo}`;
        } catch {
          return `  /pipeline-${p.name}\n    (invalid pipeline file)`;
        }
      });

      ctx.ui.notify(
        `Available pipelines (${pipelines.length}):\n\n${lines.join("\n\n")}`,
        "info",
      );
    },
  });

  // ========================================================================
  // TOOL: run_pipeline (for LLM)
  // ========================================================================
  pi.registerTool({
    name: "run_pipeline",
    label: "Run Pipeline",
    description:
      "Execute a predefined multi-agent pipeline with review gates. " +
      "Pipelines are defined in .pi/pipelines/ (project), ~/.pi/pipelines/ (global), or bundled with the extension. " +
      "The task is passed through {task} variables to each stage.",
    promptSnippet: "Run a multi-agent pipeline from the project's pipeline library",
    promptGuidelines: [
      "Use run_pipeline when the user asks to run a defined workflow or pipeline.",
      "Specify the pipeline name and a clear task description.",
      "Use list_pipelines first if you don't know what pipelines are available.",
    ],
    parameters: Type.Object({
      pipeline: Type.String({
        description:
          "Pipeline name — searched in .pi/pipelines/ (project), ~/.pi/pipelines/ (global), then extension bundled",
      }),
      task: Type.String({
        description:
          "Task description passed through {task} to pipeline stages",
      }),
    }),
    async execute(
      _toolCallId: string,
      params: { pipeline: string; task: string },
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<Record<string, unknown> | undefined> | undefined,
      ctx: ExtensionContext,
    ) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Pipeline execution cancelled." }],
          details: { cancelled: true },
        };
      }

      const found = findPipeline(params.pipeline, ctx.cwd);
      const pipelinesDir = found?.dir ?? path.join(ctx.cwd, ".pi/pipelines");

      ctx.ui.setStatus(WIDGET_KEY, `🚀 Running pipeline: ${params.pipeline}`);

      const result = await runPipeline(pi, ctx, {
        pipeline: params.pipeline,
        task: params.task,
        pipelinesDir,
        signal,
        // Default timeout 30 min per stage. Override with stageTimeoutMs if needed.
      });

      state.currentResult = result;
      ctx.ui.setStatus(WIDGET_KEY, "");

      // Set widget for TUI
      if (ctx.hasUI && result.stages.length > 0) {
        const widgetLines = buildWidgetLines(result);
        ctx.ui.setWidget(WIDGET_KEY, widgetLines);
      }

      // Build enhanced result with structured summary + instruction
      // so the LLM naturally summarizes the pipeline run.
      const enhancedResult = buildPipelineContextMessage(result);

      return {
        content: [
          {
            type: "text" as const,
            text: enhancedResult,
          },
        ],
        details: {
          pipelineName: result.pipelineName,
          task: result.task,
          success: result.success,
          stages: result.stages.map((s) => ({
            stageId: s.stageId,
            success: s.success,
            durationMs: s.durationMs,
            rounds: s.rounds,
            scores: s.scores,
            error: s.error,
          })),
          totalDurationMs: result.totalDurationMs,
          error: result.error,
        } as Record<string, unknown>,
      };
    },
  });

  // ========================================================================
  // TOOL: list_pipelines (for LLM)
  // ========================================================================
  pi.registerTool({
    name: "list_pipelines",
    label: "List Pipelines",
    description:
      "List all available pipeline definitions from project (.pi/pipelines/), global (~/.pi/pipelines/), and extension-bundled pipelines",
    promptSnippet: "List available pipeline definitions for running workflows",
    promptGuidelines: [
      "Use list_pipelines before run_pipeline when you don't know what pipelines exist.",
      "Pipelines are defined in .pi/pipelines/ (project), ~/.pi/pipelines/ (global), or bundled with the extension.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: "Optional search term to filter pipelines by name or description",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { query?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<Record<string, unknown> | undefined> | undefined,
      ctx: ExtensionContext,
    ) {
      const all = listPipelinesFromDirs(getPipelineDirs(ctx.cwd));

      if (all.length === 0) {
        const dirs = getPipelineDirs(ctx.cwd);
        return {
          content: [
            {
              type: "text" as const,
              text: `No pipelines found. Searched: ${dirs.join(", ")}`,
            },
          ],
          details: { pipelines: [] },
        };
      }

      let filtered = all;
      if (params.query) {
        const q = params.query.toLowerCase();
        filtered = all.filter(
          (p) =>
            p.name.toLowerCase().includes(q),
        );
      }

      const details = filtered.map((p) => {
        try {
          const def = loadPipeline(p.file);
          return {
            name: def.name,
            description: def.description,
            command: `/pipeline-${def.name}`,
            stages: def.stages.map((s) => ({
              id: s.id,
              agent: s.agent ?? "(parallel)",
              hasGate: !!s.gate,
              gateType: s.gate?.type,
            })),
          };
        } catch {
          return { name: p.name, description: "(invalid)", stages: [] };
        }
      });

      const lines = details.map(
        (d) =>
          `  - ${d.name}: ${d.description}${d.command ? ` (/${d.command})` : ""} (${d.stages.length} stages${
            d.stages.filter((s) => s.hasGate).length > 0
              ? `, ${d.stages.filter((s) => s.hasGate).length} with gates`
              : ""
          })`,
      );

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Available pipelines (${details.length}):\n${lines.join("\n")}`
                .trim(),
          },
        ],
        details: { pipelines: details } as Record<string, unknown>,
      };
    },
  });

  // ========================================================================
  // Cleanup on session shutdown
  // ========================================================================
  pi.on("session_shutdown", () => {
    state.currentResult = null;
    state.lastPipelinesDir = null;
  });
}

/**
 * Build widget lines for the TUI pipeline status widget.
 */
function buildWidgetLines(result: PipelineResult): string[] {
  const lines: string[] = [];
  const statusIcon = result.success ? "✅" : "❌";
  lines.push(`${statusIcon} ${result.pipelineName} (${formatDuration(result.totalDurationMs)})`);

  for (const stage of result.stages) {
    const icon = stage.success ? "✓" : "✗";
    let meta = "";
    if (stage.rounds) meta += ` ${stage.rounds}r`;
    if (stage.scores?.length) meta += ` [${stage.scores.join(",")}]`;
    lines.push(`  ${icon} ${stage.stageId}${meta}`);
  }

  if (result.error && result.stages.length === 0) {
    lines.push(`  ✗ ${result.error.slice(0, 60)}`);
  }

  return lines;
}


