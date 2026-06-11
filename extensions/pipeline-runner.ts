/**
 * Pipeline Runner — core orchestration engine
 *
 * Executes pipeline stages by dispatching subagent commands through
 * pi-subagents' event bridge. This means:
 * - No child Pi processes needed
 * - pi-subagents handles all agent execution natively
 * - Chain and parallel execution are native to pi-subagents
 * - Review gates add the iterative scoring loop on top
 *
 * For simple linear pipelines, the runner emits a single chain request.
 * For pipelines with gates, it runs stages one-by-one with programmatic
 * control over the review loop.
 */

import * as path from "node:path";
import yaml from "js-yaml";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PipelineDef, Stage, StageResult, PipelineResult, StageReportConfig } from "./types.ts";
import { findPipelineFile, listPipelines, loadPipeline } from "./config-loader.ts";
import { executeSubagent, extractResponseText } from "./subagent-bridge.ts";

/** Default pipelines directory relative to cwd */
const PIPELINES_DIR = ".pi/pipelines";

/**
 * Combine a parent AbortSignal with an optional timeout.
 * Returns a signal that aborts when EITHER the parent aborts OR the timeout fires.
 * Returns undefined when neither is provided.
 */
function createStageSignal(
  parentSignal?: AbortSignal,
  timeoutMs?: number,
): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (parentSignal) signals.push(parentSignal);
  if (timeoutMs && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/**
 * Build a condensed context string from stage results for the report synthesizer.
 * Truncates each stage output to a preview to avoid blowing up the context.
 */
/** @internal Exported for testing. See pipeline-runner.test.ts */
export function buildReportContext(
  pipelineName: string,
  pipelineDescription: string,
  task: string,
  stages: StageResult[],
  focus?: string,
): string {
  const lines: string[] = [];
  lines.push(`# Pipeline: ${pipelineName}`);
  lines.push(`Description: ${pipelineDescription}`);
  lines.push(`Task: ${task}`);
  if (focus) lines.push(`Focus: ${focus}`);
  const passed = stages.filter((s) => s.success).length;
  const total = stages.length;
  const totalMs = stages.reduce((sum, s) => sum + s.durationMs, 0);
  lines.push(`Status: ${passed === total ? "PASSED" : "FAILED"} (${passed}/${total} stages passed, ${formatDuration(totalMs)})`);
  lines.push("");
  lines.push("## Stage Results");
  lines.push("");

  for (let i = 0; i < stages.length; i++) {
    const s = stages[i]!;
    const icon = s.success ? "✅ PASS" : "❌ FAIL";
    const rounds = s.rounds ? ` (${s.rounds} round${s.rounds > 1 ? "s" : ""})` : "";
    const scores = s.scores?.length ? ` scores=[${s.scores.join(", ")}]` : "";
    lines.push(`### ${i + 1}. ${s.stageId} ${icon}${rounds}${scores}`);
    lines.push(`Duration: ${formatDuration(s.durationMs)}`);
    if (s.error) {
      lines.push(`Error: ${s.error}`);
    }
    if (s.output) {
      lines.push(`Output:\n${s.output}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * The default max length for a stage summary (characters).
 */
const STAGE_SUMMARY_MAX_LENGTH = 500;

/**
 * Summarize a single stage's output so the next stage doesn't get the full firehose.
 * Uses a fast LLM call when mode='summary'.
 * Returns the raw output unchanged when mode is not 'summary'.
 */
/** @internal Exported for testing. See pipeline-runner.test.ts */
export async function applyStageReport(
  pi: ExtensionAPI,
  stage: Stage,
  rawOutput: string,
  task: string,
  signal?: AbortSignal,
): Promise<string> {
  const report = stage.report;
  if (!report || report.mode === "full" || report.mode === undefined) {
    return rawOutput;
  }

  const maxLen = report.maxLength ?? STAGE_SUMMARY_MAX_LENGTH;
  const instruction = report.instruction ?? "Summarize the key findings and results concisely.";

  const prompt = `You are a stage output summarizer. A pipeline stage has just completed and its output
needs to be condensed so the next stage does not receive the full raw text.

Stage: ${stage.id}
Full task: ${task}

Summarization instruction: ${instruction}

Raw output (${rawOutput.length} chars):
${rawOutput}

---
Produce a concise summary of the stage output, maximum ${maxLen} characters.
Focus on key facts, decisions, and results relevant to downstream stages.
Ignore verbose reasoning, iterative exploration, and internal commentary.`;

  const response = await executeSubagent(pi, {
    agent: "worker",
    task: prompt,
    context: "fresh",
  }, signal);

  const summary = extractResponseText(response) || "(summary unavailable)";
  return summary.length > maxLen ? summary.slice(0, maxLen) + "..." : summary;
}

/**
 * Run the post-pipeline report synthesizer.
 * Calls a planner agent with all stage results to produce a summary.
 * This is best-effort — errors do not fail the pipeline.
 */
/** @internal Exported for testing. See pipeline-runner.test.ts */
export async function runReportSynthesis(
  pi: ExtensionAPI,
  pipeline: PipelineDef,
  task: string,
  stages: StageResult[],
  agentName?: string,
  focus?: string,
  signal?: AbortSignal,
): Promise<string> {
  const context = buildReportContext(
    pipeline.name,
    pipeline.description,
    task,
    stages,
    focus,
  );

  const synthesisAgent = agentName || "planner";

  const prompt = `You are a pipeline report synthesizer. A pipeline has just completed its execution.

Below is the execution summary of all stages. Based on this, produce a concise report covering:
1. **What was achieved** — what the pipeline accomplished
2. **Key findings** — important results, decisions, or artifacts produced
3. **Issues** — any failures, problems, or areas needing attention
4. **Next steps / recommendations** — what should be done next

Keep the report concise and actionable. Focus on the substance of what happened.

${context}

---
Generate the pipeline report now.`;

  const response = await executeSubagent(pi, {
    agent: synthesisAgent,
    task: prompt,
    context: "fresh",
  }, signal);

  return extractResponseText(response) || "(report synthesis produced no output)";
}

/**
 * Options passed to the pipeline runner.
 */
export interface RunOptions {
  pipeline: string;
  task: string;
  pipelinesDir?: string;
  /** Optional AbortSignal to cancel the pipeline mid-execution */
  signal?: AbortSignal;
  /** Optional per-stage timeout in milliseconds (default: no timeout) */
  stageTimeoutMs?: number;
}

/**
 * Main entry point: run a pipeline by name.
 */
export async function runPipeline(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: RunOptions,
): Promise<PipelineResult> {
  const startTime = Date.now();
  const pipelinesDir = options.pipelinesDir ?? path.join(ctx.cwd, PIPELINES_DIR);

  // Resolve pipeline file
  const filePath = findPipelineFile(pipelinesDir, options.pipeline);
  if (!filePath) {
    const available = listPipelines(pipelinesDir);
    const names = available.map((p) => `  - ${p.name}`).join("\n");
    const msg =
      available.length > 0
        ? `Pipeline "${options.pipeline}" not found.\nAvailable pipelines:\n${names}`
        : `Pipeline "${options.pipeline}" not found.\nNo pipelines defined in ${pipelinesDir}/`;
    return failResult(options.pipeline, options.task, msg, startTime);
  }

  // Load and validate pipeline
  let pipeline: PipelineDef;
  try {
    pipeline = loadPipeline(filePath);
  } catch (err) {
    return failResult(
      options.pipeline,
      options.task,
      `Failed to load pipeline: ${(err as Error).message}`,
      startTime,
    );
  }

  const parentSignal = options.signal;
  const stageTimeoutMs = options.stageTimeoutMs ?? 1_800_000; // default 30 min
  const stageSignal = createStageSignal(parentSignal, stageTimeoutMs);

  // Check for pre-existing cancellation
  if (parentSignal?.aborted) {
    return failResult(options.pipeline, options.task, "Pipeline cancelled before execution", startTime);
  }

  // Execution context
  const outputs = new Map<string, string>();
  let lastFeedback: string | undefined;
  const stages: StageResult[] = [];

  if (ctx.hasUI) {
    ctx.ui.setStatus("pipeline", `🚀 Pipeline: ${pipeline.name}`);
    ctx.ui.notify(
      `🧪 Running pipeline "${pipeline.name}" (${pipeline.stages.length} stages)`,
      "info",
    );
  }

  // Execute each stage sequentially
  for (let i = 0; i < pipeline.stages.length; i++) {
    const stage = pipeline.stages[i]!;
    const stageStart = Date.now();
    const stageLabel = `Stage ${i + 1}/${pipeline.stages.length}: ${stage.id}`;

    try {
      if (stage.parallel && stage.parallel.length > 0) {
        // === PARALLEL STAGE ===
        if (ctx.hasUI) {
          ctx.ui.setStatus("pipeline", `⚡ ${stageLabel} (parallel, ${stage.parallel.length} agents)`);
        }

        const parallelResult = await runParallelStage(pi, ctx, stage, options.task, outputs, stageSignal);
        const rawOutput = parallelResult.output;
        const stageOutput = await applyStageReport(pi, stage, rawOutput, options.task, stageSignal);
        outputs.set(stage.id, stageOutput);

        stages.push({
          ...parallelResult,
          stageId: stage.id,
          output: stageOutput,
          rawOutput,
        });
      } else if (stage.expand) {
        // === EXPAND STAGE (dynamic stage expansion) ===
        if (ctx.hasUI) {
          ctx.ui.setStatus("pipeline", `✦ ${stageLabel} (expand from "${stage.expand.from}")`);
        }

        const expandResult = await runExpandStage(
          pi, ctx, stage, options.task, outputs, stageSignal,
        );

        if (expandResult.success) {
          outputs.set(stage.id, expandResult.output);
        }

        stages.push({
          stageId: stage.id,
          success: expandResult.success,
          output: expandResult.output,
          error: expandResult.error,
          durationMs: Date.now() - stageStart,
        });
      } else if (stage.gate) {
        // === REVIEW GATE STAGE ===
        if (ctx.hasUI) {
          ctx.ui.setStatus("pipeline", `🔍 ${stageLabel} (gate, max ${stage.gate.maxRounds} rounds)`);
        }

        const gateResult = await runReviewGate(
          pi, ctx, stage, options.task, outputs, lastFeedback, stageSignal,
        );
        const rawOutput = gateResult.output;
        const stageOutput = await applyStageReport(pi, stage, rawOutput, options.task, stageSignal);
        outputs.set(stage.id, stageOutput);
        lastFeedback = gateResult.lastFeedback;

        stages.push({
          stageId: stage.id,
          success: gateResult.success,
          output: stageOutput,
          rawOutput,
          error: gateResult.error,
          durationMs: Date.now() - stageStart,
          rounds: gateResult.rounds,
          scores: gateResult.scores,
        });
      } else {
        // === SIMPLE AGENT STAGE ===
        if (ctx.hasUI) {
          ctx.ui.setStatus("pipeline", `▶ ${stageLabel} (${stage.agent})`);
        }

        const result = await runSingleStage(pi, ctx, stage, options.task, outputs, lastFeedback, stageSignal);
        const rawOutput = result;
        const stageOutput = await applyStageReport(pi, stage, rawOutput, options.task, stageSignal);
        outputs.set(stage.id, stageOutput);

        stages.push({
          stageId: stage.id,
          success: true,
          output: stageOutput,
          rawOutput,
          durationMs: Date.now() - stageStart,
        });
      }
    } catch (err) {
      // If the pipeline was aborted, return partial results gracefully
      if ((err as Error).name === "AbortError" || stageSignal?.aborted) {
        if (ctx.hasUI) {
          ctx.ui.setStatus("pipeline", "");
          ctx.ui.notify(`⏹ Pipeline "${pipeline.name}" cancelled`, "warning");
        }
        return {
          pipelineName: pipeline.name,
          task: options.task,
          success: false,
          stages,
          totalDurationMs: Date.now() - startTime,
          error: `Pipeline cancelled at stage "${stage.id}" after ${stages.length} completed stages`,
        };
      }
      const errorMsg = `Stage "${stage.id}" failed: ${(err as Error).message}`;
      stages.push({
        stageId: stage.id,
        success: false,
        output: "",
        error: errorMsg,
        durationMs: Date.now() - stageStart,
      });

      if (ctx.hasUI) {
        ctx.ui.setStatus("pipeline", "");
        ctx.ui.notify(`❌ ${errorMsg}`, "error");
      }

      return {
        pipelineName: pipeline.name,
        task: options.task,
        success: false,
        stages,
        totalDurationMs: Date.now() - startTime,
        error: errorMsg,
      };
    }
  }

  // --- Report synthesis ---
  // Run BEFORE the pipeline-complete notification to avoid the appearance
  // of completion while synthesis is still running.
  const pipelineSuccess = stages.every((s) => s.success);
  const result: PipelineResult = {
    pipelineName: pipeline.name,
    task: options.task,
    success: pipelineSuccess,
    stages,
    totalDurationMs: Date.now() - startTime,
  };

  // Run the report synthesizer unless explicitly disabled
  const reportCfg = pipeline.report !== false ? (pipeline.report ?? {}) : null;
  if (reportCfg) {
    try {
      // Synthesis gets the parent signal without the stage timeout,
      // but with a 2-minute self-imposed limit so it doesn't hang
      const synthSignal = parentSignal
        ? AbortSignal.any([parentSignal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000);

      const synthesis = await runReportSynthesis(
        pi,
        pipeline,
        options.task,
        stages,
        reportCfg.agent,
        reportCfg.focus,
        synthSignal,
      );
      result.synthesis = synthesis;
    } catch (synthErr) {
      // Synthesis failure does NOT fail the pipeline — it's best-effort
      result.synthesisError = `Report synthesis failed: ${(synthErr as Error).message}`;
    }
  }

  // Pipeline complete (after synthesis to avoid showing "done" while synthesis runs)
  if (ctx.hasUI) {
    ctx.ui.setStatus("pipeline", "");
    if (result.synthesisError) {
      ctx.ui.notify(
        `✅ Pipeline "${pipeline.name}" complete (report synthesis: ⚠️ ${result.synthesisError})`,
        "info",
      );
    } else {
      ctx.ui.notify(
        `✅ Pipeline "${pipeline.name}" complete: ${stages.filter((s) => s.success).length}/${stages.length} stages passed`,
        "info",
      );
    }
  }

  return result;
}

/**
 * Run a single agent stage via pi-subagents.
 */
/** @internal Exported for testing. See pipeline-runner.test.ts */
export async function runSingleStage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stage: Stage,
  task: string,
  outputs: Map<string, string>,
  lastFeedback: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const resolvedTask = resolveTemplate(stage.task ?? "", task, outputs, lastFeedback);
  const agentName = stage.agent!;

  const response = await executeSubagent(pi, {
    agent: agentName,
    task: resolvedTask,
    clarify: false,
    model: stage.model,
    agentScope: "both",
    cwd: ctx.cwd,
  }, signal);


  if (response.isError) {
    throw new Error(`Agent "${agentName}" failed: ${response.errorText ?? "(unknown error)"}`);
  }

  return extractResponseText(response);
}

/**
 * Run a parallel stage — fan out multiple agents concurrently.
 */
/** @internal Exported for testing. See pipeline-runner.test.ts */
export async function runParallelStage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stage: Stage,
  task: string,
  outputs: Map<string, string>,
  signal?: AbortSignal,
): Promise<StageResult> {
  const stageStart = Date.now();
  const parallelStages = stage.parallel!;

  if (ctx.hasUI) {
    ctx.ui.notify(`⚡ Running ${parallelStages.length} agents in parallel`, "info");
  }

  // Build task params for pi-subagents parallel execution
  const subagentTasks = parallelStages.map((child) => ({
    agent: child.agent ?? "worker",
    task: resolveTemplate(child.task ?? "", task, outputs, undefined),
    model: child.model,
  }));

  // Use pi-subagents' parallel execution via the bridge
  const response = await executeSubagent(pi, {
    tasks: subagentTasks,
    clarify: false,
    agentScope: "both",
    cwd: ctx.cwd,
  }, signal);

  const combinedOutput = extractResponseText(response);

  if (response.isError) {
    return {
      stageId: stage.id,
      success: false,
      output: combinedOutput,
      error: response.errorText,
      durationMs: Date.now() - stageStart,
    };
  }

  // Preserve child outputs so later stages can reference {outputs.<childId>}.
  parallelStages.forEach((child, index) => {
    outputs.set(child.id, extractTaskOutput(combinedOutput, index, parallelStages.length));
  });

  return {
    stageId: stage.id,
    success: true,
    output: combinedOutput,
    durationMs: Date.now() - stageStart,
  };
}

/**
 * Run an expand stage — dynamically expand a template into N parallel stages
 * based on items parsed from a source stage's output, then aggregate results.
 *
 * Flow:
 *   1. Get source stage output from outputs map
 *   2. Parse items (JSON, YAML, or markdown list)
 *   3. Build dynamic stages (one per item, with {item.*} resolved)
 *   4. Run all dynamic stages as parallel pi-subagents tasks
 *   5. Aggregate outputs into a single combined result
 *
 * NOTE: Gates on expand templates are NOT executed in v1. Quality checks
 * should use a separate parallel/review stage after the expand stage.
 */
/** @internal Exported for testing. See pipeline-expand.test.ts */
export async function runExpandStage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stage: Stage,
  task: string,
  outputs: Map<string, string>,
  signal?: AbortSignal,
): Promise<StageResult> {
  const stageStart = Date.now();
  const expand = stage.expand!;

  // 1. Get source stage output
  const sourceOutput = outputs.get(expand.from);
  if (!sourceOutput) {
    return {
      stageId: stage.id,
      success: false,
      output: "",
      error: `Expand source stage "${expand.from}" has no output. Stages before "${stage.id}": ${[...outputs.keys()].join(", ")}`,
      durationMs: Date.now() - stageStart,
    };
  }

  // 2. Parse items
  let items: StageItem[];
  try {
    items = parseItems(sourceOutput);
  } catch (err) {
    return {
      stageId: stage.id,
      success: false,
      output: "",
      error: `Failed to parse items from stage "${expand.from}": ${(err as Error).message}`,
      durationMs: Date.now() - stageStart,
    };
  }

  // 3. Limit items
  const maxItems = expand.maxItems ?? 10;
  const limitedItems = items.slice(0, maxItems);

  if (limitedItems.length === 0) {
    // No items to expand — not an error, just nothing to do
    if (ctx.hasUI) {
      ctx.ui.notify(`✦ Stage "${stage.id}": no items to expand`, "info");
    }
    return {
      stageId: stage.id,
      success: true,
      output: "(no items to expand)",
      durationMs: Date.now() - stageStart,
    };
  }

  // 4. Build dynamic stages
  const dynamicStages = buildExpandStages(stage, limitedItems, task, outputs);

  if (ctx.hasUI) {
    ctx.ui.notify(`✦ Stage "${stage.id}": expanding into ${dynamicStages.length} parallel tasks`, "info");
  }

  // 5. Run all dynamic stages as parallel subagent tasks
  // Each dynamic stage is a simple agent call (no gates in v1)
  const subagentTasks = dynamicStages.map((ds) => ({
    agent: ds.agent ?? "worker",
    task: ds.task ?? "",
    model: ds.model,
  }));

  try {
    const response = await executeSubagent(pi, {
      tasks: subagentTasks,
      clarify: false,
      agentScope: "both",
      cwd: ctx.cwd,
    }, signal);

    const combinedOutput = extractResponseText(response);

    if (response.isError) {
      return {
        stageId: stage.id,
        success: false,
        output: combinedOutput,
        error: response.errorText,
        durationMs: Date.now() - stageStart,
      };
    }

    // Aggregate — prefix each task's output with its stage ID
    const aggregated = dynamicStages.map((ds, i) => {
      // Extract each task's output from combined output
      // We split by known markers if available, or trust the raw combined output
      return `### ${ds.id}
${extractTaskOutput(combinedOutput, i, dynamicStages.length)}`;
    }).join("\n\n---\n\n");

    return {
      stageId: stage.id,
      success: true,
      output: aggregated,
      durationMs: Date.now() - stageStart,
    };
  } catch (err) {
    if ((err as Error).name === "AbortError" || signal?.aborted) {
      throw err;
    }
    return {
      stageId: stage.id,
      success: false,
      output: "",
      error: `Expand stage "${stage.id}" failed: ${(err as Error).message}`,
      durationMs: Date.now() - stageStart,
    };
  }
}

/**
 * Extract a single task's output from a combined parallel response.
 * When pi-subagents runs N tasks in parallel, the combined response
 * preserves each task's output sequentially. This function splits
 * by reasonable boundaries (double newlines) as a heuristic.
 */
/** @internal Exported for testing. See pipeline-expand.test.ts */
export function extractTaskOutput(
  combined: string,
  taskIndex: number,
  totalTasks: number,
): string {
  if (totalTasks <= 1) return combined.trim();

  // Split by double newlines as a heuristic for task boundaries
  const parts = combined.split(/\n{2,}/).filter(Boolean);

  if (parts.length >= totalTasks) {
    // Each part likely corresponds to one task
    return (parts[taskIndex] ?? "").trim();
  }

  // Fallback: give each task a proportional share
  const charsPerTask = Math.floor(combined.length / totalTasks);
  const start = taskIndex * charsPerTask;
  const end = taskIndex === totalTasks - 1 ? combined.length : start + charsPerTask;
  return combined.slice(start, end).trim();
}

/**
 * Run a review gate stage.
 *
 * Pattern:
 *   1. Worker executes the task
 *   2. N reviewers evaluate the result (parallel)
 *   3. Scores are averaged
 *   4. If avg >= targetScore → pass
 *   5. If avg < targetScore → worker receives feedback → repeat (max maxRounds)
 */
/** @internal Exported for testing. See pipeline-runner.test.ts */
export async function runReviewGate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stage: Stage,
  task: string,
  outputs: Map<string, string>,
  lastFeedback: string | undefined,
  signal?: AbortSignal,
): Promise<StageResult & { lastFeedback?: string }> {
  const stageStart = Date.now();
  const agentName = stage.agent!;
  const gate = stage.gate!;
  let currentFeedback = lastFeedback;
  let lastOutput = "";

  for (let round = 1; round <= gate.maxRounds; round++) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `🔄 Stage "${stage.id}": round ${round}/${gate.maxRounds}`,
        "info",
      );
    }

    // 1. Worker executes the task
    const resolvedTask = resolveTemplate(stage.task ?? "", task, outputs, currentFeedback);

    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");

    const workerResponse = await executeSubagent(pi, {
      agent: agentName,
      task: resolvedTask,
      clarify: false,
      model: stage.model,
      agentScope: "both",
      cwd: ctx.cwd,
    }, signal);

    if (workerResponse.isError) {
      throw new Error(
        `Worker round ${round} failed: ${workerResponse.errorText}`,
      );
    }

    lastOutput = extractResponseText(workerResponse);

    // 2. Run reviewers in parallel
    const reviewerTasks = gate.reviewers.map((reviewer) => ({
      agent: reviewer.agent ?? "reviewer",
      task: buildReviewerTask(reviewer.focus, lastOutput, stage.id),
      model: gate.judgeModel ?? stage.model,
    }));

    const reviewsResponse = await executeSubagent(pi, {
      tasks: reviewerTasks,
      clarify: false,
      agentScope: "both",
      cwd: ctx.cwd,
    }, signal);

    // 3. Parse review outputs to extract scores
    const rawReviewOutput = extractResponseText(reviewsResponse);
    const reviews = parseReviewOutputs(rawReviewOutput, reviewerTasks.length);

    const scores = reviews.map((r) => r.score);
    const average = scores.reduce((a, b) => a + b, 0) / scores.length;
    const allFeedback = reviews.map((r) => r.feedback).filter(Boolean).join("\n\n");

    if (ctx.hasUI) {
      ctx.ui.notify(
        `📊 Stage "${stage.id}" round ${round}: scores [${scores.join(", ")}] avg=${average.toFixed(1)} target=${gate.targetScore}`,
        average >= gate.targetScore ? "info" : "warning",
      );
    }

    // 4. Check if passed
    if (average >= gate.targetScore) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `✅ Stage "${stage.id}" passed gate (${average.toFixed(1)}≥${gate.targetScore})`,
          "info",
        );
      }

      const reviewSummary = reviews.map(
        (r, i) => `### Reviewer ${i + 1}\n- Score: ${r.score}/10\n- ${r.feedback.slice(0, 500)}`,
      ).join("\n\n");

      const finalOutput = `${lastOutput}\n\n---\n\n## Gate Review Passed (Round ${round})\n\n${reviewSummary}`;

      return {
        stageId: stage.id,
        success: true,
        output: finalOutput,
        rounds: round,
        scores,
        durationMs: Date.now() - stageStart,
      };
    }

    // 5. Not passed — prepare feedback for next round
    if (ctx.hasUI) {
      ctx.ui.notify(
        `⚠ Stage "${stage.id}" round ${round}: score ${average.toFixed(1)} < ${gate.targetScore}, retrying...`,
        "warning",
      );
    }

    currentFeedback = [
      `## Reviewer Feedback (Round ${round})`,
      "",
      `Average Score: ${average.toFixed(1)}/${gate.targetScore}`,
      "",
      "Issues to fix:",
      allFeedback,
      "",
      "Please address ALL of the above issues in your next attempt.",
    ].join("\n");
  }

  // Exhausted max rounds — gate failed
  return {
    stageId: stage.id,
    success: false,
    output: lastOutput,
    error: `Failed to pass review gate after ${gate.maxRounds} rounds. Scores: [${gate.reviewers.map(() => 0).join(", ")}]`,
    rounds: gate.maxRounds,
    scores: [],
    durationMs: Date.now() - stageStart,
    lastFeedback: currentFeedback,
  };
}

/**
 * Build a reviewer prompt that includes the work product and asks for a score.
 */
/** @internal Exported for testing. See pipeline-runner.test.ts */
export function buildReviewerTask(focus: string, output: string, stageId: string): string {
  return `You are a reviewer for stage "${stageId}" of a multi-agent pipeline.

## Review Focus
${focus}

## Work Product to Review

${output}

## Instructions
1. Analyze the work product critically against the review focus.
2. Write your detailed review analysis.
3. On the VERY LAST LINE of your response, output exactly:

SCORE: <number between 0 and 10>

Where 10 = perfect, 8+ = acceptable, 5+ = needs improvement, <5 = unacceptable.
Be honest and critical. Do NOT inflate scores.`;
}

/**
 * Parse review outputs to extract scores and feedback.
 * Handles the case where all reviewers come back in one combined response.
 */
/** @internal Exported for testing. See pipeline-runner.test.ts */
export function parseReviewOutputs(
  rawOutput: string,
  expectedCount: number,
): Array<{ score: number; feedback: string }> {
  // Try to split by reviewer sections
  const sections = rawOutput.split(/(?=SCORE:\s*\d+(?:\.\d+)?)/i).filter(Boolean);

  // Collect sections that actually contain a SCORE line (skip preamble text)
  const scoredSections = sections.filter((s) => /SCORE:\s*\d+(?:\.\d+)?/i.test(s));

  if (scoredSections.length >= expectedCount) {
    return scoredSections.slice(0, expectedCount).map((section) => {
      const scoreMatch = section.match(/SCORE:\s*(\d+(?:\.\d+)?)/i);
      const score = scoreMatch ? Math.max(0, Math.min(10, parseFloat(scoreMatch[1]!))) : 5;
      const feedback = section.replace(/SCORE:\s*\d+(?:\.\d+)?/i, "").trim();
      return { score, feedback: feedback || "(no feedback)" };
    });
  }

  // Fallback: try to find all SCORE lines in the combined output
  const allScoreLines = [...rawOutput.matchAll(/SCORE:\s*(\d+(?:\.\d+)?)/gi)];
  if (allScoreLines.length >= expectedCount) {
    return allScoreLines.slice(0, expectedCount).map((match, i) => {
      const score = Math.max(0, Math.min(10, parseFloat(match[1]!)));
      return { score, feedback: `Reviewer ${i + 1}` };
    });
  }

  // Last resort: treat entire output as one reviewer's response
  const lastScoreLine = [...rawOutput.matchAll(/SCORE:\s*(\d+(?:\.\d+)?)/gi)].pop();
  const score = lastScoreLine ? Math.max(0, Math.min(10, parseFloat(lastScoreLine[1]!))) : 0;
  const feedback = rawOutput.replace(/SCORE:\s*\d+(?:\.\d+)?/gi, "").trim();

  // Replicate for expected count
  return Array.from({ length: expectedCount }, (_, i) => ({
    score,
    feedback: i === 0 ? feedback || "(no feedback)" : "(combined response)",
  }));
}

/**
 * A single item from source stage output, used for dynamic stage expansion.
 * Each key becomes available as {item.key} in the template.
 */
export interface StageItem {
  [key: string]: unknown;
}

/**
 * Parse a source stage's output into an array of items for dynamic expansion.
 *
 * Strategy:
 *   1. Try JSON — expects an array of objects, or an object with "items" key
 *   2. Try YAML — expects a sequence
 *   3. Fallback — parse as markdown list (-, *, or 1.)
 *
 * Throws if the output cannot be parsed into items.
 */
/** @internal Exported for testing. See pipeline-expand.test.ts */
export function parseItems(output: string): StageItem[] {
  if (!output.trim()) return [];

  // Strategy 1: JSON
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed.map((item: unknown) =>
        typeof item === "string" ? { value: item } :
        typeof item === "object" && item !== null ? item as StageItem :
        { value: String(item) },
      );
    }
    if (typeof parsed === "object" && parsed !== null) {
      const items = (parsed as Record<string, unknown>).items;
      if (Array.isArray(items)) {
        return items.map((item: unknown) =>
          typeof item === "string" ? { value: item } :
          typeof item === "object" && item !== null ? item as StageItem :
          { value: String(item) },
        );
      }
    }
  } catch {
    // Not JSON, continue to next strategy
  }

  // Strategy 2: YAML list
  try {
    const parsed = yaml.load(output);
    if (Array.isArray(parsed)) {
      return parsed.map((item: unknown) =>
        typeof item === "string" ? { value: item } :
        typeof item === "object" && item !== null ? item as StageItem :
        { value: String(item) },
      );
    }
  } catch {
    // Not YAML, continue to fallback
  }

  // Strategy 3: markdown list fallback
  const lines = output.split("\n")
    .map((l) => l.trim())
    .filter((l) =>
      l.startsWith("- ") ||
      l.startsWith("* ") ||
      /^\d+[.)]\s/.test(l),
    )
    .map((l) => l.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, ""));

  if (lines.length > 0) {
    return lines.map((value) => ({ value }));
  }

  throw new Error(
    "Cannot parse items from output. Expected JSON array, YAML list, or markdown list.",
  );
}

/**
 * Resolve {item.key} and {item} variables in an already-resolved task template.
 *
 * For string-valued items (from markdown fallback), {item} resolves to the
 * value directly. For object items, {item} resolves to JSON.stringify.
 */
/** @internal Exported for testing. See pipeline-expand.test.ts */
export function expandItemTemplate(
  template: string,
  item: StageItem,
): string {
  let result = template;

  // Replace {item.key} with the specific value
  // Object.entries skips Symbol keys; String(value ?? "") handles null/undefined safely
  for (const [key, value] of Object.entries(item)) {
    const placeholder = `{item.${key}}`;
    if (value === null || value === undefined) {
      result = result.split(placeholder).join("");
    } else {
      result = result.split(placeholder).join(String(value));
    }
  }

  // Replace {item} with the full item representation
  // For string items ({ value: "..." }), use value directly
  if (Object.keys(item).length === 1 && "value" in item) {
    result = result.split("{item}").join(String(item.value ?? ""));
  } else {
    result = result.split("{item}").join(JSON.stringify(item));
  }

  return result;
}

/**
 * Build dynamic stages from a template stage and parsed items.
 *
 * Each dynamic stage gets:
 *   - id: "{template.id}-{i+1}"
 *   - The same agent, model, gate, etc. as the template
 *   - Template resolved with item variables
 *
 * NOTE: Gates are propagated on the Stage type for schema compatibility
 * but are NOT executed by the runner in v1 (see runPipeline).
 *
 * @param template — the expand stage template from YAML
 * @param items — parsed items from the source stage
 * @param task — original user task
 * @param outputs — outputs from all previous stages (for {outputs.*} resolution)
 */
/** @internal Exported for testing. See pipeline-expand.test.ts */
export function buildExpandStages(
  template: Stage,
  items: StageItem[],
  task: string,
  outputs: Map<string, string>,
): Stage[] {
  if (items.length === 0) return [];

  // First resolve {task}, {outputs.*}, {lastFeedback} — same for all items
  const baseTask = resolveTemplate(template.task ?? "", task, outputs, undefined);

  return items.map((item, i) => {
    const resolvedTask = expandItemTemplate(baseTask, item);
    return {
      id: `${template.id}-${i + 1}`,
      agent: template.agent,
      task: resolvedTask,
      model: template.model,
      gate: template.gate,
      output: template.output,
      reads: template.reads,
      maxSubagentDepth: template.maxSubagentDepth,
    };
  });
}

/**
 * Resolve template variables in a task string.
 *
 * Supported:
 *   {task}          — original user task
 *   {outputs.<id>}  — output from a previous stage
 *   {lastFeedback}  — last review feedback (inside gate retries)
 */
/** @internal Exported for testing. See pipeline-runner.test.ts */
export function resolveTemplate(
  template: string,
  task: string,
  outputs: Map<string, string>,
  lastFeedback: string | undefined,
): string {
  let result = template.replace(/\{task\}/g, task);

  result = result.replace(/\{outputs\.(\w+)\}/g, (_, stageId: string) => {
    return outputs.get(stageId) ?? `[No output from stage "${stageId}"]`;
  });

  if (lastFeedback !== undefined) {
    result = result.replace(/\{lastFeedback\}/g, lastFeedback);
  }

  return result;
}

/**
 * Format a pipeline result as a readable summary string.
 */
export function formatPipelineResult(result: PipelineResult): string {
  const lines: string[] = [];

  // --- Pipeline header ---
  lines.push(`# ${result.success ? "✅" : "❌"} Pipeline: ${result.pipelineName}`);
  lines.push(`Task: ${result.task}`);
  lines.push(`Status: ${result.success ? "✅ PASSED" : "❌ FAILED"}  ·  ${result.stages.filter((s) => s.success).length}/${result.stages.length} stages passed  ·  ${formatDuration(result.totalDurationMs)}`);
  lines.push("");

  // --- Synthesis report (prominently at the top) ---
  if (result.synthesis) {
    lines.push("> 📋 **Pipeline Report**");
    lines.push(">");
    // Indent each line of the synthesis as a blockquote
    for (const synLine of result.synthesis.trim().split("\n")) {
      lines.push(`> ${synLine}`);
    }
    lines.push("");
  }

  if (result.synthesisError) {
    lines.push(`> ⚠️ *Report synthesis note: ${result.synthesisError}*`);
    lines.push("");
  }

  // --- Stage details ---
  lines.push("## Stages");
  lines.push("");

  for (const stage of result.stages) {
    const icon = stage.success ? "✅" : "❌";
    const rounds = stage.rounds ? ` (${stage.rounds} round${stage.rounds > 1 ? "s" : ""})` : "";
    const scores = stage.scores?.length ? ` scores=[${stage.scores.join(", ")}]` : "";
    lines.push(`### ${icon} ${stage.stageId}${rounds}${scores}`);
    lines.push(`Duration: ${formatDuration(stage.durationMs)}`);
    if (stage.error) {
      lines.push(`Error: ${stage.error}`);
    }
    if (stage.output) {
      lines.push(`Output:\n${stage.output}`);
    }
    lines.push("");
  }

  if (result.error && result.stages.every((s) => !s.error)) {
    lines.push(`---\n**Fatal:** ${result.error}`);
  }

  return lines.join("\n");
}

/**
 * Build a structured context message for LLM injection.
 * Used after pipeline completion to give the agent a clear picture
 * with stage excerpts, synthesis, and an instruction to write a narrative summary.
 */
export function buildPipelineContextMessage(result: PipelineResult): string {
  const lines: string[] = [];

  lines.push(`## \u2705 Pipeline Result: ${result.pipelineName}`);
  lines.push("");
  const icon = result.success ? "\u2705" : "\u274C";
  lines.push(`**Status:** ${icon} ${result.success ? "PASSED" : "FAILED"}  \u00B7  ${result.stages.filter((s) => s.success).length}/${result.stages.length} stages passed  \u00B7  ${formatDuration(result.totalDurationMs)}`);
  if (result.task) lines.push(`**Task:** ${result.task}`);
  lines.push("");

  // Stage results table
  lines.push("### Stage Results");
  lines.push("");
  lines.push("| Stage | Agent | Result | Duration |");
  lines.push("|-------|-------|--------|----------|");
  for (const stage of result.stages) {
    const stageIcon = stage.success ? "\u2705" : "\u274C";
    const duration = formatDuration(stage.durationMs);
    lines.push(`| ${stage.stageId} | ${stage.stageId.includes("review") ? "reviewer" : stage.stageId.includes("stability") ? "worker" : "agent"} | ${stageIcon} ${stage.success ? "Pass" : "Fail"}${stage.rounds ? ` (${stage.rounds}r)` : ""}${stage.scores?.length ? ` [${stage.scores.join(", ")}]` : ""} | ${duration} |`);
  }
  lines.push("");

  // Stage output highlights (truncated)
  lines.push("### Stage Output Highlights");
  lines.push("");
  for (const stage of result.stages) {
    lines.push(`**${stage.stageId}**`);
    if (stage.error) {
      lines.push("```");
      lines.push(`Error: ${stage.error}`);
      lines.push("```");
    }
    if (stage.output) {
      const truncated = stage.output.length > 500
        ? "..." + stage.output.slice(-500)
        : stage.output;
      lines.push("```");
      lines.push(truncated);
      lines.push("```");
    }
    lines.push("");
  }

  // Pipeline synthesis
  if (result.synthesis) {
    lines.push("### Pipeline Synthesis");
    lines.push("> \uD83D\uDCCB " + result.pipelineName + " synthesis");
    lines.push(">");
    for (const synLine of result.synthesis.trim().split("\n")) {
      lines.push(`> ${synLine}`);
    }
    lines.push("");
  }
  if (result.synthesisError) {
    lines.push(`> \u26A0\uFE0F *Synthesis note: ${result.synthesisError}*`);
    lines.push("");
  }

  // Instruction for the LLM
  lines.push("---");
  lines.push("");
  lines.push("**Instructions for the Agent:**");
  lines.push("");
  lines.push("Please analyze the pipeline results above and provide a narrative summary. Cover:");
  lines.push("");
  lines.push("1. **Overall outcome** \u2014 did the pipeline pass or fail? What does this mean?");
  lines.push("2. **Stage breakdown** \u2014 which stages succeeded, which failed, and their key findings");
  lines.push("3. **Key issues** \u2014 blocking issues, review scores, recommendations from each stage");
  lines.push("4. **Synthesis** \u2014 the pipeline\u2019s own assessment (if available)");
  lines.push("5. **Next steps** \u2014 what should be done next based on the results");
  lines.push("");
  lines.push("Write your summary in the same language as this conversation. Be concise but informative.");
  lines.push("");
  lines.push("If all stages passed, state that clearly. If any failed, explain what failed and why.");

  return lines.join("\n");
}

/** @internal Exported for testing. See pipeline-runner.test.ts */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(0);
  return `${min}m ${sec}s`;
}

/** @internal Exported for testing. See pipeline-runner.test.ts */
export function failResult(
  pipelineName: string,
  task: string,
  error: string,
  startTime: number,
): PipelineResult {
  return {
    pipelineName,
    task,
    success: false,
    stages: [],
    totalDurationMs: Date.now() - startTime,
    error,
  };
}
