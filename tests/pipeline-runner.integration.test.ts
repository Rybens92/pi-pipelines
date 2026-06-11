/**
 * Integration tests for runPipeline with mocked subagent-bridge.
 *
 * Tests the full pipeline execution flow:
 *   - Pipeline discovery and loading
 *   - Sequential stage execution
 *   - Parallel stage execution
 *   - Review gate scoring loop
 *   - Error handling and partial results
 *   - Template variable resolution
 *   - UI notification behavior
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { runPipeline } from "../extensions/pipeline-runner.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Mock subagent-bridge module
// vi.hoisted() runs before vi.mock() factory so variables are in scope
// ---------------------------------------------------------------------------

const { mockBridge } = vi.hoisted(() => {
  const executeSubagent = vi.fn();
  const extractResponseText = vi.fn();
  return { mockBridge: { executeSubagent, extractResponseText } };
});

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-int-"));
  pipelinesDir = path.join(tmpDir, ".pi/pipelines");
  fs.mkdirSync(pipelinesDir, { recursive: true });
  vi.clearAllMocks();

  // Default mock for extractResponseText: passes through result.content
  mockBridge.extractResponseText.mockImplementation((response: unknown) => {
    const r = response as { result?: { content?: string }; isError?: boolean; errorText?: string };
    if (r.isError) return r.errorText ?? "(error)";
    return r.result?.content ?? "(no output)";
  });
});

/** Write a pipeline YAML file. First arg is the pipeline name (→ <name>.pipeline.yaml) */
function writePipeline(name: string, content: string): string {
  // Inject report: false to disable synthesis for integration tests
  const withReport = content.includes("report:")
    ? content
    : content.replace(/^(description:.*)$/m, "$1\nreport: false");
  const filePath = path.join(pipelinesDir, `${name}.pipeline.yaml`);
  fs.writeFileSync(filePath, withReport, "utf-8");
  return filePath;
}

function writePipelineRaw(name: string, content: string): string {
  const filePath = path.join(pipelinesDir, `${name}.pipeline.yaml`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/** Create a mock ExtensionContext */
function mockContext(overrides?: Partial<ExtensionContext>): ExtensionContext {
  return {
    cwd: tmpDir,
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      setWidget: vi.fn(),
    },
    ...overrides,
  } as unknown as ExtensionContext;
}

/** Create a mock ExtensionAPI */
function mockAPI(): ExtensionAPI {
  return {
    events: { on: vi.fn(), emit: vi.fn() },
    exec: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
}

/** Default mock success response for executeSubagent */
function mockSuccessResponse(content: string) {
  return {
    requestId: "test",
    result: { content },
    isError: false,
  };
}

/** Default mock error response for executeSubagent */
function mockErrorResponse(errorText: string) {
  return {
    requestId: "",
    result: { content: "" },
    isError: true,
    errorText,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPipeline — pipeline discovery", () => {
  it("returns failure when pipeline file is missing", async () => {
    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "nonexistent",
      task: "test",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Pipeline "nonexistent" not found');
    expect(result.stages).toHaveLength(0);
  });

  it("returns failure when pipeline YAML is invalid", async () => {
    writePipeline("bad", "<<<<<");
    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "bad",
      task: "test",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to load pipeline");
    expect(result.stages).toHaveLength(0);
  });
});

describe("runPipeline — sequential stages", () => {
  it("executes a simple two-stage pipeline", async () => {
    writePipeline("simple", `name: simple
description: "Simple two-stage pipeline"
stages:
  - id: stage1
    agent: scout
    task: "Explore: {task}"
  - id: stage2
    agent: planner
    task: "Plan based on: {outputs.stage1}"
`);

    mockBridge.executeSubagent
      .mockResolvedValueOnce(mockSuccessResponse("Explored codebase"))
      .mockResolvedValueOnce(mockSuccessResponse("Planned work"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "simple",
      task: "Build feature X",
    });

    expect(result.success).toBe(true);
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0]!.stageId).toBe("stage1");
    expect(result.stages[0]!.success).toBe(true);
    expect(result.stages[1]!.stageId).toBe("stage2");
    expect(result.stages[1]!.success).toBe(true);

    // Verify executeSubagent was called with correct tasks
    expect(mockBridge.executeSubagent).toHaveBeenCalledTimes(2);
    const firstCall = mockBridge.executeSubagent.mock.calls[0]![1] as { agent: string; task: string };
    expect(firstCall.agent).toBe("scout");
    expect(firstCall.task).toContain("Build feature X");

    const secondCall = mockBridge.executeSubagent.mock.calls[1]![1] as { agent: string; task: string };
    expect(secondCall.agent).toBe("planner");
    expect(secondCall.task).toContain("Explored codebase");
  });

  it("propagates task with {task} variable correctly", async () => {
    writePipeline("task-test", `name: task-test
description: "Task variable test"
stages:
  - id: s1
    agent: worker
    task: "Do: {task}"
`);

    mockBridge.executeSubagent.mockResolvedValueOnce(mockSuccessResponse("Done"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "task-test",
      task: "Fix bug #42",
    });

    expect(result.success).toBe(true);
    const callArg = mockBridge.executeSubagent.mock.calls[0]![1] as { task: string };
    expect(callArg.task).toContain("Fix bug #42");
  });

  it("compresses stage output through stage-level report before passing it forward", async () => {
    const rawOutput = "x".repeat(400);
    const summary = "Only important findings survived";

    writePipeline("stage-report-flow", `name: stage-report-flow
description: "Stage report flow"
report: false
stages:
  - id: scan
    agent: scout
    task: "Scan"
    report:
      mode: summary
      maxLength: 200
      instruction: "Keep only release blockers"
  - id: decide
    agent: planner
    task: "Decide using: {outputs.scan}"`);

    mockBridge.executeSubagent
      .mockResolvedValueOnce(mockSuccessResponse(rawOutput))
      .mockResolvedValueOnce(mockSuccessResponse(summary))
      .mockResolvedValueOnce(mockSuccessResponse("Decision done"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "stage-report-flow",
      task: "test",
    });

    expect(result.success).toBe(true);
    expect(mockBridge.executeSubagent).toHaveBeenCalledTimes(3);

    const summarizerCall = mockBridge.executeSubagent.mock.calls[1]![1] as { agent: string; task: string };
    expect(summarizerCall.agent).toBe("worker");
    expect(summarizerCall.task).toContain("Keep only release blockers");
    expect(summarizerCall.task).toContain(rawOutput);

    const nextCall = mockBridge.executeSubagent.mock.calls[2]![1] as { task: string };
    expect(nextCall.task).toBe(`Decide using: ${summary}`);
  });

  it("handles stage failure mid-pipeline", async () => {
    writePipeline("fail-test", `name: fail-test
description: "Test failure"
stages:
  - id: good
    agent: scout
    task: "Do first"
  - id: bad
    agent: worker
    task: "Will fail"
  - id: never
    agent: planner
    task: "Never reached"
`);

    mockBridge.executeSubagent
      .mockResolvedValueOnce(mockSuccessResponse("First OK"))
      .mockResolvedValueOnce(mockErrorResponse("Worker crashed"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "fail-test",
      task: "test",
    });

    expect(result.success).toBe(false);
    expect(result.stages).toHaveLength(2); // Only 2 stages ran
    expect(result.stages[0]!.success).toBe(true);
    expect(result.stages[0]!.stageId).toBe("good");
    expect(result.stages[1]!.success).toBe(false);
    expect(result.stages[1]!.stageId).toBe("bad");
    expect(result.stages[1]!.error).toContain("Worker crashed");
    // Third stage should NOT have been executed
    expect(mockBridge.executeSubagent).toHaveBeenCalledTimes(2);
  });
});

describe("runPipeline — parallel stages", () => {
  it("executes parallel stages via tasks array", async () => {
    writePipeline("parallel-test", `name: parallel-test
description: "Parallel test"
stages:
  - id: analysis
    agent: planner
    task: "Analyze {task}"
  - id: reviews
    parallel:
      - id: health
        agent: oracle
        task: "Health check"
      - id: security
        agent: reviewer
        task: "Security check"
  - id: synthesis
    agent: planner
    task: "Synthesize: {outputs.health} | {outputs.security}"
`);

    mockBridge.executeSubagent
      .mockResolvedValueOnce(mockSuccessResponse("Analysis done"))
      .mockResolvedValueOnce(mockSuccessResponse("Health: OK\n\nSecurity: OK"))
      .mockResolvedValueOnce(mockSuccessResponse("Synthesis done"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "parallel-test",
      task: "Check everything",
    });

    expect(result.success).toBe(true);
    expect(result.stages).toHaveLength(3);
    expect(result.stages[0]!.stageId).toBe("analysis");
    expect(result.stages[0]!.success).toBe(true);
    expect(result.stages[1]!.stageId).toBe("reviews");
    expect(result.stages[1]!.success).toBe(true);

    // Verify parallel was called with tasks array
    const parallelCall = mockBridge.executeSubagent.mock.calls[1]![1] as { tasks?: unknown[] };
    expect(parallelCall.tasks).toBeDefined();
    expect(Array.isArray(parallelCall.tasks)).toBe(true);

    expect(result.stages[2]!.stageId).toBe("synthesis");

    const synthesisCall = mockBridge.executeSubagent.mock.calls[2]![1] as { task: string };
    expect(synthesisCall.task).toBe("Synthesize: Health: OK | Security: OK");
  });
});

describe("runPipeline — review gates", () => {
  it("passes gate on first round when score is sufficient", async () => {
    writePipeline("gate-pass", `name: gate-pass
description: "Gate passes immediately"
stages:
  - id: check
    agent: worker
    task: "Do work: {task}"
    gate:
      type: review-loop
      maxRounds: 3
      targetScore: 7
      reviewers:
        - focus: "Quality check"
          agent: "reviewer"
`);

    mockBridge.executeSubagent
      .mockResolvedValueOnce(mockSuccessResponse("Worker output"))
      .mockResolvedValueOnce(mockSuccessResponse("Good quality\nSCORE: 9"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "gate-pass",
      task: "test",
    });

    expect(result.success).toBe(true);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.rounds).toBe(1);
    // expect at least one score
    expect(result.stages[0]!.scores!.length).toBeGreaterThan(0);
  });

  it("retries when score is below target and passes on round 2", async () => {
    writePipeline("gate-retry", `name: gate-retry
description: "Gate retries and passes"
stages:
  - id: check
    agent: worker
    task: "Do work: {task}"
    gate:
      type: review-loop
      maxRounds: 3
      targetScore: 8
      reviewers:
        - focus: "Quality"
          agent: "reviewer"
`);

    let round = 0;
    mockBridge.executeSubagent.mockImplementation(
      async (_pi: unknown, params: { agent?: string; tasks?: unknown[] }) => {
        if (params.agent === "worker") {
          round++;
          return mockSuccessResponse(`Worker output round ${round}`);
        }
        if (params.tasks) {
          const score = round === 1 ? 5 : 9;
          return mockSuccessResponse(`Review\nSCORE: ${score}`);
        }
        return mockSuccessResponse("unknown");
      },
    );

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "gate-retry",
      task: "test",
    });

    expect(result.success).toBe(true);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.rounds).toBe(2);
  });

  it("fails gate after exhausting maxRounds", async () => {
    writePipeline("gate-fail", `name: gate-fail
description: "Gate fails"
stages:
  - id: check
    agent: worker
    task: "Do work: {task}"
    gate:
      type: review-loop
      maxRounds: 2
      targetScore: 8
      reviewers:
        - focus: "Quality"
          agent: "reviewer"
`);

    mockBridge.executeSubagent.mockImplementation(
      async (_pi: unknown, params: { agent?: string; tasks?: unknown[] }) => {
        if (params.agent === "worker") {
          return mockSuccessResponse("Mediocre output");
        }
        if (params.tasks) {
          return mockSuccessResponse("Needs improvement everywhere\nSCORE: 4");
        }
        return mockSuccessResponse("unknown");
      },
    );

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "gate-fail",
      task: "test",
    });

    expect(result.success).toBe(false);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.success).toBe(false);
    expect(result.stages[0]!.rounds).toBe(2);
    expect(result.stages[0]!.error).toContain("Failed to pass review gate");
  });

  it("evaluates average of multiple reviewers", async () => {
    writePipeline("multi-reviewer", `name: multi-reviewer
description: "Multiple reviewers"
stages:
  - id: check
    agent: worker
    task: "Do work"
    gate:
      type: review-loop
      maxRounds: 1
      targetScore: 8
      reviewers:
        - focus: "Quality"
        - focus: "Security"
`);

    mockBridge.executeSubagent.mockImplementation(
      async (_pi: unknown, params: { agent?: string; tasks?: unknown[] }) => {
        if (params.agent === "worker") {
          return mockSuccessResponse("Worker output");
        }
        if (params.tasks) {
          return mockSuccessResponse(
            "Quality is decent\nSCORE: 7\nSecurity is good\nSCORE: 9",
          );
        }
        return mockSuccessResponse("unknown");
      },
    );

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "multi-reviewer",
      task: "test",
    });

    // avg(7, 9) = 8 which is >= target 8 → pass
    expect(result.success).toBe(true);
    expect(result.stages[0]!.rounds).toBe(1);
    expect(result.stages[0]!.scores).toBeDefined();
    expect(result.stages[0]!.scores!.length).toBeGreaterThan(0);
  });
});

describe("runPipeline — UI integration", () => {
  it("calls UI notify and setStatus when hasUI is true", async () => {
    writePipeline("ui-test", `name: ui-test
description: "UI test"
stages:
  - id: s1
    agent: worker
    task: "Test"
`);

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ui = { setStatus, notify, setWidget: vi.fn() };

    mockBridge.executeSubagent.mockResolvedValueOnce(mockSuccessResponse("Done"));

    const result = await runPipeline(
      mockAPI(),
      mockContext({ hasUI: true, ui }),
      { pipeline: "ui-test", task: "test" },
    );

    expect(result.success).toBe(true);
    expect(setStatus).toHaveBeenCalled();
    expect(notify).toHaveBeenCalled();
  });

  it("does not call UI methods when hasUI is false", async () => {
    writePipeline("no-ui-test", `name: no-ui-test
description: "No UI"
stages:
  - id: s1
    agent: worker
    task: "Test"
`);

    const setStatus = vi.fn();
    const notify = vi.fn();

    mockBridge.executeSubagent.mockResolvedValueOnce(mockSuccessResponse("Done"));

    const result = await runPipeline(
      mockAPI(),
      mockContext({ hasUI: false, ui: { setStatus, notify, setWidget: vi.fn() } }),
      { pipeline: "no-ui-test", task: "test" },
    );

    expect(result.success).toBe(true);
    expect(setStatus).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("runPipeline — edge cases", () => {
  it("includes totalDurationMs in result", async () => {
    writePipeline("duration-test", `name: duration-test
description: "Duration test"
stages:
  - id: s1
    agent: worker
    task: "Do it"
`);

    mockBridge.executeSubagent.mockResolvedValueOnce(mockSuccessResponse("Done"));

    const startTime = Date.now();
    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "duration-test",
      task: "test",
    });
    const elapsed = Date.now() - startTime;

    expect(result.success).toBe(true);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.totalDurationMs).toBeLessThanOrEqual(elapsed + 100);
  });

  it("handles missing output references gracefully", async () => {
    writePipeline("missing-ref", `name: missing-ref
description: "Missing reference"
stages:
  - id: s1
    agent: worker
    task: "{outputs.nonexistent}"
`);

    mockBridge.executeSubagent.mockResolvedValueOnce(mockSuccessResponse("Did something"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "missing-ref",
      task: "test",
    });

    expect(result.success).toBe(true);
  });

  it("shows available pipelines when requested pipeline is not found but others exist", async () => {
    // Create one pipeline but request another
    writePipeline("existing", `name: existing
description: "An existing pipeline"
stages:
  - id: s1
    agent: worker
    task: "do it"
`);

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "nonexistent",
      task: "test",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Available pipelines");
    expect(result.error).toContain("existing");
    expect(result.stages).toHaveLength(0);
  });

  it("notifies about low score in review gate when hasUI is true", async () => {
    writePipeline("gate-low-score", `name: gate-low-score
description: "Low score test"
stages:
  - id: check
    agent: worker
    task: "Do work"
    gate:
      type: review-loop
      maxRounds: 1
      targetScore: 8
      reviewers:
        - focus: "Quality"
`);

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ui = { setStatus, notify, setWidget: vi.fn() };

    mockBridge.executeSubagent.mockImplementation(
      async (_pi: unknown, params: { agent?: string; tasks?: unknown[] }) => {
        if (params.agent === "worker") {
          return mockSuccessResponse("Mediocre output");
        }
        if (params.tasks) {
          return mockSuccessResponse("Needs improvement\nSCORE: 5");
        }
        return mockSuccessResponse("unknown");
      },
    );

    const result = await runPipeline(
      mockAPI(),
      mockContext({ hasUI: true, ui }),
      { pipeline: "gate-low-score", task: "test" },
    );

    expect(result.success).toBe(false);
    // Should have been notified about the low score with a warning
    expect(setStatus).toHaveBeenCalled();
    // Should have warning-level notification about low score
    const warningCalls = notify.mock.calls.filter(
      (c: unknown[]) => (c[1] as string) === "warning",
    );
    expect(warningCalls.length).toBeGreaterThan(0);
  });

  it("runs a pipeline with the model override set", async () => {
    writePipeline("model-test", `name: model-test
description: "Model override test"
stages:
  - id: s1
    agent: worker
    task: "Do: {task}"
    model: "gpt-5"
`);

    mockBridge.executeSubagent.mockResolvedValueOnce(mockSuccessResponse("Done"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "model-test",
      task: "test",
    });

    expect(result.success).toBe(true);
    const callArg = mockBridge.executeSubagent.mock.calls[0]![1] as { model?: string };
    expect(callArg.model).toBe("gpt-5");
  });

  it("shows success notification when gate passes with UI enabled", async () => {
    writePipeline("ui-gate-pass", `name: ui-gate-pass
description: "UI gate pass"
stages:
  - id: check
    agent: worker
    task: "Do work"
    gate:
      type: review-loop
      maxRounds: 1
      targetScore: 5
      reviewers:
        - focus: "Quality"
`);

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ui = { setStatus, notify, setWidget: vi.fn() };

    mockBridge.executeSubagent.mockImplementation(
      async (_pi: unknown, params: { agent?: string; tasks?: unknown[] }) => {
        if (params.agent === "worker") {
          return mockSuccessResponse("Good work");
        }
        if (params.tasks) {
          return mockSuccessResponse("Excellent\nSCORE: 9");
        }
        return mockSuccessResponse("unknown");
      },
    );

    const result = await runPipeline(
      mockAPI(),
      mockContext({ hasUI: true, ui }),
      { pipeline: "ui-gate-pass", task: "test" },
    );

    expect(result.success).toBe(true);
    expect(setStatus).toHaveBeenCalled();
    // Should have info-level notification about passing gate
    const infoCalls = notify.mock.calls.filter(
      (c: unknown[]) => (c[1] as string) === "info",
    );
    expect(infoCalls.length).toBeGreaterThan(0);
  });

  it("shows setStatus when simple stage starts with UI enabled", async () => {
    writePipeline("ui-simple-start", `name: ui-simple-start
description: "Simple start UI"
stages:
  - id: s1
    agent: worker
    task: "Do it"
`);

    const setStatus = vi.fn();
    const ui = { setStatus, notify: vi.fn(), setWidget: vi.fn() };

    mockBridge.executeSubagent.mockResolvedValueOnce(mockSuccessResponse("Done"));

    const result = await runPipeline(
      mockAPI(),
      mockContext({ hasUI: true, ui }),
      { pipeline: "ui-simple-start", task: "test" },
    );

    expect(result.success).toBe(true);
    // Should have called setStatus at least once with the stage label
    const statusCalls = setStatus.mock.calls.filter(
      (c: unknown[]) => (c[1] as string).includes("s1"),
    );
    expect(statusCalls.length).toBeGreaterThan(0);
  });

  it("shows UI notifications for parallel stage with hasUI enabled", async () => {
    writePipeline("ui-parallel", `name: ui-parallel
description: "UI parallel test"
stages:
  - id: par
    parallel:
      - id: a
        agent: oracle
        task: "Task A"
      - id: b
        agent: scout
        task: "Task B"
`);

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ui = { setStatus, notify, setWidget: vi.fn() };

    mockBridge.executeSubagent.mockResolvedValueOnce(
      mockSuccessResponse("Both tasks done"),
    );

    const result = await runPipeline(
      mockAPI(),
      mockContext({ hasUI: true, ui }),
      { pipeline: "ui-parallel", task: "test" },
    );

    expect(result.success).toBe(true);
    expect(setStatus).toHaveBeenCalled();
    expect(notify).toHaveBeenCalled();
  });

  it("handles parallel stage failure", async () => {
    writePipeline("par-fail", `name: par-fail
description: "Parallel stage failure"
stages:
  - id: analysis
    agent: planner
    task: "Analyze"
  - id: reviews
    parallel:
      - id: health
        agent: oracle
        task: "Health"
`);

    mockBridge.executeSubagent
      .mockResolvedValueOnce(mockSuccessResponse("Analysis done"))
      .mockResolvedValueOnce(mockErrorResponse("Parallel execution failed"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "par-fail",
      task: "test",
    });

    expect(result.success).toBe(false);
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0]!.success).toBe(true);
    expect(result.stages[1]!.success).toBe(false);
    expect(result.stages[1]!.error).toContain("Parallel execution failed");
  });

  it("sends error notification when stage fails with hasUI enabled", async () => {
    writePipeline("ui-stage-fail", `name: ui-stage-fail
description: "Stage fail UI test"
stages:
  - id: s1
    agent: worker
    task: "Will fail"
`);

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ui = { setStatus, notify, setWidget: vi.fn() };

    mockBridge.executeSubagent.mockResolvedValueOnce(
      mockErrorResponse("Stage crashed hard"),
    );

    const result = await runPipeline(
      mockAPI(),
      mockContext({ hasUI: true, ui }),
      { pipeline: "ui-stage-fail", task: "test" },
    );

    expect(result.success).toBe(false);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Stage crashed hard"),
      "error",
    );
  });

  it("throws error when worker fails in review gate round", async () => {
    writePipeline("gate-worker-fail", `name: gate-worker-fail
description: "Worker fails during gate"
stages:
  - id: check
    agent: worker
    task: "Do work"
    gate:
      type: review-loop
      maxRounds: 1
      targetScore: 5
      reviewers:
        - focus: "Quality"
`);

    mockBridge.executeSubagent.mockImplementation(
      async (_pi: unknown, params: { agent?: string }) => {
        if (params.agent === "worker") {
          return mockErrorResponse("Worker crashed during review");
        }
        return mockSuccessResponse("unknown");
      },
    );

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "gate-worker-fail",
      task: "test",
    });

    expect(result.success).toBe(false);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.success).toBe(false);
    expect(result.stages[0]!.error).toContain("Worker crashed during review");
  });
});

// ---------------------------------------------------------------------------
// Report synthesis
// ---------------------------------------------------------------------------

describe("runPipeline — report synthesis", () => {
  it("runs synthesis by default when report is omitted", async () => {
    writePipelineRaw("default-report", `name: default-report
description: "Default report"
stages:
  - id: s1
    agent: worker
    task: "Do stuff"`);

    mockBridge.executeSubagent
      .mockResolvedValueOnce(mockSuccessResponse("Stage done"))
      .mockResolvedValueOnce(mockSuccessResponse("Default synthesis report"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "default-report",
      task: "test task",
    });

    expect(result.success).toBe(true);
    expect(result.stages).toHaveLength(1);
    expect(result.synthesis).toBe("Default synthesis report");
    expect(mockBridge.executeSubagent).toHaveBeenCalledTimes(2);
  });

  it("includes synthesis field when report is enabled", async () => {
    writePipeline("with-report", `name: with-report
description: "Has report"
report:
  agent: planner
  focus: "test focus"
stages:
  - id: s1
    agent: worker
    task: "Do stuff"
`);

    // Mock: first call = stage, second call = synthesis
    mockBridge.executeSubagent
      .mockResolvedValueOnce(mockSuccessResponse("Stage done"))
      .mockResolvedValueOnce(mockSuccessResponse("Synthesis report: all good"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "with-report",
      task: "test task",
    });

    expect(result.success).toBe(true);
    expect(result.stages).toHaveLength(1);
    expect(result.synthesis).toBe("Synthesis report: all good");
  });

  it("includes synthesisError when synthesis agent fails", async () => {
    writePipeline("synth-fail", `name: synth-fail
description: "Synthesis fails"
report:
  agent: planner
stages:
  - id: s1
    agent: worker
    task: "Stage 1"
`);

    mockBridge.executeSubagent
      .mockResolvedValueOnce(mockSuccessResponse("Stage done"))
      .mockRejectedValueOnce(new Error("Synthesis agent crashed"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "synth-fail",
      task: "test",
    });

    // Pipeline itself succeeded, but synthesis failed
    expect(result.success).toBe(true);
    expect(result.synthesis).toBeUndefined();
    expect(result.synthesisError).toContain("Synthesis agent crashed");
  });

  it("does NOT run synthesis when report: false in pipeline YAML", async () => {
    writePipeline("no-report", `name: no-report
description: "No report"
report: false
stages:
  - id: s1
    agent: worker
    task: "Stage 1"
`);

    mockBridge.executeSubagent.mockResolvedValueOnce(mockSuccessResponse("Done"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "no-report",
      task: "test",
    });

    expect(result.success).toBe(true);
    expect(result.synthesis).toBeUndefined();
    expect(mockBridge.executeSubagent).toHaveBeenCalledTimes(1);
  });

  it("passes the synthesis context (buildReportContext) to the synthesis agent call", async () => {
    writePipeline("report-context", `name: report-context
description: "Context verification"
report:
  agent: oracle
  focus: "check context"
stages:
  - id: analysis
    agent: scout
    task: "Analyze {task}"
`);

    mockBridge.executeSubagent
      .mockResolvedValueOnce(mockSuccessResponse("Analysis complete"))
      .mockResolvedValueOnce(mockSuccessResponse("Report done"));

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "report-context",
      task: "verify context passing",
    });

    expect(result.success).toBe(true);
    expect(result.synthesis).toBe("Report done");

    // The synthesis agent call should contain the stage context
    const synthCall = mockBridge.executeSubagent.mock.calls[1]![1] as { agent: string; task: string };
    expect(synthCall.agent).toBe("oracle");
    expect(synthCall.task).toContain("report-context");
    expect(synthCall.task).toContain("Context verification");
    expect(synthCall.task).toContain("verify context passing");
    expect(synthCall.task).toContain("Analysis complete");
  });
});

describe("runPipeline — expand stages", () => {
  it("expands a stage into multiple parallel tasks from JSON array output", async () => {
    writePipeline("expand-test", `name: expand-test
description: "Test expand"
stages:
  - id: discover
    agent: scout
    task: "Find items"
  - id: process-each
    agent: worker
    task: "Process {item.value}"
    expand:
      from: discover`);

    // Source stage output: JSON array
    mockBridge.executeSubagent.mockResolvedValueOnce(
      mockSuccessResponse(JSON.stringify([
        { value: "src/a.ts" },
        { value: "src/b.ts" },
        { value: "src/c.ts" },
      ])),
    );

    // Parallel expanded tasks: 3 calls in one executeSubagent with tasks array
    mockBridge.executeSubagent.mockResolvedValueOnce(
      mockSuccessResponse(
        "Processed a.ts\n\nProcessed b.ts\n\nProcessed c.ts",
      ),
    );

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "expand-test",
      task: "test",
    });

    expect(result.success).toBe(true);
    expect(result.stages).toHaveLength(2);
    expect(result.stages[1]!.stageId).toBe("process-each");
    expect(result.stages[1]!.success).toBe(true);
    expect(result.stages[1]!.output).toContain("process-each-1");
    expect(result.stages[1]!.output).toContain("process-each-2");
    expect(result.stages[1]!.output).toContain("process-each-3");

    // Verify the parallel call included 3 tasks
    const parallelCall = mockBridge.executeSubagent.mock.calls[1]![1] as { tasks: unknown[] };
    expect(parallelCall.tasks).toHaveLength(3);
    expect(parallelCall.tasks[0]).toMatchObject({ agent: "worker" });
  });

  it("handles expand with {item.path} variables from object items", async () => {
    writePipeline("expand-obj", `name: expand-obj
description: "Object items"
stages:
  - id: list-files
    agent: scout
    task: "List files"
  - id: refactor-each
    agent: worker
    task: "Refactor: {item.path} — {item.risk}"
    expand:
      from: list-files`);

    // Source stage output: JSON array of objects
    mockBridge.executeSubagent.mockResolvedValueOnce(
      mockSuccessResponse(JSON.stringify([
        { path: "login.ts", risk: "high" },
        { path: "signup.ts", risk: "medium" },
      ])),
    );

    mockBridge.executeSubagent.mockResolvedValueOnce(
      mockSuccessResponse("Refactored login.ts\n\nRefactored signup.ts"),
    );

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "expand-obj",
      task: "test",
    });

    expect(result.success).toBe(true);

    // Verify resolved tasks
    const parallelCall = mockBridge.executeSubagent.mock.calls[1]![1] as { tasks: Array<{ task: string }> };
    expect(parallelCall.tasks[0]!.task).toBe("Refactor: login.ts — high");
    expect(parallelCall.tasks[1]!.task).toBe("Refactor: signup.ts — medium");
  });

  it("handles expand when source stage returns empty items", async () => {
    writePipeline("expand-empty", `name: expand-empty
description: "Empty expand"
stages:
  - id: find
    agent: scout
    task: "Find"
  - id: process-each
    agent: worker
    task: "Process {item}"
    expand:
      from: find`);

    // Source stage output: empty JSON array
    mockBridge.executeSubagent.mockResolvedValueOnce(
      mockSuccessResponse("[]"),
    );

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "expand-empty",
      task: "test",
    });

    expect(result.success).toBe(true);
    expect(result.stages).toHaveLength(2);
    expect(result.stages[1]!.success).toBe(true);
    expect(result.stages[1]!.output).toContain("no items to expand");
    // No second executeSubagent call for expand (no items to process)
    expect(mockBridge.executeSubagent).toHaveBeenCalledTimes(1);
  });

  it("handles expand when source stage output is unparseable", async () => {
    writePipeline("expand-bad", `name: expand-bad
description: "Bad output"
stages:
  - id: find
    agent: scout
    task: "Find"
  - id: process-each
    agent: worker
    task: "Process {item}"
    expand:
      from: find`);

    // Source stage output: junk text
    mockBridge.executeSubagent.mockResolvedValueOnce(
      mockSuccessResponse("This is not structured data at all"),
    );

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "expand-bad",
      task: "test",
    });

    expect(result.success).toBe(false);
    expect(result.stages[1]!.success).toBe(false);
    expect(result.stages[1]!.error).toContain("Cannot parse items");
  });

  it("handles expand with source stage that has no output in the outputs map", async () => {
    writePipeline("expand-no-out", `name: expand-no-out
description: "No output"
stages:
  - id: find
    agent: scout
    task: "Find"
  - id: process-each
    agent: worker
    task: "Process {item.value}"
    expand:
      from: find`);

    // Source stage runs successfully but returns no output (empty string)
    mockBridge.executeSubagent.mockResolvedValueOnce(
      mockSuccessResponse(""),
    );

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "expand-no-out",
      task: "test",
    });

    expect(result.success).toBe(false);
    expect(result.stages).toHaveLength(2);
    expect(result.stages[1]!.success).toBe(false);
    expect(result.stages[1]!.error).toContain("no output");
  });

  it("handles expand with maxItems limit", async () => {
    writePipeline("expand-limit", `name: expand-limit
description: "Max items"
stages:
  - id: discover
    agent: scout
    task: "Find"
  - id: process-each
    agent: worker
    task: "Process {item.value}"
    expand:
      from: discover
      maxItems: 2`);

    mockBridge.executeSubagent.mockResolvedValueOnce(
      mockSuccessResponse(JSON.stringify([
        { value: "a" },
        { value: "b" },
        { value: "c" },
        { value: "d" },
      ])),
    );

    mockBridge.executeSubagent.mockResolvedValueOnce(
      mockSuccessResponse("Processed a\n\nProcessed b"),
    );

    const result = await runPipeline(mockAPI(), mockContext(), {
      pipeline: "expand-limit",
      task: "test",
    });

    expect(result.success).toBe(true);
    const parallelCall = mockBridge.executeSubagent.mock.calls[1]![1] as { tasks: unknown[] };
    expect(parallelCall.tasks).toHaveLength(2);
  });
});
