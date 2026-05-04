// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'research/**',
      '.symphony/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
  {
    // Phase 3D.2 — workers and the orchestrator MUST NOT import the
    // json-render renderer or its Symphony wrapper. Workers EMIT specs
    // (as fenced ` ```json-render ` blocks inside assistant_text); the
    // TUI RENDERS them. Crossing that line couples worker code to the
    // Ink runtime and would let a worker crash take down the panel.
    // See CLAUDE.md §"Generative TUI / rich worker output".
    files: ['src/workers/**/*.{ts,tsx}', 'src/orchestrator/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@json-render/ink', '@json-render/ink/*'],
              message:
                'Workers and orchestrator MUST NOT import the json-render renderer. Workers emit fenced specs; the TUI renders them. See CLAUDE.md §"Generative TUI / rich worker output".',
            },
            {
              group: [
                '**/ui/panels/output/JsonRenderBlock',
                '**/ui/panels/output/JsonRenderBlock.js',
                '**/ui/panels/output/jsonRenderRegistry',
                '**/ui/panels/output/jsonRenderRegistry.js',
              ],
              message:
                'Workers and orchestrator MUST NOT import the JsonRenderBlock wrapper or its registry. See CLAUDE.md §"Generative TUI / rich worker output".',
            },
            {
              // Phase 3F.4 — same constraint, syntax highlighter edition.
              // Workers EMIT markdown fences inside assistant_text; the
              // TUI tokenizes + renders them. Workers must not link
              // against the highlighter or its components.
              group: [
                '**/ui/panels/output/highlight',
                '**/ui/panels/output/highlight.js',
                '**/ui/panels/output/diffColorize',
                '**/ui/panels/output/diffColorize.js',
                '**/ui/panels/output/CodeBlock',
                '**/ui/panels/output/CodeBlock.js',
                '**/ui/panels/output/markdownFenceDetect',
                '**/ui/panels/output/markdownFenceDetect.js',
              ],
              message:
                'Workers and orchestrator MUST NOT import the syntax highlighter or fence detector. Workers emit fenced markdown; the TUI renders. See CLAUDE.md §"Generative TUI / rich worker output".',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
      },
    },
  },
  prettier,
);
