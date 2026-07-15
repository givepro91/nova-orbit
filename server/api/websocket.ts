import type { IncomingMessage } from "node:http";
import type { WebSocketServer, WebSocket } from "ws";

export interface WSMessageHandlers {
  onTerminalSubscribe?: (ws: WebSocket, terminalId: string) => void;
  onTerminalInput?: (terminalId: string, data: string) => void;
  onTerminalResize?: (terminalId: string, cols: number, rows: number) => void;
}

export function createWSHandler(
  wss: WebSocketServer,
  apiKey: string,
  onAuthenticated?: () => void,
  handlers: WSMessageHandlers = {},
): void {
  // Prevent server crash on WebSocket errors
  wss.on("error", (err) => {
    console.error("[WS Server] Error:", err.message);
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // 인증: URL 쿼리 토큰(레거시) 또는 첫 메시지 auth 토큰(신규) 지원
    // close()는 proxy EPIPE 가능성이 있어 유예 close 사용
    // 미인증 연결은 subscribe/broadcast 모두 차단되고 10초 후 close
    const url = new URL(req.url ?? "", "http://localhost");
    const urlToken = url.searchParams.get("token");
    let authed = urlToken === apiKey;
    (ws as any).__authenticated = authed;

    // Handle client errors gracefully
    ws.on("error", (err) => {
      console.error("[WS Client] Error:", err.message);
    });

    // URL 토큰 미인증 시: 첫 메시지로 auth 패킷을 기다림 (10초 타임아웃)
    let authTimer: ReturnType<typeof setTimeout> | null = null;
    if (!authed) {
      authTimer = setTimeout(() => {
        if (!(ws as any).__authenticated) {
          try { ws.send(JSON.stringify({ type: "error", payload: { code: "unauthorized" } })); } catch { /* ignore */ }
          try { ws.close(4001, "Unauthorized"); } catch { /* already closed */ }
        }
      }, 10_000);
      ws.on("close", () => { if (authTimer) clearTimeout(authTimer); });
    }

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // 첫 메시지 auth 처리 (신규 방식)
        if (msg.type === "auth" && !authed) {
          if (msg.token === apiKey) {
            authed = true;
            (ws as any).__authenticated = true;
            if (authTimer) { clearTimeout(authTimer); authTimer = null; }
            try {
              ws.send(JSON.stringify({
                type: "connected",
                payload: { message: "Crewdeck WebSocket connected" },
                timestamp: new Date().toISOString(),
              }));
            } catch { /* ignore */ }
            onAuthenticated?.();
          } else {
            try { ws.send(JSON.stringify({ type: "error", payload: { code: "unauthorized" } })); } catch { /* ignore */ }
            try { ws.close(4001, "Unauthorized"); } catch { /* already closed */ }
          }
          return;
        }

        // 미인증 연결 — subscribe/broadcast 차단
        if (!(ws as any).__authenticated) return;

        if (msg.type === "subscribe" && msg.projectId) {
          (ws as any).__projectId = msg.projectId;
        }

        if (msg.type === "subscribe:agent" && msg.agentId) {
          if (!(ws as any).__agentIds) (ws as any).__agentIds = new Set();
          (ws as any).__agentIds.add(msg.agentId);
        }

        if (msg.type === "unsubscribe:agent" && msg.agentId) {
          (ws as any).__agentIds?.delete(msg.agentId);
        }

        if (msg.type === "subscribe:terminal" && typeof msg.terminalId === "string") {
          if (!(ws as any).__terminalIds) (ws as any).__terminalIds = new Set();
          (ws as any).__terminalIds.add(msg.terminalId);
          handlers.onTerminalSubscribe?.(ws, msg.terminalId);
        }

        if (msg.type === "unsubscribe:terminal" && typeof msg.terminalId === "string") {
          (ws as any).__terminalIds?.delete(msg.terminalId);
        }

        if (msg.type === "terminal:input" && typeof msg.terminalId === "string" && typeof msg.data === "string") {
          handlers.onTerminalInput?.(msg.terminalId, msg.data);
        }

        if (
          msg.type === "terminal:resize" && typeof msg.terminalId === "string" &&
          Number.isFinite(msg.cols) && Number.isFinite(msg.rows)
        ) {
          handlers.onTerminalResize?.(msg.terminalId, Number(msg.cols), Number(msg.rows));
        }
      } catch {
        // Ignore malformed messages
      }
    });

    // URL 토큰으로 이미 인증된 경우 즉시 connected 전송 (레거시 호환)
    if (authed) {
      try {
        ws.send(JSON.stringify({
          type: "connected",
          payload: { message: "Crewdeck WebSocket connected" },
          timestamp: new Date().toISOString(),
        }));
      } catch {
        // Client may have disconnected immediately
      }
      onAuthenticated?.();
    }
  });
}

/**
 * Broadcast token usage and cost for a completed task.
 */
export function broadcastTaskUsage(
  wss: WebSocketServer,
  payload: { taskId: string; agentId: string; totalTokens: number; costUsd: number },
): void {
  const message = JSON.stringify({
    type: "task:usage",
    payload,
    timestamp: new Date().toISOString(),
  });

  for (const client of wss.clients) {
    if (client.readyState !== 1 || !(client as any).__authenticated) continue;
    try {
      client.send(message);
    } catch {
      // Skip failed clients
    }
  }
}

/**
 * Safe broadcast — skip clients that are not ready or not authenticated.
 */
export function broadcastAgentOutput(
  wss: WebSocketServer,
  agentId: string,
  output: string,
): void {
  const message = JSON.stringify({
    type: "agent:output",
    payload: { agentId, output },
    timestamp: new Date().toISOString(),
  });

  for (const client of wss.clients) {
    if (client.readyState !== 1 || !(client as any).__authenticated) continue;
    try {
      const ids = (client as any).__agentIds as Set<string> | undefined;
      if (ids?.has(agentId)) {
        client.send(message);
      }
    } catch {
      // Skip failed clients
    }
  }
}
