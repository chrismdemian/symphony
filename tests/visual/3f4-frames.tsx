/**
 * Phase 3F.4 — visual frame harness for syntax highlighting + diff
 * colorization in the output panel.
 *
 * Captures canonical states:
 *   01-ts-code-block       ts fence with const/string/number tokens
 *   02-diff-block          diff fence with +/-/@@/meta lines
 *   03-py-code-block       py fence with def/comment
 *   04-mixed               narrative + ts fence + diff fence in one event
 *   05-unknown-lang        ` ```weirdlang ` fence renders default text
 *   06-unclosed-fence      missing closing delimiter falls through as text
 *
 * `.visual-frames/3f4-<state>.{ansi,plain}.txt` + `INDEX-3f4.md`.
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { CodeBlock } from '../../src/ui/panels/output/CodeBlock.js';
import { detectMarkdownFences } from '../../src/ui/panels/output/markdownFenceDetect.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly element: React.JSX.Element;
}

const SCENARIOS: Scenario[] = [
  {
    name: '01-ts-code-block',
    description:
      'ts code block: violet `const`/`number` keywords, gold `\'hello\'` string, light-gray default text.',
    element: (
      <CodeBlock
        kind="code"
        lang="ts"
        source={`const greeting: string = 'hello';\nconst n: number = 42;`}
      />
    ),
  },
  {
    name: '02-diff-block',
    description:
      'Unified diff: green +adds, red -removes, cyan @@hunk, muted +++/--- file headers + "\\ No newline".',
    element: (
      <CodeBlock
        kind="diff"
        source={[
          '--- a/file.ts',
          '+++ b/file.ts',
          '@@ -1,3 +1,3 @@',
          ' const x = 1;',
          '-const y = 2;',
          '+const y = 3;',
          ' return x + y;',
          '\\ No newline at end of file',
        ].join('\n')}
      />
    ),
  },
  {
    name: '03-py-code-block',
    description: 'py code block: violet `def`/`return` keywords, muted gray `# comment`, gold strings.',
    element: (
      <CodeBlock
        kind="code"
        lang="py"
        source={`def greet(name: str) -> str:\n    # friendly hello\n    return f'Hello, {name}!'`}
      />
    ),
  },
  {
    name: '04-mixed-fences',
    description:
      'Narrative text + a ts fence + a diff fence. Verifies detector + renderer interplay end-to-end.',
    element: (() => {
      const text =
        'Here is the change.\n\n' +
        '```ts\n' +
        'function add(a: number, b: number): number {\n  return a + b;\n}\n' +
        '```\n\n' +
        'Diff:\n\n' +
        '```diff\n' +
        '@@ -1,1 +1,1 @@\n' +
        '-old\n' +
        '+new\n' +
        '```';
      const { segments } = detectMarkdownFences(text);
      return (
        <Box flexDirection="column">
          {segments.map((seg, i) => {
            const key = `s-${i}`;
            if (seg.kind === 'text') {
              return <Box key={key}><RenderText text={seg.value} /></Box>;
            }
            if (seg.kind === 'diff') {
              return <CodeBlock key={key} kind="diff" source={seg.source} />;
            }
            return <CodeBlock key={key} kind="code" lang={seg.lang} source={seg.source} />;
          })}
        </Box>
      );
    })(),
  },
  {
    name: '05-unknown-lang',
    description:
      'Unknown language tag (`weirdlang`) renders as default text — no token coloring beyond outputText.',
    element: (
      <CodeBlock
        kind="code"
        lang="weirdlang"
        source={'foo bar baz\nx y z'}
      />
    ),
  },
  {
    name: '06-unclosed-fence',
    description:
      'Unclosed fence inside narrative falls through as plain text — no half-rendering.',
    element: (() => {
      const text = 'before\n```ts\nconst x = 1;\nno closing delimiter';
      const { segments } = detectMarkdownFences(text);
      return (
        <Box flexDirection="column">
          {segments.map((seg, i) => {
            const key = `s-${i}`;
            if (seg.kind === 'text') {
              return <Box key={key}><RenderText text={seg.value} /></Box>;
            }
            if (seg.kind === 'diff') {
              return <CodeBlock key={key} kind="diff" source={seg.source} />;
            }
            return <CodeBlock key={key} kind="code" lang={seg.lang} source={seg.source} />;
          })}
        </Box>
      );
    })(),
  },
];

import { Text } from 'ink';
import { useTheme } from '../../src/ui/theme/context.js';

function RenderText({ text }: { readonly text: string }): React.JSX.Element {
  const theme = useTheme();
  return <Text color={theme['outputText']}>{text}</Text>;
}

interface CapturedFrame {
  readonly ansi: string;
  readonly plain: string;
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

async function captureScenario(scenario: Scenario): Promise<CapturedFrame> {
  const result = render(
    <Box flexDirection="column" width={100}>
      <ThemeProvider>{scenario.element}</ThemeProvider>
    </Box>,
  );
  await flushAll();
  const ansi = result.lastFrame() ?? '';
  const plain = stripAnsi(ansi);
  result.unmount();
  return { ansi, plain };
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const summary: string[] = [
    '# Phase 3F.4 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Code-block + diff rendering for the output panel.',
    '',
    'Palette referenced (locked):',
    '- `syntaxKeyword` (ts `const`, py `def`, json `true`/`false`/`null`) → violet `#7C6FEB` → `\\x1b[38;2;124;111;235m`',
    '- `syntaxString` (`\'hello\'`, `"abc"`) → gold `#D4A843` → `\\x1b[38;2;212;168;67m`',
    '- `syntaxComment` (`//`, `#`, `/* */`) → muted `#888888` → `\\x1b[38;2;136;136;136m`',
    '- `syntaxNumber` (42, 42.5) → gold-light `#E5C07B` → `\\x1b[38;2;229;192;123m`',
    '- `outputText` (default for code, plain narrative) → light gray `#E0E0E0` → `\\x1b[38;2;224;224;224m`',
    '- `diffAdd` (`+` lines) → green `#98C379` → `\\x1b[38;2;152;195;121m`',
    '- `diffRemove` (`-` lines) → red `#E06C75` → `\\x1b[38;2;224;108;117m`',
    '- `diffHunk` (`@@`) → cyan `#56B6C2` → `\\x1b[38;2;86;182;194m`',
    '- `diffMeta` (`+++`/`---`/`\\ No newline`) → muted `#888888` → `\\x1b[38;2;136;136;136m`',
    '- `diffContext` (unprefixed) → light gray `#E0E0E0` → `\\x1b[38;2;224;224;224m`',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3f4-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3f4-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3f4.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
