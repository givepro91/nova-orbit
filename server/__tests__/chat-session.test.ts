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
    // 채팅 세션은 task에 묶이지 않으므로 taskId(4번째 인자)는 undefined로 전달된다.
    expect(deps.spawnAgent).toHaveBeenCalledWith('agent-1', '/repo', 'chat-agent-1', undefined);
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
    expect(chatSessionKey('abc', 'workspace-1')).toBe('workspace-workspace-1-chat-abc');
  });

  it('scopes terminal chat to a Workspace and persists terminal ownership', () => {
    const { deps, spawned } = makeDeps(undefined);
    const r = resolveChatSession(deps, 'agent-1', '/repo/worktree', 'task-1', 'workspace-1');
    expect(r).toEqual({ session: spawned, reused: false });
    expect(deps.getSession).toHaveBeenCalledWith('workspace-workspace-1-chat-agent-1');
    expect(deps.spawnAgent).toHaveBeenCalledWith(
      'agent-1',
      '/repo/worktree',
      'workspace-workspace-1-chat-agent-1',
      'task-1',
      undefined,
      undefined,
      { workspaceId: 'workspace-1', origin: 'terminal' },
    );
  });
});
