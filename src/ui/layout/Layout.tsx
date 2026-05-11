import React from 'react';
import { Box } from 'ink';
import type { ProjectSnapshot } from '../../projects/types.js';
import type { WorkerRecordSnapshot } from '../../orchestrator/worker-registry.js';
import type { ToolMode } from '../../orchestrator/types.js';
import { ChatPanel } from '../panels/chat/ChatPanel.js';
import { WorkerPanel } from '../panels/workers/WorkerPanel.js';
import { OutputPanel } from '../panels/output/OutputPanel.js';
import { QuestionPopup } from '../panels/questions/QuestionPopup.js';
import { QuestionHistory } from '../panels/questions/QuestionHistory.js';
import { Palette } from '../panels/palette/Palette.js';
import { WorkerSelector } from '../panels/palette/WorkerSelector.js';
import { HelpOverlay } from '../panels/help/HelpOverlay.js';
import { SettingsPanel } from '../panels/settings/SettingsPanel.js';
import { KeybindEditorPopup } from '../panels/settings/KeybindEditorPopup.js';
import { useFocus, type FocusContext } from '../focus/focus.js';
import { KeybindBar } from './KeybindBar.js';
import { StatusBar } from './StatusBar.js';
import { useStdoutDimensions } from './useDimensions.js';
import { ToastTray } from '../feedback/ToastTray.js';
import type { TuiRpc } from '../runtime/rpc.js';
import type { UseWorkersResult } from '../data/useWorkers.js';
import type { UseQueueResult } from '../data/useQueue.js';
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
 * Phase 3F.3: popup overlay refactor — the underlying body is rendered
 * UNCONDITIONALLY (no more ternary unmount), and the popup mounts as
 * an absolute-positioned sibling on top. This preserves chat scroll
 * position, output stream state, worker selection, and any other
 * mounted-only state across popup open/close cycles. Pattern from
 * lazygit / k9s ncurses overlays. Ink's `Box` supports
 * `position: 'absolute'` natively (Yoga POSITION_TYPE_ABSOLUTE).
 *
 * Popup keys handled: `'question'` (3E), `'palette'`, `'worker-select'`,
 * `'help'` (3F.1), `'question-history'` (3F.3). Unknown keys silently
 * render no popup so a stale `pushPopup('typo')` doesn't crash.
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
  /** Phase 3L — task queue snapshot (polled at App level). */
  readonly queueResult?: UseQueueResult;
  /** Phase 3E — question queue (polled at App level). */
  readonly questionsResult?: UseQuestionsResult;
  /** Phase 3M — Away Mode flag for StatusBar segment + capability surfacing. */
  readonly awayMode?: boolean;
}

function getPopupOnTopKey(stack: readonly FocusContext[]): string | null {
  const top = stack[stack.length - 1];
  return top !== undefined && top.kind === 'popup' ? top.key : null;
}

export function Layout(props: LayoutProps): React.JSX.Element {
  const { columns } = useStdoutDimensions();
  const focus = useFocus();
  const wide = columns >= NARROW_THRESHOLD;
  const popupKey = getPopupOnTopKey(focus.state.stack);
  const workersPanel = (
    <WorkerPanel
      rpc={props.rpc}
      workersResult={props.workersResult}
      queueResult={props.queueResult}
    />
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
        awayMode={props.awayMode ?? false}
        pendingQueueCount={props.queueResult?.pending.length ?? 0}
      />
      {/*
       * Phase 3F.3 — popup-mount strategy. We considered an
       * absolute-positioned overlay over a kept-mounted body, but Ink's
       * cell-based renderer doesn't fully mask body content where the
       * popup has whitespace cells: empty rows past the popup's content
       * height stay un-rendered, so body text bleeds through. lazygit/
       * k9s achieve true masking via ncurses windows, which Ink lacks.
       *
       * Pragmatic decision: KEEP the unmount-on-popup pattern from 3E
       * for visual fidelity; preserve chat-scroll/output-stream/worker-
       * selection state across popup cycles by lifting the relevant
       * state to provider-context layer (Phase 3F.4+). Ship the popup
       * type expansion (question-history) and the new
       * `popAndSetMain` reducer NOW; layout-level overlay refactor
       * remains deferred with a different mechanism (see Known Gotchas
       * 3F.3).
       */}
      {popupNode !== null ? (
        popupNode
      ) : wide ? (
        <WideLayout workersPanel={workersPanel} outputPanel={outputPanel} />
      ) : (
        <NarrowLayout workersPanel={workersPanel} outputPanel={outputPanel} />
      )}
      <ToastTray />
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
    case 'question-history':
      return <QuestionHistory rpc={props.rpc} projects={props.projects} />;
    case 'palette':
      return <Palette />;
    case 'help':
      return <HelpOverlay />;
    case 'worker-select':
      return <WorkerSelector workers={props.workers} />;
    case 'settings':
      return <SettingsPanel />;
    case 'keybind-list':
    case 'keybind-capture':
      // Phase 3H.4 — both scopes route to the same component instance
      // so React preserves component-level state (capturingId,
      // selectedIdx, lastError) across the list↔capture transition.
      // The component branches its render on `useFocus().currentScope`.
      return <KeybindEditorPopup />;
    case null:
      return null;
    default:
      // Unknown popup key — render nothing rather than throw, so a
      // stale `pushPopup('typo')` doesn't crash the TUI.
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
