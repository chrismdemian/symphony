import React from 'react';
import { Box, Text } from 'ink';
import {
  StateProvider,
  VisibilityProvider,
  ValidationProvider,
  ActionProvider,
  Renderer,
} from '@json-render/ink';
import { useTheme } from '../../theme/context.js';
import type { Theme } from '../../theme/theme.js';
import { SYMPHONY_JSON_RENDER_REGISTRY } from './jsonRenderRegistry.js';

/**
 * Phase 3D.2 — wrapper around `@json-render/ink`'s Renderer.
 *
 * Responsibilities:
 *  1. Provide the renderer's required contexts WITHOUT json-render's
 *     `<JSONUIProvider>`. Phase 4E: `JSONUIProvider` hardwires an
 *     internal `<FocusProvider>` that unconditionally registers an Ink
 *     `useInput` Tab handler. The output panel can mount N
 *     `<JsonRenderBlock>` instances at once (one per worker completion
 *     `display`); Ink's `useInput` is additive (every mounted handler
 *     receives every keypress), so N FocusProviders = N rival Tab
 *     handlers competing with Symphony's `KeybindProvider`
 *     (`focus.cycle` / `focus.cycleReverse`, both `unbindable`). We
 *     instead compose `JSONUIProvider`'s exact stack
 *     (State→Visibility→Validation→Action) by hand and substitute a
 *     `<NoopFocusProvider>` for json-render's FocusProvider. See 3D.2
 *     review M2 ("custom FocusProvider shim").
 *  2. Apply Symphony's themed component overrides via `registry`.
 *  3. Pre-validate the spec shape locally (cheap structural checks)
 *     before passing it through — invalid specs render the fallback
 *     directly without a boundary trip.
 *  4. Wrap the renderer in a class-based React `ErrorBoundary` so a
 *     runtime crash inside the renderer (theoretically possible from
 *     Ink-6→7 API drift, even though the spike didn't trip any) shows
 *     a fallback row instead of tearing down the panel.
 *  5. The stack is mounted with no handlers and no navigation —
 *     display-only specs per PLAN.md §3D.2 D7. Worker `display` specs
 *     are display-only and the bundled `json-render` skill bans
 *     focusable components (`TextInput`/`Select`/…); the shim is
 *     defense-in-depth so a spec that violates the ban still cannot
 *     steal Tab — it just renders non-interactive.
 *
 * Failure modes:
 *  - Spec shape invalid (`!spec.root` / `!elements`) → `<FallbackPlainText>`
 *    with `reason='spec missing root or elements'`.
 *  - Renderer throws at runtime → boundary catches → `<FallbackPlainText>`
 *    with `reason=<error.message>`.
 *  - Standard component fails to find a registry entry → `@json-render/ink`'s
 *    own `console.warn` + null-render. Surfaces in test logs but doesn't
 *    crash the panel; visible signal is "the spec block is empty."
 */

export interface JsonRenderBlockProps {
  readonly spec: unknown;
}

/** Truncation cap for the raw spec dump in the fallback row. Generous
 *  enough to debug small specs; bounded so a malformed 100 KB blob
 *  doesn't flood the panel. Mirrors the 1500-ch / 12-line cap used by
 *  `formatToolResult` in chat. */
const RAW_TRUNCATION_CHARS = 500;

interface JsonRenderBoundaryState {
  readonly errorMessage: string | null;
}

/** React `ErrorBoundary` is class-only (function components can't catch
 *  child render errors). `componentDidCatch` lets us swallow the error,
 *  set state, and render the fallback. Unrelated to Ink's lifecycle —
 *  Ink supports class components fine.
 *
 *  Exported for direct unit testing — the boundary is otherwise private
 *  to this module's render path and the only way to exercise its
 *  `componentDidCatch` is to pass a child that throws synchronously. */
export class JsonRenderErrorBoundary extends React.Component<
  { readonly children: React.ReactNode; readonly raw: string; readonly theme: Theme },
  JsonRenderBoundaryState
> {
  override state: JsonRenderBoundaryState = { errorMessage: null };

  static getDerivedStateFromError(error: unknown): JsonRenderBoundaryState {
    return {
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  override render(): React.ReactNode {
    if (this.state.errorMessage !== null) {
      return (
        <FallbackPlainText
          reason={this.state.errorMessage}
          raw={this.props.raw}
        />
      );
    }
    return this.props.children;
  }
}

interface FallbackPlainTextProps {
  readonly reason: string;
  readonly raw: string;
}

export function FallbackPlainText({
  reason,
  raw,
}: FallbackPlainTextProps): React.JSX.Element {
  const theme = useTheme();
  const truncated =
    raw.length > RAW_TRUNCATION_CHARS
      ? `${raw.slice(0, RAW_TRUNCATION_CHARS)}…`
      : raw;
  return (
    <Box flexDirection="column">
      <Text color={theme['jsonRenderError']}>
        ⚠ json-render block failed: {reason}
      </Text>
      {truncated.length > 0 ? (
        <Text color={theme['jsonRenderMuted']}>{truncated}</Text>
      ) : null}
    </Box>
  );
}

interface ParsedSpec {
  readonly root: string;
  readonly elements: Record<string, unknown>;
  readonly state?: Record<string, unknown>;
}

/** Cheap structural shape check before we hand the spec to the renderer.
 *  The renderer is defensive (returns `null` on missing root) but
 *  silent — we'd see no fallback for the user. Doing the check here
 *  lets us emit the visible fallback row consistently. */
function validateShape(spec: unknown): ParsedSpec | string {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return 'spec must be a json object';
  }
  const obj = spec as Record<string, unknown>;
  const root = obj['root'];
  if (typeof root !== 'string' || root.length === 0) {
    return 'spec.root must be a non-empty string';
  }
  const elements = obj['elements'];
  if (
    elements === null ||
    typeof elements !== 'object' ||
    Array.isArray(elements)
  ) {
    return 'spec.elements must be a json object';
  }
  if (!(root in (elements as Record<string, unknown>))) {
    return `spec.elements is missing the root element "${root}"`;
  }
  const state = obj['state'];
  const parsed: ParsedSpec = {
    root,
    elements: elements as Record<string, unknown>,
  };
  if (state !== undefined) {
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      return 'spec.state must be a json object when present';
    }
    return {
      ...parsed,
      state: state as Record<string, unknown>,
    };
  }
  return parsed;
}

/**
 * Stand-in for json-render's internal `<FocusProvider>` (Phase 4E shim).
 *
 * json-render's `FocusContext` is module-private (not exported), so we
 * cannot construct a context value and inject it. We don't need to:
 * every consumer of that context — `useFocus()` and `useFocusDisable()`
 * — reads it with optional chaining and a safe fallback
 * (`ctx?.register(id)`, `ctx?.isFocused(id) ?? false`,
 * `ctx?.setDisabled(...)`). With no provider mounted the context stays
 * at its `createContext(null)` default: focusable components report
 * `isActive: false` and `useFocusDisable` is a no-op — no throw, and
 * critically NO Ink `useInput` Tab registration. The shim is therefore
 * a transparent passthrough; its value is documenting the intent and
 * giving the omission a single greppable, testable seam.
 */
export function NoopFocusProvider({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return <>{children}</>;
}

export function JsonRenderBlock({
  spec,
}: JsonRenderBlockProps): React.JSX.Element {
  const theme = useTheme();
  const validated = validateShape(spec);
  const raw =
    typeof spec === 'object' && spec !== null
      ? safeStringify(spec)
      : String(spec);

  if (typeof validated === 'string') {
    return <FallbackPlainText reason={validated} raw={raw} />;
  }

  return (
    <JsonRenderErrorBoundary raw={raw} theme={theme}>
      <StateProvider initialState={validated.state}>
        <VisibilityProvider>
          <ValidationProvider>
            <ActionProvider>
              <NoopFocusProvider>
                <Renderer
                  spec={
                    validated as unknown as Parameters<
                      typeof Renderer
                    >[0]['spec']
                  }
                  registry={SYMPHONY_JSON_RENDER_REGISTRY}
                />
              </NoopFocusProvider>
            </ActionProvider>
          </ValidationProvider>
        </VisibilityProvider>
      </StateProvider>
    </JsonRenderErrorBoundary>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unstringifiable spec]';
  }
}
