/**
 * Config Loader — reads and validates pipeline definitions
 * from .pi/pipelines/*.pipeline.yaml files
 */

import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";

import type {
  PipelineDef,
  Stage,
  ExpandConfig,
  ReviewGate,
  ReviewerDef,
  ReportConfig,
  StageReportConfig,
} from "./types.ts";

/** Errors found during validation */
class PipelineValidationError extends Error {
  constructor(
    message: string,
    public readonly filePath?: string,
  ) {
    super(message);
    this.name = "PipelineValidationError";
  }
}

/** Default values for optional pipeline fields */
const DEFAULTS = {
  version: 1,
  judgeModel: undefined as string | undefined,
  gateMaxRounds: 3,
  gateTargetScore: 8,
  maxSubagentDepth: 1,
} as const;

/**
 * Find all pipeline definition files in the given directory.
 * Looks for *.pipeline.yaml and *.pipeline.yml.
 */
export function discoverPipelineFiles(pipelinesDir: string): string[] {
  try {
    if (!fs.existsSync(pipelinesDir)) return [];
    return fs
      .readdirSync(pipelinesDir)
      .filter((f) => f.endsWith(".pipeline.yaml") || f.endsWith(".pipeline.yml"))
      .map((f) => path.join(pipelinesDir, f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Find a pipeline file by name (with or without extension).
 */
export function findPipelineFile(pipelinesDir: string, name: string): string | null {
  const candidates = [
    path.join(pipelinesDir, `${name}.pipeline.yaml`),
    path.join(pipelinesDir, `${name}.pipeline.yml`),
    path.join(pipelinesDir, name), // exact path
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Like findPipelineFile but searches multiple directories (first match wins).
 */
export function searchPipelineFile(dirs: string[], name: string): string | null {
  for (const dir of dirs) {
    const found = findPipelineFile(dir, name);
    if (found) return found;
  }
  return null;
}

/**
 * List pipelines from multiple directories, deduplicated by name (first dir wins).
 */
export function listPipelinesFromDirs(dirs: string[]): { name: string; file: string }[] {
  const seen = new Set<string>();
  const result: { name: string; file: string }[] = [];
  for (const dir of dirs) {
    for (const p of listPipelines(dir)) {
      if (!seen.has(p.name)) {
        seen.add(p.name);
        result.push(p);
      }
    }
  }
  return result;
}

/**
 * List all available pipeline names in a single directory.
 */
export function listPipelines(pipelinesDir: string): { name: string; file: string }[] {
  return discoverPipelineFiles(pipelinesDir).map((file) => ({
    name: path.basename(file).replace(/\.pipeline\.(ya?ml)$/, ""),
    file,
  }));
}

/**
 * Load and parse a pipeline definition file.
 * Throws PipelineValidationError on invalid content.
 */
export function loadPipeline(filePath: string): PipelineDef {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (_err) {
    throw new PipelineValidationError(`Cannot read pipeline file: ${filePath}`, filePath);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (_err) {
    throw new PipelineValidationError(
      `YAML parse error in ${filePath}: ${(_err as Error).message}`,
      filePath,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new PipelineValidationError("Pipeline must be a YAML object (mapping)", filePath);
  }

  const data = parsed as Record<string, unknown>;

  // Validate required fields
  if (typeof data.name !== "string" || !data.name.trim()) {
    throw new PipelineValidationError(
      "Pipeline must have a 'name' field (non-empty string)",
      filePath,
    );
  }
  if (typeof data.description !== "string") {
    throw new PipelineValidationError(
      "Pipeline must have a 'description' field (string)",
      filePath,
    );
  }
  if (!Array.isArray(data.stages) || data.stages.length === 0) {
    throw new PipelineValidationError(
      "Pipeline must have at least one stage in 'stages' array",
      filePath,
    );
  }

  // Validate and normalize stages (sequential, so expand.from can reference earlier stages)
  const prevStageIds = new Set<string>();
  const stages: Stage[] = [];
  for (let idx = 0; idx < data.stages.length; idx++) {
    const s = data.stages[idx]!;
    const validated = validateStage(s, idx, filePath, prevStageIds);
    if (validated.expand) {
      validateExpand(validated.expand, validated.id, prevStageIds, filePath);
    }
    prevStageIds.add(validated.id);
    stages.push(validated);
  }

  // Parse optional report config
  let report: ReportConfig | false | undefined;
  if (data.report === false) {
    report = false;
  } else if (typeof data.report === "object" && data.report !== null) {
    const r = data.report as Record<string, unknown>;
    report = {
      agent: typeof r.agent === "string" ? r.agent : undefined,
      focus: typeof r.focus === "string" ? r.focus : undefined,
    };
  }
  // undefined = not configured → use default (synthesis enabled)

  const pipeline: PipelineDef = {
    name: data.name.trim(),
    description: data.description.trim(),
    version: typeof data.version === "number" ? data.version : DEFAULTS.version,
    judgeModel: typeof data.judgeModel === "string" ? data.judgeModel : DEFAULTS.judgeModel,
    stages,
    report,
  };

  return pipeline;
}

/**
 * Validate and normalize a single stage object.
 */
function validateStage(
  data: unknown,
  index: number,
  filePath?: string,
  prevStageIds?: Set<string>,
  allowParallel = true,
): Stage {
  if (typeof data !== "object" || data === null) {
    throw new PipelineValidationError(`Stage #${index + 1} must be an object`, filePath);
  }

  const stage = data as Record<string, unknown>;

  if (typeof stage.id !== "string" || !stage.id.trim()) {
    throw new PipelineValidationError(
      `Stage #${index + 1} must have an 'id' field (non-empty string)`,
      filePath,
    );
  }

  const id = stage.id.trim();

  // Parallel stage
  if (Array.isArray(stage.parallel)) {
    if (!allowParallel) {
      throw new PipelineValidationError(
        `Stage "${id}" cannot use nested 'parallel' stages`,
        filePath,
      );
    }
    if (typeof stage.agent === "string" && stage.agent.trim()) {
      throw new PipelineValidationError(
        `Stage "${id}" cannot have both 'agent' and 'parallel'`,
        filePath,
      );
    }
    const children = stage.parallel.map((s, ci) =>
      validateStage(s, ci, filePath, undefined, false),
    );
    return {
      id,
      task: undefined,
      parallel: children,
      report: validateStageReport(stage.report, id, filePath),
    };
  }

  // Simple agent stage
  if (typeof stage.agent !== "string" || !stage.agent.trim()) {
    throw new PipelineValidationError(
      `Stage "${id}" must have an 'agent' field (non-empty string) or be a 'parallel' stage`,
      filePath,
    );
  }

  const agent = stage.agent.trim();

  // Validate task
  const task = typeof stage.task === "string" ? stage.task : `Execute task for stage: ${id}`;

  // Validate gate if present
  let gate: ReviewGate | undefined;
  if (stage.gate !== undefined) {
    gate = validateGate(stage.gate, id, filePath);
  }

  // Expand stage
  let expand: ExpandConfig | undefined;
  if (stage.expand !== undefined) {
    expand = validateExpand(stage.expand, id, prevStageIds, filePath);
  }

  // Optional fields
  const model = typeof stage.model === "string" ? stage.model.trim() : undefined;
  const output = typeof stage.output === "string" ? stage.output.trim() : undefined;
  const reads = Array.isArray(stage.reads) ? stage.reads.map(String) : undefined;
  const maxSubagentDepth =
    typeof stage.maxSubagentDepth === "number" ? stage.maxSubagentDepth : undefined;
  const report = validateStageReport(stage.report, id, filePath);

  return { id, agent, task, expand, gate, model, output, reads, maxSubagentDepth, report };
}

/**
 * Validate an expand configuration.
 * Checks that `from` references a valid previously defined stage.
 */
function validateExpand(
  data: unknown,
  stageId: string,
  prevStageIds: Set<string> | undefined,
  filePath?: string,
): ExpandConfig {
  if (typeof data !== "object" || data === null) {
    throw new PipelineValidationError(
      `Stage "${stageId}": expand must be an object with a 'from' field`,
      filePath,
    );
  }

  const expand = data as Record<string, unknown>;

  if (typeof expand.from !== "string" || !expand.from.trim()) {
    throw new PipelineValidationError(
      `Stage "${stageId}": expand.from must be a non-empty string (stage ID)`,
      filePath,
    );
  }

  const from = expand.from.trim();

  // Validate that `from` references an earlier stage in the pipeline
  if (prevStageIds && !prevStageIds.has(from)) {
    const available =
      prevStageIds.size > 0
        ? ` Available stages before "${stageId}": ${[...prevStageIds].join(", ")}`
        : " No stages before this one.";
    throw new PipelineValidationError(
      `Stage "${stageId}": expand.from "${from}" does not match any stage defined before "${stageId}".${available}`,
      filePath,
    );
  }

  let maxItems: number | undefined;
  if (expand.maxItems !== undefined) {
    if (
      typeof expand.maxItems !== "number" ||
      !Number.isFinite(expand.maxItems) ||
      expand.maxItems <= 0
    ) {
      throw new PipelineValidationError(
        `Stage "${stageId}": expand.maxItems must be a positive number if provided`,
        filePath,
      );
    }
    maxItems = expand.maxItems;
  }

  return { from, maxItems };
}

/**
 * Validate optional stage-level report compression config.
 */
function validateStageReport(
  data: unknown,
  stageId: string,
  filePath?: string,
): StageReportConfig | undefined {
  if (data === undefined) return undefined;

  if (typeof data !== "object" || data === null) {
    throw new PipelineValidationError(
      `Stage "${stageId}": report must be an object with optional mode, maxLength, instruction`,
      filePath,
    );
  }

  const report = data as Record<string, unknown>;
  const mode = report.mode;
  if (mode !== undefined && mode !== "full" && mode !== "summary") {
    throw new PipelineValidationError(
      `Stage "${stageId}": report.mode must be "full" or "summary"`,
      filePath,
    );
  }

  const maxLength = report.maxLength;
  if (maxLength !== undefined) {
    if (typeof maxLength !== "number" || !Number.isFinite(maxLength) || maxLength <= 0) {
      throw new PipelineValidationError(
        `Stage "${stageId}": report.maxLength must be a positive number if provided`,
        filePath,
      );
    }
  }

  const instruction = report.instruction;
  if (instruction !== undefined && typeof instruction !== "string") {
    throw new PipelineValidationError(
      `Stage "${stageId}": report.instruction must be a string if provided`,
      filePath,
    );
  }

  return {
    mode: mode as "full" | "summary" | undefined,
    maxLength: typeof maxLength === "number" ? maxLength : undefined,
    instruction: typeof instruction === "string" ? instruction : undefined,
  };
}

/**
 * Validate a review gate definition.
 */
function validateGate(data: unknown, stageId: string, filePath?: string): ReviewGate {
  if (typeof data !== "object" || data === null) {
    throw new PipelineValidationError(`Stage "${stageId}": gate must be an object`, filePath);
  }

  const gate = data as Record<string, unknown>;

  if (gate.type !== "review-loop") {
    throw new PipelineValidationError(
      `Stage "${stageId}": gate.type must be "review-loop"`,
      filePath,
    );
  }

  if (!Array.isArray(gate.reviewers) || gate.reviewers.length === 0) {
    throw new PipelineValidationError(
      `Stage "${stageId}": gate must have at least one reviewer`,
      filePath,
    );
  }

  const reviewers: ReviewerDef[] = gate.reviewers.map((r: unknown, i: number) => {
    if (typeof r !== "object" || r === null) {
      throw new PipelineValidationError(
        `Stage "${stageId}": reviewer #${i + 1} must be an object with 'focus'`,
        filePath,
      );
    }
    const rv = r as Record<string, unknown>;
    if (typeof rv.focus !== "string" || !rv.focus.trim()) {
      throw new PipelineValidationError(
        `Stage "${stageId}": reviewer #${i + 1} must have a 'focus' string`,
        filePath,
      );
    }
    return {
      focus: rv.focus.trim(),
      agent: typeof rv.agent === "string" ? rv.agent.trim() : "reviewer",
    };
  });

  return {
    type: "review-loop",
    maxRounds: typeof gate.maxRounds === "number" ? gate.maxRounds : DEFAULTS.gateMaxRounds,
    targetScore: typeof gate.targetScore === "number" ? gate.targetScore : DEFAULTS.gateTargetScore,
    reviewers,
    judgeModel: typeof gate.judgeModel === "string" ? gate.judgeModel.trim() : undefined,
  };
}
