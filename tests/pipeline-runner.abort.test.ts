/**
 * Tests for pipeline abort/cancel scenarios and error UX.
 *
 * Covers:
 *   - Pre-existing abort (signal already fired before runPipeline)
 *   - Abort during stage execution (partial results returned)
 *   - Abort during review gate
 *   - Error message clarity and stage chain traceability
 *   - Partial results after failure vs abort
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { runPipeline, formatPipelineResult } from "../extensions/pipeline-runner.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Mock subagent-bridge
// ---------------------------------------------------------------------------

const { mockBridge } = vi.hoisted(() => ({
  mockBridge: { executeSubagent: vi.fn(), extractResponseText: vi.fn() },
}));

vi.mock("../extensions/subagent-bridge.ts", () => ({
  executeSubagent: (...args: unknown[]) => mockBridge.executeSubagent(...args),
  extractResponseText: (...args: unknown[]) => mockBridge.extractResponseText(...args),
  isSubagentAvailable: () => true,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let pipelinesDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-abort-"));
  pipelinesDir = path.join(tmpDir, ".pi/pipelines");
  fs.mkdirSync(pipelinesDir, { recursive: true });
  vi.clearAllMocks();

  mockBridge.extractResponseText.mockImplementation((response: unknown) => {
    const r = response as { result?: { content?: string }; isError?: boolean; errorText?: string };
    if (r.isError) return r.errorText ?? "(error)";
    return r.result?.content ?? "(no output)";
  });
});

function writePipeline(name: string, content: string): string {
  // Inject report: false to disable synthesis for abort tests
  const withReport = content.includes("report:")
    ? content
    : content.replace(/^(description:.*)$/m, "$1\nreport: false");
  const filePath = path.join(pipelinesDir, `${name}.pipeline.yaml`);
  fs.writeFileSync(filePath, withReport, "utf-8");
  return filePath;
}

function mockContext(overrides?: Partial<ExtensionContext>): ExtensionContext {
  return {
    cwd: tmpDir,
    hasUI: false,
    ui: { setStatus: vi.fn(), notify: vi.fn(), setWidget: vi.fn() },
    ...overrides,
  } as unknown as ExtensionContext;
}

function mockAPI(): ExtensionAPI {
  return {
    events: { on: vi.fn(), emit: vi.fn() },
    exec: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
}

function successResponse(content: string) {
  return { requestId: "test", result: { content }, isError: false };
}

function errorResponse(errorText: string) {
  return { requestId: "", result: { content: "" }, isError: true, errorText };
}

// ---------------------------------------------------------------------------
// AbortSignal scenarios
// ---------------------------------------------------------------------------

describe("runPipeline — abort scenarios", () => {
  it("returns immediately with cancelled status when signal is pre-aborted", async () => {
    writePipeline("simple", `name: simple
description: "Simple"
stages:
  - id: s1
    agent: worker
    task: "Do it"
`);

    const controller = new AbortController();
    controller.abort(); // Pre-abort

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "simple",
      task: "test",
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Pipeline cancelled before execution");
    expect(result.stages).toHaveLength(0);
    // No subagent calls should have been made
    expect(mockBridge.executeSubagent).not.toHaveBeenCalled();
  });

  it("returns partial results when abort fires during a stage", async () => {
    writePipeline("two-stage", `name: two-stage
description: "Two stages"
stages:
  - id: s1
    agent: worker
    task: "First"
  - id: s2
    agent: worker
    task: "Second"
`);

    const controller = new AbortController();

    // First call completes, second call triggers abort
    mockBridge.executeSubagent
      .mockResolvedValueOnce(successResponse("Stage 1 done"))
      .mockImplementationOnce(() => {
        controller.abort(); // Simulate abort during stage 2
        throw new DOMException("The operation was aborted", "AbortError");
      });

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "two-stage",
      task: "test",
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Pipeline cancelled");
    expect(result.error).toContain("s2");
    // First stage should be in the partial results
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.stageId).toBe("s1");
    expect(result.stages[0]!.success).toBe(true);
  });

  it("returns partial results when abort fires during review gate", async () => {
    writePipeline("gate-abort", `name: gate-abort
description: "Gate abort test"
stages:
  - id: before
    agent: worker
    task: "Before gate"
  - id: check
    agent: worker
    task: "Gate work"
    gate:
      type: review-loop
      maxRounds: 3
      targetScore: 7
      reviewers:
        - focus: "Check it"
`);

    const controller = new AbortController();

    // First stage succeeds, gate stage gets aborted
    mockBridge.executeSubagent
      .mockResolvedValueOnce(successResponse("Before done"))
      .mockImplementationOnce(() => {
        controller.abort();
        throw new DOMException("The operation was aborted", "AbortError");
      });

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "gate-abort",
      task: "test",
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Pipeline cancelled");
    expect(result.error).toContain("check");
    // Stage 1 should have completed
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.stageId).toBe("before");
    expect(result.stages[0]!.success).toBe(true);
  });

  it("includes completed stages before abort point in partial results", async () => {
    writePipeline("three-stage", `name: three-stage
description: "Three stages"
stages:
  - id: plan
    agent: planner
    task: "Plan"
  - id: implement
    agent: worker
    task: "Implement"
  - id: review
    agent: reviewer
    task: "Review"
`);

    const controller = new AbortController();

    mockBridge.executeSubagent
      .mockResolvedValueOnce(successResponse("Plan done"))
      .mockResolvedValueOnce(successResponse("Implement done"))
      .mockImplementationOnce(() => {
        controller.abort();
        throw new DOMException("The operation was aborted", "AbortError");
      });

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "three-stage",
      task: "test",
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Pipeline cancelled");
    // Should have 2 completed stages before abort
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0]!.stageId).toBe("plan");
    expect(result.stages[0]!.success).toBe(true);
    expect(result.stages[1]!.stageId).toBe("implement");
    expect(result.stages[1]!.success).toBe(true);
  });

  it("handles stage error differently from abort", async () => {
    writePipeline("err-vs-abort", `name: err-vs-abort
description: "Error vs abort"
stages:
  - id: good
    agent: worker
    task: "Good"
  - id: bad
    agent: worker
    task: "Bad"
`);

    // Stage failure (not abort)
    mockBridge.executeSubagent
      .mockResolvedValueOnce(successResponse("Good"))
      .mockResolvedValueOnce(errorResponse("Something crashed"));

    const controller = new AbortController();

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "err-vs-abort",
      task: "test",
      signal: controller.signal, // signal is NOT aborted
    });

    expect(result.success).toBe(false);
    // Error message mentions the actual error, not cancellation
    expect(result.error).toContain("Something crashed");
    expect(result.error).not.toContain("cancelled");

    // Partial results: 1 completed stage, 1 failed stage
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0]!.success).toBe(true);
    expect(result.stages[0]!.stageId).toBe("good");
    expect(result.stages[1]!.success).toBe(false);
    expect(result.stages[1]!.stageId).toBe("bad");
  });
});

// ---------------------------------------------------------------------------
// Error UX — formatPipelineResult
// ---------------------------------------------------------------------------

describe("formatPipelineResult — error UX quality", () => {
  it("shows which stages passed and which failed in a chain", () => {
    const result = {
      pipelineName: "my-pipe",
      task: "Fix authentication",
      success: false,
      stages: [
        {
          stageId: "plan",
          success: true,
          output: "Plan approved",
          durationMs: 100,
        },
        {
          stageId: "implement",
          success: false,
          output: "",
          error: 'Agent "worker" failed: Type error in auth.ts',
          durationMs: 200,
        },
      ],
      totalDurationMs: 300,
      error: 'Stage "implement" failed: Agent "worker" failed: Type error in auth.ts',
    };

    const formatted = formatPipelineResult(result);

    // Must show per-stage status
    expect(formatted).toContain("✅ plan");
    expect(formatted).toContain("❌ implement");

    // Must show the error message on the failing stage
    expect(formatted).toContain("Type error in auth.ts");

    // Must show the pipeline status
    expect(formatted).toContain("❌ FAILED");
  });

  it("shows review gate scores on failed gate stages", () => {
    const result = {
      pipelineName: "review-pipe",
      task: "Review code",
      success: false,
      stages: [
        {
          stageId: "quality-check",
          success: false,
          output: "Some output",
          error: "Failed to pass review gate after 2 rounds. Scores: [4, 5]",
          durationMs: 500,
          rounds: 2,
          scores: [4, 5],
        },
      ],
      totalDurationMs: 500,
      error: 'Stage "quality-check" failed: Failed to pass review gate after 2 rounds',
    };

    const formatted = formatPipelineResult(result);

    // Must show gate-specific info
    expect(formatted).toContain("2 rounds");
    expect(formatted).toContain("[4, 5]");
    expect(formatted).toContain("Failed to pass review gate");

    // Must show the stage as failed
    expect(formatted).toContain("❌ quality-check");
  });

  it("shows actionable error messages that tell the user what happened", () => {
    const result = {
      pipelineName: "deploy",
      task: "Deploy to production",
      success: false,
      stages: [
        {
          stageId: "security-scan",
          success: false,
          output: "",
          error: 'Agent "reviewer" failed: npm audit found 5 critical vulnerabilities',
          durationMs: 100,
        },
      ],
      totalDurationMs: 100,
      error: 'Stage "security-scan" failed: Agent "reviewer" failed: npm audit found 5 critical vulnerabilities',
    };

    const formatted = formatPipelineResult(result);

    // Error message should be descriptive
    expect(formatted).toContain("security-scan");
    expect(formatted).toContain("npm audit");
    expect(formatted).toContain("5 critical");

    // The error chain should be visible
    expect(formatted).toContain("Agent");
    expect(formatted).toContain("reviewer");
  });

  it("shows all completed stages even when a later stage fails", () => {
    const result = {
      pipelineName: "p",
      task: "t",
      success: false,
      stages: [
        { stageId: "stage-a", success: true, output: "A done", durationMs: 50 },
        { stageId: "stage-b", success: true, output: "B done", durationMs: 50 },
        { stageId: "stage-c", success: true, output: "C done", durationMs: 50 },
        {
          stageId: "stage-d",
          success: false,
          output: "",
          error: "Stage d failed",
          durationMs: 100,
        },
      ],
      totalDurationMs: 250,
      error: 'Stage "stage-d" failed: Stage d failed',
    };

    const formatted = formatPipelineResult(result);

    // All stages should be visible
    expect(formatted).toContain("stage-a");
    expect(formatted).toContain("stage-b");
    expect(formatted).toContain("stage-c");
    expect(formatted).toContain("stage-d");
    expect(formatted).toContain("Stage d failed");
  });

  it("provides summary of passed vs total stages", () => {
    const result = {
      pipelineName: "p",
      task: "t",
      success: true,
      stages: [
        { stageId: "a", success: true, output: "ok", durationMs: 10 },
        { stageId: "b", success: true, output: "ok", durationMs: 10 },
        { stageId: "c", success: true, output: "ok", durationMs: 10 },
      ],
      totalDurationMs: 30,
    };

    const formatted = formatPipelineResult(result);
    expect(formatted).toContain("✅ PASSED");
  });
});

// ---------------------------------------------------------------------------
// Partial results UX
// ---------------------------------------------------------------------------

describe("PipelineResult — partial results after failure", () => {
  it("stage results contain stageId, success, output, durationMs for every stage", () => {
    const result = {
      pipelineName: "p",
      task: "t",
      success: true,
      stages: [
        { stageId: "s1", success: true, output: "Hello", durationMs: 50 },
      ],
      totalDurationMs: 50,
    };

    for (const stage of result.stages) {
      expect(stage).toHaveProperty("stageId");
      expect(stage).toHaveProperty("success");
      expect(stage).toHaveProperty("output");
      expect(stage).toHaveProperty("durationMs");
    }
  });

  it("failed stages have error message explaining what went wrong", () => {
    const result = {
      pipelineName: "p",
      task: "t",
      success: false,
      stages: [
        {
          stageId: "compile",
          success: false,
          output: "",
          error: "Agent \"worker\" failed: TypeScript compilation error in src/index.ts",
          durationMs: 100,
        },
      ],
      totalDurationMs: 100,
      error: 'Stage "compile" failed: Agent "worker" failed: TypeScript compilation error in src/index.ts',
    };

    // The error must contain both the agent name and the root cause
    expect(result.stages[0]!.error).toContain("Agent");
    expect(result.stages[0]!.error).toContain("worker");
    expect(result.stages[0]!.error).toContain("TypeScript compilation");
  });

  it("sends warning notification when pipeline is aborted with UI enabled", async () => {
    writePipeline("ui-abort", `name: ui-abort
description: "UI abort test"
stages:
  - id: s1
    agent: worker
    task: "Stage 1"
  - id: s2
    agent: worker
    task: "Stage 2"
`);

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ui = { setStatus, notify, setWidget: vi.fn() };
    const controller = new AbortController();

    mockBridge.executeSubagent
      .mockResolvedValueOnce(successResponse("Stage 1 done"))
      .mockImplementationOnce(() => {
        controller.abort();
        throw new DOMException("The operation was aborted", "AbortError");
      });

    const result = await runPipeline(
      mockAPI(),
      mockContext({ hasUI: true, ui }),
      {
        pipeline: "ui-abort",
        task: "test",
        signal: controller.signal,
      },
    );

    expect(result.success).toBe(false);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.stageId).toBe("s1");
    expect(result.stages[0]!.success).toBe(true);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
      "warning",
    );
  });

  it("respects stageTimeoutMs and aborts slow stages", async () => {
    writePipeline("timeout-test", `name: timeout-test
description: "Timeout test"
stages:
  - id: s1
    agent: worker
    task: "Slow task"
`);

    // Mock that listens to signal — if it fires before work completes, reject
    mockBridge.executeSubagent.mockImplementationOnce(
      async (_pi: unknown, _params: unknown, signal?: AbortSignal) => {
        if (signal?.aborted) throw signal.reason ?? new DOMException("Pre-aborted", "AbortError");
        // Simulate work that respects the abort signal
        await new Promise<void>((resolve, reject) => {
          const finish = setTimeout(() => resolve(), 200);
          signal?.addEventListener("abort", () => {
            clearTimeout(finish);
            reject(signal.reason ?? new DOMException("Aborted by signal", "AbortError"));
          }, { once: true });
        });
        return successResponse("Done");
      },
    );

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "timeout-test",
      task: "test",
      stageTimeoutMs: 10, // Very short timeout — fires before the 200ms mock completes
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("cancelled");
    expect(result.error).toContain("s1");
    expect(result.stages).toHaveLength(0);
  });
});
