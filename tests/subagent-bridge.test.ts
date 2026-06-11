/**
 * Tests for subagent-bridge.ts — extractResponseText and isSubagentAvailable
 */

import { describe, it, expect } from "vitest";
import {
  extractResponseText,
  isSubagentAvailable,
  executeSubagent,
} from "../extensions/subagent-bridge.ts";

// ---------------------------------------------------------------------------
// extractResponseText
// ---------------------------------------------------------------------------

describe("extractResponseText", () => {
  it("returns string content as-is", () => {
    const response = {
      requestId: "abc",
      result: { content: "Hello world" },
      isError: false,
    };
    expect(extractResponseText(response)).toBe("Hello world");
  });

  it("joins text blocks from array content", () => {
    const response = {
      requestId: "abc",
      result: {
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
          { type: "image", text: "skip me" },
        ],
      },
      isError: false,
    };
    expect(extractResponseText(response)).toBe("Part 1\nPart 2");
  });

  it("returns errorText when response.isError is true", () => {
    const response = {
      requestId: "",
      result: { content: "" },
      isError: true,
      errorText: "Something went wrong",
    };
    expect(extractResponseText(response)).toBe("Something went wrong");
  });

  it("returns '(error)' when isError but no errorText", () => {
    const response = {
      requestId: "",
      result: { content: "" },
      isError: true,
    };
    expect(extractResponseText(response)).toBe("(error)");
  });

  it("extracts from details.results array", () => {
    const response = {
      requestId: "abc",
      result: {
        content: "",
        details: {
          results: [
            { agent: "worker", output: "Output A" },
            { agent: "reviewer", output: "Output B" },
          ],
        },
      },
      isError: false,
    };
    const text = extractResponseText(response);
    expect(text).toContain("Output A");
    expect(text).toContain("Output B");
  });

  it("returns '(no output)' when no content or details available", () => {
    const response = {
      requestId: "abc",
      result: { content: "" },
      isError: false,
    };
    expect(extractResponseText(response)).toBe("(no output)");
  });

  it("returns '(no output)' when content is empty array", () => {
    const response = {
      requestId: "abc",
      result: { content: [] },
      isError: false,
    };
    expect(extractResponseText(response)).toBe("(no output)");
  });

  it("skips non-text content blocks", () => {
    const response = {
      requestId: "abc",
      result: {
        content: [
          { type: "image", text: "img" },
          { type: "code", text: "code" },
        ],
      },
      isError: false,
    };
    // No text blocks → empty join → "(no output)"
    const text = extractResponseText(response);
    expect(text).toBe("(no output)");
  });

  it("handles content as array with leading text", () => {
    const response = {
      requestId: "abc",
      result: {
        content: [
          { type: "text", text: "Leading analysis" },
          { type: "image", text: "chart" },
          { type: "text", text: "Trailing notes" },
        ],
      },
      isError: false,
    };
    expect(extractResponseText(response)).toBe("Leading analysis\nTrailing notes");
  });
});

// ---------------------------------------------------------------------------
// isSubagentAvailable
// ---------------------------------------------------------------------------

describe("isSubagentAvailable", () => {
  it("returns true optimistically", () => {
    // Mock pi API (minimal)
    const pi = {} as never;
    expect(isSubagentAvailable(pi)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executeSubagent — context defaulting
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock Pi API for testing executeSubagent.
 * Captures emitted "subagent:slash:request" payload.
 * The bridge times out after ~100ms (no bridge responder) — we catch that.
 */
function mockPiForSlash(): { pi: never; emitted: Array<{ requestId: string; params: Record<string, unknown> }> } {
  const emitted: Array<{ requestId: string; params: Record<string, unknown> }> = [];

  const pi = {
    events: {
      on: () => {
        // Return a noop unsubscriber
        return () => {};
      },
      emit: (event: string, data: unknown) => {
        if (event === "subagent:slash:request") {
          emitted.push(data as { requestId: string; params: Record<string, unknown> });
        }
      },
    },
  };

  return { pi: pi as never, emitted };
}

describe("executeSubagent context defaulting", () => {
  it("defaults context to 'fresh' when not specified", async () => {
    const { pi, emitted } = mockPiForSlash();

    // The bridge will timeout → rejection. Catch it and inspect what was emitted.
    await expect(executeSubagent(pi, {
      agent: "worker",
      task: "test task",
    })).rejects.toThrow();

    expect(emitted.length).toBe(1);
    const params = emitted[0]!.params;
    expect(params.context).toBe("fresh");
  });

  it("defaults context to 'fresh' for parallel tasks when not specified", async () => {
    const { pi, emitted } = mockPiForSlash();

    await expect(executeSubagent(pi, {
      tasks: [
        { agent: "worker", task: "task 1" },
        { agent: "reviewer", task: "task 2" },
      ],
    })).rejects.toThrow();

    expect(emitted.length).toBe(1);
    const params = emitted[0]!.params;
    expect(params.context).toBe("fresh");
  });

  it("preserves explicit context 'fork' when set", async () => {
    const { pi, emitted } = mockPiForSlash();

    await expect(executeSubagent(pi, {
      agent: "worker",
      task: "test task",
      context: "fork",
    })).rejects.toThrow();

    expect(emitted.length).toBe(1);
    const params = emitted[0]!.params;
    expect(params.context).toBe("fork");
  });

  it("preserves explicit context 'fresh' when set", async () => {
    const { pi, emitted } = mockPiForSlash();

    await expect(executeSubagent(pi, {
      agent: "worker",
      task: "test task",
      context: "fresh",
    })).rejects.toThrow();

    expect(emitted.length).toBe(1);
    const params = emitted[0]!.params;
    expect(params.context).toBe("fresh");
  });
});
