import React from 'react';
import { Panel } from '../../layout/Panel.js';
import { useFocus } from '../../focus/focus.js';
import { useWorkerSelection } from '../../data/WorkerSelection.js';
import type { TuiRpc } from '../../runtime/rpc.js';
import { EmptySelectionHint } from './EmptySelectionHint.js';
import { WorkerOutputView } from './WorkerOutputView.js';

/**
 * Phase 3D.1 — output panel.
 *
 * Bottom-right slot of the TUI. Streams the selected worker's stream-json
 * output via `useWorkerEvents(rpc, workerId)`. Selection comes from
 * `WorkerSelectionProvider` (Phase 3C); the panel doesn't own selection
 * state.
 *
 * `<WorkerOutputView key={workerId}/>` is the keyed remount that resets
 * the reducer + scroll state on selection change. See PLAN.md decision:
 * key-based reset is simpler than imperative reducer reinitialization.
 */

export interface OutputPanelProps {
  readonly rpc: TuiRpc;
}

export function OutputPanel({ rpc }: OutputPanelProps): React.JSX.Element {
  const focus = useFocus();
  const selection = useWorkerSelection();
  const isFocused = focus.currentMainKey === 'output';

  return (
    <Panel focusKey="output" title="Output" flexGrow={1}>
      {selection.selectedId === null ? (
        <EmptySelectionHint />
      ) : (
        <WorkerOutputView
          key={selection.selectedId}
          rpc={rpc}
          workerId={selection.selectedId}
          isFocused={isFocused}
        />
      )}
    </Panel>
  );
}
