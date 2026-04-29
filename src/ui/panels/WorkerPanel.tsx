import React from 'react';
import { Text } from 'ink';
import { Panel } from '../layout/Panel.js';
import { useTheme } from '../theme/context.js';

/**
 * Phase 3A placeholder. Phase 3C fills this with:
 * - workers grouped by project (collapsible)
 * - instrument names (Violin/Cello/...) with status icons
 * - flashing dots for active workers, solid for idle/done
 * - K/R/P/Enter actions on the selected worker
 * - 1-9 quick-select shortcuts
 */
export function WorkerPanel(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Panel focusKey="workers" title="Workers" flexGrow={1}>
      <Text color={theme['textMuted']} dimColor>
        Worker list — Phase 3C will land here.
      </Text>
    </Panel>
  );
}
