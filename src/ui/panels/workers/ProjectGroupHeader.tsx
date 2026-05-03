import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import type { ProjectGroup } from '../../data/useProjectGroups.js';

export interface ProjectGroupHeaderProps {
  readonly group: ProjectGroup;
  readonly collapsed: boolean;
  readonly selected: boolean;
  readonly activeCount: number;
}

export function ProjectGroupHeader({
  group,
  collapsed,
  selected,
  activeCount,
}: ProjectGroupHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const arrow = collapsed ? '▸' : '▾';
  const total = group.workers.length;
  const totalLabel = total === 1 ? '1 worker' : `${total} workers`;
  const summary = activeCount > 0 ? `${totalLabel}, ${activeCount} active` : totalLabel;
  // Visual review M1/M2 (3c #1):
  //   - Inverse highlight wraps only the project name, never trailing
  //     padding.
  //   - The leading column always renders a single space-or-bar
  //     (matching WorkerRow's gutter), no extra color on the
  //     non-selected branch.
  return (
    <Box flexDirection="row">
      {selected ? <Text color={theme['accent']}>▌</Text> : <Text> </Text>}
      <Text color={theme['accent']}> {arrow} </Text>
      {selected ? (
        <Text color={theme['text']} bold inverse>
          {group.displayName}
        </Text>
      ) : (
        <Text color={theme['text']} bold>
          {group.displayName}
        </Text>
      )}
      <Text color={theme['textMuted']}>{`  (${summary})`}</Text>
    </Box>
  );
}
