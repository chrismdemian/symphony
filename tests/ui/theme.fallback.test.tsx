import React from 'react';
import { Text } from 'ink';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import {
  pickThemeJson,
  probeTruecolor,
  resolveTheme,
  SYMPHONY_THEME,
  SYMPHONY_THEME_16,
} from '../../src/ui/theme/theme.js';
import {
  ThemeProvider,
  useTheme,
  useThemeController,
} from '../../src/ui/theme/context.js';

/**
 * Phase 3H.2 — theme auto-fallback picks 16-color when truecolor isn't
 * detected, and the ThemeProvider hot-swaps cleanly when
 * `setThemeJson` fires from a config-driven AppShell effect.
 */

describe('probeTruecolor (3H.2)', () => {
  it('returns false when NO_COLOR is set', () => {
    expect(probeTruecolor({ NO_COLOR: '1', COLORTERM: 'truecolor' })).toBe(false);
  });

  it('returns false when FORCE_COLOR=0', () => {
    expect(probeTruecolor({ FORCE_COLOR: '0', COLORTERM: 'truecolor' })).toBe(false);
  });

  it('returns false when FORCE_COLOR=1 or 2 (explicit user downgrade)', () => {
    expect(probeTruecolor({ FORCE_COLOR: '1', COLORTERM: 'truecolor' })).toBe(false);
    expect(probeTruecolor({ FORCE_COLOR: '2', COLORTERM: 'truecolor' })).toBe(false);
  });

  it('returns true when FORCE_COLOR=3', () => {
    expect(probeTruecolor({ FORCE_COLOR: '3' })).toBe(true);
  });

  it('returns true for COLORTERM=truecolor (case-insensitive)', () => {
    expect(probeTruecolor({ COLORTERM: 'truecolor' })).toBe(true);
    expect(probeTruecolor({ COLORTERM: 'TrueColor' })).toBe(true);
    expect(probeTruecolor({ COLORTERM: '24bit' })).toBe(true);
  });

  it('returns true for known truecolor TERMs (kitty, ghostty, wezterm, alacritty)', () => {
    expect(probeTruecolor({ TERM: 'xterm-kitty' })).toBe(true);
    expect(probeTruecolor({ TERM: 'xterm-ghostty' })).toBe(true);
    expect(probeTruecolor({ TERM: 'wezterm' })).toBe(true);
    expect(probeTruecolor({ TERM: 'alacritty' })).toBe(true);
  });

  it('returns true for vscode and ghostty TERM_PROGRAM', () => {
    expect(probeTruecolor({ TERM_PROGRAM: 'vscode' })).toBe(true);
    expect(probeTruecolor({ TERM_PROGRAM: 'ghostty' })).toBe(true);
  });

  it('returns true for iTerm.app v3+ (assumes modern when version unset)', () => {
    expect(probeTruecolor({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0' })).toBe(true);
    expect(probeTruecolor({ TERM_PROGRAM: 'iTerm.app' })).toBe(true);
    expect(probeTruecolor({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '2.9.0' })).toBe(false);
  });

  it('returns true when WT_SESSION is set (Windows Terminal)', () => {
    expect(probeTruecolor({ WT_SESSION: 'abc-123' })).toBe(true);
  });

  it('returns false for Apple_Terminal', () => {
    expect(probeTruecolor({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false);
  });

  it('returns false on empty env (conservative default)', () => {
    expect(probeTruecolor({})).toBe(false);
  });
});

describe('pickThemeJson (3H.2)', () => {
  it('returns the truecolor palette when autoFallback is false', () => {
    expect(pickThemeJson(false)).toBe(SYMPHONY_THEME);
  });

  it('returns 16-color when autoFallback is true and probe fails', () => {
    // Empty env → probe returns false → 16-color path.
    expect(pickThemeJson(true, {})).toBe(SYMPHONY_THEME_16);
  });

  it('returns truecolor when autoFallback is true and env signals truecolor', () => {
    expect(pickThemeJson(true, { COLORTERM: 'truecolor' })).toBe(SYMPHONY_THEME);
    expect(pickThemeJson(true, { FORCE_COLOR: '3' })).toBe(SYMPHONY_THEME);
    expect(pickThemeJson(true, { WT_SESSION: 'abc' })).toBe(SYMPHONY_THEME);
  });

  it('autoFallback=false ALWAYS returns truecolor regardless of env', () => {
    expect(pickThemeJson(false, { NO_COLOR: '1' })).toBe(SYMPHONY_THEME);
    expect(pickThemeJson(false, {})).toBe(SYMPHONY_THEME);
  });
});

describe('SYMPHONY_THEME_16 (3H.2)', () => {
  it('resolves to ANSI named colors for the brand tokens', () => {
    const t = resolveTheme(SYMPHONY_THEME_16);
    expect(t['accent']).toBe('magenta');
    expect(t['primary']).toBe('yellow');
    expect(t['error']).toBe('red');
    expect(t['text']).toBe('white');
    // Audit M4: grayMuted maps to ANSI white so panel borders (gray)
    // stay distinguishable from muted body text on legacy conhost.
    expect(t['textMuted']).toBe('white');
    expect(t['border']).toBe('gray');
  });

  it('preserves every semantic token from the truecolor variant', () => {
    const truecolor = resolveTheme(SYMPHONY_THEME);
    const sixteen = resolveTheme(SYMPHONY_THEME_16);
    expect(Object.keys(sixteen).sort()).toEqual(Object.keys(truecolor).sort());
  });

  it('resolves diff tokens to git-convention green/red/cyan ANSI names', () => {
    const t = resolveTheme(SYMPHONY_THEME_16);
    expect(t['diffAdd']).toBe('green');
    expect(t['diffRemove']).toBe('red');
    expect(t['diffHunk']).toBe('cyan');
  });
});

describe('ThemeProvider hot-swap (3H.2)', () => {
  it('swaps the resolved theme AND the rendered ANSI escape when setThemeJson is called', async () => {
    let captured: ReturnType<typeof useThemeController> | undefined;

    function Probe(): React.JSX.Element {
      const t = useTheme();
      captured = useThemeController();
      // Render a colored bit of text so the rendered ANSI escape is
      // observable via lastFrame(). The accent token is what AppShell
      // uses for borders + headings — the most user-visible swap.
      return <Text color={t['accent']}>SWAP</Text>;
    }

    const { lastFrame } = render(
      <ThemeProvider themeJson={SYMPHONY_THEME}>
        <Probe />
      </ThemeProvider>,
    );
    // 24-bit truecolor escape for #7C6FEB (124, 111, 235).
    const TRUECOLOR_VIOLET = '\x1b[38;2;124;111;235m';
    // ANSI named magenta resolves to a 16-color SGR escape.
    const ANSI_MAGENTA = '\x1b[35m';

    let frame = lastFrame() ?? '';
    expect(frame).toContain(TRUECOLOR_VIOLET);
    expect(frame).not.toContain(ANSI_MAGENTA);

    if (captured === undefined) throw new Error('captured undefined');
    captured.setThemeJson(SYMPHONY_THEME_16);
    // 32 microtask drains + 1 macrotask hop covers React 19's
    // commit-phase chain (3E known-gotchas pattern).
    for (let i = 0; i < 32; i += 1) await Promise.resolve();
    await new Promise((r) => setImmediate(r));

    frame = lastFrame() ?? '';
    expect(frame).toContain(ANSI_MAGENTA);
    expect(frame).not.toContain(TRUECOLOR_VIOLET);
  });

  it('setThemeJson is a no-op when the JSON identity is unchanged', async () => {
    let renderCount = 0;
    let captured: ReturnType<typeof useThemeController> | undefined;

    function Probe(): React.JSX.Element {
      const ctrl = useThemeController();
      captured = ctrl;
      renderCount += 1;
      return <></>;
    }

    render(
      <ThemeProvider themeJson={SYMPHONY_THEME}>
        <Probe />
      </ThemeProvider>,
    );
    if (captured === undefined) throw new Error('captured undefined');
    const baseline = renderCount;
    // Calling with the SAME JSON object should NOT trigger a re-render.
    captured.setThemeJson(captured.themeJson);
    await new Promise((r) => setTimeout(r, 20));
    expect(renderCount).toBe(baseline);
  });
});
