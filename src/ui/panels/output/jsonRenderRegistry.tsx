/**
 * Phase 3D.2 — Symphony-themed registry overrides for `@json-render/ink`.
 *
 * The default registry uses generic colors; Symphony's locked palette
 * (PLAN.md §3A: violet `#7C6FEB` brand + warm gold `#D4A843` highlight)
 * has to override `Heading`, `Text`, and `Card` so worker-emitted specs
 * inherit the brand styling without each worker spec needing to set
 * explicit color props.
 *
 * The `Renderer` already merges the registry with `standardComponents`
 * (`includeStandard: true` default) — our overrides win for keys we
 * specify; everything else (Box, Stack-via-flexDirection, Metric,
 * Badge, Spinner, etc.) falls through to standard.
 *
 * Static registry (no React hooks here) — `useTheme()` runs inside the
 * component bodies via React context.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { ComponentRegistry, ComponentRenderer } from '@json-render/ink';
import { useTheme } from '../../theme/context.js';

/** Heading override — gold + bold, ignores any spec-supplied color. */
const HeadingThemed: ComponentRenderer<{
  text: string;
  level?: 'h1' | 'h2' | 'h3' | 'h4' | null;
  color?: string | null;
}> = ({ element }) => {
  const theme = useTheme();
  const text = element.props.text ?? '';
  return (
    <Text bold color={theme['jsonRenderHeading']}>
      {text}
    </Text>
  );
};

/** Text override — light gray default. Spec `color` prop still honored
 *  if explicitly set to a non-null hex (lets workers signal alarm
 *  states without bypassing the theme entirely for normal text). */
const TextThemed: ComponentRenderer<{
  text: string;
  color?: string | null;
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean | null;
  dimColor?: boolean | null;
  inverse?: boolean | null;
}> = ({ element }) => {
  const theme = useTheme();
  const p = element.props;
  const color = p.color ?? theme['jsonRenderText'];
  return (
    <Text
      color={color}
      bold={p.bold ?? false}
      italic={p.italic ?? false}
      underline={p.underline ?? false}
      dimColor={p.dimColor ?? false}
      inverse={p.inverse ?? false}
    >
      {p.text ?? ''}
    </Text>
  );
};

/** Card override — violet round border, gold non-bold title (so a Card
 *  title and a child Heading aren't visually duplicated when both are
 *  present), padded body. */
const CardThemed: ComponentRenderer<{
  title?: string | null;
  padding?: number | null;
}> = ({ element, children }) => {
  const theme = useTheme();
  const title = element.props.title;
  const padding = element.props.padding ?? 1;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme['jsonRenderBorder']}
      paddingX={padding}
      paddingY={0}
    >
      {title !== null && title !== undefined && title.length > 0 ? (
        <Text color={theme['jsonRenderHeading']}>{title}</Text>
      ) : null}
      {children}
    </Box>
  );
};

/** Metric override — `label  value` two-line form. Label in muted gray
 *  (palette muted, NOT Ink's `dimColor` SGR `[2m`); value in gold.
 *  Trend arrow optional, rendered next to the value when present. */
const MetricThemed: ComponentRenderer<{
  label: string;
  value: string;
  detail?: string | null;
  trend?: 'up' | 'down' | 'neutral' | null;
}> = ({ element }) => {
  const theme = useTheme();
  const p = element.props;
  const trendChar =
    p.trend === 'up' ? ' ↑' : p.trend === 'down' ? ' ↓' : '';
  return (
    <Box flexDirection="column">
      <Text color={theme['jsonRenderMuted']}>{p.label ?? ''}</Text>
      <Text bold color={theme['jsonRenderHeading']}>
        {p.value ?? ''}
        {trendChar}
      </Text>
      {p.detail !== null && p.detail !== undefined && p.detail.length > 0 ? (
        <Text color={theme['jsonRenderMuted']}>{p.detail}</Text>
      ) : null}
    </Box>
  );
};

export const SYMPHONY_JSON_RENDER_REGISTRY: ComponentRegistry = {
  Heading: HeadingThemed as ComponentRenderer,
  Text: TextThemed as ComponentRenderer,
  Card: CardThemed as ComponentRenderer,
  Metric: MetricThemed as ComponentRenderer,
};
