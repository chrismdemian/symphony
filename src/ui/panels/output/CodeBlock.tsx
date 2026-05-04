import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import { tokenize, type TokenKind } from './highlight.js';
import { colorizeDiff, type DiffLineKind } from './diffColorize.js';

/**
 * Phase 3F.4 — render a fenced code or diff block as colorized Ink text.
 *
 * Two flavors:
 *   - `<CodeBlock kind="code" lang={lang} source={source}/>` — runs
 *     `tokenize(lang, source)` and emits one `<Text>` per token,
 *     colored via `theme[syntaxKeyword|String|Comment|Number]`.
 *   - `<CodeBlock kind="diff" source={source}/>` — runs
 *     `colorizeDiff(source)` and emits one `<Text>` per line, colored
 *     via `theme[diffAdd|Remove|Hunk|Meta|Context]`.
 *
 * Tokenization is memoized inside `tokenize()` (LRU keyed on
 * `${lang}::${source}`); the `useMemo` here is belt-and-braces against
 * React re-renders triggered by parent state.
 *
 * No left padding / line-numbers; the worker output panel already has
 * its own panel chrome and we don't want to double-indent. Diff lines
 * keep their leading `+`/`-`/`@@` so users can copy-paste back into a
 * unified-diff context cleanly.
 */

export type CodeBlockProps =
  | { readonly kind: 'code'; readonly lang: string; readonly source: string }
  | { readonly kind: 'diff'; readonly source: string };

export function CodeBlock(props: CodeBlockProps): React.JSX.Element {
  if (props.kind === 'code') return <CodeBlockSyntax lang={props.lang} source={props.source} />;
  return <CodeBlockDiff source={props.source} />;
}

function CodeBlockSyntax({
  lang,
  source,
}: {
  readonly lang: string;
  readonly source: string;
}): React.JSX.Element {
  const theme = useTheme();
  const tokens = useMemo(() => tokenize(lang, source), [lang, source]);
  return (
    <Box flexDirection="column">
      <Text>
        {tokens.map((tok, i) => (
          <Text key={i} color={syntaxColor(theme, tok.kind)}>
            {tok.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function CodeBlockDiff({ source }: { readonly source: string }): React.JSX.Element {
  const theme = useTheme();
  const lines = useMemo(() => colorizeDiff(source), [source]);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={diffColor(theme, line.kind)}>
          {line.text}
        </Text>
      ))}
    </Box>
  );
}

function syntaxColor(theme: Record<string, string>, kind: TokenKind): string {
  switch (kind) {
    case 'keyword':
      return theme['syntaxKeyword']!;
    case 'string':
      return theme['syntaxString']!;
    case 'comment':
      return theme['syntaxComment']!;
    case 'number':
      return theme['syntaxNumber']!;
    case 'default':
      return theme['outputText']!;
  }
}

function diffColor(theme: Record<string, string>, kind: DiffLineKind): string {
  switch (kind) {
    case 'add':
      return theme['diffAdd']!;
    case 'remove':
      return theme['diffRemove']!;
    case 'hunk':
      return theme['diffHunk']!;
    case 'meta':
      return theme['diffMeta']!;
    case 'context':
      return theme['diffContext']!;
  }
}
