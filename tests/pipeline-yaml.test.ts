/**
 * Validation tests for shipped .pipeline.yaml files.
 *
 * Ensures all pipeline definitions in pipelines/ (extension-bundled) are valid and
 * have correct structure before users run them.
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";

import { loadPipeline, listPipelines } from "../extensions/config-loader.ts";

const PIPELINES_DIR = path.resolve(__dirname, "../pipelines");

describe("shipped pipeline YAML files", () => {
  const pipelines = listPipelines(PIPELINES_DIR);

  it("at least one pipeline exists", () => {
    expect(pipelines.length).toBeGreaterThan(0);
  });

  for (const p of pipelines) {
    describe(`pipeline: ${p.name}`, () => {
      let pipeline: ReturnType<typeof loadPipeline>;

      it("loads successfully", () => {
        pipeline = loadPipeline(p.file);
      });

      it("has a non-empty name", () => {
        expect(pipeline.name).toBeTruthy();
        expect(pipeline.name).toBe(p.name);
      });

      it("has a non-empty description", () => {
        expect(pipeline.description).toBeTruthy();
      });

      it("has at least one stage", () => {
        expect(pipeline.stages.length).toBeGreaterThan(0);
      });

      it("has unique stage IDs (no duplicates)", () => {
        const ids = pipeline.stages.map((s) => s.id);
        const flatIds = flattenStageIds(pipeline.stages);
        const uniqueIds = new Set(flatIds);
        expect(flatIds.length).toBe(uniqueIds.size);
      });

      it("every stage has valid agent or is parallel", () => {
        for (const stage of pipeline.stages) {
          if (stage.parallel) {
            expect(stage.agent).toBeUndefined();
            for (const child of stage.parallel) {
              expect(child.agent).toBeTruthy();
              expect(typeof child.agent).toBe("string");
            }
          } else {
            expect(stage.agent).toBeTruthy();
            expect(typeof stage.agent).toBe("string");
          }
        }
      });

      it("review gates are well-formed", () => {
        for (const stage of pipeline.stages) {
          if (stage.gate) {
            expect(stage.gate.type).toBe("review-loop");
            expect(stage.gate.maxRounds).toBeGreaterThan(0);
            expect(stage.gate.targetScore).toBeGreaterThanOrEqual(0);
            expect(stage.gate.targetScore).toBeLessThanOrEqual(10);
            expect(stage.gate.reviewers.length).toBeGreaterThan(0);
            for (const reviewer of stage.gate.reviewers) {
              expect(typeof reviewer.focus).toBe("string");
              expect(reviewer.focus.trim().length).toBeGreaterThan(0);
              if (reviewer.agent) {
                expect(typeof reviewer.agent).toBe("string");
              }
            }
          }
        }
      });

      it("report config is valid if present", () => {
        // report can be undefined (not set), false (disabled), or ReportConfig object
        if (pipeline.report !== undefined && pipeline.report !== false) {
          expect(typeof pipeline.report).toBe("object");
          expect(pipeline.report).not.toBeNull();
          const r = pipeline.report as Record<string, unknown>;
          if (r.agent !== undefined) {
            expect(typeof r.agent).toBe("string");
          }
          if (r.focus !== undefined) {
            expect(typeof r.focus).toBe("string");
          }
        }
      });
    });
  }
});

/** Get all stage IDs including nested parallel stages */
function flattenStageIds(
  stages: Array<{ id: string; parallel?: Array<{ id: string }> }>,
): string[] {
  const ids: string[] = [];
  for (const s of stages) {
    ids.push(s.id);
    if (s.parallel) {
      for (const child of s.parallel) {
        ids.push(child.id);
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Specific pipeline structure checks
// ---------------------------------------------------------------------------

describe("specific pipeline structures", () => {
  it("hello-world has 2 sequential stages, no gates", () => {
    const pipeline = loadPipeline(path.join(PIPELINES_DIR, "hello-world.pipeline.yaml"));
    expect(pipeline.stages).toHaveLength(2);
    expect(pipeline.stages[0]!.agent).toBe("scout");
    expect(pipeline.stages[1]!.agent).toBe("planner");
    expect(pipeline.stages[0]!.gate).toBeUndefined();
    expect(pipeline.stages[1]!.gate).toBeUndefined();
    expect(pipeline.report).toBeDefined();
    expect(pipeline.report).not.toBe(false);
    expect((pipeline.report as Record<string, unknown>).agent).toBe("planner");
  });

  it("tdd-review has 5 stages, 2 with gates", () => {
    const pipeline = loadPipeline(path.join(PIPELINES_DIR, "tdd-review.pipeline.yaml"));
    expect(pipeline.stages).toHaveLength(5);
    const gates = pipeline.stages.filter((s) => s.gate);
    expect(gates).toHaveLength(2);
    expect(gates[0]!.id).toBe("write-tests");
    expect(gates[0]!.gate!.targetScore).toBe(9);
    expect(gates[1]!.id).toBe("implement");
    expect(gates[1]!.gate!.targetScore).toBe(8);
    expect(pipeline.stages[4]!.parallel![0]!.task).toContain("{outputs.verify}");
    expect(pipeline.report).toBeDefined();
    expect(pipeline.report).not.toBe(false);
    expect((pipeline.report as Record<string, unknown>).agent).toBe("planner");
  });

  it("dev-sprint has 6 stages, 2 with gates, 1 parallel", () => {
    const pipeline = loadPipeline(path.join(PIPELINES_DIR, "dev-sprint.pipeline.yaml"));
    expect(pipeline.stages).toHaveLength(6);
    const gates = pipeline.stages.filter((s) => s.gate);
    expect(gates).toHaveLength(2);
    const parallelStages = pipeline.stages.filter((s) => s.parallel);
    expect(parallelStages).toHaveLength(1);
    expect(parallelStages[0]!.id).toBe("project-review");
    expect(parallelStages[0]!.parallel).toHaveLength(3);
    expect(parallelStages[0]!.parallel!.find((c) => c.id === "next-priorities")!.agent).toBe(
      "planner",
    );
    expect(pipeline.stages[5]!.task).toContain("{outputs.verify}");
    expect(pipeline.report).toBeDefined();
    expect(pipeline.report).not.toBe(false);
    expect((pipeline.report as Record<string, unknown>).agent).toBe("planner");
  });

  it("release-check uses one parallel quality-check stage before readiness decision", () => {
    const pipeline = loadPipeline(path.join(PIPELINES_DIR, "release-check.pipeline.yaml"));
    expect(pipeline.stages).toHaveLength(2);
    expect(pipeline.stages[0]!.parallel).toBeDefined();
    expect(pipeline.stages[0]!.parallel).toHaveLength(3);
    expect(pipeline.stages[0]!.parallel!.map((c) => c.id)).toEqual([
      "code-review",
      "security-audit",
      "stability-check",
    ]);
    expect(pipeline.stages[1]!.task).toContain("{outputs.code-review}");
    expect(pipeline.stages[1]!.task).toContain("{outputs.security-audit}");
    expect(pipeline.stages[1]!.task).toContain("{outputs.stability-check}");
    expect(pipeline.stages.every((s) => !s.gate)).toBe(true);
    expect(pipeline.report).toBeDefined();
    expect(pipeline.report).not.toBe(false);
    expect((pipeline.report as Record<string, unknown>).agent).toBe("scout");
  });

  it("refactor has 5 stages, 1 with gate, and realistic refactor score threshold", () => {
    const pipeline = loadPipeline(path.join(PIPELINES_DIR, "refactor.pipeline.yaml"));
    expect(pipeline.stages).toHaveLength(5);
    const gates = pipeline.stages.filter((s) => s.gate);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.id).toBe("refactor");
    expect(gates[0]!.gate!.targetScore).toBe(8);
    expect(gates[0]!.gate!.reviewers).toHaveLength(3);
    expect(pipeline.report).toBeDefined();
    expect(pipeline.report).not.toBe(false);
    expect((pipeline.report as Record<string, unknown>).agent).toBe("planner");
  });
});
