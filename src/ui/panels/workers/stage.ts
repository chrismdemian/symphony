import type { WorkerRole } from '../../../orchestrator/types.js';

/**
 * Phase 3I — map a worker's role to its conceptual position on the
 * 5-stage quality pipeline (Research → Plan → Implement → Test → Review)
 * and to the gerund label that appears next to its progress bar.
 *
 * The pipeline is conceptually per-task; each worker occupies ONE stage.
 * The bar visualizes the conceptual position of THIS worker — cells
 * before its stage are gold (logically completed prior stages), the
 * cell at its stage is colored by lifecycle status, and cells after are
 * dim. See `PipelineBar.tsx` for the cell-coloring rules.
 *
 * `debugger` is mapped to the Test slot (index 3) because debugging
 * happens during the verify phase. Its label remains "Debugging" so the
 * row honestly names what the worker is doing rather than pretending
 * it's a tester.
 */

export const PIPELINE_STAGE_COUNT = 5;

const STAGE_LABEL_PAD = 12;

interface StageInfo {
  readonly index: number;
  readonly label: string;
}

const STAGE_INFO: Readonly<Record<WorkerRole, StageInfo>> = {
  researcher: { index: 0, label: padStageLabel('Researching') },
  planner: { index: 1, label: padStageLabel('Planning') },
  implementer: { index: 2, label: padStageLabel('Implementing') },
  debugger: { index: 3, label: padStageLabel('Debugging') },
  reviewer: { index: 4, label: padStageLabel('Reviewing') },
};

function padStageLabel(label: string): string {
  if (label.length >= STAGE_LABEL_PAD) return label;
  return label + ' '.repeat(STAGE_LABEL_PAD - label.length);
}

export function roleToStage(role: WorkerRole): number {
  return STAGE_INFO[role].index;
}

export function stageLabelFor(role: WorkerRole): string {
  return STAGE_INFO[role].label;
}
