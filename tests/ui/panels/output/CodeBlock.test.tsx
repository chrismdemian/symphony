import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { CodeBlock } from '../../../../src/ui/panels/output/CodeBlock.js';

describe('<CodeBlock> (Phase 3F.4)', () => {
  it('renders ts code with violet keyword + gold string', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <CodeBlock kind="code" lang="ts" source={"const s = 'hi';"} />
      </ThemeProvider>,
    );
    const raw = lastFrame() ?? '';
    // Violet for keywords (`const`)
    expect(raw).toContain('\x1b[38;2;124;111;235m');
    // Gold for strings (`'hi'`)
    expect(raw).toContain('\x1b[38;2;212;168;67m');
  });

  it('renders unknown lang as plain text (no token coloring beyond default)', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <CodeBlock kind="code" lang="unknownlang" source="abc 123" />
      </ThemeProvider>,
    );
    const raw = lastFrame() ?? '';
    // Default text color (light gray)
    expect(raw).toContain('\x1b[38;2;224;224;224m');
    // No keyword violet (no recognized lang).
    expect(raw).not.toContain('\x1b[38;2;124;111;235m');
  });

  it('renders diff with green +/red -/cyan @@', () => {
    const source = '@@ -1,1 +1,1 @@\n-old\n+new';
    const { lastFrame } = render(
      <ThemeProvider>
        <CodeBlock kind="diff" source={source} />
      </ThemeProvider>,
    );
    const raw = lastFrame() ?? '';
    // diffAdd green #98C379 → \x1b[38;2;152;195;121m
    expect(raw).toContain('\x1b[38;2;152;195;121m');
    // diffRemove red #E06C75 → \x1b[38;2;224;108;117m
    expect(raw).toContain('\x1b[38;2;224;108;117m');
    // diffHunk cyan #56B6C2 → \x1b[38;2;86;182;194m
    expect(raw).toContain('\x1b[38;2;86;182;194m');
  });

  it('renders diff +++/--- file headers as muted meta', () => {
    const source = '--- a/x\n+++ b/x';
    const { lastFrame } = render(
      <ThemeProvider>
        <CodeBlock kind="diff" source={source} />
      </ThemeProvider>,
    );
    const raw = lastFrame() ?? '';
    // diffMeta = grayMuted #888888 → \x1b[38;2;136;136;136m
    expect(raw).toContain('\x1b[38;2;136;136;136m');
    // Should NOT use the add/remove green/red for the headers.
  });

  it('renders python code with violet `def` keyword', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <CodeBlock kind="code" lang="py" source={'def foo():\n    pass'} />
      </ThemeProvider>,
    );
    const raw = lastFrame() ?? '';
    expect(raw).toContain('\x1b[38;2;124;111;235m'); // violet keyword
  });
});
