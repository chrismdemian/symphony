/**
 * Pure multi-line input buffer.
 *
 * Decoupled from Ink so cursor logic / kill operations are unit-testable
 * without rendering. The InputBar React component (Phase 3B.1) wraps this
 * in `useReducer` and translates `useInput` keystrokes into actions.
 *
 * Invariants:
 *  - `lines.length >= 1` always (a never-empty array)
 *  - `0 <= row < lines.length`
 *  - `0 <= col <= lines[row].length`
 *  - All ops return a NEW buffer if state changed; the SAME buffer
 *    otherwise (referential stability for React.memo).
 */

export interface InputBuffer {
  readonly lines: readonly string[];
  readonly row: number;
  readonly col: number;
}

export const EMPTY_BUFFER: InputBuffer = {
  lines: [''],
  row: 0,
  col: 0,
};

export function bufferText(buf: InputBuffer): string {
  return buf.lines.join('\n');
}

export function isEmpty(buf: InputBuffer): boolean {
  return buf.lines.length === 1 && buf.lines[0] === '';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function replaceLine(lines: readonly string[], idx: number, value: string): readonly string[] {
  return [...lines.slice(0, idx), value, ...lines.slice(idx + 1)];
}

function currentLine(buf: InputBuffer): string {
  return buf.lines[buf.row] ?? '';
}

export function insertChunk(buf: InputBuffer, chunk: string): InputBuffer {
  if (chunk.length === 0) return buf;
  // Split chunk on '\n' so embedded newlines become real line breaks.
  // Pasted text and Ctrl+J both flow through here.
  const parts = chunk.split('\n');
  if (parts.length === 1) {
    // No newline — single-line insert at cursor.
    const line = currentLine(buf);
    const updated = line.slice(0, buf.col) + chunk + line.slice(buf.col);
    return {
      lines: replaceLine(buf.lines, buf.row, updated),
      row: buf.row,
      col: buf.col + chunk.length,
    };
  }

  // Multi-line: split current line at cursor, splice in chunk's lines.
  const line = currentLine(buf);
  const head = line.slice(0, buf.col);
  const tail = line.slice(buf.col);
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  const middle = parts.slice(1, -1);
  const newLines: string[] = [
    ...buf.lines.slice(0, buf.row),
    head + first,
    ...middle,
    last + tail,
    ...buf.lines.slice(buf.row + 1),
  ];
  const newRow = buf.row + parts.length - 1;
  const newCol = last.length;
  return { lines: newLines, row: newRow, col: newCol };
}

export function insertNewline(buf: InputBuffer): InputBuffer {
  return insertChunk(buf, '\n');
}

export function deleteBack(buf: InputBuffer): InputBuffer {
  const line = currentLine(buf);
  if (buf.col > 0) {
    const updated = line.slice(0, buf.col - 1) + line.slice(buf.col);
    return {
      lines: replaceLine(buf.lines, buf.row, updated),
      row: buf.row,
      col: buf.col - 1,
    };
  }
  if (buf.row === 0) return buf; // Nothing to delete at the very start.
  // Join with previous line.
  const prev = buf.lines[buf.row - 1] ?? '';
  const merged = prev + line;
  const newLines = [
    ...buf.lines.slice(0, buf.row - 1),
    merged,
    ...buf.lines.slice(buf.row + 1),
  ];
  return { lines: newLines, row: buf.row - 1, col: prev.length };
}

export function deleteForward(buf: InputBuffer): InputBuffer {
  const line = currentLine(buf);
  if (buf.col < line.length) {
    const updated = line.slice(0, buf.col) + line.slice(buf.col + 1);
    return {
      lines: replaceLine(buf.lines, buf.row, updated),
      row: buf.row,
      col: buf.col,
    };
  }
  if (buf.row === buf.lines.length - 1) return buf; // No next line to join.
  const next = buf.lines[buf.row + 1] ?? '';
  const merged = line + next;
  const newLines = [
    ...buf.lines.slice(0, buf.row),
    merged,
    ...buf.lines.slice(buf.row + 2),
  ];
  return { lines: newLines, row: buf.row, col: buf.col };
}

export function moveLeft(buf: InputBuffer): InputBuffer {
  if (buf.col > 0) return { ...buf, col: buf.col - 1 };
  if (buf.row === 0) return buf;
  const prev = buf.lines[buf.row - 1] ?? '';
  return { ...buf, row: buf.row - 1, col: prev.length };
}

export function moveRight(buf: InputBuffer): InputBuffer {
  const line = currentLine(buf);
  if (buf.col < line.length) return { ...buf, col: buf.col + 1 };
  if (buf.row === buf.lines.length - 1) return buf;
  return { ...buf, row: buf.row + 1, col: 0 };
}

export function moveUp(buf: InputBuffer): InputBuffer {
  if (buf.row === 0) return buf;
  const target = buf.lines[buf.row - 1] ?? '';
  return { ...buf, row: buf.row - 1, col: clamp(buf.col, 0, target.length) };
}

export function moveDown(buf: InputBuffer): InputBuffer {
  if (buf.row === buf.lines.length - 1) return buf;
  const target = buf.lines[buf.row + 1] ?? '';
  return { ...buf, row: buf.row + 1, col: clamp(buf.col, 0, target.length) };
}

export function home(buf: InputBuffer): InputBuffer {
  if (buf.col === 0) return buf;
  return { ...buf, col: 0 };
}

export function end(buf: InputBuffer): InputBuffer {
  const len = currentLine(buf).length;
  if (buf.col === len) return buf;
  return { ...buf, col: len };
}

export function killToEnd(buf: InputBuffer): InputBuffer {
  const line = currentLine(buf);
  if (buf.col === line.length) return buf;
  const updated = line.slice(0, buf.col);
  return { lines: replaceLine(buf.lines, buf.row, updated), row: buf.row, col: buf.col };
}

export function killToStart(buf: InputBuffer): InputBuffer {
  if (buf.col === 0) return buf;
  const line = currentLine(buf);
  const updated = line.slice(buf.col);
  return { lines: replaceLine(buf.lines, buf.row, updated), row: buf.row, col: 0 };
}

/**
 * Ctrl+W — delete the word immediately before the cursor. A "word" is a
 * maximal run of non-whitespace characters; trailing whitespace before
 * the word is also consumed (matching bash readline behavior).
 */
export function killWordBack(buf: InputBuffer): InputBuffer {
  if (buf.col === 0) {
    // At column 0 with non-empty prev line: join lines (treat newline
    // as a "word boundary"). Otherwise no-op.
    if (buf.row === 0) return buf;
    return deleteBack(buf);
  }
  const line = currentLine(buf);
  let cut = buf.col;
  // Skip trailing whitespace.
  while (cut > 0 && /\s/.test(line[cut - 1] ?? '')) cut -= 1;
  // Then skip the word itself.
  while (cut > 0 && !/\s/.test(line[cut - 1] ?? '')) cut -= 1;
  if (cut === buf.col) return buf;
  const updated = line.slice(0, cut) + line.slice(buf.col);
  return { lines: replaceLine(buf.lines, buf.row, updated), row: buf.row, col: cut };
}

export function clear(buf: InputBuffer): InputBuffer {
  if (isEmpty(buf)) return buf;
  return EMPTY_BUFFER;
}
