import type { Readable } from 'node:stream';
import { ndjsonLines, type NdjsonOptions } from './ndjson.js';
import { scanForCompletionReport } from './completion-report.js';
import type {
  StreamEvent,
  TokenUsage,
  ResultEvent,
  ParseErrorEvent,
} from './types.js';

export type ParseOptions = NdjsonOptions;

export async function* parseStream(
  source: Readable | AsyncIterable<Buffer | string>,
  options: ParseOptions = {},
): AsyncIterable<StreamEvent> {
  const usageByModel: Record<string, TokenUsage> = {};

  for await (const line of ndjsonLines(source, options)) {
    if (line.kind === 'over_cap') {
      yield {
        type: 'parse_error',
        reason: `line exceeded max bytes; dropped ${line.droppedBytes} bytes`,
      };
      continue;
    }

    let msg: RawMessage;
    try {
      const parsed = JSON.parse(line.value);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        yield parseError('json payload was not an object', line.value);
        continue;
      }
      msg = parsed as RawMessage;
    } catch (err) {
      yield parseError(
        `json parse failed: ${err instanceof Error ? err.message : String(err)}`,
        line.value,
      );
      continue;
    }

    const rawType = typeof msg.type === 'string' ? msg.type : '';
    switch (rawType) {
      case 'system':
        yield* handleSystem(msg);
        break;
      case 'assistant':
        yield* handleAssistant(msg, usageByModel);
        break;
      case 'user':
        yield* handleUser(msg);
        break;
      case 'control_request':
        yield* handleControlRequest(msg);
        break;
      case 'result': {
        const event = buildResult(msg, usageByModel);
        if (event.kind === 'error') yield event.error;
        else yield event.value;
        break;
      }
      case 'log':
        yield* handleLog(msg);
        break;
      case 'stream_event':
        // Deferred for v1 — complete-turn events are authoritative. Silent
        // skip keeps the parse_error channel meaningful for real bugs.
        break;
      default:
        yield parseError(`unknown event type: ${JSON.stringify(rawType)}`, line.value);
    }
  }
}

function parseError(reason: string, line?: string): ParseErrorEvent {
  return line === undefined ? { type: 'parse_error', reason } : { type: 'parse_error', reason, line };
}

function* handleSystem(msg: RawMessage): Generator<StreamEvent> {
  const subtype = typeof msg.subtype === 'string' ? msg.subtype : '';
  if (subtype === 'init') {
    const sessionId = stringOr(msg.session_id, '');
    if (sessionId === '') {
      yield parseError('system/init missing session_id');
      return;
    }
    yield {
      type: 'system_init',
      sessionId,
      cwd: optionalString(msg.cwd),
      model: optionalString(msg.model),
      tools: optionalStringArray(msg.tools),
      mcpServers: optionalMcpServers(msg.mcp_servers),
    };
    return;
  }
  if (subtype === 'api_retry') {
    const retry: StreamEvent = {
      type: 'system_api_retry',
      raw: msg as Record<string, unknown>,
    };
    const attempt = asNumber(msg.attempt);
    if (attempt !== undefined) retry.attempt = attempt;
    const delayMs = asNumber(msg.delay_ms);
    if (delayMs !== undefined) retry.delayMs = delayMs;
    yield retry;
    return;
  }
  yield {
    type: 'system',
    subtype,
    sessionId: optionalString(msg.session_id),
    raw: msg as Record<string, unknown>,
  };
}

function* handleAssistant(
  msg: RawMessage,
  usageByModel: Record<string, TokenUsage>,
): Generator<StreamEvent> {
  const content = coerceMessageContent(msg.message);
  if (!content) {
    yield parseError('assistant.message not a parseable object');
    return;
  }

  accumulateUsage(content, usageByModel);

  const blocks = Array.isArray(content.content) ? content.content : [];
  const model = typeof content.model === 'string' ? content.model : undefined;

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const btype = (block as Record<string, unknown>).type;
    if (btype === 'text') {
      const text = stringOr((block as Record<string, unknown>).text, '');
      if (text.length === 0) continue;
      const textEvent: StreamEvent = { type: 'assistant_text', text };
      if (model !== undefined) textEvent.model = model;
      yield textEvent;
      const scan = scanForCompletionReport(text);
      if (scan.kind === 'valid' && scan.report && scan.raw !== undefined) {
        yield {
          type: 'structured_completion',
          report: scan.report,
          raw: scan.raw,
        };
      } else if (scan.kind === 'invalid') {
        yield parseError(
          `structured completion fence invalid: ${scan.reason ?? 'unknown'}`,
        );
      }
    } else if (btype === 'thinking') {
      const text = stringOr((block as Record<string, unknown>).text, '');
      if (text.length > 0) yield { type: 'assistant_thinking', text };
    } else if (btype === 'tool_use') {
      const callId = stringOr((block as Record<string, unknown>).id, '');
      const name = stringOr((block as Record<string, unknown>).name, '');
      const input = (block as Record<string, unknown>).input;
      yield {
        type: 'tool_use',
        callId,
        name,
        input: isObject(input) ? input : {},
      };
    }
  }
}

function* handleUser(msg: RawMessage): Generator<StreamEvent> {
  const content = coerceMessageContent(msg.message);
  if (!content) {
    yield parseError('user.message not a parseable object');
    return;
  }

  const blocks = Array.isArray(content.content) ? content.content : [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_result') continue;
    const callId = stringOr(b.tool_use_id, '');
    const isError = typeof b.is_error === 'boolean' ? b.is_error : false;
    const contentString = toolResultContentToString(b.content);
    yield { type: 'tool_result', callId, content: contentString, isError };
  }
}

function* handleControlRequest(msg: RawMessage): Generator<StreamEvent> {
  const requestId = stringOr(msg.request_id, '');
  const reqRaw = msg.request;
  const req = isObject(reqRaw) ? reqRaw : {};
  const subtype = stringOr(req.subtype, '');
  const toolName = stringOr(req.tool_name, '');
  const input = isObject(req.input) ? req.input : {};
  yield { type: 'control_request', requestId, subtype, toolName, input };
}

type BuildResult =
  | { kind: 'value'; value: ResultEvent }
  | { kind: 'error'; error: ParseErrorEvent };

function buildResult(
  msg: RawMessage,
  usageByModel: Record<string, TokenUsage>,
): BuildResult {
  const sessionId = stringOr(msg.session_id, '');
  if (sessionId === '') {
    return {
      kind: 'error',
      error: parseError('result event missing session_id'),
    };
  }
  const event: ResultEvent = {
    type: 'result',
    sessionId,
    isError: msg.is_error === true,
    resultText: stringOr(msg.result, ''),
    durationMs: asNumber(msg.duration_ms) ?? 0,
    numTurns: asNumber(msg.num_turns) ?? 0,
    usageByModel: { ...usageByModel },
  };
  const cost = asNumber(msg.total_cost_usd);
  if (cost !== undefined) event.costUsd = cost;
  const sessionUsage = coerceTopUsage(msg.usage);
  if (sessionUsage) event.sessionUsage = sessionUsage;
  return { kind: 'value', value: event };
}

function* handleLog(msg: RawMessage): Generator<StreamEvent> {
  const log = isObject(msg.log) ? msg.log : {};
  yield {
    type: 'log',
    level: stringOr(log.level, 'info'),
    message: stringOr(log.message, ''),
  };
}

// ── helpers ──

interface RawMessage {
  type?: unknown;
  subtype?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  model?: unknown;
  tools?: unknown;
  mcp_servers?: unknown;
  message?: unknown;
  request_id?: unknown;
  request?: unknown;
  result?: unknown;
  is_error?: unknown;
  duration_ms?: unknown;
  num_turns?: unknown;
  total_cost_usd?: unknown;
  usage?: unknown;
  log?: unknown;
  attempt?: unknown;
  delay_ms?: unknown;
  [k: string]: unknown;
}

function coerceMessageContent(raw: unknown): {
  model?: string;
  content?: unknown;
  usage?: unknown;
} | null {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (isObject(raw)) return raw;
  return null;
}

function accumulateUsage(
  content: Record<string, unknown>,
  usageByModel: Record<string, TokenUsage>,
): void {
  const usage = content.usage;
  const model = content.model;
  if (!isObject(usage) || typeof model !== 'string' || model.length === 0) return;
  const existing: TokenUsage = usageByModel[model] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  usageByModel[model] = {
    inputTokens: existing.inputTokens + (asNumber(usage.input_tokens) ?? 0),
    outputTokens: existing.outputTokens + (asNumber(usage.output_tokens) ?? 0),
    cacheReadTokens:
      existing.cacheReadTokens + (asNumber(usage.cache_read_input_tokens) ?? 0),
    cacheWriteTokens:
      existing.cacheWriteTokens +
      (asNumber(usage.cache_creation_input_tokens) ?? 0),
  };
}

function coerceTopUsage(raw: unknown): TokenUsage | null {
  if (!isObject(raw)) return null;
  return {
    inputTokens: asNumber(raw.input_tokens) ?? 0,
    outputTokens: asNumber(raw.output_tokens) ?? 0,
    cacheReadTokens: asNumber(raw.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: asNumber(raw.cache_creation_input_tokens) ?? 0,
  };
}

function toolResultContentToString(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const block of raw) {
      if (!isObject(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    if (parts.length > 0) return parts.join('');
    return JSON.stringify(raw);
  }
  if (raw === undefined || raw === null) return '';
  return JSON.stringify(raw);
}

function optionalMcpServers(
  raw: unknown,
): Array<{ name: string; status: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const servers: Array<{ name: string; status: string }> = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    servers.push({
      name: stringOr(entry.name, ''),
      status: stringOr(entry.status, ''),
    });
  }
  return servers;
}

function optionalStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) if (typeof item === 'string') out.push(item);
  return out;
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

function stringOr(raw: unknown, fallback: string): string {
  return typeof raw === 'string' ? raw : fallback;
}

function asNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}
