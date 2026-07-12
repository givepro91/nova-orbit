import { describe, it, expect } from 'vitest';
import { parseStreamJson } from '../core/agent/adapters/stream-parser.js';

describe('parseStreamJson — valid stream-json output', () => {
  it('extracts assistant text from message content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-abc',
      message: {
        content: [
          { type: 'text', text: 'Hello, ' },
          { type: 'text', text: 'world!' },
        ],
      },
    });

    const result = parseStreamJson(line);
    expect(result.text).toBe('Hello, world!');
  });

  it('counts lines correctly', () => {
    const lines = [
      JSON.stringify({ type: 'system', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'result', result: 'done' }),
    ].join('\n');

    const result = parseStreamJson(lines);
    expect(result.lineCount).toBe(3);
  });

  it('result type overrides intermediate assistant text', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'interim' }] } }),
      JSON.stringify({ type: 'result', result: 'final answer' }),
    ].join('\n');

    const result = parseStreamJson(lines);
    expect(result.text).toBe('final answer');
  });

  it('distinguishes reported token and cost metrics, including actual zero', () => {
    const result = parseStreamJson(JSON.stringify({
      type: 'result',
      result: 'done',
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    }));

    expect(result.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
      tokenUsageReported: true,
      costUsdReported: true,
    });
  });

  it.each([
    { name: 'empty usage', usage: {} },
    { name: 'partial usage', usage: { input_tokens: 12 } },
    { name: 'negative input tokens', usage: { input_tokens: -1, output_tokens: 12 } },
    { name: 'negative output tokens', usage: { input_tokens: 12, output_tokens: -1 } },
  ])('treats $name without both token fields as unreported', ({ usage }) => {
    const result = parseStreamJson(JSON.stringify({
      type: 'result',
      result: 'done',
      usage,
    }));

    expect(result.usage?.tokenUsageReported).toBe(false);
  });

  it.each([null, -1, '0'])('treats invalid cost %j as unreported', (totalCostUsd) => {
    const result = parseStreamJson(JSON.stringify({
      type: 'result',
      result: 'done',
      usage: { input_tokens: 1, output_tokens: 2 },
      total_cost_usd: totalCostUsd,
    }));

    expect(result.usage).toMatchObject({
      totalCostUsd: totalCostUsd ?? 0,
      costUsdReported: false,
    });
  });

  it('collects multiple tool uses', () => {
    const lines = [
      JSON.stringify({ type: 'tool_use', name: 'read_file', input: { path: '/foo.ts' } }),
      JSON.stringify({ type: 'tool_use', name: 'write_file', input: { path: '/bar.ts', content: 'x' } }),
    ].join('\n');

    const result = parseStreamJson(lines);
    expect(result.toolUses).toHaveLength(2);
    expect(result.toolUses[0].name).toBe('read_file');
    expect(result.toolUses[1].name).toBe('write_file');
  });

  it('collects error messages', () => {
    const line = JSON.stringify({ type: 'error', message: 'Rate limit exceeded' });

    const result = parseStreamJson(line);
    expect(result.errors).toContain('Rate limit exceeded');
  });
});

describe('parseStreamJson — empty string', () => {
  it('returns empty fields with an empty-stdout diagnostic error', () => {
    const result = parseStreamJson('');
    expect(result.text).toBe('');
    expect(result.sessionId).toBeNull();
    expect(result.lineCount).toBe(0);
    expect(result.toolUses).toHaveLength(0);
    // Empty stdout is a failure signal, not a silent no-op — the parser
    // reports it so the task doesn't false-positive as "completed with no output".
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Empty stdout/);
  });
});

describe('parseStreamJson — session ID extraction', () => {
  it('extracts session_id from first line that has it', () => {
    const lines = [
      JSON.stringify({ type: 'system', session_id: 'ses-001' }),
      JSON.stringify({ type: 'assistant', session_id: 'ses-002', message: { content: [] } }),
    ].join('\n');

    const result = parseStreamJson(lines);
    expect(result.sessionId).toBe('ses-001');
  });

  it('returns null when no session_id present', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [] } });

    const result = parseStreamJson(line);
    expect(result.sessionId).toBeNull();
  });

  it('handles session_id in any event type', () => {
    const line = JSON.stringify({ type: 'result', session_id: 'ses-xyz', result: 'ok' });

    const result = parseStreamJson(line);
    expect(result.sessionId).toBe('ses-xyz');
  });
});

describe('parseStreamJson — error extraction', () => {
  it('falls back to error field when message is missing', () => {
    const line = JSON.stringify({ type: 'error', error: 'Connection timeout' });

    const result = parseStreamJson(line);
    expect(result.errors).toContain('Connection timeout');
  });

  it('uses "Unknown error" when neither message nor error field is present', () => {
    const line = JSON.stringify({ type: 'error' });

    const result = parseStreamJson(line);
    expect(result.errors).toContain('Unknown error');
  });

  it('collects multiple errors across lines', () => {
    // Include an assistant text line so the unrelated "no text extracted"
    // fallback warning doesn't inflate the error count (same convention as
    // the rate_limit_event tests below).
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'error', message: 'Error one' }),
      JSON.stringify({ type: 'error', message: 'Error two' }),
    ].join('\n');

    const result = parseStreamJson(lines);
    expect(result.errors).toHaveLength(2);
    expect(result.errors).toEqual(['Error one', 'Error two']);
  });
});

describe('parseStreamJson — robustness', () => {
  it('skips non-JSON lines without throwing', () => {
    const mixed = [
      'not json at all',
      JSON.stringify({ type: 'result', result: 'ok' }),
      '{ broken json',
    ].join('\n');

    expect(() => parseStreamJson(mixed)).not.toThrow();
    const result = parseStreamJson(mixed);
    expect(result.text).toBe('ok');
  });

  it('handles subtype tool_use field', () => {
    const line = JSON.stringify({ subtype: 'tool_use', tool_name: 'bash', tool_input: { cmd: 'ls' } });

    const result = parseStreamJson(line);
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].name).toBe('bash');
  });
});

describe('parseStreamJson — rate_limit_event', () => {
  // Claude Code emits rate_limit_event as a state-change notification with 3
  // possible statuses. Only "rejected" is fatal — the others must be treated
  // as informational and MUST NOT fail the task.
  //
  // Tests include an assistant text line to avoid the unrelated "no text
  // extracted" fallback warning (that's a separate concern).

  const assistantLine = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'done' }] },
  });

  it('does NOT treat "allowed" status as an error', () => {
    const lines = [
      assistantLine,
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          rate_limit_type: 'five_hour',
          utilization: 0.36,
          resets_at: 1733000000,
        },
      }),
    ].join('\n');

    const result = parseStreamJson(lines);
    expect(result.errors).toHaveLength(0);
    expect(result.rateLimit?.status).toBe('allowed');
    expect(result.rateLimit?.utilization).toBe(0.36);
  });

  it('does NOT treat "allowed_warning" (approaching limit) as an error', () => {
    // Real-world case: user at 82% of 5h window, Claude Code warns but still
    // allows requests. Older code incorrectly failed the task here.
    const lines = [
      assistantLine,
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          rate_limit_type: 'five_hour',
          utilization: 0.82,
        },
      }),
    ].join('\n');

    const result = parseStreamJson(lines);
    expect(result.errors).toHaveLength(0);
    expect(result.rateLimit?.status).toBe('allowed_warning');
  });

  it('DOES treat "rejected" status as an error', () => {
    const lines = [
      assistantLine,
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rate_limit_type: 'seven_day',
          utilization: 1.02,
          resets_at: 1733000000,
        },
      }),
    ].join('\n');

    const result = parseStreamJson(lines);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/Rate limit hit/);
    expect(result.rateLimit?.status).toBe('rejected');
  });

  it('handles camelCase rateLimitInfo from CLI', () => {
    // CLI emits camelCase; SDKs normalize to snake_case. Parser must accept both.
    const lines = [
      assistantLine,
      JSON.stringify({
        type: 'rate_limit_event',
        rateLimitInfo: {
          status: 'allowed_warning',
          rateLimitType: 'five_hour',
          utilization: 0.65,
          resetsAt: 1733000000,
          isUsingOverage: false,
        },
      }),
    ].join('\n');

    const result = parseStreamJson(lines);
    expect(result.errors).toHaveLength(0);
    expect(result.rateLimit?.status).toBe('allowed_warning');
    expect(result.rateLimit?.rateLimitType).toBe('five_hour');
    expect(result.rateLimit?.utilization).toBe(0.65);
  });
});
