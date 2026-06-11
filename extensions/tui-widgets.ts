/**
 * TUI Widgets — rendering for pipeline progress and results
 */

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { PipelineResult } from "./types.ts";
import { formatDuration } from "./utils.ts";

export type ThemeAccessor = {
  fg: (category: string, text: string) => string;
  bg: (category: string, text: string) => string;
  bold: (text: string) => string;
};

/**
 * Create a TUI component for a pipeline result (used in custom message rendering).
 */
export function createPipelineResultComponent(
  result: PipelineResult,
  theme: ThemeAccessor,
): Container {
  const container = new Container();
  container.addChild(new Spacer(1));

  // Header
  const statusIcon = result.success ? "✅" : "❌";
  const headerText = theme.fg("toolTitle", theme.bold(`Pipeline: ${result.pipelineName}`));
  container.addChild(
    new Text(
      `${headerText} ${theme.fg(result.success ? "success" : "error", `[${statusIcon}]`)}`,
      0,
      0,
    ),
  );
  container.addChild(new Text(theme.fg("dim", `Task: ${result.task}`), 0, 0));
  container.addChild(
    new Text(theme.fg("dim", `Duration: ${formatDuration(result.totalDurationMs)}`), 0, 0),
  );
  container.addChild(new Text("", 0, 0));

  // Stages
  for (const stage of result.stages) {
    const icon = stage.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const name = theme.bold(stage.stageId);

    let meta = "";
    if (stage.rounds) {
      meta += ` ${theme.fg("dim", `(${stage.rounds}r)`)}`;
    }
    if (stage.scores?.length) {
      meta += ` ${theme.fg("accent", `[${stage.scores.join(",")}]`)}`;
    }
    meta += ` ${theme.fg("dim", formatDuration(stage.durationMs))}`;

    container.addChild(new Text(`${icon} ${name}${meta}`, 0, 0));

    if (stage.error) {
      container.addChild(new Text(theme.fg("error", `  ${stage.error}`), 0, 0));
    }
  }

  // Fatal error
  if (result.error && result.stages.length === 0) {
    container.addChild(new Text(theme.fg("error", `Fatal: ${result.error}`), 0, 0));
  }

  return container;
}
