import { z } from 'zod';

/**
 * Phase 7A — minimal JSON-Schema → `z.ZodRawShape` converter.
 *
 * MCP `listTools()` returns each tool's `inputSchema` as a JSON Schema
 * object (`{ type: 'object', properties: {...}, required: [...] }`).
 * Symphony's `ToolRegistry.register` wants a `z.ZodRawShape` (a record of
 * property → ZodType). This bridges the two for proxy-tool registration.
 *
 * Scope: the realistic subset MCP tools actually emit — typed object
 * properties with optional enums, arrays, and one level of nested object.
 * Anything unrecognized degrades to `z.unknown()` rather than throwing:
 * this is a PROXY, so the plugin subprocess is the real validator; the
 * host-side shape exists only so Maestro's MCP client sees parameter
 * names + descriptions and the SDK doesn't reject the registration.
 * Fail-open here is correct (loose host validation, strict plugin
 * validation) — the inverse of the security-relevant manifest parse.
 */

type JsonSchema = Record<string, unknown>;

function asObject(value: unknown): JsonSchema | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonSchema)
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v) => typeof v === 'string')) return undefined;
  return value as string[];
}

/** Convert a single JSON-Schema node into a ZodType. Never throws. */
export function jsonSchemaNodeToZod(node: unknown, depth = 0): z.ZodTypeAny {
  const schema = asObject(node);
  if (schema === undefined || depth > 4) return z.unknown();

  // `enum` of strings → z.enum; `const` → z.literal. Independent of `type`.
  const enumValues = stringArray(schema['enum']);
  if (enumValues !== undefined && enumValues.length > 0) {
    return z.enum(enumValues as [string, ...string[]]);
  }
  if (typeof schema['const'] === 'string') {
    return z.literal(schema['const'] as string);
  }

  const type = schema['type'];
  // Union types (`["string","null"]`) or missing type → permissive.
  if (typeof type !== 'string') return z.unknown();

  switch (type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      const items = schema['items'];
      // Tuple `items` (array) → fall back to unknown[] for v1.
      const itemSchema = Array.isArray(items)
        ? z.unknown()
        : jsonSchemaNodeToZod(items, depth + 1);
      return z.array(itemSchema);
    }
    case 'object': {
      const props = asObject(schema['properties']);
      if (props === undefined) return z.record(z.string(), z.unknown());
      const shape = buildShape(schema, depth + 1);
      // Nested objects allow extra keys (proxy is permissive).
      return z.object(shape).passthrough();
    }
    default:
      return z.unknown();
  }
}

function buildShape(objectSchema: JsonSchema, depth: number): Record<string, z.ZodTypeAny> {
  const props = asObject(objectSchema['properties']);
  if (props === undefined) return {};
  const required = new Set(stringArray(objectSchema['required']) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, rawProp] of Object.entries(props)) {
    let zType = jsonSchemaNodeToZod(rawProp, depth);
    const prop = asObject(rawProp);
    const description = prop?.['description'];
    if (typeof description === 'string' && description.length > 0) {
      zType = zType.describe(description);
    }
    shape[key] = required.has(key) ? zType : zType.optional();
  }
  return shape;
}

/**
 * Convert an MCP tool `inputSchema` into a `z.ZodRawShape` for
 * `ToolRegistry.register`. A non-object schema, or an object schema with
 * no `properties`, yields an empty shape `{}` (a tool that takes no
 * structured arguments).
 */
export function jsonSchemaToZodRawShape(inputSchema: unknown): Record<string, z.ZodTypeAny> {
  const schema = asObject(inputSchema);
  if (schema === undefined) return {};
  if (schema['type'] !== undefined && schema['type'] !== 'object') return {};
  return buildShape(schema, 0);
}
