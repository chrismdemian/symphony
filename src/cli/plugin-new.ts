import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assertSafePluginId, PluginIdError } from '../plugins/paths.js';
import { parsePluginManifest, PLUGIN_API_VERSION } from '../plugins/manifest.js';

/**
 * Phase 7B.1 — `symphony plugin new <name>` scaffolding generator.
 *
 * Produces a self-contained, runnable plugin directory: a validated
 * `plugin.json`, a `package.json` (deps the vendored SDK needs), a working
 * `index.js` starter, the vendored `@symphony/plugin-sdk` build under
 * `lib/`, a README, and a `.gitignore`. The scaffold runs with just
 * `npm install` (for `@modelcontextprotocol/sdk` + `zod`) and `node
 * index.js` — no published SDK package required.
 *
 * The id is derived from `<name>` (slugged + validated via the same
 * `assertSafePluginId` boundary the host uses). A non-empty target dir is
 * refused unless `--force` (no silent overwrite — mirrors the 5B add /
 * 4F.1 fail-loud posture).
 */

export interface PluginCliResult {
  readonly exitCode: number;
}

export interface RunPluginNewOptions {
  readonly name: string;
  /** Target directory. Defaults to `<cwd>/<id>`. */
  readonly out?: string;
  readonly author?: string;
  readonly force?: boolean;
  /** Override the vendored-SDK source path (test seam). */
  readonly sdkVendorPath?: string;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

function writer(stream: NodeJS.WritableStream | undefined, fallback: NodeJS.WritableStream) {
  const s = stream ?? fallback;
  return (line: string): void => {
    s.write(line.endsWith('\n') ? line : `${line}\n`);
  };
}

/** Slug a free-form name into a candidate plugin id. May return ''. */
export function slugifyPluginId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    // Collapse `__` — it's reserved as the `<id>__<tool>` proxy separator,
    // so `assertSafePluginId` rejects it. Auto-fix rather than fail on a
    // reasonable name like `foo__bar`.
    .replace(/_{2,}/g, '_')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/**
 * Resolve the vendored SDK bundle (`symphony-plugin-sdk.mjs`). Walks
 * candidate locations for both dev (tsx, `src/cli/`) and built
 * (`dist/index.js`) layouts, plus a copy emitted next to `dist/`. Returns
 * the first that exists.
 */
async function resolveSdkVendorPath(override?: string): Promise<string | undefined> {
  if (override !== undefined) {
    return (await exists(override)) ? override : undefined;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // tsup copies the vendor bundle here on build (next to dist/index.js).
    path.resolve(here, 'plugin-sdk/symphony-plugin-sdk.mjs'),
    // built layout: dist/index.js → repo root → packages workspace.
    path.resolve(here, '../packages/plugin-sdk/dist/vendor/symphony-plugin-sdk.mjs'),
    // dev layout: src/cli/ → repo root → packages workspace.
    path.resolve(here, '../../packages/plugin-sdk/dist/vendor/symphony-plugin-sdk.mjs'),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function dirIsNonEmpty(p: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(p);
    return entries.length > 0;
  } catch {
    return false;
  }
}

export async function runPluginNew(opts: RunPluginNewOptions): Promise<PluginCliResult> {
  const out = writer(opts.stdout, process.stdout);
  const err = writer(opts.stderr, process.stderr);

  // 1. Derive + validate the id.
  const slug = slugifyPluginId(opts.name);
  if (slug.length === 0) {
    err(`[symphony plugin] cannot derive a valid id from '${opts.name}' — pass a name with letters/digits.`);
    return { exitCode: 1 };
  }
  let id: string;
  try {
    id = assertSafePluginId(slug);
  } catch (e) {
    err(`[symphony plugin] ${e instanceof PluginIdError ? e.message : String(e)}`);
    return { exitCode: 1 };
  }

  // 2. Resolve + check the target dir.
  const targetDir = path.resolve(opts.out ?? path.join(process.cwd(), id));
  if ((await dirIsNonEmpty(targetDir)) && opts.force !== true) {
    err(`[symphony plugin] target '${targetDir}' is not empty — pass --force to scaffold into it anyway.`);
    return { exitCode: 1 };
  }

  // 3. Resolve the vendored SDK bundle.
  const sdkVendor = await resolveSdkVendorPath(opts.sdkVendorPath);
  if (sdkVendor === undefined) {
    err(
      '[symphony plugin] could not locate the bundled SDK (symphony-plugin-sdk.mjs). ' +
        'Run `pnpm build:packages` first (builds @symphony/plugin-sdk).',
    );
    return { exitCode: 1 };
  }

  // 4. Build + validate the manifest BEFORE writing anything.
  const manifestObject = {
    schemaVersion: 1,
    id,
    name: opts.name.trim(),
    version: '0.1.0',
    author: (opts.author ?? 'you').trim() || 'you',
    description: `A Symphony plugin (${id}).`,
    entrypoint: { command: 'node', args: ['index.js'] },
    permissions: [] as string[],
    capabilityFlags: [] as string[],
    events: ['onTaskCompleted'] as string[],
    requiresPluginApi: `^${PLUGIN_API_VERSION}`,
    toolScope: 'act',
  };
  try {
    parsePluginManifest(manifestObject);
  } catch (e) {
    // Should never happen (we construct a valid object) — fail loud if it does.
    err(`[symphony plugin] internal: generated manifest is invalid: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: 1 };
  }

  // 5. Write the scaffold.
  try {
    await fsp.mkdir(path.join(targetDir, 'lib'), { recursive: true });
    await fsp.copyFile(sdkVendor, path.join(targetDir, 'lib', 'symphony-plugin-sdk.mjs'));
    await Promise.all([
      writeFile(path.join(targetDir, 'plugin.json'), `${JSON.stringify(manifestObject, null, 2)}\n`),
      writeFile(path.join(targetDir, 'package.json'), scaffoldPackageJson(id, manifestObject.author)),
      writeFile(path.join(targetDir, 'index.js'), scaffoldIndexJs(id, opts.name.trim())),
      writeFile(path.join(targetDir, 'README.md'), scaffoldReadme(id, opts.name.trim())),
      writeFile(path.join(targetDir, '.gitignore'), 'node_modules/\n*.log\n'),
    ]);
  } catch (e) {
    err(`[symphony plugin] scaffold failed: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: 1 };
  }

  out(`Created plugin '${id}' at ${targetDir}`);
  err(`[symphony plugin] next steps:`);
  err(`  cd ${targetDir}`);
  err('  npm install');
  err(`  symphony plugin install ${targetDir}`);
  err(`  symphony plugin enable ${id}`);
  return { exitCode: 0 };
}

async function writeFile(p: string, content: string): Promise<void> {
  await fsp.writeFile(p, content, 'utf8');
}

function scaffoldPackageJson(id: string, author: string): string {
  const pkg = {
    name: id,
    version: '0.1.0',
    private: true,
    description: `A Symphony plugin (${id}).`,
    type: 'module',
    author,
    scripts: {
      start: 'node index.js',
    },
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.29.0',
      zod: '^4.3.6',
    },
    license: 'MIT',
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function scaffoldIndexJs(id: string, displayName: string): string {
  return `// ${displayName} — a Symphony plugin.
//
// Built with @symphony/plugin-sdk (vendored at ./lib/symphony-plugin-sdk.mjs).
// Run \`npm install\` once to fetch @modelcontextprotocol/sdk + zod, then
// \`symphony plugin install .\` from this directory.
//
// IMPORTANT: stdout is the MCP channel — write diagnostics to stderr only.
import { createPlugin } from './lib/symphony-plugin-sdk.mjs';
import { z } from 'zod';

await createPlugin({ id: ${JSON.stringify(id)}, name: ${JSON.stringify(displayName)}, version: '0.1.0' })
  // A callable tool. Maestro sees it as \`${id}__hello\`.
  .tool({
    name: 'hello',
    description: 'Return a friendly greeting.',
    inputSchema: { who: z.string().describe('Who to greet.') },
    handler: ({ who }) => \`Hello, \${who}, from ${displayName}!\`,
  })
  // An event handler. Symphony calls this when a task completes.
  // Declare the event in plugin.json's "events" array for it to fire.
  .onTaskCompleted((e) => {
    process.stderr.write(\`[${id}] task \${e.taskId} completed\\n\`);
  })
  .serve();

process.stderr.write('[${id}] serving\\n');
`;
}

function scaffoldReadme(id: string, displayName: string): string {
  return `# ${displayName}

A Symphony plugin, scaffolded with \`symphony plugin new\`.

## Develop

\`\`\`bash
npm install        # fetch @modelcontextprotocol/sdk + zod
node index.js      # smoke-run the MCP server (Ctrl+C to stop)
\`\`\`

## Install into Symphony

\`\`\`bash
symphony plugin install .
symphony plugin enable ${id}
# turn on the plugins master switch (default off):
symphony config set pluginsEnabled true
\`\`\`

Restart Symphony. The plugin's tools appear to Maestro namespaced as
\`${id}__<tool>\`.

## Files

- \`plugin.json\` — install-time consent record (spawn recipe + permissions + events).
- \`index.js\` — the plugin (edit this).
- \`lib/symphony-plugin-sdk.mjs\` — vendored SDK (do not edit; re-vendor on SDK upgrade).
`;
}
