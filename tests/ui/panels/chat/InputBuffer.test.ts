import { describe, it, expect } from 'vitest';
import {
  EMPTY_BUFFER,
  bufferText,
  clear,
  deleteBack,
  deleteForward,
  end,
  home,
  insertChunk,
  insertNewline,
  isEmpty,
  killToEnd,
  killToStart,
  killWordBack,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  type InputBuffer,
} from '../../../../src/ui/panels/chat/InputBuffer.js';

function buf(lines: readonly string[], row: number, col: number): InputBuffer {
  return { lines, row, col };
}

describe('InputBuffer', () => {
  describe('insertChunk', () => {
    it('inserts a single-line chunk at the cursor', () => {
      const result = insertChunk(EMPTY_BUFFER, 'hello');
      expect(result).toEqual({ lines: ['hello'], row: 0, col: 5 });
    });

    it('inserts a chunk in the middle of an existing line', () => {
      const result = insertChunk(buf(['ab'], 0, 1), 'XY');
      expect(result).toEqual({ lines: ['aXYb'], row: 0, col: 3 });
    });

    it('preserves embedded newlines in pasted text', () => {
      const result = insertChunk(EMPTY_BUFFER, 'line1\nline2\nline3');
      expect(result).toEqual({ lines: ['line1', 'line2', 'line3'], row: 2, col: 5 });
    });

    it('splits the current line correctly when pasting multi-line', () => {
      const result = insertChunk(buf(['abXcd'], 0, 2), 'PQ\nRS');
      expect(result).toEqual({ lines: ['abPQ', 'RSXcd'], row: 1, col: 2 });
    });

    it('returns the same buffer for empty chunk (referential stability)', () => {
      const start = buf(['hi'], 0, 1);
      expect(insertChunk(start, '')).toBe(start);
    });
  });

  describe('insertNewline', () => {
    it('splits the current line at the cursor', () => {
      const result = insertNewline(buf(['abcd'], 0, 2));
      expect(result).toEqual({ lines: ['ab', 'cd'], row: 1, col: 0 });
    });

    it('appends an empty line when at end of line', () => {
      const result = insertNewline(buf(['abc'], 0, 3));
      expect(result).toEqual({ lines: ['abc', ''], row: 1, col: 0 });
    });
  });

  describe('deleteBack', () => {
    it('removes char before cursor', () => {
      expect(deleteBack(buf(['abc'], 0, 2))).toEqual({ lines: ['ac'], row: 0, col: 1 });
    });

    it('joins lines when cursor at col 0 with prior line present', () => {
      const result = deleteBack(buf(['abc', 'def'], 1, 0));
      expect(result).toEqual({ lines: ['abcdef'], row: 0, col: 3 });
    });

    it('is no-op at the very start of the buffer', () => {
      expect(deleteBack(EMPTY_BUFFER)).toBe(EMPTY_BUFFER);
    });
  });

  describe('deleteForward', () => {
    it('removes the char at cursor', () => {
      expect(deleteForward(buf(['abc'], 0, 1))).toEqual({ lines: ['ac'], row: 0, col: 1 });
    });

    it('joins next line when at end of current line', () => {
      const result = deleteForward(buf(['abc', 'def'], 0, 3));
      expect(result).toEqual({ lines: ['abcdef'], row: 0, col: 3 });
    });

    it('is no-op at the very end of the buffer', () => {
      expect(deleteForward(buf(['abc'], 0, 3))).toEqual(buf(['abc'], 0, 3));
    });
  });

  describe('cursor moves', () => {
    it('moveLeft wraps to end of previous line', () => {
      expect(moveLeft(buf(['abc', 'def'], 1, 0))).toEqual({ lines: ['abc', 'def'], row: 0, col: 3 });
    });

    it('moveLeft is no-op at very start', () => {
      expect(moveLeft(EMPTY_BUFFER)).toBe(EMPTY_BUFFER);
    });

    it('moveRight wraps to start of next line', () => {
      expect(moveRight(buf(['abc', 'def'], 0, 3))).toEqual({ lines: ['abc', 'def'], row: 1, col: 0 });
    });

    it('moveRight is no-op at very end', () => {
      const start = buf(['abc'], 0, 3);
      expect(moveRight(start)).toBe(start);
    });

    it('moveUp clamps col to target line length', () => {
      expect(moveUp(buf(['hi', 'longer'], 1, 5))).toEqual({ lines: ['hi', 'longer'], row: 0, col: 2 });
    });

    it('moveUp is no-op on first line', () => {
      const start = buf(['abc'], 0, 1);
      expect(moveUp(start)).toBe(start);
    });

    it('moveDown clamps col to target line length', () => {
      expect(moveDown(buf(['longer', 'hi'], 0, 5))).toEqual({
        lines: ['longer', 'hi'],
        row: 1,
        col: 2,
      });
    });

    it('moveDown is no-op on last line', () => {
      const start = buf(['abc'], 0, 1);
      expect(moveDown(start)).toBe(start);
    });

    it('home jumps to col 0 of current line', () => {
      expect(home(buf(['abc'], 0, 2))).toEqual({ lines: ['abc'], row: 0, col: 0 });
    });

    it('end jumps to length of current line', () => {
      expect(end(buf(['abc'], 0, 0))).toEqual({ lines: ['abc'], row: 0, col: 3 });
    });
  });

  describe('kill operations', () => {
    it('killToEnd truncates current line at cursor', () => {
      expect(killToEnd(buf(['abcdef'], 0, 3))).toEqual({ lines: ['abc'], row: 0, col: 3 });
    });

    it('killToEnd is no-op at end of line', () => {
      const start = buf(['abc'], 0, 3);
      expect(killToEnd(start)).toBe(start);
    });

    it('killToStart removes prefix of current line', () => {
      expect(killToStart(buf(['abcdef'], 0, 3))).toEqual({ lines: ['def'], row: 0, col: 0 });
    });

    it('killToStart is no-op at col 0', () => {
      const start = buf(['abc'], 0, 0);
      expect(killToStart(start)).toBe(start);
    });

    it('killWordBack removes the word immediately before the cursor', () => {
      expect(killWordBack(buf(['hello world'], 0, 11))).toEqual({
        lines: ['hello '],
        row: 0,
        col: 6,
      });
    });

    it('killWordBack consumes trailing whitespace before the word', () => {
      expect(killWordBack(buf(['hello   world'], 0, 13))).toEqual({
        lines: ['hello   '],
        row: 0,
        col: 8,
      });
    });

    it('killWordBack joins lines when at col 0', () => {
      expect(killWordBack(buf(['abc', 'def'], 1, 0))).toEqual({
        lines: ['abcdef'],
        row: 0,
        col: 3,
      });
    });
  });

  describe('text serialization + utilities', () => {
    it('bufferText joins lines with \\n', () => {
      expect(bufferText(buf(['a', 'b', 'c'], 0, 0))).toBe('a\nb\nc');
    });

    it('isEmpty true on empty buffer, false otherwise', () => {
      expect(isEmpty(EMPTY_BUFFER)).toBe(true);
      expect(isEmpty(buf(['a'], 0, 0))).toBe(false);
      expect(isEmpty(buf(['', ''], 0, 0))).toBe(false); // multi-line empty is not "empty"
    });

    it('clear returns EMPTY_BUFFER', () => {
      expect(clear(buf(['hi'], 0, 2))).toBe(EMPTY_BUFFER);
    });

    it('clear is no-op on already-empty buffer', () => {
      expect(clear(EMPTY_BUFFER)).toBe(EMPTY_BUFFER);
    });
  });
});
