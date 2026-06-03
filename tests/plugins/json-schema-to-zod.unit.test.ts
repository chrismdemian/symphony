import type { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  jsonSchemaToZodRawShape,
  jsonSchemaNodeToZod,
} from '../../src/plugins/json-schema-to-zod.js';

function ok(shape: Record<string, z.ZodTypeAny>, key: string, value: unknown): boolean {
  const t = shape[key];
  if (t === undefined) throw new Error(`missing shape key '${key}'`);
  return t.safeParse(value).success;
}

describe('jsonSchemaToZodRawShape', () => {
  it('builds a shape from object properties with required handling', () => {
    const shape = jsonSchemaToZodRawShape({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'search text' },
        limit: { type: 'integer' },
      },
      required: ['query'],
    });
    expect(Object.keys(shape).sort()).toEqual(['limit', 'query']);
    // query is required → parse fails without it; limit optional → ok absent.
    expect(ok(shape, 'query', undefined)).toBe(false);
    expect(ok(shape, 'limit', undefined)).toBe(true);
    expect(ok(shape, 'query', 'hello')).toBe(true);
    expect(ok(shape, 'limit', 3)).toBe(true);
    expect(ok(shape, 'limit', 3.5)).toBe(false); // integer
  });

  it('returns empty shape for a non-object schema', () => {
    expect(jsonSchemaToZodRawShape({ type: 'string' })).toEqual({});
    expect(jsonSchemaToZodRawShape(null)).toEqual({});
    expect(jsonSchemaToZodRawShape(undefined)).toEqual({});
  });

  it('returns empty shape for an object with no properties', () => {
    expect(jsonSchemaToZodRawShape({ type: 'object' })).toEqual({});
  });
});

describe('jsonSchemaNodeToZod', () => {
  it('maps primitive types', () => {
    expect(jsonSchemaNodeToZod({ type: 'string' }).safeParse('x').success).toBe(true);
    expect(jsonSchemaNodeToZod({ type: 'number' }).safeParse(1.2).success).toBe(true);
    expect(jsonSchemaNodeToZod({ type: 'boolean' }).safeParse(true).success).toBe(true);
  });

  it('maps string enum', () => {
    const t = jsonSchemaNodeToZod({ type: 'string', enum: ['a', 'b'] });
    expect(t.safeParse('a').success).toBe(true);
    expect(t.safeParse('c').success).toBe(false);
  });

  it('maps arrays of typed items', () => {
    const t = jsonSchemaNodeToZod({ type: 'array', items: { type: 'string' } });
    expect(t.safeParse(['a', 'b']).success).toBe(true);
    expect(t.safeParse([1]).success).toBe(false);
  });

  it('maps nested object (permissive passthrough)', () => {
    const t = jsonSchemaNodeToZod({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    });
    expect(t.safeParse({ a: 'x', extra: 1 }).success).toBe(true);
    expect(t.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('falls back to unknown for unsupported / union types', () => {
    expect(jsonSchemaNodeToZod({ type: ['string', 'null'] }).safeParse(123).success).toBe(true);
    expect(jsonSchemaNodeToZod({}).safeParse(anything()).success).toBe(true);
  });
});

function anything(): unknown {
  return { whatever: [1, 2, 3] };
}
