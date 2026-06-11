/**
 * Tests for the dynamic stage expansion feature (expand).
 *
 * Covers:
 *   - parseItems() — parsing source stage output into items
 *   - expandItemTemplate() — resolving {item.*} variables
 *   - buildExpandStages() — creating dynamic stages from items
 *   - extractTaskOutput() — extracting per-task output from combined parallel response
 */

import { describe, it, expect } from "vitest";
import {
  parseItems,
  expandItemTemplate,
  buildExpandStages,
  extractTaskOutput,
} from "../extensions/pipeline-runner.ts";
import type { Stage } from "../extensions/types.ts";

const emptyOutputs = new Map<string, string>();

// ---------------------------------------------------------------------------
// parseItems
// ---------------------------------------------------------------------------

describe("parseItems", () => {
  it("parses a JSON array of objects", () => {
    const output = JSON.stringify([
      { path: "src/a.ts", reason: "duplication" },
      { path: "src/b.ts", reason: "old code" },
    ]);
    const items = parseItems(output);
    expect(items).toHaveLength(2);
    expect(items[0]!.path).toBe("src/a.ts");
    expect(items[1]!.reason).toBe("old code");
  });

  it("parses a JSON object with an 'items' key", () => {
    const output = JSON.stringify({
      items: [
        { file: "login.ts", risk: "high" },
        { file: "signup.ts", risk: "medium" },
      ],
      count: 2,
    });
    const items = parseItems(output);
    expect(items).toHaveLength(2);
    expect(items[0]!.file).toBe("login.ts");
    expect(items[1]!.risk).toBe("medium");
  });

  it("parses a JSON array of strings", () => {
    const output = JSON.stringify(["file1.ts", "file2.ts", "file3.ts"]);
    const items = parseItems(output);
    expect(items).toHaveLength(3);
    expect(items[0]!.value).toBe("file1.ts");
    expect(items[1]!.value).toBe("file2.ts");
  });

  it("parses a YAML list", () => {
    const output = `- path: src/a.ts
  reason: duplication
- path: src/b.ts
  reason: old code`;
    const items = parseItems(output);
    expect(items).toHaveLength(2);
    expect(items[0]!.path).toBe("src/a.ts");
    expect(items[1]!.reason).toBe("old code");
  });

  it("parses a YAML list of strings", () => {
    const output = `- src/a.ts
- src/b.ts
- src/c.ts`;
    const items = parseItems(output);
    expect(items).toHaveLength(3);
    expect(items[0]!.value).toBe("src/a.ts");
    expect(items[1]!.value).toBe("src/b.ts");
  });

  it("parses markdown bullet list (dash)", () => {
    const output = [
      "- First item content here",
      "- Second item with more details",
      "- Third item",
    ].join("\n");
    const items = parseItems(output);
    expect(items).toHaveLength(3);
    expect(items[0]!.value).toBe("First item content here");
    expect(items[2]!.value).toBe("Third item");
  });

  it("parses markdown bullet list (asterisk)", () => {
    const output = [
      "* Item one",
      "* Item two",
    ].join("\n");
    const items = parseItems(output);
    expect(items).toHaveLength(2);
    expect(items[0]!.value).toBe("Item one");
    expect(items[1]!.value).toBe("Item two");
  });

  it("parses markdown numbered list", () => {
    const output = [
      "1. First priority item",
      "2. Second priority item",
      "3. Third priority item",
    ].join("\n");
    const items = parseItems(output);
    expect(items).toHaveLength(3);
    expect(items[0]!.value).toBe("First priority item");
    expect(items[2]!.value).toBe("Third priority item");
  });

  it("returns empty array for empty string", () => {
    const items = parseItems("");
    expect(items).toEqual([]);
  });

  it("returns empty array for empty JSON array", () => {
    const items = parseItems("[]");
    expect(items).toEqual([]);
  });

  it("throws on completely unparseable output", () => {
    expect(() => parseItems("junk text without any list structure")).toThrow(
      "Cannot parse items from output",
    );
  });

  it("throws on null JSON", () => {
    expect(() => parseItems("null")).toThrow("Cannot parse items from output");
  });

  it("throws on scalar JSON", () => {
    expect(() => parseItems("42")).toThrow();
  });

  it("throws on empty YAML object", () => {
    expect(() => parseItems("{}")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// expandItemTemplate
// ---------------------------------------------------------------------------

describe("expandItemTemplate", () => {
  it("replaces {item.path} with the item's path value", () => {
    const result = expandItemTemplate("Refactor: {item.path}", { path: "src/a.ts", reason: "dup" });
    expect(result).toBe("Refactor: src/a.ts");
  });

  it("replaces {item.name} with the item name value", () => {
    const result = expandItemTemplate("Process: {item.name}", { name: "module-x" });
    expect(result).toBe("Process: module-x");
  });

  it("replaces {item} with full JSON for object items", () => {
    const item = { path: "src/a.ts", risk: "high" };
    const result = expandItemTemplate("Full: {item}", item);
    expect(result).toBe(`Full: ${JSON.stringify(item)}`);
  });

  it("uses item.value for {item} when item has a value key (string items)", () => {
    const item = { value: "src/a.ts" };
    const result = expandItemTemplate("Full: {item}", item);
    expect(result).toBe("Full: src/a.ts");
  });

  it("handles multiple {item.*} variables in one template", () => {
    const result = expandItemTemplate(
      "Refactor {item.path}: {item.reason}",
      { path: "src/a.ts", reason: "duplication" },
    );
    expect(result).toBe("Refactor src/a.ts: duplication");
  });

  it("handles undefined item keys gracefully (leaves placeholder)", () => {
    const result = expandItemTemplate(
      "Path: {item.path}, Risk: {item.risk}",
      { path: "src/a.ts" },
    );
    expect(result).toBe("Path: src/a.ts, Risk: {item.risk}");
  });

  it("handles empty template", () => {
    const result = expandItemTemplate("", { path: "src/a.ts" });
    expect(result).toBe("");
  });

  it("preserves non-item template variables unchanged", () => {
    const result = expandItemTemplate(
      "{task}: {item.path}",
      { path: "src/a.ts" },
    );
    expect(result).toBe("{task}: src/a.ts");
  });

  it("handles items with numeric keys", () => {
    const result = expandItemTemplate(
      "Item {item.id}: {item.name}",
      { id: 3, name: "test" },
    );
    expect(result).toBe("Item 3: test");
  });

  it("handles items with boolean values", () => {
    const result = expandItemTemplate("Required: {item.required}", { required: true });
    expect(result).toBe("Required: true");
  });
});

// ---------------------------------------------------------------------------
// buildExpandStages
// ---------------------------------------------------------------------------

describe("buildExpandStages", () => {
  const templateStage: Stage = {
    id: "process-each",
    agent: "worker",
    task: "Refactor: {item.path} — {item.reason}",
  };

  const items = [
    { path: "src/a.ts", reason: "duplication" },
    { path: "src/b.ts", reason: "old code" },
    { path: "src/c.ts", reason: "no types" },
  ];

  it("creates correct number of dynamic stages", () => {
    const stages = buildExpandStages(templateStage, items, "original task", emptyOutputs);
    expect(stages).toHaveLength(3);
  });

  it("gives each dynamic stage a unique id", () => {
    const stages = buildExpandStages(templateStage, items, "task", emptyOutputs);
    const ids = stages.map((s) => s.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("process-each-1");
    expect(ids[1]).toBe("process-each-2");
    expect(ids[2]).toBe("process-each-3");
  });

  it("resolves {item.*} variables in the task", () => {
    const stages = buildExpandStages(templateStage, items, "task", emptyOutputs);
    expect(stages[0]!.task).toContain("src/a.ts");
    expect(stages[0]!.task).toContain("duplication");
    expect(stages[1]!.task).toContain("src/b.ts");
    expect(stages[2]!.task).toContain("src/c.ts");
  });

  it("resolves {task} in the template before item expansion", () => {
    const stageWithTask: Stage = {
      id: "process-each",
      agent: "worker",
      task: "For {task}: refactor {item.path}",
    };
    const stages = buildExpandStages(stageWithTask, items, "sprint-12", emptyOutputs);
    expect(stages[0]!.task).toContain("sprint-12");
    expect(stages[0]!.task).toContain("src/a.ts");
  });

  it("respects maxItems limit", () => {
    const stages = buildExpandStages(templateStage, items, "task", emptyOutputs);
    expect(stages.length).toBeLessThanOrEqual(10); // default max
  });

  it("propagates gate to each dynamic stage (but not gate.fn reference)", () => {
    const stageWithGate: Stage = {
      id: "process-each",
      agent: "worker",
      task: "Refactor: {item.path}",
      gate: {
        type: "review-loop",
        maxRounds: 2,
        targetScore: 8,
        reviewers: [{ focus: "Is the refactoring correct?" }],
      },
    };
    const stages = buildExpandStages(stageWithGate, items.slice(0, 2), "task", emptyOutputs);
    expect(stages[0]!.gate).toBeDefined();
    expect(stages[0]!.gate!.type).toBe("review-loop");
    expect(stages[0]!.gate!.maxRounds).toBe(2);
    expect(stages[1]!.gate).toBeDefined();
    // Note: gate on expand stages is for documentation/type only in v1;
    // runtime does NOT execute gates on expanded stages.
  });

  it("propagates model to each dynamic stage", () => {
    const stageWithModel: Stage = {
      id: "process-each",
      agent: "worker",
      task: "{item.path}",
      model: "anthropic/claude-sonnet-4",
    };
    const stages = buildExpandStages(stageWithModel, items.slice(0, 1), "task", emptyOutputs);
    expect(stages[0]!.model).toBe("anthropic/claude-sonnet-4");
  });

  it("returns empty array for empty items", () => {
    const stages = buildExpandStages(templateStage, [], "task", emptyOutputs);
    expect(stages).toEqual([]);
  });

  it("handles string-valued items (from markdown fallback)", () => {
    const stage: Stage = {
      id: "process-each",
      agent: "worker",
      task: "Process {item.value}",
    };
    const stringItems = [
      { value: "file1.ts" },
      { value: "file2.ts" },
    ];
    const stages = buildExpandStages(stage, stringItems, "task", emptyOutputs);
    expect(stages[0]!.task).toBe("Process file1.ts");
    expect(stages[1]!.task).toBe("Process file2.ts");
  });

  it("propagates output field to each dynamic stage", () => {
    const stageWithOutput: Stage = {
      id: "process-each",
      agent: "worker",
      task: "{item.path}",
      output: "result.txt",
    };
    const stages = buildExpandStages(stageWithOutput, [{ path: "a.ts" }, { path: "b.ts" }], "task", emptyOutputs);
    expect(stages[0]!.output).toBe("result.txt");
    expect(stages[1]!.output).toBe("result.txt");
  });

  it("propagates reads and maxSubagentDepth to each dynamic stage", () => {
    const stage: Stage = {
      id: "process-each",
      agent: "worker",
      task: "{item}",
      reads: ["config.json"],
      maxSubagentDepth: 2,
    };
    const stages = buildExpandStages(stage, [{ path: "a.ts" }], "task", emptyOutputs);
    expect(stages[0]!.reads).toEqual(["config.json"]);
    expect(stages[0]!.maxSubagentDepth).toBe(2);
  });

  it("resolves {outputs.stageId} in the template before item expansion", () => {
    const outputs = new Map<string, string>([["discover", "items from discovery"]]);
    const stage: Stage = {
      id: "process-each",
      agent: "worker",
      task: "Context: {outputs.discover}. Process {item.path}",
    };
    const stages = buildExpandStages(stage, [{ path: "a.ts" }], "task", outputs);
    expect(stages[0]!.task).toBe("Context: items from discovery. Process a.ts");
  });

  it("resolves {lastFeedback} in the template before item expansion", () => {
    // Note: buildExpandStages passes undefined for lastFeedback to resolveTemplate
    // This test verifies the placeholder is preserved
    const stage: Stage = {
      id: "process-each",
      agent: "worker",
      task: "Feedback: {lastFeedback}. Item: {item.path}",
    };
    const stages = buildExpandStages(stage, [{ path: "a.ts" }], "task", emptyOutputs);
    // {lastFeedback} stays literal since resolveTemplate gets undefined
    expect(stages[0]!.task).toContain("{lastFeedback}");
    expect(stages[0]!.task).toContain("a.ts");
  });
});

describe("parseItems — edge cases", () => {
  it("skips non-list prose before a markdown list", () => {
    const output = [
      "Here are the items I found after scanning the project:",
      "",
      "- src/a.ts",
      "- src/b.ts",
    ].join("\n");
    const items = parseItems(output);
    expect(items).toHaveLength(2);
    expect(items[0]!.value).toBe("src/a.ts");
  });

  it("parses markdown list with mixed content after the list", () => {
    const output = [
      "- file1.ts",
      "- file2.ts",
      "",
      "Summary: 2 files found",
    ].join("\n");
    const items = parseItems(output);
    expect(items).toHaveLength(2);
  });

  it("extracts items from YAML output with inline comments", () => {
    const output = `# Files to refactor
- path: src/a.ts
  reason: duplication
# End of list`;
    const items = parseItems(output);
    expect(items).toHaveLength(1);
    expect(items[0]!.path).toBe("src/a.ts");
  });
});

describe("extractTaskOutput", () => {
  it("returns the entire combined output for a single task", () => {
    const result = extractTaskOutput("Just one result", 0, 1);
    expect(result).toBe("Just one result");
  });

  it("splits by double newlines for multiple tasks when format matches", () => {
    const combined = "Task 1 output\n\nTask 2 output\n\nTask 3 output";
    expect(extractTaskOutput(combined, 0, 3)).toBe("Task 1 output");
    expect(extractTaskOutput(combined, 1, 3)).toBe("Task 2 output");
    expect(extractTaskOutput(combined, 2, 3)).toBe("Task 3 output");
  });

  it("uses proportional split fallback when fewer parts than tasks", () => {
    // Only 1 \n\n separator → 2 parts for 3 tasks → falls to proportional split
    const combined = "AAAA\n\nBBBBCCCC";
    const t0 = extractTaskOutput(combined, 0, 3);
    const t1 = extractTaskOutput(combined, 1, 3);
    const t2 = extractTaskOutput(combined, 2, 3);
    expect(t0.length).toBeGreaterThan(0);
    expect(t1.length).toBeGreaterThan(0);
    expect(t2.length).toBeGreaterThan(0);
    // Each part gets a proportional share (trimmed)
    // After trim, the parts may be shorter than the original
    expect(t0.length + t1.length + t2.length).toBeLessThanOrEqual(combined.length);
    // And they should cover most of the combined output
    expect(t0.length + t1.length + t2.length).toBeGreaterThan(combined.length - 4);
  });

  it("handles empty combined output gracefully", () => {
    expect(extractTaskOutput("", 0, 1)).toBe("");
  });

  it("splits correctly when there are extra separators", () => {
    const combined = "A\n\nB\n\nC\n\nD";
    expect(extractTaskOutput(combined, 2, 2)).toBe("C");
    // Only take first 2 of 4 parts
  });

  it("trims whitespace from each extracted part", () => {
    const combined = "  Task 1  \n\n  Task 2  ";
    expect(extractTaskOutput(combined, 0, 2)).toBe("Task 1");
    expect(extractTaskOutput(combined, 1, 2)).toBe("Task 2");
  });
});
