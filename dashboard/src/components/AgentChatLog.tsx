import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "./AgentAvatar";

type MessageType = "agent" | "system-success" | "system-error" | "system-info";

interface ChatMessage {
  id: string;
  type: MessageType;
  text: string;
  agentName?: string;
  agentRole?: string;
  timestamp: Date;
}

interface AgentChatLogProps {
  taskId: string;
  agentName?: string;
  agentRole?: string;
  isWorking: boolean;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

let msgCounter = 0;
function makeId() {
  return `msg-${Date.now()}-${++msgCounter}`;
}

export function AgentChatLog({ taskId, agentName, agentRole, isWorking }: AgentChatLogProps) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const resolvedRole = agentRole ?? "custom";
  const resolvedName = agentName ?? "Agent";

  useEffect(() => {
    const handleAgentOutput = (e: Event) => {
      const ev = e as CustomEvent<{ taskId?: string; text: string; agentName?: string; agentRole?: string }>;
      // Filter to relevant task if taskId is provided in the event
      if (ev.detail.taskId && ev.detail.taskId !== taskId) return;

      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          type: "agent",
          text: ev.detail.text,
          agentName: ev.detail.agentName ?? agentName,
          agentRole: ev.detail.agentRole ?? agentRole,
          timestamp: new Date(),
        },
      ]);
    };

    const handleRefresh = (e: Event) => {
      const ev = e as CustomEvent<{ type?: string; verdict?: string; taskId?: string }>;
      if (ev.detail.taskId && ev.detail.taskId !== taskId) return;

      const type = ev.detail.type;
      if (type === "task_completed") {
        setMessages((prev) => [
          ...prev,
          {
            id: makeId(),
            type: "system-success",
            text: t("taskCompleted"),
            timestamp: new Date(),
          },
        ]);
      } else if (type === "verification_done") {
        const passed = ev.detail.verdict === "PASS";
        setMessages((prev) => [
          ...prev,
          {
            id: makeId(),
            type: passed ? "system-success" : "system-error",
            text: passed ? t("verificationPassed") : t("verificationFailed"),
            timestamp: new Date(),
          },
        ]);
      }
    };

    window.addEventListener("crewdeck:agent-output", handleAgentOutput);
    window.addEventListener("crewdeck:refresh", handleRefresh);
    return () => {
      window.removeEventListener("crewdeck:agent-output", handleAgentOutput);
      window.removeEventListener("crewdeck:refresh", handleRefresh);
    };
  }, [taskId, agentName, agentRole, t]);

  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll within container only (not the page)
  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isWorking]);

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-y-auto px-4 py-3 space-y-3">
      {messages.length === 0 && !isWorking && (
        <p className="text-xs text-faint text-center pt-4">
          {t("terminalWaiting")}
        </p>
      )}

      {messages.map((msg) => {
        if (msg.type === "agent") {
          return (
            <div key={msg.id} className="flex items-start gap-2">
              <AgentAvatar
                name={msg.agentName ?? resolvedName}
                role={msg.agentRole ?? resolvedRole}
                size="sm"
                showBadge={false}
              />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-faint mb-0.5">
                  {msg.agentName ?? resolvedName}
                </div>
                <div className="bg-surface border border-line-soft rounded-lg px-3 py-2 text-xs text-muted whitespace-pre-wrap break-words">
                  {msg.text}
                </div>
                <div className="text-[10px] text-faint mt-0.5">
                  {formatTime(msg.timestamp)}
                </div>
              </div>
            </div>
          );
        }

        // System messages — centered
        const iconMap: Record<MessageType, string> = {
          "system-success": "✅",
          "system-error": "❌",
          "system-info": "⚡",
          agent: "",
        };
        const colorMap: Record<MessageType, string> = {
          "system-success": "text-success",
          "system-error": "text-danger",
          "system-info": "text-info",
          agent: "",
        };

        return (
          <div key={msg.id} className="flex flex-col items-center gap-0.5">
            <span className={`text-xs font-medium ${colorMap[msg.type]}`}>
              {iconMap[msg.type]} {msg.text}
            </span>
            <span className="text-[10px] text-faint">
              {formatTime(msg.timestamp)}
            </span>
          </div>
        );
      })}

      {/* Thinking animation — shown when working but no recent message */}
      {isWorking && (
        <div className="flex items-start gap-2">
          <AgentAvatar name={resolvedName} role={resolvedRole} size="sm" showBadge={false} />
          <div className="flex-1">
            <div className="text-[10px] text-faint mb-0.5">
              {resolvedName}
            </div>
            <div className="bg-surface border border-line-soft rounded-lg px-3 py-2 inline-flex items-center gap-1">
              <span className="text-xs text-faint mr-1">{t("thinking")}</span>
              <span className="w-1.5 h-1.5 rounded-full bg-fg/30 animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-fg/30 animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-fg/30 animate-bounce [animation-delay:300ms]" />
            </div>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
