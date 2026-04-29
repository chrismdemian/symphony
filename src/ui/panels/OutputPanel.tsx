import React from 'react';
import { Text } from 'ink';
import { Panel } from '../layout/Panel.js';
import { useTheme } from '../theme/context.js';

/**
 * Phase 3A placeholder. Phase 3D fills this with:
 * - real-time NDJSON stream rendering for the selected worker
 * - syntax-highlighted code blocks
 * - tool-call icons + labels
 * - inline json-render for worker-emitted dashboards
 * - PageUp/PageDown scroll, follow-mode toggle
 */
export function OutputPanel(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Panel focusKey="output" title="Output" flexGrow={1}>
      <Text color={theme['textMuted']} dimColor>
        Output stream — Phase 3D will land here.
      </Text>
    </Panel>
  );
}
