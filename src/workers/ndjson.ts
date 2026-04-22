import type { Readable } from 'node:stream';

export const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;

export interface NdjsonOptions {
  maxLineBytes?: number;
}

export type NdjsonLine =
  | { kind: 'line'; value: string }
  | { kind: 'over_cap'; droppedBytes: number };

export async function* ndjsonLines(
  source: Readable | AsyncIterable<Buffer | string>,
  options: NdjsonOptions = {},
): AsyncIterable<NdjsonLine> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  // ignoreBOM: false (default) strips a leading BOM from the decoded output.
  // Setting it to true would preserve the BOM as U+FEFF, which is the opposite of what we want.
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  let overflowing = false;
  let droppedBytes = 0;

  for await (const chunk of source) {
    const rawText =
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk as Uint8Array, { stream: true });
    if (rawText.length === 0) continue;

    // TextDecoder only strips BOM at stream start. Strip any mid-stream BOM
    // too so subsequent JSON.parse doesn't fail on a sneaky U+FEFF prefix.
    const text = rawText.includes('\uFEFF') ? rawText.replace(/\uFEFF/g, '') : rawText;
    if (text.length === 0) continue;

    buffer += text;

    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const raw = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (overflowing) {
        yield { kind: 'over_cap', droppedBytes: droppedBytes + raw.length };
        overflowing = false;
        droppedBytes = 0;
      } else if (raw.length > maxLineBytes) {
        yield { kind: 'over_cap', droppedBytes: raw.length };
      } else {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.length > 0) yield { kind: 'line', value: line };
      }
      newlineIdx = buffer.indexOf('\n');
    }

    if (buffer.length > maxLineBytes) {
      droppedBytes += buffer.length;
      buffer = '';
      overflowing = true;
    }
  }

  const tail = decoder.decode();
  if (tail.length > 0) buffer += tail;

  if (overflowing) {
    yield { kind: 'over_cap', droppedBytes: droppedBytes + buffer.length };
  } else if (buffer.length > maxLineBytes) {
    yield { kind: 'over_cap', droppedBytes: buffer.length };
  } else if (buffer.length > 0) {
    const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
    if (line.length > 0) yield { kind: 'line', value: line };
  }
}
