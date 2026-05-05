import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../src/ui/theme/context.js';
import { ToastProvider, useToast } from '../../../src/ui/feedback/ToastProvider.js';
import { ToastTray } from '../../../src/ui/feedback/ToastTray.js';

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');

function ShowOnMount({ message, ttlMs }: { readonly message: string; readonly ttlMs?: number }): null {
  const { showToast } = useToast();
  React.useEffect(() => {
    if (ttlMs !== undefined) {
      showToast(message, { ttlMs });
    } else {
      showToast(message);
    }
  }, [message, showToast, ttlMs]);
  return null;
}

describe('<ToastProvider> + <ToastTray>', () => {
  it('renders nothing when no toasts active', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <ToastProvider>
          <ToastTray />
        </ToastProvider>
      </ThemeProvider>,
    );
    expect(lastFrame() ?? '').toBe('');
  });

  it('renders an active toast', async () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <ToastProvider>
          <ToastTray />
          <ShowOnMount message="hello world" ttlMs={5000} />
        </ToastProvider>
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('hello world');
  });

  it('auto-dismisses after ttl', async () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <ToastProvider>
          <ToastTray />
          <ShowOnMount message="dismiss me" ttlMs={100} />
        </ToastProvider>
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    const frame1 = stripAnsi(lastFrame() ?? '');
    expect(frame1).toContain('dismiss me');
    await new Promise((r) => setTimeout(r, 200));
    const frame2 = stripAnsi(lastFrame() ?? '');
    expect(frame2).not.toContain('dismiss me');
  });

  it('caps queue at 3 toasts (oldest evicted)', async () => {
    function FireFour(): null {
      const { showToast } = useToast();
      React.useEffect(() => {
        showToast('a', { ttlMs: 5000 });
        showToast('b', { ttlMs: 5000 });
        showToast('c', { ttlMs: 5000 });
        showToast('d', { ttlMs: 5000 });
      }, [showToast]);
      return null;
    }
    const { lastFrame } = render(
      <ThemeProvider>
        <ToastProvider>
          <ToastTray />
          <FireFour />
        </ToastProvider>
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = stripAnsi(lastFrame() ?? '');
    // 'a' should have been evicted (oldest); 'b'/'c'/'d' remain.
    expect(frame).not.toContain('a\n');
    expect(frame).toContain('b');
    expect(frame).toContain('c');
    expect(frame).toContain('d');
  });

  it('useToast() outside provider returns no-op (lenient fallback)', () => {
    function Probe(): null {
      const { toasts, showToast } = useToast();
      expect(toasts).toEqual([]);
      // Should not throw
      showToast('test');
      return null;
    }
    expect(() =>
      render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      ),
    ).not.toThrow();
  });
});
