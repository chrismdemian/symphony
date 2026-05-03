import React from 'react';
import { Box } from 'ink';
import type { ProjectSnapshot } from '../../projects/types.js';
import type { WorkerRecordSnapshot } from '../../orchestrator/worker-registry.js';
import type { ToolMode } from '../../orchestrator/types.js';
import { ChatPanel } from '../panels/chat/ChatPanel.js';
import { WorkerPanel } from '../panels/workers/WorkerPanel.js';
import { OutputPanel } from '../panels/output/OutputPanel.js';
import { KeybindBar } from './KeybindBar.js';
import { StatusBar } from './StatusBar.js';
import { useStdoutDimensions } from './useDimensions.js';
import type { TuiRpc } from '../runtime/rpc.js';
import type { UseWorkersResult } from '../data/useWorkers.js';

/**
 * Top-level layout: status bar (top) → main split (chat | workers+output)
 * → keybind bar (bottom).
 *
 * Two-column layout when `columns >= NARROW_THRESHOLD` (PLAN.md §3A
 * mandates 100). Below that, collapses to a vertical stack:
 *   chat → workers → output → keybind bar.
 *
 * `flexBasis="55%"` / `"45%"` per PLAN.md split. The right column
 * stacks workers (top) over output (bottom), each `flexGrow=1`.
 */

export const NARROW_THRESHOLD = 100;

export interface LayoutProps {
  readonly version: string;
  readonly mode: ToolMode | null;
  readonly projects: readonly ProjectSnapshot[];
  readonly workers: readonly WorkerRecordSnapshot[];
  readonly sessionId: string | null;
  readonly rpc: TuiRpc;
  readonly workersResult: UseWorkersResult;
}

export function Layout(props: LayoutProps): React.JSX.Element {
  const { columns } = useStdoutDimensions();
  const wide = columns >= NARROW_THRESHOLD;
  const workersPanel = (
    <WorkerPanel rpc={props.rpc} workersResult={props.workersResult} />
  );
  const outputPanel = <OutputPanel rpc={props.rpc} />;

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <StatusBar
        version={props.version}
        mode={props.mode}
        projects={props.projects}
        workers={props.workers}
        sessionId={props.sessionId}
      />
      {wide ? (
        <WideLayout workersPanel={workersPanel} outputPanel={outputPanel} />
      ) : (
        <NarrowLayout workersPanel={workersPanel} outputPanel={outputPanel} />
      )}
      <KeybindBar />
    </Box>
  );
}

function WideLayout({
  workersPanel,
  outputPanel,
}: {
  readonly workersPanel: React.JSX.Element;
  readonly outputPanel: React.JSX.Element;
}): React.JSX.Element {
  return (
    <Box flexDirection="row" flexGrow={1}>
      <Box flexBasis="55%" flexDirection="column">
        <ChatPanel />
      </Box>
      <Box flexBasis="45%" flexDirection="column">
        {workersPanel}
        {outputPanel}
      </Box>
    </Box>
  );
}

function NarrowLayout({
  workersPanel,
  outputPanel,
}: {
  readonly workersPanel: React.JSX.Element;
  readonly outputPanel: React.JSX.Element;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <ChatPanel />
      {workersPanel}
      {outputPanel}
    </Box>
  );
}
