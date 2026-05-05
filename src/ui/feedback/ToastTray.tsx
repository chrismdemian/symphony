import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/context.js';
import { useToast, type Toast } from './ToastProvider.js';

/**
 * Phase 3F.2 — bottom-of-screen toast tray. One line per active toast,
 * rendered above the KeybindBar by `<Layout>`. Returns null when no
 * toasts are active (no flex placeholder, no extra rows consumed).
 */
export function ToastTray(): React.JSX.Element | null {
  const theme = useTheme();
  const { toasts } = useToast();
  if (toasts.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} theme={theme} />
      ))}
    </Box>
  );
}

function ToastRow({
  toast,
  theme,
}: {
  readonly toast: Toast;
  readonly theme: Record<string, string>;
}): React.JSX.Element {
  const accent = toneColor(theme, toast.tone);
  return (
    <Box flexDirection="row">
      <Text color={accent}>● </Text>
      <Text color={theme['text']}>{toast.message}</Text>
    </Box>
  );
}

function toneColor(theme: Record<string, string>, tone: Toast['tone']): string {
  switch (tone) {
    case 'success':
      return theme['success']!;
    case 'warning':
      return theme['warning']!;
    case 'error':
      return theme['error']!;
    case 'info':
      return theme['accent']!;
  }
}
