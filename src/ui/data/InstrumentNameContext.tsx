import React, { createContext, useContext } from 'react';

/**
 * Phase 3K — read-only context exposing a `getWorkerName(workerId)`
 * resolver to deeply-nested components (notably `SystemBubble` in the
 * chat panel).
 *
 * Why context instead of prop drilling: completion summaries arrive at
 * the chat reducer's `pushSystem` action; the TUI's instrument
 * allocator (`useInstrumentNames`) is parented at `AppShell`. The
 * Bubble component sits 4-5 levels down and would otherwise need an
 * invasive prop chain through MessageList. The context makes the
 * resolver render-time available without touching unrelated panels.
 *
 * Why resolution at render time (not at receipt): a worker that
 * spawns + completes inside one TUI poll-tick window never appears in
 * `useInstrumentNames`'s input set when its summary lands; receipt-
 * time resolution would freeze the system row on the server's slug
 * fallback (`worker-abc123`). A render-time lookup recovers the
 * proper instrument name as soon as the next poll cycle surfaces the
 * worker in the live registry.
 *
 * Default (provider-less): the resolver returns `undefined` for every
 * id, so callers fall back to whatever name the chat reducer stored
 * in the SystemTurn (the server's slug payload). Tests and visual
 * fixtures can mount Bubbles without wrapping in a provider.
 */

type Resolver = (workerId: string) => string | undefined;

const NOOP_RESOLVER: Resolver = () => undefined;

const InstrumentNameContext = createContext<Resolver>(NOOP_RESOLVER);

export interface InstrumentNameProviderProps {
  readonly value: Resolver;
  readonly children: React.ReactNode;
}

export function InstrumentNameProvider(
  props: InstrumentNameProviderProps,
): React.JSX.Element {
  return (
    <InstrumentNameContext.Provider value={props.value}>
      {props.children}
    </InstrumentNameContext.Provider>
  );
}

export function useResolveWorkerName(): Resolver {
  return useContext(InstrumentNameContext);
}
