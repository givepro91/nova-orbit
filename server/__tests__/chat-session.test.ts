import { describe, it, expect, vi } from 'vitest';
import { resolveChatSession, chatSessionKey } from '../core/agent/chat-session.js';

function makeDeps(existing?: { status: string }) {
  const spawned = { status: 'idle' };
  return {
    spawned,
    deps: {
      getSession: vi.fn((_key: string) => existing),
      spawnAgent: vi.fn((_a: string, _w: string, _k: string) => spawned),
    },
  };
}

describe('resolveChatSession', () => {
  it('spawns a new session when none exists', () => {
    const { deps, spawned } = makeDeps(undefined);
    const r = resolveChatSession(deps, 'agent-1', '/repo');
    expect(r).toEqual({ session: spawned, reused: false });
    expect(deps.spawnAgent).toHaveBeenCalledWith('agent-1', '/repo', 'chat-agent-1');
  });

  it('reuses an existing idle session (resume path)', () => {
    const existing = { status: 'idle' };
    const { deps } = makeDeps(existing);
    const r = resolveChatSession(deps, 'agent-1', '/repo');
    expect(r).toEqual({ session: existing, reused: true });
    expect(deps.spawnAgent).not.toHaveBeenCalled();
  });

  it('returns busy when the session is working', () => {
    const { deps } = makeDeps({ status: 'working' });
    expect(resolveChatSession(deps, 'agent-1', '/repo')).toEqual({ busy: true });
  });

  it('chatSessionKey is stable', () => {
    expect(chatSessionKey('abc')).toBe('chat-abc');
  });
});
