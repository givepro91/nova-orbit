import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseAgentOutput } from "../utils/agentOutputParser";

interface TimelineEvent {
  id: string;
  type: "started" | "completed" | "failed" | "delegated" | "verified" | "rate-limit" | "info";
  taskTitle: string;
  agentName: string;
  message?: string;
  timestamp: Date;
}

interface TaskTimelineProps {
  activeTasks: Array<{
    id: string;
    title: string;
    status: string;
    assignee_id: string | null;
  }>;
  agents: Array<{ id: string; name: string; role: string; status: string }>;
}

const TYPE_STYLES: Record<TimelineEvent["type"], { dot: string; text: string }> = {
  started: { dot: "bg-accent animate-pulse", text: "text-accent" },
  completed: { dot: "bg-success", text: "text-success" },
  failed: { dot: "bg-danger", text: "text-danger" },
  delegated: { dot: "bg-review", text: "text-review" },
  verified: { dot: "bg-success", text: "text-success" },
  "rate-limit": { dot: "bg-warning", text: "text-warning" },
  info: { dot: "bg-faint", text: "text-muted" },
};

let eventCounter = 0;

export function TaskTimeline({ activeTasks, agents }: TaskTimelineProps) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  // Track last output per agent: short (1-line) + full (recent history)
  const [agentOutputs, setAgentOutputs] = useState<Record<string, { short: string; full: string[] }>>({});
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const expandedRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const agentMap = Object.fromEntries(agents.map((a) => [a.id, a]));

  // Listen for real-time agent output — parse stream-json into readable messages
  useEffect(() => {
    const ICONS: Record<string, string> = {
      tool: "⚡", thinking: "💭", text: "💬", error: "⚠️", result: "✅",
    };
    const onOutput = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d?.agentId || !d?.output) return;
      const activity = parseAgentOutput(d.output);
      if (activity) {
        const icon = ICONS[activity.type] ?? "";
        const line = `${icon} ${activity.message}`;
        setAgentOutputs((prev) => {
          const existing = prev[d.agentId] ?? { short: "", full: [] };
          return {
            ...prev,
            [d.agentId]: {
              short: line,
              full: [...existing.full.slice(-19), line], // keep last 20
            },
          };
        });
      }
    };
    window.addEventListener("crewdeck:agent-output", onOutput);
    return () => window.removeEventListener("crewdeck:agent-output", onOutput);
  }, []);

  // Listen for task lifecycle events
  useEffect(() => {
    const addEvent = (evt: TimelineEvent) => {
      setEvents((prev) => [...prev.slice(-50), evt]); // keep last 50
    };

    const onTaskStarted = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d?.taskId) return;
      const agent = d.agentId ? agentMap[d.agentId]?.name ?? "Agent" : "Agent";
      addEvent({
        id: `ev-${++eventCounter}`,
        type: "started",
        taskTitle: d.title ?? d.taskId,
        agentName: agent,
        timestamp: new Date(),
      });
    };

    const onTaskCompleted = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d?.taskId) return;
      const agent = d.agentId ? agentMap[d.agentId]?.name ?? "Agent" : "Agent";
      addEvent({
        id: `ev-${++eventCounter}`,
        type: "completed",
        taskTitle: d.title ?? d.taskId,
        agentName: agent,
        timestamp: new Date(),
      });
    };

    const onTaskUpdated = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d) return;
      const agent = d.agentId ? agentMap[d.agentId]?.name ?? "" : "";
      if (d.status === "blocked" && d.error) {
        addEvent({
          id: `ev-${++eventCounter}`,
          type: "failed",
          taskTitle: d.title ?? d.taskId ?? "",
          agentName: agent,
          message: d.error?.slice(0, 100),
          timestamp: new Date(),
        });
      }
    };

    const onDelegated = (e: Event) => {
      const d = (e as CustomEvent).detail;
      addEvent({
        id: `ev-${++eventCounter}`,
        type: "delegated",
        taskTitle: "",
        agentName: d.parentAgentName ?? "Agent",
        message: t("delegatedSubtasks", { count: d.subtaskCount ?? 0 }),
        timestamp: new Date(),
      });
    };

    const onVerification = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d?.verdict) return;
      // FAIL/CONDITIONAL은 판정만으로는 정보가 없다 — 첫 이슈를 같이 싣는다
      const firstIssue =
        d.verdict !== "pass" && Array.isArray(d.issues) && d.issues.length > 0
          ? d.issues[0]?.message
          : null;
      addEvent({
        id: `ev-${++eventCounter}`,
        type: d.verdict === "pass" ? "verified" : "failed",
        taskTitle: "",
        agentName: "Quality Gate",
        message: d.verdict.toUpperCase() + (firstIssue ? ` — ${String(firstIssue).slice(0, 100)}` : ""),
        timestamp: new Date(),
      });
    };

    const onRateLimit = (e: Event) => {
      const d = (e as CustomEvent).detail;
      addEvent({
        id: `ev-${++eventCounter}`,
        type: "rate-limit",
        taskTitle: "",
        agentName: d.agentName ?? "System",
        message: t("rateLimitDetected"),
        timestamp: new Date(),
      });
    };

    window.addEventListener("crewdeck:task-started", onTaskStarted);
    window.addEventListener("crewdeck:task-completed", onTaskCompleted);
    window.addEventListener("crewdeck:task-updated-event", onTaskUpdated);
    window.addEventListener("crewdeck:task-delegated", onDelegated);
    window.addEventListener("crewdeck:verification-result", onVerification);
    window.addEventListener("crewdeck:rate-limit", onRateLimit);
    // Also listen to generic refresh for task status changes
    window.addEventListener("crewdeck:refresh", (e) => {
      const d = (e as CustomEvent).detail;
      if (d?.type === "task:updated") onTaskUpdated(e);
    });

    return () => {
      window.removeEventListener("crewdeck:task-started", onTaskStarted);
      window.removeEventListener("crewdeck:task-completed", onTaskCompleted);
      window.removeEventListener("crewdeck:task-updated-event", onTaskUpdated);
      window.removeEventListener("crewdeck:task-delegated", onDelegated);
      window.removeEventListener("crewdeck:verification-result", onVerification);
      window.removeEventListener("crewdeck:rate-limit", onRateLimit);
    };
  }, [agents, t]);

  // Auto-scroll timeline
  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, activeTasks]);

  // Auto-scroll expanded output panels to bottom
  useEffect(() => {
    for (const id of expandedAgents) {
      const el = expandedRefs.current[id];
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [agentOutputs, expandedAgents]);

  const workingAgents = agents.filter((a) => a.status === "working");
  const inProgressTasks = activeTasks.filter((t) => t.status === "in_progress" || t.status === "in_review");
  const hasActivity = inProgressTasks.length > 0 || events.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Active Tasks — status cards */}
      {inProgressTasks.length > 0 && (
        <div className="px-4 py-2.5 border-b border-line-soft space-y-2">
          {inProgressTasks.map((task) => {
            const agent = task.assignee_id ? agentMap[task.assignee_id] : null;
            const output = task.assignee_id ? agentOutputs[task.assignee_id] : null;
            const isExpanded = task.assignee_id ? expandedAgents.has(task.assignee_id) : false;
            return (
              <div key={task.id} className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full animate-pulse shrink-0 ${task.status === "in_review" ? "bg-review" : "bg-accent"}`} />
                  <span className="text-[11px] text-muted truncate flex-1">
                    {task.status === "in_review" && <span className="text-review mr-1">검토 중:</span>}
                    {task.title}
                  </span>
                  {agent && (
                    <span className="text-[10px] text-faint shrink-0">{agent.name}</span>
                  )}
                </div>
                {output && (
                  <div
                    className="ml-3.5 px-2 py-0.5 bg-sunken rounded text-[10px] text-muted font-mono cursor-pointer hover:bg-fg/5 transition-colors"
                    onClick={() => {
                      if (!task.assignee_id) return;
                      setExpandedAgents((prev) => {
                        const next = new Set(prev);
                        next.has(task.assignee_id!) ? next.delete(task.assignee_id!) : next.add(task.assignee_id!);
                        return next;
                      });
                    }}
                  >
                    {isExpanded ? (
                      <div
                        ref={(el) => { if (task.assignee_id) expandedRefs.current[task.assignee_id] = el; }}
                        className="max-h-40 overflow-y-auto space-y-0.5 py-0.5"
                      >
                        {output.full.map((line, i) => (
                          <div key={i} className={`whitespace-pre-wrap break-all ${i === output.full.length - 1 ? "text-muted" : ""}`}>
                            {line}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="truncate">{output.short}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Timeline */}
      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {!hasActivity && (
          <p className="text-xs text-faint text-center pt-6">
            {t("timelineEmpty")}
          </p>
        )}

        {events.map((evt) => {
          const style = TYPE_STYLES[evt.type];
          return (
            <div key={evt.id} className="flex items-start gap-2">
              <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${style.dot}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`text-[11px] font-medium ${style.text}`}>
                    {evt.agentName}
                  </span>
                  {evt.taskTitle && (
                    <span className="text-[10px] text-faint truncate">
                      {evt.taskTitle}
                    </span>
                  )}
                  <span className="text-[9px] text-faint shrink-0 ml-auto">
                    {evt.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                </div>
                {evt.message && (
                  <p className="text-[10px] text-faint truncate">{evt.message}</p>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Footer — working agent count */}
      {workingAgents.length > 0 && (
        <div className="px-4 py-2 border-t border-line-soft flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          <span className="text-[10px] text-muted">
            {t("agentsWorking", { count: workingAgents.length })}
          </span>
        </div>
      )}
    </div>
  );
}
