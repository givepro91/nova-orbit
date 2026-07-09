import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AgentActivityRing,
  ActivityLogStore,
  parseActivityEvents,
  truncateDetail,
  ACTIVITY_RING_SIZE,
  ACTIVITY_DETAIL_MAX,
} from '../core/agent/activity-log.js';

describe('AgentActivityRing — bounded ring buffer', () => {
  it('caps at ACTIVITY_RING_SIZE, evicting oldest first', () => {
    const ring = new AgentActivityRing();
    for (let i = 0; i < ACTIVITY_RING_SIZE + 20; i++) {
      ring.push({ kind: 'command', detail: `cmd-${i}` }, `2026-07-08T00:00:${String(i % 60).padStart(2, '0')}.000Z`);
    }
    const list = ring.list();
    expect(ring.size).toBe(ACTIVITY_RING_SIZE);
    expect(list.length).toBe(ACTIVITY_RING_SIZE);
    // Oldest surviving entry is #20 (0..19 evicted)
    expect(list[0].detail).toBe('cmd-20');
    expect(list[list.length - 1].detail).toBe(`cmd-${ACTIVITY_RING_SIZE + 19}`);
  });

  it('truncates detail to ACTIVITY_DETAIL_MAX chars and tracks lastEventAt', () => {
    const ring = new AgentActivityRing();
    expect(ring.lastEventAt).toBeNull();
    const long = 'x'.repeat(500);
    const ev = ring.push({ kind: 'text', detail: long }, '2026-07-08T01:02:03.000Z');
    expect(ev.detail.length).toBe(ACTIVITY_DETAIL_MAX);
    expect(ring.lastEventAt).toBe('2026-07-08T01:02:03.000Z');
  });

  it('preserves the action field when present and omits it when absent', () => {
    const ring = new AgentActivityRing();
    const withAction = ring.push({ kind: 'browser', detail: 'a button', action: 'click' });
    expect(withAction.action).toBe('click');
    const withoutAction = ring.push({ kind: 'command', detail: 'ls' });
    expect('action' in withoutAction).toBe(false);
  });

  it('list() preserves chronological order and clear() empties it', () => {
    const ring = new AgentActivityRing();
    ring.push({ kind: 'command', detail: 'a' }, '2026-07-08T00:00:01.000Z');
    ring.push({ kind: 'file_read', detail: 'b' }, '2026-07-08T00:00:02.000Z');
    expect(ring.list().map((e) => e.detail)).toEqual(['a', 'b']);
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.lastEventAt).toBeNull();
    expect(ring.snapshot()).toEqual({ lastEventAt: null, events: [] });
  });
});

describe('truncateDetail', () => {
  it('collapses whitespace to a single line', () => {
    expect(truncateDetail('  foo\n\t  bar  baz ')).toBe('foo bar baz');
  });
  it('returns empty string for null/undefined', () => {
    expect(truncateDetail(null)).toBe('');
    expect(truncateDetail(undefined)).toBe('');
  });
});

describe('parseActivityEvents — stream-json line → activity', () => {
  it('extracts assistant text and tool_use blocks in order', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check the file' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
    });
    const events = parseActivityEvents(line);
    expect(events).toEqual([
      { kind: 'text', detail: 'Let me check the file' },
      { kind: 'command', detail: 'ls -la' },
    ]);
  });

  it('maps Read to file_read and Edit to file_edit using file_path', () => {
    const read = parseActivityEvents(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }] },
    }));
    expect(read).toEqual([{ kind: 'file_read', detail: '/a/b.ts' }]);

    const edit = parseActivityEvents(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/c/d.ts' } }] },
    }));
    expect(edit).toEqual([{ kind: 'file_edit', detail: '/c/d.ts' }]);
  });

  const toolLine = (name: string, input: unknown) => JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input }] },
  });

  it('maps Playwright MCP browser tools to kind=browser with a semantic action + human detail', () => {
    expect(parseActivityEvents(toolLine('mcp__playwright__browser_click', { element: '슬롯 2 새 게임 버튼', ref: 'e31' })))
      .toEqual([{ kind: 'browser', action: 'click', detail: '슬롯 2 새 게임 버튼' }]);

    expect(parseActivityEvents(toolLine('mcp__plugin_playwright_playwright__browser_navigate', { url: 'http://localhost:5188/' })))
      .toEqual([{ kind: 'browser', action: 'navigate', detail: 'http://localhost:5188/' }]);

    expect(parseActivityEvents(toolLine('mcp__playwright__browser_snapshot', {})))
      .toEqual([{ kind: 'browser', action: 'snapshot', detail: '' }]);

    expect(parseActivityEvents(toolLine('mcp__playwright__browser_console_messages', { level: 'error' })))
      .toEqual([{ kind: 'browser', action: 'console_messages', detail: 'error' }]);

    expect(parseActivityEvents(toolLine('mcp__playwright__browser_evaluate', { function: '() => {\n const key = 1;\n}' })))
      .toEqual([{ kind: 'browser', action: 'evaluate', detail: '() => {' }]);

    expect(parseActivityEvents(toolLine('mcp__playwright__browser_type', { element: '이름 입력창', text: 'abc' })))
      .toEqual([{ kind: 'browser', action: 'type', detail: '이름 입력창 — "abc"' }]);
  });

  it('parses Codex exec --json: command_execution(started) → command, agent_message → text', () => {
    const cmdStarted = JSON.stringify({
      type: 'item.started',
      item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'ls -la'", status: 'in_progress' },
    });
    expect(parseActivityEvents(cmdStarted)).toEqual([{ kind: 'command', detail: 'ls -la' }]);

    // 큰따옴표 래퍼도 벗긴다
    const cmdDq = JSON.stringify({
      type: 'item.started',
      item: { id: 'item_x', type: 'command_execution', command: '/bin/zsh -lc "pwd && ls"', status: 'in_progress' },
    });
    expect(parseActivityEvents(cmdDq)).toEqual([{ kind: 'command', detail: 'pwd && ls' }]);

    // command_execution completed는 started와 중복이라 스킵
    const cmdCompleted = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'ls -la'", status: 'completed' },
    });
    expect(parseActivityEvents(cmdCompleted)).toEqual([]);

    const msg = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_2', type: 'agent_message', text: '작업을 완료했습니다.' },
    });
    expect(parseActivityEvents(msg)).toEqual([{ kind: 'text', detail: '작업을 완료했습니다.' }]);

    // 비치명 error item / turn 이벤트는 활동 없음
    expect(parseActivityEvents(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'dev feature' } }))).toEqual([]);
    expect(parseActivityEvents(JSON.stringify({ type: 'turn.started' }))).toEqual([]);
  });

  it('maps non-browser MCP tools to kind=tool with the short tool name as action', () => {
    expect(parseActivityEvents(toolLine('mcp__claude_ai_Notion__notion-search', { query: 'roadmap' })))
      .toEqual([{ kind: 'tool', action: 'notion-search', detail: 'roadmap' }]);
  });

  it('maps semantic native tools: WebSearch/WebFetch → web, Task → subagent, TodoWrite → plan', () => {
    expect(parseActivityEvents(toolLine('WebSearch', { query: 'react 19 changes' })))
      .toEqual([{ kind: 'web', action: 'search', detail: 'react 19 changes' }]);

    expect(parseActivityEvents(toolLine('WebFetch', { url: 'https://example.com' })))
      .toEqual([{ kind: 'web', action: 'fetch', detail: 'https://example.com' }]);

    expect(parseActivityEvents(toolLine('Task', { description: 'fix the bug', prompt: 'long prompt...' })))
      .toEqual([{ kind: 'subagent', action: 'delegate', detail: 'fix the bug' }]);

    expect(parseActivityEvents(toolLine('TodoWrite', {
      todos: [
        { content: 'done thing', status: 'completed' },
        { content: 'current thing', status: 'in_progress' },
      ],
    }))).toEqual([{ kind: 'plan', action: 'todo', detail: 'current thing' }]);
  });

  it('maps unknown native tools to kind=tool, keeping the tool name as action', () => {
    const events = parseActivityEvents(toolLine('FooBar', { description: 'do something' }));
    expect(events).toEqual([{ kind: 'tool', action: 'FooBar', detail: 'do something' }]);

    // No usable input → detail stays empty (UI shows the action label alone)
    expect(parseActivityEvents(toolLine('FooBar', {})))
      .toEqual([{ kind: 'tool', action: 'FooBar', detail: '' }]);
  });

  it('ignores empty/whitespace-only text blocks and malformed JSON', () => {
    expect(parseActivityEvents('not json')).toEqual([]);
    expect(parseActivityEvents('')).toEqual([]);
    const events = parseActivityEvents(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '   \n  ' }] },
    }));
    expect(events).toEqual([]);
  });

  it('ignores non-assistant events (result/system/user tool_result)', () => {
    expect(parseActivityEvents(JSON.stringify({ type: 'result', result: 'done' }))).toEqual([]);
    expect(parseActivityEvents(JSON.stringify({ type: 'system', session_id: 's1' }))).toEqual([]);
  });
});

describe('ActivityLogStore — per-agent rings + lossless batched broadcast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an empty snapshot for an unknown agent', () => {
    const store = new ActivityLogStore();
    expect(store.snapshot('nobody')).toEqual({ lastEventAt: null, events: [] });
  });

  it('records events per agent and reset() clears only that agent', () => {
    const store = new ActivityLogStore();
    store.record('a1', { kind: 'command', detail: 'ls' }, '2026-07-08T00:00:01.000Z');
    store.record('a2', { kind: 'file_read', detail: '/x' }, '2026-07-08T00:00:02.000Z');
    expect(store.snapshot('a1').events).toHaveLength(1);
    expect(store.snapshot('a1').lastEventAt).toBe('2026-07-08T00:00:01.000Z');
    store.reset('a1');
    expect(store.snapshot('a1')).toEqual({ lastEventAt: null, events: [] });
    expect(store.snapshot('a2').events).toHaveLength(1);
  });

  it('batches within the throttle window and flushes the pending batch on the trailing edge', () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const store = new ActivityLogStore(); // default 1000ms throttle
    store.setBroadcaster(spy);
    store.record('a1', { kind: 'command', detail: 'one' });
    store.record('a1', { kind: 'command', detail: 'two' }); // within 1s → queued
    store.record('a1', { kind: 'command', detail: 'three' }); // also queued

    // First event flushed immediately
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('agent:activity');
    expect(spy.mock.calls[0][1].events.map((e: any) => e.detail)).toEqual(['one']);

    // Trailing edge delivers the rest as one batch — nothing dropped
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(2);
    const second = spy.mock.calls[1][1];
    expect(second.events.map((e: any) => e.detail)).toEqual(['two', 'three']);
    expect(second.event.detail).toBe('three'); // legacy singular field = last of batch
    expect(second.lastEventAt).toBe(second.events[1].ts);

    // Ring captured everything regardless of broadcast batching
    expect(store.snapshot('a1').events).toHaveLength(3);
  });

  it('broadcasts every event when throttle window is zero', () => {
    const spy = vi.fn();
    const store = new ActivityLogStore({ throttleMs: 0 });
    store.setBroadcaster(spy);
    store.record('a1', { kind: 'command', detail: 'one' });
    store.record('a1', { kind: 'command', detail: 'two' });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
