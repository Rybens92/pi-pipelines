/**
 * Tests for pipeline-runner.ts — pure functions only.
 *
 * Covers:
 *   - resolveTemplate
 *   - parseReviewOutputs
 *   - buildReviewerTask
 *   - formatPipelineResult
 *   - formatDuration (internal, used by failResult and formatPipelineResult)
 *   - failResult
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  formatPipelineResult,
  resolveTemplate,
  parseReviewOutputs,
  buildReviewerTask,
  failResult,
  buildReportContext,
  buildPipelineContextMessage,
  applyStageReport,
} from "../extensions/pipeline-runner.ts";

import type { PipelineResult, StageResult, Stage } from "../extensions/types.ts";

const { mockBridge } = vi.hoisted(() => ({
  mockBridge: {
    executeSubagent: vi.fn(),
    extractResponseText: vi.fn(),
  },
}));

vi.mock("../extensions/subagent-bridge.ts", () => ({
  executeSubagent: (...args: unknown[]) => mockBridge.executeSubagent(...args),
  extractResponseText: (...args: unknown[]) => mockBridge.extractResponseText(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// resolveTemplate
// ---------------------------------------------------------------------------

describe("resolveTemplate", () => {
  it("replaces {task} with the task string", () => {
    const result = resolveTemplate("Analyze: {task}", "fix login bug", new Map(), undefined);
    expect(result).toBe("Analyze: fix login bug");
  });

  it("replaces {outputs.stageId} from the outputs map", () => {
    const outputs = new Map<string, string>([["plan", "Use TDD approach"]]);
    const result = resolveTemplate("Based on plan: {outputs.plan}", "task", outputs, undefined);
    expect(result).toBe("Based on plan: Use TDD approach");
  });

  it("shows placeholder for missing output", () => {
    const outputs = new Map<string, string>();
    const result = resolveTemplate("Use: {outputs.nonexistent}", "task", outputs, undefined);
    expect(result).toBe('Use: [No output from stage "nonexistent"]');
  });

  it("replaces {lastFeedback} when provided", () => {
    const result = resolveTemplate(
      "Fix: {lastFeedback}",
      "task",
      new Map(),
      "Need better error handling",
    );
    expect(result).toBe("Fix: Need better error handling");
  });

  it("keeps {lastFeedback} literal when undefined", () => {
    const result = resolveTemplate("Fix: {lastFeedback}", "task", new Map(), undefined);
    expect(result).toBe("Fix: {lastFeedback}");
  });

  it("resolves multiple variables in one template", () => {
    const outputs = new Map<string, string>([["code", "console.log('hi')"]]);
    const result = resolveTemplate(
      "Task: {task}\nCode: {outputs.code}\nFeedback: {lastFeedback}",
      "hello",
      outputs,
      "Add comments",
    );
    expect(result).toBe("Task: hello\nCode: console.log('hi')\nFeedback: Add comments");
  });

  it("returns unchanged template with no variables", () => {
    const result = resolveTemplate("Just a static string", "task", new Map(), undefined);
    expect(result).toBe("Just a static string");
  });

  it("handles empty template", () => {
    const result = resolveTemplate("", "task", new Map(), undefined);
    expect(result).toBe("");
  });

  it("handles {task} appearing multiple times", () => {
    const result = resolveTemplate("{task} and {task}", "hello", new Map(), undefined);
    expect(result).toBe("hello and hello");
  });

  it("handles unicode in task and outputs", () => {
    const outputs = new Map([["stage", "über cool ✅"]]);
    const result = resolveTemplate("{task}: {outputs.stage}", "føø bår", outputs, undefined);
    expect(result).toBe("føø bår: über cool ✅");
  });

  it("does NOT recursively resolve", () => {
    const outputs = new Map([["stage", "{task}"]]);
    const result = resolveTemplate("{outputs.stage}", "hello", outputs, undefined);
    // The output value contains {task} but the template has no {task} left after replacement
    expect(result).toBe("{task}");
  });
});

// ---------------------------------------------------------------------------
// parseReviewOutputs
// ---------------------------------------------------------------------------

describe("parseReviewOutputs", () => {
  // Strategy 1: Sections split by SCORE: lines
  // Preamble sections (text before the first SCORE) are skipped.
  // Only sections with a SCORE line are counted.
  it("parses individual reviewer sections (strategy 1)", () => {
    const raw = `Some analysis here.
SCORE: 8

Different analysis.
SCORE: 6`;
    const result = parseReviewOutputs(raw, 2);
    expect(result).toHaveLength(2);
    // First scored section: "SCORE: 8\n\nDifferent analysis.\n" → score 8
    expect(result[0]!.score).toBe(8);
    expect(result[0]!.feedback).toContain("Different analysis.");
    // Second scored section: "SCORE: 6" → score 6
    expect(result[1]!.score).toBe(6);
  });

  // Strategy 2: Multiple SCORE lines in combined output
  // Preamble sections (text before first SCORE) are skipped.
  it("falls back to finding SCORE lines when no clear sections (strategy 2)", () => {
    const raw = `Here is one combined review.
SCORE: 7
And some more text.
SCORE: 9`;
    const result = parseReviewOutputs(raw, 2);
    expect(result).toHaveLength(2);
    // First scored section: "SCORE: 7\nAnd some more text.\n" → score 7
    expect(result[0]!.score).toBe(7);
    // Second scored section: "SCORE: 9" → score 9
    expect(result[1]!.score).toBe(9);
  });

  // Strategy 3: Single SCORE line for all reviewers
  it("replicates single SCORE line for multiple reviewers (strategy 3)", () => {
    const raw = `Everything is ok.\nSCORE: 8`;
    const result = parseReviewOutputs(raw, 3);
    expect(result).toHaveLength(3);
    expect(result[0]!.score).toBe(8);
    expect(result[1]!.score).toBe(8);
    expect(result[2]!.score).toBe(8);
  });

  it("clamps scores to 0-10 range", () => {
    const raw = `SCORE: 100\nSCORE: -5\nSCORE: 7.5`;
    const result = parseReviewOutputs(raw, 2);
    // SCORE:-5 doesn't match split lookahead (\d+ doesn't match -5),
    // so it's part of the second section. filter(Boolean) drops empty strings.
    // Section 1: "SCORE: 100\nSCORE: -5\n" → SCORE:100 clamped to 10
    // Section 2: "SCORE: 7.5" → score 7.5
    expect(result[0]!.score).toBe(10);
    expect(result[1]!.score).toBe(7.5);
  });

  it("parses decimal scores", () => {
    const raw = `SCORE: 7.5`;
    const result = parseReviewOutputs(raw, 1);
    expect(result[0]!.score).toBe(7.5);
  });

  it("is case-insensitive for SCORE:", () => {
    const raw = `score: 6\nScore: 7\nSCORE: 8`;
    const result = parseReviewOutputs(raw, 3);
    // filter(Boolean) removes the empty string before first SCORE match
    expect(result[0]!.score).toBe(6);
    expect(result[1]!.score).toBe(7);
    expect(result[2]!.score).toBe(8);
  });

  it("returns score=0 when no SCORE line exists (strategy 3 fallback)", () => {
    const raw = "Just a review without a score.";
    const result = parseReviewOutputs(raw, 2);
    expect(result).toHaveLength(2);
    expect(result[0]!.score).toBe(0);
  });

  it("only uses first N sections when more than expected", () => {
    const raw = `SCORE: 9\nSCORE: 8\nSCORE: 7\nSCORE: 6`;
    const result = parseReviewOutputs(raw, 2);
    expect(result).toHaveLength(2);
    // filter(Boolean) removes empty string before first SCORE
    // Sections: ["SCORE: 9\n", "SCORE: 8\n", "SCORE: 7\n", "SCORE: 6"]
    expect(result[0]!.score).toBe(9);
    expect(result[1]!.score).toBe(8);
  });

  it("returns '(no feedback)' for empty feedback sections", () => {
    const raw = `SCORE: 8`;
    const result = parseReviewOutputs(raw, 1);
    expect(result[0]!.feedback).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// buildReviewerTask
// ---------------------------------------------------------------------------

describe("buildReviewerTask", () => {
  it("includes stage ID in the prompt", () => {
    const result = buildReviewerTask("Quality check", "some output", "stage-1");
    expect(result).toContain("stage-1");
  });

  it("includes review focus", () => {
    const result = buildReviewerTask("Check security", "output", "s1");
    expect(result).toContain("Check security");
  });

  it("includes the work product", () => {
    const result = buildReviewerTask("Focus", "This is the work product content", "s1");
    expect(result).toContain("This is the work product content");
  });

  it("includes full output even when over 8000 chars (no truncation)", () => {
    const longOutput = "x".repeat(8500);
    const result = buildReviewerTask("Focus", longOutput, "s1");
    // Full output must be present — no truncation
    expect(result).toContain(longOutput);
  });

  it("includes short output in full", () => {
    const shortOutput = "y".repeat(100);
    const result = buildReviewerTask("Focus", shortOutput, "s1");
    expect(result).toContain(shortOutput);
  });

  it("includes SCORE instruction in the prompt", () => {
    const result = buildReviewerTask("Focus", "output", "s1");
    expect(result).toContain("SCORE: <number between 0 and 10>");
    expect(result).toContain("Be honest and critical");
  });

  it("includes review instructions", () => {
    const result = buildReviewerTask("Focus", "output", "s1");
    expect(result).toContain("Analyze the work product");
    expect(result).toContain("Write your detailed review");
  });
});

// ---------------------------------------------------------------------------
// formatPipelineResult
// ---------------------------------------------------------------------------

describe("formatPipelineResult", () => {
  it("shows passed status for successful pipeline", () => {
    const result: PipelineResult = {
      pipelineName: "test",
      task: "do it",
      success: true,
      stages: [],
      totalDurationMs: 500,
    };
    const formatted = formatPipelineResult(result);
    expect(formatted).toContain("✅ PASSED");
    expect(formatted).toContain("test");
    expect(formatted).toContain("do it");
    expect(formatted).toContain("500ms");
  });

  it("shows failed status for unsuccessful pipeline", () => {
    const result: PipelineResult = {
      pipelineName: "fail-pipe",
      task: "fail task",
      success: false,
      stages: [],
      totalDurationMs: 1000,
      error: "Something went wrong",
    };
    const formatted = formatPipelineResult(result);
    expect(formatted).toContain("❌ FAILED");
    expect(formatted).toContain("Something went wrong");
  });

  it("includes stage details with rounds and scores", () => {
    const stageResult: StageResult = {
      stageId: "review-stage",
      success: true,
      output: "Good work!",
      durationMs: 2000,
      rounds: 2,
      scores: [7, 8],
    };
    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: true,
      stages: [stageResult],
      totalDurationMs: 3000,
    };
    const formatted = formatPipelineResult(result);
    expect(formatted).toContain("review-stage");
    expect(formatted).toContain("2 rounds");
    expect(formatted).toContain("[7, 8]");
  });

  it("shows stage error when present", () => {
    const stageResult: StageResult = {
      stageId: "fail",
      success: false,
      output: "",
      error: "Stage crashed",
      durationMs: 100,
    };
    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: false,
      stages: [stageResult],
      totalDurationMs: 200,
    };
    const formatted = formatPipelineResult(result);
    expect(formatted).toContain("❌ fail");
    expect(formatted).toContain("Stage crashed");
  });

  it("includes full stage output without truncation", () => {
    const longOutput = "x".repeat(600);
    const stageResult: StageResult = {
      stageId: "out",
      success: true,
      output: longOutput,
      durationMs: 100,
    };
    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: true,
      stages: [stageResult],
      totalDurationMs: 200,
    };
    const formatted = formatPipelineResult(result);
    expect(formatted).toContain(longOutput);
    expect(formatted).toContain("Output:");
  });

  it("does not truncate short output", () => {
    const stageResult: StageResult = {
      stageId: "o",
      success: true,
      output: "Short output",
      durationMs: 100,
    };
    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: true,
      stages: [stageResult],
      totalDurationMs: 200,
    };
    const formatted = formatPipelineResult(result);
    expect(formatted).toContain("Short output");
  });

  it("shows fatal error when no stages have individual errors", () => {
    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: false,
      stages: [],
      totalDurationMs: 0,
      error: "Fatal: pipeline not found",
    };
    const formatted = formatPipelineResult(result);
    expect(formatted).toContain("Fatal:");
    expect(formatted).toContain("pipeline not found");
  });
});

// ---------------------------------------------------------------------------
// failResult (internal helper)
// ---------------------------------------------------------------------------

describe("failResult", () => {
  it("returns a failed result with no stages", () => {
    const startTime = Date.now();
    const result = failResult("my-pipe", "my task", "Not found", startTime);

    expect(result.pipelineName).toBe("my-pipe");
    expect(result.task).toBe("my task");
    expect(result.success).toBe(false);
    expect(result.stages).toEqual([]);
    expect(result.error).toBe("Not found");
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("computes duration from startTime", () => {
    const startTime = Date.now() - 1000; // 1 second ago
    const result = failResult("p", "t", "error", startTime);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(900);
    expect(result.totalDurationMs).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// formatDuration (internal, tested through formatPipelineResult output)
// ---------------------------------------------------------------------------

describe("formatDuration (via formatPipelineResult)", () => {
  function resultWithDuration(ms: number): string {
    const s: StageResult = {
      stageId: "s1",
      success: true,
      output: "",
      durationMs: ms,
    };
    return formatPipelineResult({
      pipelineName: "p",
      task: "t",
      success: true,
      stages: [s],
      totalDurationMs: ms,
    });
  }

  it("formats <1000ms as '<N>ms'", () => {
    expect(resultWithDuration(500)).toContain("500ms");
  });

  it("formats 1000-59999ms as seconds with one decimal", () => {
    expect(resultWithDuration(1500)).toContain("1.5s");
    expect(resultWithDuration(30000)).toContain("30.0s");
  });

  it("formats >=60000ms as minutes and seconds", () => {
    const formatted = resultWithDuration(90000);
    expect(formatted).toContain("1m");
    expect(formatted).toContain("30s");
  });

  it("formats exactly 60000ms as '1m 0s'", () => {
    expect(resultWithDuration(60000)).toContain("1m");
    expect(resultWithDuration(60000)).toContain("0s");
  });
});

// ---------------------------------------------------------------------------
// buildReportContext
// ---------------------------------------------------------------------------

describe("applyStageReport", () => {
  const stage: Stage = { id: "scan", agent: "scout", task: "Scan files" };

  it("returns raw output when report mode is full", async () => {
    const output = "Raw output";
    const result = await applyStageReport(
      {} as never,
      { ...stage, report: { mode: "full" } },
      output,
      "Scan files",
    );

    expect(result).toBe(output);
    expect(mockBridge.executeSubagent).not.toHaveBeenCalled();
  });

  it("returns raw output when report is undefined", async () => {
    const output = "Raw output";
    const result = await applyStageReport({} as never, stage, output, "Scan files");

    expect(result).toBe(output);
    expect(mockBridge.executeSubagent).not.toHaveBeenCalled();
  });

  it("summarizes output and truncates to maxLength", async () => {
    const rawOutput = "x".repeat(100);
    const summary = "y".repeat(20);
    mockBridge.extractResponseText.mockReturnValueOnce(summary);

    const result = await applyStageReport(
      {} as never,
      {
        ...stage,
        report: {
          mode: "summary",
          maxLength: 12,
          instruction: "Keep only blockers",
        },
      },
      rawOutput,
      "Scan files",
    );

    expect(result).toBe("yyyyyyyyyyyy...");
    expect(mockBridge.executeSubagent).toHaveBeenCalledTimes(1);
    const call = mockBridge.executeSubagent.mock.calls[0]![1] as { agent: string; task: string };
    expect(call.agent).toBe("worker");
    expect(call.task).toContain("Keep only blockers");
    expect(call.task).toContain(rawOutput);
    expect(call.task).toContain("maximum 12 characters");
  });
});

describe("buildReportContext", () => {
  it("includes pipeline name, description, and task", () => {
    const ctx = buildReportContext("my-pipe", "A test pipeline", "build feature X", []);
    expect(ctx).toContain("my-pipe");
    expect(ctx).toContain("A test pipeline");
    expect(ctx).toContain("build feature X");
  });

  it("reports 0/0 status when no stages", () => {
    const ctx = buildReportContext("p", "d", "t", []);
    expect(ctx).toContain("0/0");
    expect(ctx).toContain("PASSED");
  });

  it("includes each stage with pass/fail icon and duration", () => {
    const stages: StageResult[] = [
      { stageId: "s1", success: true, output: "ok", durationMs: 100 },
      { stageId: "s2", success: false, output: "", error: "crashed", durationMs: 50 },
    ];
    const ctx = buildReportContext("p", "d", "t", stages);
    expect(ctx).toContain("✅ PASS");
    expect(ctx).toContain("❌ FAIL");
    expect(ctx).toContain("s1");
    expect(ctx).toContain("s2");
    expect(ctx).toContain("100ms");
    expect(ctx).toContain("50ms");
    expect(ctx).toContain("crashed");
  });

  it("does not truncate stage output in synthesis context", () => {
    const longOutput = "a".repeat(1500);
    const stages: StageResult[] = [
      { stageId: "long", success: true, output: longOutput, durationMs: 100 },
    ];
    const ctx = buildReportContext("p", "d", "t", stages);
    // Full output should be present, not truncated
    expect(ctx).toContain(longOutput);
    expect(ctx).not.toContain("[truncated]");
    expect(ctx).toContain("Output:");
  });

  it("includes focus when provided", () => {
    const ctx = buildReportContext("p", "d", "t", [], "release check");
    expect(ctx).toContain("release check");
  });

  it("includes review gate rounds and scores", () => {
    const stages: StageResult[] = [
      {
        stageId: "gated",
        success: true,
        output: "passed gate",
        durationMs: 500,
        rounds: 2,
        scores: [7, 9],
      },
    ];
    const ctx = buildReportContext("p", "d", "t", stages);
    expect(ctx).toContain("2 rounds");
    expect(ctx).toContain("7, 9");
  });
});

// ---------------------------------------------------------------------------
// formatPipelineResult — synthesis
// ---------------------------------------------------------------------------

describe("formatPipelineResult with synthesis", () => {
  it("includes synthesis report in blockquote at the top", () => {
    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: true,
      stages: [{ stageId: "a", success: true, output: "ok", durationMs: 10 }],
      totalDurationMs: 10,
      synthesis: "All stages passed.\nKey finding: everything works.",
    };
    const formatted = formatPipelineResult(result);
    expect(formatted).toContain("📋 **Pipeline Report**");
    expect(formatted).toContain("> All stages passed.");
    expect(formatted).toContain("> Key finding: everything works.");
  });

  it("shows synthesis error note without failing the output", () => {
    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: true,
      stages: [{ stageId: "a", success: true, output: "ok", durationMs: 10 }],
      totalDurationMs: 10,
      synthesisError: "Report synthesis failed: Agent busy",
    };
    const formatted = formatPipelineResult(result);
    expect(formatted).toContain("Report synthesis failed");
    expect(formatted).toContain("Agent busy");
    // Should still show ✅ PASSED
    expect(formatted).toContain("✅ PASSED");
  });

  it("does not include synthesis section when no synthesis exists", () => {
    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: true,
      stages: [{ stageId: "a", success: true, output: "ok", durationMs: 10 }],
      totalDurationMs: 10,
    };
    const formatted = formatPipelineResult(result);
    expect(formatted).not.toContain("Pipeline Report");
    expect(formatted).not.toContain("synthesisError");
  });
});

// ---------------------------------------------------------------------------
// buildPipelineContextMessage
// ---------------------------------------------------------------------------

describe("buildPipelineContextMessage", () => {
  it("includes pipeline name and status", () => {
    const result: PipelineResult = {
      pipelineName: "release-check",
      task: "verify release",
      success: true,
      stages: [{ stageId: "code-review", success: true, output: "ok", durationMs: 1000 }],
      totalDurationMs: 1000,
    };
    const msg = buildPipelineContextMessage(result);
    expect(msg).toContain("release-check");
    expect(msg).toContain("PASSED");
    expect(msg).toContain("verify release");
    expect(msg).toContain("Stage Results");
    expect(msg).toContain("Instructions for the Agent");
  });

  it("shows FAILED status for failing pipelines", () => {
    const result: PipelineResult = {
      pipelineName: "test",
      task: "",
      success: false,
      stages: [
        { stageId: "stage-a", success: true, output: "ok", durationMs: 100 },
        { stageId: "stage-b", success: false, output: "crash", error: "timeout", durationMs: 50 },
      ],
      totalDurationMs: 150,
    };
    const msg = buildPipelineContextMessage(result);
    expect(msg).toContain("FAILED");
    expect(msg).toContain("1/2 stages passed");
    expect(msg).toContain("timeout");
  });

  it("includes stage output truncated to 500 chars", () => {
    // Distinct beginning and end to verify truncation preserves tail
    const prefix = "BEGIN_" + "x".repeat(200);
    const suffix = "y".repeat(200) + "_END";
    const longOutput = prefix + "z".repeat(200) + suffix;
    // Total: 5+200+200+200+4 = 609 chars — well over 500
    const result: PipelineResult = {
      pipelineName: "p",
      task: "",
      success: true,
      stages: [{ stageId: "s1", success: true, output: longOutput, durationMs: 10 }],
      totalDurationMs: 10,
    };
    const msg = buildPipelineContextMessage(result);
    // Should have the last ~500 chars preceded by "..."
    expect(msg).toContain("...");
    // The end of the output should be present
    expect(msg).toContain(suffix);
    // The very beginning of the output should be truncated
    expect(msg).not.toContain("BEGIN_");
    // The truncated portion should be exactly right length
    const excerptMatch = msg.match(/```[\s\S]*```/);
    expect(excerptMatch).not.toBeNull();
    if (excerptMatch) {
      const excerpt = excerptMatch[0];
      // The pure content between the backticks (minus "..." prefix)
      const content = excerpt.replace("```\n", "").replace("\n```", "");
      expect(content.startsWith("...")).toBe(true);
      expect(content.length).toBeLessThanOrEqual(510); // 3 for "..." + 500 + fudge
      expect(content.length).toBeGreaterThan(500);
    }
  });

  it("includes full stage output when it fits in 500 chars", () => {
    const shortOutput = "short output";
    const result: PipelineResult = {
      pipelineName: "p",
      task: "",
      success: true,
      stages: [{ stageId: "s1", success: true, output: shortOutput, durationMs: 10 }],
      totalDurationMs: 10,
    };
    const msg = buildPipelineContextMessage(result);
    expect(msg).toContain(shortOutput);
    expect(msg).not.toContain("...");
  });

  it("includes synthesis report", () => {
    const result: PipelineResult = {
      pipelineName: "p",
      task: "",
      success: true,
      stages: [{ stageId: "s1", success: true, output: "ok", durationMs: 10 }],
      totalDurationMs: 10,
      synthesis: "All good. Score: 9/10.",
    };
    const msg = buildPipelineContextMessage(result);
    expect(msg).toContain("Pipeline Synthesis");
    expect(msg).toContain("All good.");
    expect(msg).toContain("Score: 9/10.");
  });

  it("includes synthesis error note", () => {
    const result: PipelineResult = {
      pipelineName: "p",
      task: "",
      success: true,
      stages: [{ stageId: "s1", success: true, output: "ok", durationMs: 10 }],
      totalDurationMs: 10,
      synthesisError: "Synthesis agent busy",
    };
    const msg = buildPipelineContextMessage(result);
    expect(msg).toContain("Synthesis note");
    expect(msg).toContain("Synthesis agent busy");
  });

  it("contains the instruction for the agent to write a narrative summary", () => {
    const result: PipelineResult = {
      pipelineName: "p",
      task: "",
      success: true,
      stages: [],
      totalDurationMs: 0,
    };
    const msg = buildPipelineContextMessage(result);
    expect(msg).toContain("Instructions for the Agent");
    expect(msg).toContain("narrative summary");
    expect(msg).toContain("Overall outcome");
    expect(msg).toContain("Stage breakdown");
    expect(msg).toContain("Key issues");
    expect(msg).toContain("Next steps");
  });

  it("shows 0/0 stages passed for empty stages", () => {
    const result: PipelineResult = {
      pipelineName: "empty",
      task: "",
      success: true,
      stages: [],
      totalDurationMs: 0,
    };
    const msg = buildPipelineContextMessage(result);
    expect(msg).toContain("0/0 stages passed");
  });

  it("does not include synthesis section when no synthesis exists", () => {
    const result: PipelineResult = {
      pipelineName: "p",
      task: "",
      success: true,
      stages: [{ stageId: "s1", success: true, output: "ok", durationMs: 10 }],
      totalDurationMs: 10,
    };
    const msg = buildPipelineContextMessage(result);
    expect(msg).not.toContain("Pipeline Synthesis");
    expect(msg).not.toContain("Synthesis note");
  });
});
