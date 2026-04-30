/**
 * Build the args array for `child_process.spawn(nodeBinary, args)` when
 * launching a Symphony entry point.
 *
 * In dev mode (`.ts` entry under `tsx watch`), we must prepend
 * `--import tsx` so node's loader compiles TypeScript at runtime.
 * In production (bundled `.js` entry), returns args unchanged.
 *
 * tsx 4.x exports its loader at the default `tsx` specifier; node 22+
 * accepts `--import <specifier>` for module customization hooks.
 */
export function prependTsxLoaderIfTs(args: readonly string[]): readonly string[] {
  const entry = args[0];
  if (entry !== undefined && entry.endsWith('.ts')) {
    return ['--import', 'tsx', ...args];
  }
  return args;
}
