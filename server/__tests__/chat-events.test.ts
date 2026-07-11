import { describe, it, expect } from 'vitest';
import { parseChatEvents, ChatEventAssembler } from '../core/agent/adapters/chat-events.js';

describe('parseChatEvents — claude stream-json', () => {
  it('extracts assistant text blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
    expect(parseChatEvents(line, 'claude')).toEqual([{ kind: 'text', text: 'Hello' }]);
  });

  it('extracts thinking blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'let me check' }] },
    });
    expect(parseChatEvents(line, 'claude')).toEqual([{ kind: 'thinking', text: 'let me check' }]);
  });

  it('extracts tool_use with id/name/input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a.ts' } }] },
    });
    expect(parseChatEvents(line, 'claude')).toEqual([
      { kind: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a.ts' } },
    ]);
  });

  it('maps TodoWrite tool_use to a todo event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'TodoWrite',
        input: { todos: [{ content: 'fix', status: 'in_progress' }] } }] },
    });
    expect(parseChatEvents(line, 'claude')).toEqual([
      { kind: 'todo', items: [{ content: 'fix', status: 'in_progress' }] },
    ]);
  });

  it('extracts tool_result from user message (error flagged)', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'boom' }] },
    });
    expect(parseChatEvents(line, 'claude')).toEqual([
      { kind: 'tool_result', id: 'tu_1', isError: true, content: 'boom' },
    ]);
  });

  it('stringifies array tool_result content', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_3',
        content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] }] },
    });
    expect(parseChatEvents(line, 'claude')).toEqual([
      { kind: 'tool_result', id: 'tu_3', isError: false, content: 'line1\nline2' },
    ]);
  });

  it('ignores non-JSON and unknown lines', () => {
    expect(parseChatEvents('not json', 'claude')).toEqual([]);
    expect(parseChatEvents(JSON.stringify({ type: 'system' }), 'claude')).toEqual([]);
  });
});

describe('ChatEventAssembler — reassembles split lines', () => {
  it('buffers partial lines across chunks', () => {
    const asm = new ChatEventAssembler('claude');
    const full = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    const mid = Math.floor(full.length / 2);
    expect(asm.push(full.slice(0, mid))).toEqual([]);
    expect(asm.push(full.slice(mid) + '\n')).toEqual([{ kind: 'text', text: 'hi' }]);
  });

  it('emits multiple events for multiple complete lines in one chunk', () => {
    const asm = new ChatEventAssembler('claude');
    const l1 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } });
    const l2 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'b' }] } });
    expect(asm.push(l1 + '\n' + l2 + '\n')).toEqual([
      { kind: 'text', text: 'a' }, { kind: 'text', text: 'b' },
    ]);
  });
});
