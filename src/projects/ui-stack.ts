import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Phase 4F.3 — UI-stack detection.
 *
 * Rule #13 (PLAN.md line 80, "design taste comes from reference") gates
 * the `design-researcher` droid behind THREE conditions:
 *   1. user message matches a design-intent phrase (Maestro's prompt
 *      handles this from the vocabulary fragment),
 *   2. `<project>/DESIGN.md` does not exist,
 *   3. the project has a UI stack.
 *
 * (3) is the only one that needs filesystem inspection. This helper
 * reads `<project>/package.json` and matches `dependencies` +
 * `devDependencies` against a closed set of known UI-framework
 * packages. Missing package.json (e.g. a Python project) ⇒ no UI
 * stack. Surfaced via `get_project_info`'s `hasUiStack` field so
 * Maestro can read it through the existing tool (no new MCP surface).
 *
 * The framework set is intentionally finite and named — adding
 * `htmx`, `qwik-city`, etc. is a one-line edit + a test row. Don't
 * widen to a regex match against `*-ui` patterns; the false-positive
 * tax outweighs the convenience.
 */

/** Closed set of UI-framework package names triggering rule #13. */
export const UI_FRAMEWORK_PACKAGES: ReadonlySet<string> = new Set([
  // React + meta-frameworks
  'react',
  'react-dom',
  'next',
  'remix',
  '@remix-run/react',
  'preact',
  'gatsby',
  // Vue + meta
  'vue',
  'nuxt',
  // Svelte
  'svelte',
  '@sveltejs/kit',
  // Other component frameworks
  'solid-js',
  'solid-start',
  'astro',
  'lit',
  'qwik',
  '@builder.io/qwik',
  '@builder.io/qwik-city',
  // Native-app UI frameworks (still count as a "design surface")
  'react-native',
  'expo',
  // Component-library-only signals (a project that ships shadcn or
  // installs an MUI/Chakra/etc. set is doing visual work).
  '@radix-ui/themes',
  '@mui/material',
  '@chakra-ui/react',
  '@mantine/core',
  'antd',
  'tailwindcss',
]);

export interface UiStackDetection {
  /** True when at least one known UI-framework package is in package.json. */
  readonly hasUiStack: boolean;
  /**
   * Names of the matched packages (lowercased, de-duplicated, sorted)
   * — surfaced in `get_project_info` so Maestro can name what it saw.
   */
  readonly frameworks: readonly string[];
}

/**
 * Detect whether `<projectPath>/package.json` declares any known UI
 * framework. Read errors (missing file, malformed JSON) are NOT
 * thrown — they resolve to `{hasUiStack: false, frameworks: []}` so
 * a Python/Go project never crashes the rule-#13 check.
 */
export async function detectUiStack(
  projectPath: string,
): Promise<UiStackDetection> {
  const pkgPath = path.join(projectPath, 'package.json');
  let raw: string;
  try {
    raw = await fsp.readFile(pkgPath, 'utf8');
  } catch {
    return { hasUiStack: false, frameworks: [] };
  }
  let parsed: { dependencies?: unknown; devDependencies?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed package.json — don't infer a UI stack from broken data.
    return { hasUiStack: false, frameworks: [] };
  }
  const keys = new Set<string>();
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const block = parsed[field];
    if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
      for (const k of Object.keys(block as Record<string, unknown>)) {
        if (UI_FRAMEWORK_PACKAGES.has(k)) keys.add(k);
      }
    }
  }
  const frameworks = [...keys].sort();
  return { hasUiStack: frameworks.length > 0, frameworks };
}

/**
 * Has the project already had a `DESIGN.md` written (rule #13 skip
 * condition). Lives next to the UI-stack helper because both feed
 * the same trigger gate; both are read by `get_project_info`.
 */
export async function hasDesignMd(projectPath: string): Promise<boolean> {
  try {
    await fsp.access(path.join(projectPath, 'DESIGN.md'));
    return true;
  } catch {
    return false;
  }
}
