import { describe, expect, it } from 'vitest';
import { countRequest, countText, encoder } from '../../plugins/lib/tokenize.ts';
import type { ModelRequest } from '../../src/core/plugin-api.ts';

const req: ModelRequest = {
  system: 'You are a careful engineer.',
  messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Create the users API.' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'src/app.ts' } }] },
    { role: 'user', parts: [{ type: 'tool_result', callId: 'c1', content: '1: import express from "express";', isError: false }] },
  ],
  tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
  maxOutputTokens: 1000,
};

describe('tokenize', () => {
  it('counts text deterministically', () => {
    expect(countText('')).toBe(0);
    expect(countText('hello world')).toBe(2);
    expect(countText('hello world')).toBe(countText('hello world'));
    expect(encoder()).toBe(encoder());
  });

  it('does not throw on special-token text', () => {
    expect(countText('<|endoftext|>')).toBeGreaterThan(1);
  });

  it('counts a request: >0, deterministic, grows with content', () => {
    const a = countRequest(req);
    expect(a).toBeGreaterThan(0);
    expect(countRequest(req)).toBe(a);
    const more = countRequest({ ...req, messages: [...req.messages, { role: 'user', parts: [{ type: 'text', text: 'more text here' }] }] });
    expect(more).toBeGreaterThan(a);
    expect(countRequest({ ...req, tools: [] })).toBeLessThan(a);
  });
});
