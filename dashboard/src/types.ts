export type AgentProvider = "claude" | "codex";
export type ProviderResolutionSource = "agent" | "project" | "global";
export type ProviderFailoverReasonCode = "rate_limit" | "session_exhausted" | "env_error";
export type ProviderActivityEvent = "provider:resolved" | "provider:failover" | "provider:redispatched";

export interface ActivityLogEntry {
  id: number;
  project_id: string;
  projectId: string;
  agent_id: string | null;
  agentId: string | null;
  type: string;
  message: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  createdAt: string;
}

export interface ProviderActivityPayload {
  event?: ProviderActivityEvent;
  projectId?: string;
  taskId?: string;
  agentId?: string | null;
  taskTitle?: string;
  sessionId?: string | null;
  resolvedProvider?: AgentProvider | null;
  resolutionSource?: ProviderResolutionSource | null;
  failoverOverride?: boolean;
  reasonCode?: ProviderFailoverReasonCode | null;
  userMessage?: string | null;
  fromProvider?: AgentProvider | null;
  toProvider?: AgentProvider | null;
  redispatched?: boolean;
  loopGuardBlocked?: boolean;
  originalSessionId?: string | null;
  redispatchedSessionId?: string | null;
}

export interface ProviderActivityDetails {
  event: ProviderActivityEvent;
  reasonCode: ProviderFailoverReasonCode | null;
  userMessage: string | null;
  fromProvider: AgentProvider | null;
  toProvider: AgentProvider | null;
  resolvedProvider: AgentProvider | null;
  redispatched: boolean;
  loopGuardBlocked: boolean;
}

/** ⚠ shared/types.ts 의 ChatEvent 와 동기 유지 (WS payload 계약). */
export type ChatEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; isError: boolean; content: string }
  | { kind: "todo"; items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { kind: "result"; text: string }
  | { kind: "context"; items: Array<{ label: string; detail?: string; tone: "pass" | "conditional" | "fail" | "neutral" }> }
  | { kind: "queue"; remaining: number };
