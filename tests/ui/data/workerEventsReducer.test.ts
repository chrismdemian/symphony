import { describe, it, expect } from 'vitest';
import {
  INITIAL_WORKER_EVENTS_STATE,
  workerEventsReducer,
  type WorkerEventsAction,
  type WorkerEventsState,
} from '../../../src/ui/data/workerEventsReducer.js';
import type {
  AssistantTextEvent,
  AssistantThinkingEvent,
  ControlRequestEvent,
  LogEvent,
  ParseErrorEvent,
  ResultEvent,
  StreamEvent,
  SystemApiRetryEvent,
  SystemEvent,
  SystemInitEvent,
  ToolResultEvent,
  ToolUseEvent,
} from '../../../src/workers/types.js';

const text = (t: string): AssistantTextEvent => ({ type: 'assistant_text', text: t });
const thinking = (t: string): AssistantThinkingEvent => ({ type: 'assistant_thinking', text: t });
const toolUse = (callId: string, name: string, input: Record<string, unknown> = {}): ToolUseEvent => ({
  type: 'tool_use',
  callId,
  name,
  input,
});
const toolResult = (callId: string, content: string, isError = false): ToolResultEvent => ({
  type: 'tool_result',
  callId,
  content,
  isError,
});
const retry = (attempt = 1, delayMs = 5000): SystemApiRetryEvent => ({
  type: 'system_api_retry',
  attempt,
  delayMs,
  raw: { event: 'rate_limit', attempt, delayMs },
});
const result = (sessionId = 'sess-1', isError = false): ResultEvent => ({
  type: 'result',
  sessionId,
  isError,
  resultText: 'done',
  durationMs: 12_000,
  numTurns: 4,
  usageByModel: {},
});
const parseError = (reason = 'malformed json'): ParseErrorEvent => ({
  type: 'parse_error',
  reason,
});
const systemInit = (): SystemInitEvent => ({ type: 'system_init', sessionId: 'sess-1' });
const log = (message = 'noop'): LogEvent => ({ type: 'log', level: 'info', message });
const system = (subtype = 'compact_started'): SystemEvent => ({
  type: 'system',
  subtype,
  raw: { subtype },
});
const controlReq = (): ControlRequestEvent => ({
  type: 'control_request',
  requestId: 'r1',
  subtype: 'permission',
  toolName: 'Read',
  input: {},
});

function fold(actions: readonly WorkerEventsAction[]): WorkerEventsState {
  return actions.reduce(workerEventsReducer, INITIAL_WORKER_EVENTS_STATE);
}

const live = (event: StreamEvent): WorkerEventsAction => ({ kind: 'live', event });
const merge = (
  backfill: readonly StreamEvent[],
  pending: readonly StreamEvent[] = [],
): WorkerEventsAction => ({ kind: 'backfillMerge', backfill, pending });

describe('workerEventsReducer', () => {
  it('initial state is empty', () => {
    expect(INITIAL_WORKER_EVENTS_STATE).toEqual({
      events: [],
      lastRetryEvent: null,
      subscribeError: null,
      backfillReady: false,
    });
  });

  describe('live append', () => {
    it('appends visible events in order', () => {
      const out = fold([
        live(text('hello')),
        live(thinking('thinking aloud')),
        live(toolUse('c1', 'Read')),
        live(toolResult('c1', 'file contents')),
      ]);
      expect(out.events.map((e) => e.type)).toEqual([
        'assistant_text',
        'assistant_thinking',
        'tool_use',
        'tool_result',
      ]);
    });

    it('drops silent event types (system_init, log, control_request, system)', () => {
      const out = fold([
        live(systemInit()),
        live(log()),
        live(controlReq()),
        live(system('compact_completed')),
        live(text('visible')),
      ]);
      expect(out.events).toHaveLength(1);
      expect(out.events[0]?.type).toBe('assistant_text');
    });

    it('preserves backfillReady flag across live appends', () => {
      const merged = fold([merge([text('a')]), live(text('b'))]);
      expect(merged.backfillReady).toBe(true);
      expect(merged.events.map((e) => (e.type === 'assistant_text' ? e.text : '?'))).toEqual([
        'a',
        'b',
      ]);
    });
  });

  describe('rate-limit banner', () => {
    it('sets lastRetryEvent on system_api_retry', () => {
      const out = fold([live(retry(2, 8000))]);
      expect(out.lastRetryEvent).not.toBeNull();
      expect(out.lastRetryEvent?.attempt).toBe(2);
      expect(out.lastRetryEvent?.delayMs).toBe(8000);
    });

    it('clears lastRetryEvent on the next non-retry event', () => {
      const out = fold([live(retry()), live(text('back online'))]);
      expect(out.lastRetryEvent).toBeNull();
      expect(out.events.map((e) => e.type)).toEqual(['system_api_retry', 'assistant_text']);
    });

    it('a sequence of retries leaves lastRetryEvent pointing at the latest', () => {
      const out = fold([live(retry(1)), live(retry(2)), live(retry(3))]);
      expect(out.lastRetryEvent?.attempt).toBe(3);
      expect(out.events).toHaveLength(3);
    });

    it('silent events do NOT clear an active retry banner', () => {
      const out = fold([live(retry()), live(systemInit()), live(log())]);
      expect(out.lastRetryEvent).not.toBeNull();
    });
  });

  describe('backfillMerge', () => {
    it('produces backfill events in order with backfillReady=true', () => {
      const events: readonly StreamEvent[] = [text('one'), text('two'), text('three')];
      const out = fold([merge(events)]);
      expect(out.backfillReady).toBe(true);
      expect(out.events.map((e) => (e.type === 'assistant_text' ? e.text : '?'))).toEqual([
        'one',
        'two',
        'three',
      ]);
    });

    it('appends pending events when no overlap with backfill', () => {
      const backfill: readonly StreamEvent[] = [text('past-1'), text('past-2')];
      const pending: readonly StreamEvent[] = [text('live-1'), text('live-2')];
      const out = fold([merge(backfill, pending)]);
      expect(out.events.map((e) => (e.type === 'assistant_text' ? e.text : '?'))).toEqual([
        'past-1',
        'past-2',
        'live-1',
        'live-2',
      ]);
    });

    it('dedupes pending events that match backfill tail by deep-equality', () => {
      const overlap = text('overlap');
      const backfill: readonly StreamEvent[] = [text('past'), overlap];
      const pending: readonly StreamEvent[] = [{ ...overlap }, text('newer')];
      const out = fold([merge(backfill, pending)]);
      // The deep-equal overlap is dropped; the newer event survives.
      expect(out.events.map((e) => (e.type === 'assistant_text' ? e.text : '?'))).toEqual([
        'past',
        'overlap',
        'newer',
      ]);
    });

    it('filters silent events from BOTH backfill and pending', () => {
      const backfill: readonly StreamEvent[] = [systemInit(), text('visible-back')];
      const pending: readonly StreamEvent[] = [log(), text('visible-pending')];
      const out = fold([merge(backfill, pending)]);
      expect(out.events.map((e) => (e.type === 'assistant_text' ? e.text : '?'))).toEqual([
        'visible-back',
        'visible-pending',
      ]);
    });

    it('re-derives lastRetryEvent via backwards walk after merge', () => {
      // A retry buried under a later non-retry should NOT raise the banner.
      const backfill: readonly StreamEvent[] = [retry(1), text('answered')];
      expect(fold([merge(backfill)]).lastRetryEvent).toBeNull();

      // A retry at the very end keeps the banner up.
      const backfill2: readonly StreamEvent[] = [text('older'), retry(2)];
      expect(fold([merge(backfill2)]).lastRetryEvent?.attempt).toBe(2);

      // A trailing pending non-retry clears it after merge.
      const backfill3: readonly StreamEvent[] = [retry(3)];
      const pending3: readonly StreamEvent[] = [text('reply')];
      expect(fold([merge(backfill3, pending3)]).lastRetryEvent).toBeNull();
    });

    it('handles result + parse_error events alongside the rest', () => {
      const out = fold([merge([text('hi'), result(), parseError('bad-line')])]);
      expect(out.events.map((e) => e.type)).toEqual([
        'assistant_text',
        'result',
        'parse_error',
      ]);
    });
  });

  describe('subscribeError', () => {
    it('sets the error without touching events or backfillReady', () => {
      const e = new Error('ws closed');
      const out = fold([live(text('a')), { kind: 'subscribeError', error: e }]);
      expect(out.subscribeError).toBe(e);
      expect(out.events).toHaveLength(1);
      expect(out.backfillReady).toBe(false);
    });

    it('does not clobber existing events on later live appends', () => {
      const out = fold([
        { kind: 'subscribeError', error: new Error('boom') },
        live(text('after')),
      ]);
      expect(out.events).toHaveLength(1);
      expect(out.subscribeError?.message).toBe('boom');
    });
  });
});
