/**
 * Tests for tui-widgets.ts — pipeline result rendering components.
 *
 * These components depend on @earendil-works/pi-tui for Container, Text, Spacer.
 * We mock the TUI classes since they need the Pi runtime.
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @earendil-works/pi-tui — vi.mock is hoisted by Vitest
// ---------------------------------------------------------------------------

vi.mock("@earendil-works/pi-tui", () => {
  class MockContainer {
    children: unknown[] = [];
    addChild(child: unknown) { this.children.push(child); }
  }
  class MockText {
    text: string;
    constructor(text: string, ..._args: unknown[]) { this.text = text; }
  }
  class MockSpacer {}
  return { Container: MockContainer, Text: MockText, Spacer: MockSpacer };
});

import { createPipelineResultComponent } from "../extensions/tui-widgets.ts";
import type { PipelineResult, StageResult } from "../extensions/types.ts";

// ---------------------------------------------------------------------------
// Mock ThemeAccessor
// ---------------------------------------------------------------------------

const mockTheme = {
  fg: (_category: string, text: string) => text,
  bg: (_category: string, text: string) => text,
  bold: (text: string) => text,
};

/** Check if a component has the addChild method — duck-type for Container */
function isContainer(c: unknown): boolean {
  return typeof c === "object" && c !== null && "addChild" in c && typeof (c as Record<string, unknown>).addChild === "function";
}

/** Check if a component has a text property — duck-type for Text */
function isText(c: unknown): c is { text: string } {
  return typeof c === "object" && c !== null && "text" in c;
}

/** Extract text from text components, recursively */
function extractTexts(component: unknown): string[] {
  if (isContainer(component)) {
    return (component.children as unknown[]).flatMap((child: unknown) => extractTexts(child));
  }
  if (isText(component)) {
    return [component.text];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPipelineResultComponent", () => {
  it("returns a container with children for successful pipeline", () => {
    const result: PipelineResult = {
      pipelineName: "test-pipe",
      task: "do something",
      success: true,
      stages: [],
      totalDurationMs: 500,
    };

    const component = createPipelineResultComponent(result, mockTheme);
    expect(isContainer(component)).toBe(true);
    const container = component as { children: unknown[] };
    expect(container.children.length).toBeGreaterThanOrEqual(4);
  });

  it("includes pipeline name and status in rendered output", () => {
    const result: PipelineResult = {
      pipelineName: "my-pipeline",
      task: "my task",
      success: true,
      stages: [],
      totalDurationMs: 100,
    };

    const component = createPipelineResultComponent(result, mockTheme);
    const texts = extractTexts(component);
    const combined = texts.join(" ");
    expect(combined).toContain("my-pipeline");
    expect(combined).toContain("my task");
  });

  it("renders stage details with rounds and scores", () => {
    const stage: StageResult = {
      stageId: "review-stage",
      success: true,
      output: "Work product",
      durationMs: 2000,
      rounds: 2,
      scores: [7, 8],
    };

    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: true,
      stages: [stage],
      totalDurationMs: 3000,
    };

    const component = createPipelineResultComponent(result, mockTheme);
    const texts = extractTexts(component);
    const combined = texts.join(" ");
    expect(combined).toContain("review-stage");
  });

  it("shows error for failed stages", () => {
    const stage: StageResult = {
      stageId: "failed-stage",
      success: false,
      output: "",
      error: "Something broke",
      durationMs: 100,
    };

    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: false,
      stages: [stage],
      totalDurationMs: 200,
    };

    const component = createPipelineResultComponent(result, mockTheme);
    const texts = extractTexts(component);
    const combined = texts.join(" ");
    expect(combined).toContain("Something broke");
    expect(combined).toContain("failed-stage");
  });

  it("shows fatal error when no stages have individual errors", () => {
    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: false,
      stages: [],
      totalDurationMs: 0,
      error: "Fatal pipeline error",
    };

    const component = createPipelineResultComponent(result, mockTheme);
    const texts = extractTexts(component);
    const combined = texts.join(" ");
    expect(combined).toContain("Fatal pipeline error");
  });

  it("handles parallel stage results without rounds or scores", () => {
    const stage: StageResult = {
      stageId: "parallel-stage",
      success: true,
      output: "All good",
      durationMs: 1500,
    };

    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: true,
      stages: [stage],
      totalDurationMs: 1600,
    };

    const component = createPipelineResultComponent(result, mockTheme);
    const texts = extractTexts(component);
    const combined = texts.join(" ");
    expect(combined).toContain("parallel-stage");
  });

  it("formats duration in seconds for results 1000-59999ms", () => {
    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: true,
      stages: [],
      totalDurationMs: 1500,
    };
    const component = createPipelineResultComponent(result, mockTheme);
    const texts = extractTexts(component);
    const combined = texts.join(" ");
    expect(combined).toContain("1.5s");
  });

  it("formats duration in minutes for results >=60000ms", () => {
    const result: PipelineResult = {
      pipelineName: "p",
      task: "t",
      success: true,
      stages: [],
      totalDurationMs: 90000,
    };
    const component = createPipelineResultComponent(result, mockTheme);
    const texts = extractTexts(component);
    const combined = texts.join(" ");
    expect(combined).toContain("1m");
  });
});
