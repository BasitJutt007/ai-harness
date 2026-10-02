import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toClaudeTools } from '../../plugins/drivers/claude.ts';
import { toOpenAITools } from '../../plugins/drivers/openai.ts';
import { isRecord, toolSchema } from '../../plugins/drivers/_wire.ts';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { loadRegistry, toolInputSchema, toolSpecs } from '../../src/core/registry.ts';
import type { ToolSpec } from '../../src/core/plugin-api.ts';

/** The root-level rules both function-calling APIs enforce on a tool's input schema. */
function expectAcceptableRoot(schema: unknown, label: string): void {
  expect(isRecord(schema), label).toBe(true);
  if (!isRecord(schema)) return;
  expect(schema['type'], label).toBe('object');
  expect(isRecord(schema['properties']), label).toBe(true);
  for (const k of ['$schema', 'anyOf', 'oneOf', 'allOf', 'not', 'enum']) expect(k in schema, `${label}: root ${k}`).toBe(false);
  expect(JSON.parse(JSON.stringify(schema)), label).toEqual(schema);
}

function expectAcceptable(specs: ToolSpec[]): void {
  for (const t of toClaudeTools(specs)) {
    expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(t.description.length).toBeGreaterThan(0);
    expectAcceptableRoot(t.input_schema, `claude ${t.name}`);
  }
  for (const t of toOpenAITools(specs)) {
    expect(t.function.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect('strict' in t.function).toBe(false);
    expectAcceptableRoot(t.function.parameters, `openai ${t.function.name}`);
  }
  for (const t of toOpenAITools(specs, true)) expectAcceptableRoot(t.function.parameters, `openai loose ${t.function.name}`);
}

describe('tool schemas on the wire', () => {
  it('every registered tool (both task kinds) has a schema both drivers can send', async () => {
    const reg = await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT);
    const greenfield = toolSpecs(reg.tools, 'greenfield');
    const brownfield = toolSpecs(reg.tools, 'brownfield');
    expect(greenfield.length).toBeGreaterThan(5);
    expectAcceptable(greenfield);
    expectAcceptable(brownfield);
    // a registered schema passes through unchanged apart from the guaranteed root shape
    for (const s of greenfield) expect(toolSchema(s.inputSchema)).toEqual({ ...s.inputSchema, type: 'object', properties: s.inputSchema['properties'] ?? {} });
  });

  it('normalises awkward zod inputs a plugin author might write', () => {
    const shapes: Record<string, z.ZodType> = {
      empty: z.object({}),
      strictEmpty: z.strictObject({}),
      any: z.any(),
      record: z.record(z.string(), z.string()),
      union: z.union([z.object({ path: z.string(), mode: z.literal('a') }), z.object({ path: z.string(), url: z.string() })]),
      discriminated: z.discriminatedUnion('kind', [z.object({ kind: z.literal('file'), path: z.string() }), z.object({ kind: z.literal('url'), url: z.string() })]),
      intersection: z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
      nested: z.object({ items: z.array(z.object({ id: z.uuid(), n: z.int().min(1) })).min(1), opt: z.string().optional().default('x') }),
    };
    const specs: ToolSpec[] = Object.entries(shapes).map(([name, s]) => ({ name, description: `${name} tool`, inputSchema: toolInputSchema(s) }));
    expectAcceptable(specs);

    const union = toolSchema(toolInputSchema(shapes['union'] ?? z.never()));
    expect(union['properties']).toEqual({ path: { type: 'string' }, mode: { type: 'string', const: 'a' }, url: { type: 'string' } });
    expect(union['required']).toEqual(['path']);
    const disc = toolSchema(toolInputSchema(shapes['discriminated'] ?? z.never()));
    expect(Object.keys(isRecord(disc['properties']) ? disc['properties'] : {})).toEqual(['kind', 'path', 'url']);
    expect(disc['required']).toEqual(['kind']);
  });

  it('the loose form keeps only widely supported keywords', () => {
    const loose = toolSchema(
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { maximum: { type: 'integer', minimum: 1, maximum: 9007199254740991, description: 'a property named like a keyword' }, id: { type: 'string', format: 'uuid', pattern: '^x' } },
        required: ['id'],
        additionalProperties: false,
      },
      true,
    );
    expect(loose).toEqual({
      type: 'object',
      properties: { maximum: { type: 'integer', description: 'a property named like a keyword' }, id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  });
});

describe('root combinators', () => {
  it('allOf branches all apply: their required lists are united', () => {
    const s = toolSchema(toolInputSchema(z.intersection(z.object({ a: z.string() }), z.object({ b: z.number().optional() }))));
    expect(s['properties']).toEqual({ a: { type: 'string' }, b: { type: 'number' } });
    expect(s['required']).toEqual(['a']);
    expect('allOf' in s).toBe(false);
  });
});
