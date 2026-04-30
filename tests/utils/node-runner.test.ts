import { describe, it, expect } from 'vitest';
import { prependTsxLoaderIfTs } from '../../src/utils/node-runner.js';

describe('prependTsxLoaderIfTs', () => {
  it('prepends `--import tsx` when entry is a .ts file', () => {
    expect(prependTsxLoaderIfTs(['/repo/src/index.ts', 'mcp-server'])).toEqual([
      '--import',
      'tsx',
      '/repo/src/index.ts',
      'mcp-server',
    ]);
  });

  it('returns args verbatim when entry is a .js file', () => {
    const args = ['/abs/dist/index.js', 'mcp-server', '--in-memory'];
    expect(prependTsxLoaderIfTs(args)).toEqual(args);
  });

  it('returns args verbatim when entry is empty', () => {
    expect(prependTsxLoaderIfTs([])).toEqual([]);
  });

  it('matches only the .ts suffix, not .ts in the middle of a name', () => {
    // `entry.tsx` does NOT end in `.ts` — the substring check is suffix-only.
    expect(prependTsxLoaderIfTs(['/path/foo.tsx', 'mcp-server'])).toEqual([
      '/path/foo.tsx',
      'mcp-server',
    ]);
  });
});
