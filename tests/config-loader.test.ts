/**
 * Tests for config-loader.ts
 *
 * Covers every error branch, valid case, edge case, and default value in:
 *   - discoverPipelineFiles
 *   - findPipelineFile
 *   - listPipelines
 *   - loadPipeline (including validateStage and validateGate internals)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Module under test
import {
  discoverPipelineFiles,
  findPipelineFile,
  listPipelines,
  loadPipeline,
  searchPipelineFile,
  listPipelinesFromDirs,
} from "../extensions/config-loader.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipelines-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a string to a file inside tmpDir */
function writePipeline(name: string, content: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/** Create a minimal valid pipeline YAML */
function minimalPipelineYaml(name = "test-pipeline"): string {
  return `name: ${name}
description: "A test pipeline"
stages:
  - id: stage1
    agent: worker
    task: "Do something"
`;
}

// ---------------------------------------------------------------------------
// discoverPipelineFiles
// ---------------------------------------------------------------------------

describe("discoverPipelineFiles", () => {
  it("returns [] when directory does not exist", () => {
    const result = discoverPipelineFiles("/nonexistent/dir");
    expect(result).toEqual([]);
  });

  it("returns [] when directory is empty", () => {
    const result = discoverPipelineFiles(tmpDir);
    expect(result).toEqual([]);
  });

  it("returns [] when directory has non-matching files", () => {
    writePipeline("random.yaml", "a: 1");
    writePipeline("notes.txt", "hello");
    writePipeline("config.json", "{}");
    const result = discoverPipelineFiles(tmpDir);
    expect(result).toEqual([]);
  });

  it("finds .pipeline.yaml files", () => {
    writePipeline("hello.pipeline.yaml", minimalPipelineYaml("hello"));
    writePipeline("world.pipeline.yaml", minimalPipelineYaml("world"));
    const result = discoverPipelineFiles(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("hello.pipeline.yaml");
    expect(result[1]).toContain("world.pipeline.yaml");
  });

  it("finds .pipeline.yml files", () => {
    writePipeline("test.pipeline.yml", minimalPipelineYaml("test"));
    const result = discoverPipelineFiles(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("test.pipeline.yml");
  });

  it("finds both .yaml and .yml files", () => {
    writePipeline("a.pipeline.yaml", minimalPipelineYaml("a"));
    writePipeline("b.pipeline.yml", minimalPipelineYaml("b"));
    const result = discoverPipelineFiles(tmpDir);
    expect(result).toHaveLength(2);
  });

  it("returns sorted results", () => {
    writePipeline("z.pipeline.yaml", minimalPipelineYaml("z"));
    writePipeline("a.pipeline.yaml", minimalPipelineYaml("a"));
    writePipeline("m.pipeline.yaml", minimalPipelineYaml("m"));
    const result = discoverPipelineFiles(tmpDir);
    const basenames = result.map((f) => path.basename(f));
    expect(basenames).toEqual([
      "a.pipeline.yaml",
      "m.pipeline.yaml",
      "z.pipeline.yaml",
    ]);
  });

  it("does NOT match files without the .pipeline. prefix", () => {
    writePipeline("test.yaml", "name: test\ndescription: 'x'\nstages: []");
    writePipeline("test.pipeline.yaml", minimalPipelineYaml("test"));
    const result = discoverPipelineFiles(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain(".pipeline.yaml");
  });
});

// ---------------------------------------------------------------------------
// findPipelineFile
// ---------------------------------------------------------------------------

describe("findPipelineFile", () => {
  it("returns the .pipeline.yaml path when it exists", () => {
    const filePath = writePipeline("my-pipe.pipeline.yaml", minimalPipelineYaml("my-pipe"));
    const result = findPipelineFile(tmpDir, "my-pipe");
    expect(result).toBe(filePath);
  });

  it("returns the .pipeline.yml path when .yaml does not exist", () => {
    const filePath = writePipeline("my-pipe.pipeline.yml", minimalPipelineYaml("my-pipe"));
    const result = findPipelineFile(tmpDir, "my-pipe");
    expect(result).toBe(filePath);
  });

  it("prefers .pipeline.yaml over .pipeline.yml", () => {
    writePipeline("my-pipe.pipeline.yml", minimalPipelineYaml("my-pipe"));
    const yamlPath = writePipeline("my-pipe.pipeline.yaml", minimalPipelineYaml("my-pipe"));
    const result = findPipelineFile(tmpDir, "my-pipe");
    expect(result).toBe(yamlPath);
  });

  it("returns exact path when given an explicit file path", () => {
    const filePath = writePipeline("custom-name.yaml", minimalPipelineYaml("custom"));
    const result = findPipelineFile(tmpDir, "custom-name.yaml");
    expect(result).toBe(filePath);
  });

  it("returns null when no file matches", () => {
    const result = findPipelineFile(tmpDir, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when directory does not exist", () => {
    const result = findPipelineFile("/nonexistent", "test");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listPipelines
// ---------------------------------------------------------------------------

describe("listPipelines", () => {
  it("returns empty array when no pipelines exist", () => {
    expect(listPipelines(tmpDir)).toEqual([]);
  });

  it("strips extension from pipeline names", () => {
    writePipeline("hello.pipeline.yaml", minimalPipelineYaml("hello"));
    writePipeline("world.pipeline.yml", minimalPipelineYaml("world"));
    const result = listPipelines(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("hello");
    expect(result[0].file).toContain("hello.pipeline.yaml");
    expect(result[1].name).toBe("world");
    expect(result[1].file).toContain("world.pipeline.yml");
  });

  it("handles multiple dots in name", () => {
    writePipeline("my.cool.pipeline.yaml", minimalPipelineYaml("my.cool"));
    const result = listPipelines(tmpDir);
    expect(result[0].name).toBe("my.cool");
  });

  it("returns empty array when directory does not exist", () => {
    const result = listPipelines(path.join(tmpDir, "nonexistent"));
    expect(result).toEqual([]);
  });
});

describe("searchPipelineFile", () => {
  it("returns the first match across multiple directories", () => {
    const dir1 = path.join(tmpDir, "one");
    const dir2 = path.join(tmpDir, "two");
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    writePipeline(path.join("one", "hello.pipeline.yaml"), minimalPipelineYaml("hello"));
    writePipeline(path.join("two", "world.pipeline.yaml"), minimalPipelineYaml("world"));

    const found = searchPipelineFile([dir1, dir2], "hello");
    expect(found).toBe(path.join(dir1, "hello.pipeline.yaml"));
  });

  it("checks second directory when first has no match", () => {
    const dir1 = path.join(tmpDir, "emptyDir");
    const dir2 = path.join(tmpDir, "hasPipeline");
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    writePipeline(path.join("hasPipeline", "foo.pipeline.yaml"), minimalPipelineYaml("foo"));

    const found = searchPipelineFile([dir1, dir2], "foo");
    expect(found).toBe(path.join(dir2, "foo.pipeline.yaml"));
  });

  it("returns null when no directory has a match", () => {
    const dir1 = path.join(tmpDir, "a");
    const dir2 = path.join(tmpDir, "b");
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    const found = searchPipelineFile([dir1, dir2], "nonexistent");
    expect(found).toBeNull();
  });

  it("returns null for empty dirs array", () => {
    const found = searchPipelineFile([], "anything");
    expect(found).toBeNull();
  });
});

describe("listPipelinesFromDirs", () => {
  it("merges pipelines from multiple directories", () => {
    const dir1 = path.join(tmpDir, "repo");
    const dir2 = path.join(tmpDir, "ext");
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    writePipeline(path.join("repo", "a.pipeline.yaml"), minimalPipelineYaml("a"));
    writePipeline(path.join("repo", "b.pipeline.yaml"), minimalPipelineYaml("b"));
    writePipeline(path.join("ext", "c.pipeline.yaml"), minimalPipelineYaml("c"));

    const result = listPipelinesFromDirs([dir1, dir2]);
    const names = result.map((r) => r.name).sort();
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("deduplicates by name (first dir wins)", () => {
    const dir1 = path.join(tmpDir, "user");
    const dir2 = path.join(tmpDir, "ext");
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    writePipeline(path.join("user", "release-check.pipeline.yaml"), minimalPipelineYaml("release-check"));
    writePipeline(path.join("ext", "release-check.pipeline.yaml"), minimalPipelineYaml("release-check-ext"));

    const result = listPipelinesFromDirs([dir1, dir2]);
    expect(result).toHaveLength(1);
    expect(result[0]!.file).toContain("user/release-check");
  });

  it("returns empty array for empty directories", () => {
    const dir1 = path.join(tmpDir, "empty1");
    const dir2 = path.join(tmpDir, "empty2");
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    const result = listPipelinesFromDirs([dir1, dir2]);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty dirs list", () => {
    const result = listPipelinesFromDirs([]);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadPipeline — validation errors (every branch)
// ---------------------------------------------------------------------------

describe("loadPipeline — file I/O errors", () => {
  it("throws PipelineValidationError when file does not exist", () => {
    expect(() => loadPipeline("/nonexistent/file.yaml")).toThrow(
      /Cannot read pipeline file/,
    );
  });

  it("throws PipelineValidationError on invalid YAML", () => {
    const f = writePipeline("bad.pipeline.yaml", "\t\t\tinvalid: [yaml: \n  bad indent]");
    expect(() => loadPipeline(f)).toThrow(/YAML parse error/);
  });
});

describe("loadPipeline — top-level structure validation", () => {
  it("throws when YAML parses to null", () => {
    const f = writePipeline("null.yaml", "null");
    expect(() => loadPipeline(f)).toThrow(/must be a YAML object/);
  });

  it("throws when YAML parses to a string", () => {
    const f = writePipeline("str.yaml", '"just a string"');
    expect(() => loadPipeline(f)).toThrow(/must be a YAML object/);
  });

  it("throws when YAML parses to a number", () => {
    const f = writePipeline("num.yaml", "42");
    expect(() => loadPipeline(f)).toThrow(/must be a YAML object/);
  });

  it("throws when YAML parses to an array", () => {
    const f = writePipeline("arr.yaml", "[1, 2, 3]");
    expect(() => loadPipeline(f)).toThrow(/must have a 'name' field/);
  });

  it("throws when name is missing", () => {
    const f = writePipeline("no-name.yaml", `description: "x"\nstages:\n  - id: s1\n    agent: w`);
    expect(() => loadPipeline(f)).toThrow(/must have a 'name' field/);
  });

  it("throws when name is empty string", () => {
    const f = writePipeline("empty-name.yaml", `name: ""\ndescription: "x"\nstages:\n  - id: s1\n    agent: w`);
    expect(() => loadPipeline(f)).toThrow(/must have a 'name' field/);
  });

  it("throws when name is whitespace-only", () => {
    const f = writePipeline("ws-name.yaml", `name: "   "\ndescription: "x"\nstages:\n  - id: s1\n    agent: w`);
    expect(() => loadPipeline(f)).toThrow(/must have a 'name' field/);
  });

  it("throws when name is not a string (number)", () => {
    const f = writePipeline("num-name.yaml", `name: 42\ndescription: "x"\nstages:\n  - id: s1\n    agent: w`);
    expect(() => loadPipeline(f)).toThrow(/must have a 'name' field/);
  });

  it("throws when description is missing", () => {
    const f = writePipeline("no-desc.yaml", `name: "test"\nstages:\n  - id: s1\n    agent: w`);
    expect(() => loadPipeline(f)).toThrow(/must have a 'description' field/);
  });

  it("throws when description is not a string", () => {
    const f = writePipeline("bad-desc.yaml", `name: "test"\ndescription: 42\nstages:\n  - id: s1\n    agent: w`);
    expect(() => loadPipeline(f)).toThrow(/must have a 'description' field/);
  });

  it("throws when stages is missing", () => {
    const f = writePipeline("no-stages.yaml", `name: "test"\ndescription: "x"`);
    expect(() => loadPipeline(f)).toThrow(/must have at least one stage/);
  });

  it("throws when stages is empty array", () => {
    const f = writePipeline("empty-stages.yaml", `name: "test"\ndescription: "x"\nstages: []`);
    expect(() => loadPipeline(f)).toThrow(/must have at least one stage/);
  });

  it("throws when stages is not an array", () => {
    const f = writePipeline("stages-obj.yaml", `name: "test"\ndescription: "x"\nstages:\n  id: s1`);
    expect(() => loadPipeline(f)).toThrow(/must have at least one stage/);
  });
});

describe("loadPipeline — stage validation", () => {
  it("throws when a stage is not an object", () => {
    const f = writePipeline("stage-null.yaml", `name: "test"\ndescription: "x"\nstages:\n  - null`);
    expect(() => loadPipeline(f)).toThrow(/Stage #1 must be an object/);
  });

  it("throws when a stage is a string", () => {
    const f = writePipeline("stage-str.yaml", `name: "test"\ndescription: "x"\nstages:\n  - "hello"`);
    expect(() => loadPipeline(f)).toThrow(/Stage #1 must be an object/);
  });

  it("throws when stage id is missing", () => {
    const f = writePipeline("no-id.yaml", `name: "test"\ndescription: "x"\nstages:\n  - agent: w`);
    expect(() => loadPipeline(f)).toThrow(/must have an 'id' field/);
  });

  it("throws when stage id is empty", () => {
    const f = writePipeline("empty-id.yaml", `name: "test"\ndescription: "x"\nstages:\n  - id: ""\n    agent: w`);
    expect(() => loadPipeline(f)).toThrow(/must have an 'id' field/);
  });

  it("throws when stage has no agent and no parallel", () => {
    const f = writePipeline("no-agent.yaml", `name: "test"\ndescription: "x"\nstages:\n  - id: s1`);
    expect(() => loadPipeline(f)).toThrow(/must have an 'agent' field/);
  });

  it("throws when stage has both agent and parallel", () => {
    const f = writePipeline("agent-and-parallel.yaml", `name: "test"\ndescription: "x"\nstages:\n  - id: s1\n    agent: worker\n    parallel:\n      - id: child\n        agent: scout`);
    expect(() => loadPipeline(f)).toThrow(/cannot have both 'agent' and 'parallel'/);
  });

  it("throws when a parallel child is nested parallel", () => {
    const f = writePipeline("nested-parallel.yaml", `name: "test"\ndescription: "x"\nstages:\n  - id: s1\n    parallel:\n      - id: child\n        parallel:\n          - id: nested\n            agent: scout`);
    expect(() => loadPipeline(f)).toThrow(/cannot use nested 'parallel' stages/);
  });

  it("throws when stage agent is empty string", () => {
    const f = writePipeline("empty-agent.yaml", `name: "test"\ndescription: "x"\nstages:\n  - id: s1\n    agent: ""`);
    expect(() => loadPipeline(f)).toThrow(/must have an 'agent' field/);
  });

  it("throws when stage agent is not a string", () => {
    const f = writePipeline("num-agent.yaml", `name: "test"\ndescription: "x"\nstages:\n  - id: s1\n    agent: 42`);
    expect(() => loadPipeline(f)).toThrow(/must have an 'agent' field/);
  });

  it("throws when parallel child has no id", () => {
    const f = writePipeline(
      "parallel-no-id.yaml",
      `name: "test"\ndescription: "x"\nstages:\n  - id: s1\n    parallel:\n      - agent: w`,
    );
    expect(() => loadPipeline(f)).toThrow(/must have an 'id' field/);
  });
});

describe("loadPipeline — gate validation", () => {
  it("throws when gate is not an object", () => {
    const f = writePipeline(
      "gate-str.yaml",
      `name: "test"\ndescription: "x"\nstages:\n  - id: s1\n    agent: w\n    gate: "review-loop"`,
    );
    expect(() => loadPipeline(f)).toThrow(/gate must be an object/);
  });

  it("throws when gate.type is not review-loop", () => {
    const f = writePipeline(
      "gate-type.yaml",
      `name: "test"\ndescription: "x"\nstages:\n  - id: s1\n    agent: w\n    gate:\n      type: something-else\n      reviewers:\n        - focus: "check quality"`,
    );
    expect(() => loadPipeline(f)).toThrow(/gate.type must be "review-loop"/);
  });

  it("throws when gate has no reviewers", () => {
    const f = writePipeline(
      "gate-no-reviewers.yaml",
      `name: "test"\ndescription: "x"\nstages:\n  - id: s1\n    agent: w\n    gate:\n      type: review-loop`,
    );
    expect(() => loadPipeline(f)).toThrow(/must have at least one reviewer/);
  });

  it("throws when reviewers is empty array", () => {
    const f = writePipeline(
      "gate-empty-reviewers.yaml",
      `name: "test"\ndescription: "x"\nstages:\n  - id: s1\n    agent: w\n    gate:\n      type: review-loop\n      reviewers: []`,
    );
    expect(() => loadPipeline(f)).toThrow(/must have at least one reviewer/);
  });

  it("throws when a reviewer is not an object", () => {
    const f = writePipeline(
      "gate-bad-reviewer.yaml",
      `name: "test"\ndescription: "x"\nstages:\n  - id: s1\n    agent: w\n    gate:\n      type: review-loop\n      reviewers:\n        - "just a string"`,
    );
    expect(() => loadPipeline(f)).toThrow(/reviewer #1 must be an object/);
  });

  it("throws when a reviewer has no focus", () => {
    const f = writePipeline(
      "gate-no-focus.yaml",
      `name: "test"\ndescription: "x"\nstages:\n  - id: s1\n    agent: w\n    gate:\n      type: review-loop\n      reviewers:\n        - agent: reviewer`,
    );
    expect(() => loadPipeline(f)).toThrow(/must have a 'focus' string/);
  });

  it("throws when a reviewer focus is empty", () => {
    const f = writePipeline(
      "gate-empty-focus.yaml",
      `name: "test"\ndescription: "x"\nstages:\n  - id: s1\n    agent: w\n    gate:\n      type: review-loop\n      reviewers:\n        - focus: ""`,
    );
    expect(() => loadPipeline(f)).toThrow(/must have a 'focus' string/);
  });

  it("throws when a reviewer focus is not a string", () => {
    const f = writePipeline(
      "gate-num-focus.yaml",
      `name: "test"\ndescription: "x"\nstages:\n  - id: s1\n    agent: w\n    gate:\n      type: review-loop\n      reviewers:\n        - focus: 42`,
    );
    expect(() => loadPipeline(f)).toThrow(/must have a 'focus' string/);
  });
});

describe("loadPipeline — stage report validation", () => {
  it("throws when stage report is not an object", () => {
    const f = writePipeline(
      "stage-report-str.yaml",
      `name: "test"
description: "x"
stages:
  - id: s1
    agent: worker
    report: "summary"`,
    );
    expect(() => loadPipeline(f)).toThrow(/report must be an object/);
  });

  it("throws when stage report mode is invalid", () => {
    const f = writePipeline(
      "stage-report-bad-mode.yaml",
      `name: "test"
description: "x"
stages:
  - id: s1
    agent: worker
    report:
      mode: compress`,
    );
    expect(() => loadPipeline(f)).toThrow(/report.mode must be "full" or "summary"/);
  });

  it("throws when stage report maxLength is not positive", () => {
    const f = writePipeline(
      "stage-report-bad-length.yaml",
      `name: "test"
description: "x"
stages:
  - id: s1
    agent: worker
    report:
      mode: summary
      maxLength: 0`,
    );
    expect(() => loadPipeline(f)).toThrow(/report.maxLength must be a positive number/);
  });

  it("throws when stage report instruction is not a string", () => {
    const f = writePipeline(
      "stage-report-bad-instruction.yaml",
      `name: "test"
description: "x"
stages:
  - id: s1
    agent: worker
    report:
      mode: summary
      instruction: 123`,
    );
    expect(() => loadPipeline(f)).toThrow(/report.instruction must be a string/);
  });
});

// ---------------------------------------------------------------------------
// loadPipeline — success cases
// ---------------------------------------------------------------------------

describe("loadPipeline — valid pipelines", () => {
  it("loads a minimal pipeline with defaults", () => {
    const f = writePipeline("minimal.yaml", minimalPipelineYaml("my-pipe"));
    const result = loadPipeline(f);
    expect(result.name).toBe("my-pipe");
    expect(result.description).toBe("A test pipeline");
    expect(result.version).toBe(1); // default
    expect(result.judgeModel).toBeUndefined();
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.id).toBe("stage1");
    expect(result.stages[0]!.agent).toBe("worker");
    expect(result.stages[0]!.task).toBe("Do something");
    expect(result.stages[0]!.gate).toBeUndefined();
  });

  it("loads a pipeline with explicit version and judgeModel", () => {
    const f = writePipeline(
      "advanced.yaml",
      `name: "advanced"\ndescription: "Advanced pipeline"\nversion: 2\njudgeModel: "gpt-5"\nstages:\n  - id: plan\n    agent: planner\n    task: "Plan {task}"`,
    );
    const result = loadPipeline(f);
    expect(result.version).toBe(2);
    expect(result.judgeModel).toBe("gpt-5");
  });

  it("loads a pipeline with a gate having explicit maxRounds and targetScore", () => {
    const f = writePipeline(
      "gated.yaml",
      `name: "gated"\ndescription: "With gate"\nstages:\n  - id: check\n    agent: worker\n    task: "Do work"\n    gate:\n      type: review-loop\n      maxRounds: 5\n      targetScore: 7\n      reviewers:\n        - focus: "Quality"\n          agent: "code-reviewer"\n        - focus: "Security"`,
    );
    const result = loadPipeline(f);
    const gate = result.stages[0]!.gate!;
    expect(gate.maxRounds).toBe(5);
    expect(gate.targetScore).toBe(7);
    expect(gate.reviewers).toHaveLength(2);
    expect(gate.reviewers[0]!.agent).toBe("code-reviewer");
    expect(gate.reviewers[0]!.focus).toBe("Quality");
    expect(gate.reviewers[1]!.agent).toBe("reviewer"); // default
    expect(gate.reviewers[1]!.focus).toBe("Security");
  });

  it("loads a gate with default maxRounds (3) and targetScore (8)", () => {
    const f = writePipeline(
      "gate-defaults.yaml",
      `name: "gate-defaults"\ndescription: "Test defaults"\nstages:\n  - id: g\n    agent: w\n    gate:\n      type: review-loop\n      reviewers:\n        - focus: "Check"`,
    );
    const result = loadPipeline(f);
    const gate = result.stages[0]!.gate!;
    expect(gate.maxRounds).toBe(3);
    expect(gate.targetScore).toBe(8);
  });

  it("loads a parallel stage", () => {
    const f = writePipeline(
      "parallel.yaml",
      `name: "parallel"\ndescription: "Parallel test"\nstages:\n  - id: par\n    parallel:\n      - id: a\n        agent: scout\n        task: "Task A"\n      - id: b\n        agent: oracle\n        task: "Task B"`,
    );
    const result = loadPipeline(f);
    expect(result.stages[0]!.parallel).toHaveLength(2);
    expect(result.stages[0]!.parallel![0]!.id).toBe("a");
    expect(result.stages[0]!.parallel![0]!.agent).toBe("scout");
    expect(result.stages[0]!.parallel![1]!.id).toBe("b");
    // Parallel stage has no top-level agent
    expect(result.stages[0]!.agent).toBeUndefined();
    // Default task for parallel children
    expect(result.stages[0]!.parallel![0]!.task).toBe("Task A");
  });

  it("loads a stage with optional fields (model, output, reads, maxSubagentDepth)", () => {
    const f = writePipeline(
      "full-stage.yaml",
      `name: "full"\ndescription: "Full stage"\nstages:\n  - id: s1\n    agent: worker\n    task: "Do it"\n    model: "gpt-5"\n    output: "result.txt"\n    reads:\n      - "file1.ts"\n      - "file2.ts"\n    maxSubagentDepth: 3`,
    );
    const result = loadPipeline(f);
    const stage = result.stages[0]!;
    expect(stage.model).toBe("gpt-5");
    expect(stage.output).toBe("result.txt");
    expect(stage.reads).toEqual(["file1.ts", "file2.ts"]);
    expect(stage.maxSubagentDepth).toBe(3);
  });

  it("loads a stage-level report config for output compression", () => {
    const f = writePipeline(
      "stage-report.yaml",
      `name: "stage-report"
description: "Stage report"
stages:
  - id: s1
    agent: worker
    task: "Do it"
    report:
      mode: summary
      maxLength: 500
      instruction: "Summarize only user-facing risks"`,
    );
    const result = loadPipeline(f);
    expect(result.stages[0]!.report).toEqual({
      mode: "summary",
      maxLength: 500,
      instruction: "Summarize only user-facing risks",
    });
  });

  it("loads a stage-level report config with full mode", () => {
    const f = writePipeline(
      "stage-report-full.yaml",
      `name: "stage-report-full"
description: "Stage report full"
stages:
  - id: s1
    agent: worker
    report:
      mode: full`,
    );
    const result = loadPipeline(f);
    expect(result.stages[0]!.report).toEqual({ mode: "full" });
  });

  it("loads a stage without explicit task — generates default", () => {
    const f = writePipeline(
      "default-task.yaml",
      `name: "default-task"\ndescription: "Test default task"\nstages:\n  - id: s1\n    agent: worker`,
    );
    const result = loadPipeline(f);
    expect(result.stages[0]!.task).toBe("Execute task for stage: s1");
  });

  it("loads a stage with judgeModel on the gate", () => {
    const f = writePipeline(
      "gate-judge-model.yaml",
      `name: "gate-judge"\ndescription: "Judge model"\nstages:\n  - id: s1\n    agent: w\n    gate:\n      type: review-loop\n      maxRounds: 3\n      targetScore: 8\n      judgeModel: "gpt-5-judge"\n      reviewers:\n        - focus: "Check"`,
    );
    const result = loadPipeline(f);
    expect(result.stages[0]!.gate!.judgeModel).toBe("gpt-5-judge");
  });

  it("trims whitespace from name, description, and other string fields", () => {
    const f = writePipeline(
      "trim.yaml",
      `name: "  trimmed  "\ndescription: "  desc  "\nstages:\n  - id: "  sid  "\n    agent: "  worker  "`,
    );
    const result = loadPipeline(f);
    expect(result.name).toBe("trimmed");
    expect(result.description).toBe("desc");
    expect(result.stages[0]!.id).toBe("sid");
    expect(result.stages[0]!.agent).toBe("worker");
  });

  it("loads a multi-stage pipeline", () => {
    const f = writePipeline(
      "multi.yaml",
      `name: "multi"\ndescription: "Multiple stages"\nstages:\n  - id: a\n    agent: scout\n  - id: b\n    agent: worker\n    gate:\n      type: review-loop\n      reviewers:\n        - focus: "Review"\n  - id: c\n    parallel:\n      - id: c1\n        agent: oracle`,
    );
    const result = loadPipeline(f);
    expect(result.stages).toHaveLength(3);
    // Stage a
    expect(result.stages[0]!.agent).toBe("scout");
    // Stage b — with gate
    expect(result.stages[1]!.agent).toBe("worker");
    expect(result.stages[1]!.gate).toBeDefined();
    // Stage c — parallel
    expect(result.stages[2]!.parallel).toHaveLength(1);
    expect(result.stages[2]!.parallel![0]!.agent).toBe("oracle");
  });

  it("parses report: false as disabled", () => {
    const f = writePipeline(
      "no-report.yaml",
      `name: no-report
description: "No report"
report: false
stages:
  - id: s1
    agent: worker
    task: "Task"`,
    );
    const result = loadPipeline(f);
    expect(result.report).toBe(false);
  });

  it("parses report config with agent and focus", () => {
    const f = writePipeline(
      "with-report.yaml",
      `name: with-report
description: "Has report"
report:
  agent: oracle
  focus: "release check"
stages:
  - id: s1
    agent: worker
    task: "Task"`,
    );
    const result = loadPipeline(f);
    expect(result.report).not.toBe(false);
    expect(result.report).not.toBeUndefined();
    const r = result.report as Record<string, unknown>;
    expect(r.agent).toBe("oracle");
    expect(r.focus).toBe("release check");
  });

  it("parses report config with agent only", () => {
    const f = writePipeline(
      "report-agent.yaml",
      `name: report-agent
description: "Report agent only"
report:
  agent: planner
stages:
  - id: s1
    agent: worker
    task: "Task"`,
    );
    const result = loadPipeline(f);
    expect(result.report).not.toBeUndefined();
    const r = result.report as Record<string, unknown>;
    expect(r.agent).toBe("planner");
    expect(r.focus).toBeUndefined();
  });

  it("omits report when not specified in YAML", () => {
    const f = writePipeline(
      "default.yaml",
      `name: default
description: "No report field"
stages:
  - id: s1
    agent: worker
    task: "Task"`,
    );
    const result = loadPipeline(f);
    expect(result.report).toBeUndefined();
  });

  it("loads a pipeline with expand referencing a previous stage", () => {
    const f = writePipeline(
      "expand-valid.yaml",
      `name: "expand-valid"
description: "Valid expand"
stages:
  - id: discover
    agent: scout
    task: "Find items"
  - id: process-each
    agent: worker
    task: "Process {item.value}"
    expand:
      from: discover
      maxItems: 5`,
    );
    const result = loadPipeline(f);
    expect(result.stages).toHaveLength(2);
    expect(result.stages[1]!.expand).toBeDefined();
    expect(result.stages[1]!.expand!.from).toBe("discover");
    expect(result.stages[1]!.expand!.maxItems).toBe(5);
  });

  it("loads a pipeline with expand and default maxItems", () => {
    const f = writePipeline(
      "expand-default-max.yaml",
      `name: "expand-default-max"
description: "Expand with defaults"
stages:
  - id: a
    agent: scout
  - id: b
    agent: worker
    task: "Process {item}"
    expand:
      from: a`,
    );
    const result = loadPipeline(f);
    expect(result.stages[1]!.expand!.from).toBe("a");
    expect(result.stages[1]!.expand!.maxItems).toBeUndefined();
  });
});

describe("loadPipeline — expand validation", () => {
  it("throws when expand.from is missing", () => {
    const f = writePipeline(
      "expand-no-from.yaml",
      `name: "expand-no-from"
description: "Missing from"
stages:
  - id: a
    agent: scout
  - id: b
    agent: worker
    task: "Process"
    expand:
      maxItems: 3`,
    );
    expect(() => loadPipeline(f)).toThrow(/expand.from must be a non-empty string/);
  });

  it("throws when expand.from is empty", () => {
    const f = writePipeline(
      "expand-empty-from.yaml",
      `name: "expand-empty-from"
description: "Empty from"
stages:
  - id: a
    agent: scout
  - id: b
    agent: worker
    expand:
      from: ""`,
    );
    expect(() => loadPipeline(f)).toThrow(/expand.from must be a non-empty string/);
  });

  it("throws when expand.from references a stage that doesn't exist", () => {
    const f = writePipeline(
      "expand-bad-ref.yaml",
      `name: "expand-bad-ref"
description: "Bad reference"
stages:
  - id: a
    agent: scout
  - id: b
    agent: worker
    expand:
      from: nonexistent`,
    );
    expect(() => loadPipeline(f)).toThrow(/does not match any stage/);
  });

  it("throws when expand.from references the same stage (self-reference)", () => {
    const f = writePipeline(
      "expand-self-ref.yaml",
      `name: "expand-self-ref"
description: "Self reference"
stages:
  - id: a
    agent: scout
  - id: b
    agent: worker
    expand:
      from: b`,
    );
    expect(() => loadPipeline(f)).toThrow(/does not match any stage/);
  });

  it("throws when expand.from references a stage defined after the current one", () => {
    const f = writePipeline(
      "expand-future-ref.yaml",
      `name: "expand-future-ref"
description: "Future reference"
stages:
  - id: a
    agent: scout
    expand:
      from: b
  - id: b
    agent: worker`,
    );
    expect(() => loadPipeline(f)).toThrow(/does not match any stage/);
  });

  it("throws when expand is not an object", () => {
    const f = writePipeline(
      "expand-not-obj.yaml",
      `name: "expand-not-obj"
description: "Not an object"
stages:
  - id: a
    agent: scout
  - id: b
    agent: worker
    expand: "just a string"`,
    );
    expect(() => loadPipeline(f)).toThrow(/expand must be an object/);
  });

  it("throws when expand.maxItems is zero", () => {
    const f = writePipeline(
      "expand-max-zero.yaml",
      `name: "expand-max-zero"
description: "Max zero"
stages:
  - id: a
    agent: scout
  - id: b
    agent: worker
    expand:
      from: a
      maxItems: 0`,
    );
    expect(() => loadPipeline(f)).toThrow(/expand.maxItems must be a positive number/);
  });

  it("throws when expand.maxItems is negative", () => {
    const f = writePipeline(
      "expand-max-negative.yaml",
      `name: "expand-max-negative"
description: "Max negative"
stages:
  - id: a
    agent: scout
  - id: b
    agent: worker
    expand:
      from: a
      maxItems: -1`,
    );
    expect(() => loadPipeline(f)).toThrow(/expand.maxItems must be a positive number/);
  });

  it("throws when expand.maxItems is not a number", () => {
    const f = writePipeline(
      "expand-max-string.yaml",
      `name: "expand-max-string"
description: "Max string"
stages:
  - id: a
    agent: scout
  - id: b
    agent: worker
    expand:
      from: a
      maxItems: five`,
    );
    expect(() => loadPipeline(f)).toThrow(/expand.maxItems must be a positive number/);
  });
});
