/**
 * Subagent Bridge — programmatic access to pi-subagents via the event bus
 *
 * Uses pi-subagents' internal event bridge to execute subagent tasks
 * synchronously from within another extension.
 *
 * Events used:
 *   subagent:slash:request   — emit to request subagent execution
 *   subagent:slash:started   — emitted when execution starts
 *   subagent:slash:response  — emitted with execution result
 *   subagent:slash:cancel    — emit to cancel a running subagent
 *
 * This approach is cleaner than spawning child Pi processes because:
 * - It reuses pi-subagents' existing execution pipeline
 * - Results are returned via the same process (no IPC needed)
 * - Parallel execution is handled natively
 * - The extension composes with pi-subagents rather than wrapping it
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Request params expected by pi-subagents' slash bridge */
interface SubagentSlashParams {
  agent?: string;
  task?: string;
  chain?: SubagentChainStep[];
  tasks?: SubagentTaskParam[];
  async?: boolean;
  clarify?: boolean;
  context?: "fresh" | "fork";
  model?: string;
  output?: string | boolean;
  agentScope?: string;
  cwd?: string;
  skill?: string | string[] | boolean;
  progress?: boolean;
  reads?: string[] | boolean;
  outputMode?: "inline" | "file-only";
  [key: string]: unknown;
}

interface SubagentChainStep {
  agent: string;
  task?: string;
  phase?: string;
  label?: string;
  as?: string;
  output?: string | boolean;
  reads?: string[] | boolean;
  model?: string;
  skill?: string | string[] | boolean;
  progress?: boolean;
}

interface SubagentTaskParam {
  agent: string;
  task: string;
  output?: string | boolean;
  reads?: string[] | boolean;
  model?: string;
  count?: number;
}

interface SlashResponse {
  requestId: string;
  result: {
    content: string | Array<{ type: string; text: string }>;
    details?: {
      results?: Array<{
        agent?: string;
        exitCode?: number;
        output?: string;
        sessionFile?: string;
        progress?: { status: string };
      }>;
    };
    isError?: boolean;
  };
  isError: boolean;
  errorText?: string;
}

/**
 * Execute a single subagent task and wait for the result.
 *
 * Uses pi-subagents' slash event bridge (fast, same-process).
 * Falls back to pi.exec() launching a child Pi process if the bridge
 * is not available (transparent to the caller).
 */
export async function executeSubagent(
  pi: ExtensionAPI,
  params: SubagentSlashParams,
  signal?: AbortSignal,
): Promise<SlashResponse> {
  // Pipeline stages should never fork the parent session — they are independent tasks.
  // Explicitly default to "fresh" context to avoid failures when pi-subagents agents
  // have defaultContext: "fork" but the parent session hasn't been persisted to disk yet.
  // This affects ALL pipelines, not just the built-in ones.
  if (params.context === undefined) {
    params.context = "fresh";
  }

  // Try the event bridge first
  try {
    return await tryBridge(pi, params, signal);
  } catch (bridgeErr) {
    const bridgeMessage = (bridgeErr as Error).message;

    // If it's a bridge-unavailable error, try pi.exec() fallback
    if (bridgeMessage.includes("bridge")) {
      console.warn(`Bridge unavailable, falling back to pi.exec(): ${bridgeMessage}`);
      try {
        return await tryExec(pi, params, signal);
      } catch (execErr) {
        throw new Error(
          `Subagent execution failed (bridge+fallback): ${(execErr as Error).message}`,
        );
      }
    }

    throw bridgeErr;
  }
}

/**
 * Event-bridge execution path (same-process, pi-subagents must be loaded).
 */
function tryBridge(
  pi: ExtensionAPI,
  params: SubagentSlashParams,
  signal?: AbortSignal,
): Promise<SlashResponse> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    let started = false;
    let done = false;

    const startTimeout = setTimeout(() => {
      if (!done) cleanup();
      if (!done) {
        done = true;
        reject(new Error("Subagent bridge did not respond within 15s. Is pi-subagents installed?"));
      }
    }, 15_000);

    const onStarted = (data: unknown) => {
      if (done) return;
      const d = data as { requestId?: string } | undefined;
      if (d?.requestId !== requestId) return;
      started = true;
      clearTimeout(startTimeout);
    };

    const onResponse = (data: unknown) => {
      if (done) return;
      const d = data as SlashResponse | undefined;
      if (d?.requestId !== requestId) return;
      cleanup();
      done = true;
      resolve(d);
    };

    const cleanup = () => {
      clearTimeout(startTimeout);
      try {
        unsubStarted?.();
      } catch { /* ignore */ }
      try {
        unsubResponse?.();
      } catch { /* ignore */ }
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new Error("Aborted"));
        return;
      }
      signal.addEventListener("abort", () => {
        if (!done) {
          pi.events.emit("subagent:slash:cancel", { requestId });
          cleanup();
          done = true;
          reject(new Error("Aborted"));
        }
      }, { once: true });
    }

    const unsubStarted = pi.events.on("subagent:slash:started", onStarted);
    const unsubResponse = pi.events.on("subagent:slash:response", onResponse);

    pi.events.emit("subagent:slash:request", { requestId, params });

    // If not started after a microtask tick, bridge didn't respond
    setTimeout(() => {
      if (!started && !done) {
        cleanup();
        done = true;
        reject(new Error(
          "No subagent bridge responded. Ensure pi-subagents is installed (pi install npm:pi-subagents).",
        ));
      }
    }, 100);
  });
}

/**
 * Fallback: launch a child Pi process to execute the subagent.
 * Used when the event bridge is not available.
 */
async function tryExec(
  pi: ExtensionAPI,
  params: SubagentSlashParams,
  signal?: AbortSignal,
): Promise<SlashResponse> {
  const agent = params.agent ?? "worker";
  const task = params.task ?? "";

  // Build the command
  const escapedTask = task.replace(/"/g, '\\"');
  const cmd = `/run ${agent} "${escapedTask}"`;

  const result = await pi.exec("pi", ["-p", cmd], {
    timeout: 300_000,
    signal,
  });

  const output = (result.stdout ?? "").trim();
  const error = (result.stderr ?? "").trim();

  if (result.code !== 0 && !output) {
    return {
      requestId: "",
      result: { content: error || "(no output)" },
      isError: true,
      errorText: error || `Exit code: ${result.code}`,
    };
  }

  return {
    requestId: "",
    result: { content: output || "(done)" },
    isError: result.code !== 0,
    errorText: result.code !== 0 ? error : undefined,
  };
}

/**
 * Extract text content from a subagent response.
 */
export function extractResponseText(response: SlashResponse): string {
  if (response.isError) return response.errorText ?? "(error)";

  const content = response.result?.content;
  if (typeof content === "string" && content.length > 0) return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    if (texts.length > 0) return texts.join("\n");
  }

  // Try details
  const details = response.result?.details;
  if (details?.results?.length) {
    const outputs = details.results
      .map((r) => r.output ?? "")
      .filter(Boolean);
    if (outputs.length > 0) return outputs.join("\n\n");
  }

  return "(no output)";
}

/**
 * Check if pi-subagents is available by probing the event bus.
 */
export function isSubagentAvailable(pi: ExtensionAPI): boolean {
  // We can probe by emitting a quick test or checking a known event handler
  // Simple heuristic: check if the slash request event can be emitted
  // (we can't directly check, but we'll learn from errors)
  return true; // optimistic — errors surface when trying to execute
}
