import React from 'react';
import { Box } from 'ink';
import type { ProjectSnapshot } from '../../projects/types.js';
import type { WorkerRecordSnapshot } from '../../orchestrator/worker-registry.js';
import type { ToolMode } from '../../orchestrator/types.js';
import { ChatPanel } from '../panels/chat/ChatPanel.js';
import { WorkerPanel } from '../panels/workers/WorkerPanel.js';
import { OutputPanel } from '../panels/output/OutputPanel.js';
import { QuestionPopup } from '../panels/questions/QuestionPopup.js';
import { Palette } from '../panels/palette/Palette.js';
import { WorkerSelector } from '../panels/palette/WorkerSelector.js';
import { HelpOverlay } from '../panels/help/HelpOverlay.js';
import { useFocus, type FocusContext } from '../focus/focus.js';
import { KeybindBar } from './KeybindBar.js';
import { StatusBar } from './StatusBar.js';
import { useStdoutDimensions } from './useDimensions.js';
import type { TuiRpc } from '../runtime/rpc.js';
import type { UseWorkersResult } from '../data/useWorkers.js';
import type { UseQuestionsResult } from '../data/useQuestions.js';

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
 *
 * Phase 3F.1: popup mounting handles `'question'` (3E), `'palette'`,
 * `'worker-select'`, and `'help'` (all 3F.1). Phase 3F.3 will refactor
 * away from the unmount-the-split pattern to absolute-positioned
 * overlays — this commit keeps the existing approach so 3F.1 ships
 * without coupling to the layout refactor.
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
  /** Phase 3E — question queue (polled at App level). */
  readonly questionsResult?: UseQuestionsResult;
}

function getPopupOnTopKey(
  stack: readonly FocusContext[],
): string | null {
  const top = stack[stack.length - 1];
  return top !== undefined && top.kind === 'popup' ? top.key : null;
}

export function Layout(props: LayoutProps): React.JSX.Element {
  const { columns } = useStdoutDimensions();
  const focus = useFocus();
  const wide = columns >= NARROW_THRESHOLD;
  const popupKey = getPopupOnTopKey(focus.state.stack);
  const workersPanel = (
    <WorkerPanel rpc={props.rpc} workersResult={props.workersResult} />
  );
  const outputPanel = <OutputPanel rpc={props.rpc} />;
  const popupNode = renderPopup(popupKey, props);

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <StatusBar
        version={props.version}
        mode={props.mode}
        projects={props.projects}
        workers={props.workers}
        sessionId={props.sessionId}
        questionsCount={props.questionsResult?.count ?? 0}
        blockingCount={props.questionsResult?.blockingCount ?? 0}
      />
      {popupNode !== null ? (
        popupNode
      ) : wide ? (
        <WideLayout workersPanel={workersPanel} outputPanel={outputPanel} />
      ) : (
        <NarrowLayout workersPanel={workersPanel} outputPanel={outputPanel} />
      )}
      <KeybindBar />
    </Box>
  );
}

function renderPopup(
  popupKey: string | null,
  props: LayoutProps,
): React.JSX.Element | null {
  switch (popupKey) {
    case 'question':
      return (
        <QuestionPopup
          rpc={props.rpc}
          questions={props.questionsResult?.questions ?? []}
          projects={props.projects}
        />
      );
    case 'palette':
      return <Palette />;
    case 'help':
      return <HelpOverlay />;
    case 'worker-select':
      return <WorkerSelector workers={props.workers} />;
    case null:
      return null;
    default:
      // Unknown popup key — render nothing rather than throw, so a
      // stale `pushPopup('typo')` doesn't crash the TUI. A test asserts
      // every key in `FocusContext.key` is handled.
      return null;
  }
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
