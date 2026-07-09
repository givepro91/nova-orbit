import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

/**
 * Live activity flow view for an agent, shown in the TaskDetail right pane.
 *
 * Not a raw log: the agent's own narration ("text" events) anchors the flow —
 * each narration starts a step, and the tool events that follow belong to it.
 * Past steps collapse to a one-line summary (click to expand); the current
 * step stays open. A "now" strip pins the latest action at the top so the
 * user can always tell what the agent is doing this second.
 */

export interface ActivityEvent {
  ts: string;
  kind: string;
  detail: string;
  action?: string;
}

interface ActivityItem {
  ev: ActivityEvent;
  count: number; // consecutive identical events collapse into ×N
}

interface ActivityGroup {
  key: string;
  narration: ActivityEvent | null; // null = events before the first narration
  items: ActivityItem[];
}

// kind → terminal glyph + color + i18n label (dark terminal palette, both themes)
const KIND_META: Record<string, { icon: string; labelKey: string; color: string }> = {
  command: { icon: "$", labelKey: "activityKindCommand", color: "text-green-400" },
  file_read: { icon: "◎", labelKey: "activityKindFileRead", color: "text-sky-400" },
  file_edit: { icon: "✎", labelKey: "activityKindFileEdit", color: "text-amber-400" },
  search: { icon: "⌕", labelKey: "activityKindSearch", color: "text-violet-400" },
  browser: { icon: "⌖", labelKey: "activityKindBrowser", color: "text-rose-400" },
  web: { icon: "⇄", labelKey: "activityKindWeb", color: "text-cyan-400" },
  subagent: { icon: "⑂", labelKey: "activityKindSubagent", color: "text-indigo-400" },
  plan: { icon: "☰", labelKey: "activityKindPlan", color: "text-teal-400" },
  text: { icon: "›", labelKey: "activityKindText", color: "text-gray-400" },
  tool: { icon: "⚙", labelKey: "activityKindTool", color: "text-gray-400" },
};

// action (server data key) → i18n label key. Unknown actions render as-is.
const ACTION_LABEL_KEYS: Record<string, string> = {
  click: "activityActClick",
  navigate: "activityActNavigate",
  navigate_back: "activityActBack",
  snapshot: "activityActSnapshot",
  take_screenshot: "activityActScreenshot",
  type: "activityActType",
  press_key: "activityActKey",
  select_option: "activityActSelect",
  fill_form: "activityActFillForm",
  wait_for: "activityActWait",
  console_messages: "activityActConsole",
  evaluate: "activityActScript",
  run_code_unsafe: "activityActScript",
  hover: "activityActHover",
  drag: "activityActDrag",
  drop: "activityActDrag",
  resize: "activityActResize",
  tabs: "activityActTabs",
  network_requests: "activityActNetwork",
  network_request: "activityActNetwork",
  close: "activityActCloseBrowser",
  install: "activityActInstall",
  handle_dialog: "activityActDialog",
  file_upload: "activityActUpload",
  search: "activityActWebSearch",
  fetch: "activityActWebFetch",
  delegate: "activityActDelegate",
  todo: "activityActTodo",
  skill: "activityActSkill",
};

/** Group events into narration-anchored steps, merging consecutive duplicates. */
function groupActivities(events: ActivityEvent[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const ev of events) {
    if (ev.kind === "text") {
      groups.push({ key: `n-${ev.ts}-${groups.length}`, narration: ev, items: [] });
      continue;
    }
    let group = groups[groups.length - 1];
    if (!group) {
      group = { key: "head", narration: null, items: [] };
      groups.push(group);
    }
    const last = group.items[group.items.length - 1];
    if (last && last.ev.kind === ev.kind && last.ev.action === ev.action && last.ev.detail === ev.detail) {
      last.count += 1;
      last.ev = ev; // keep the latest timestamp for display
    } else {
      group.items.push({ ev, count: 1 });
    }
  }
  return groups;
}

/** Long absolute paths → tail segments (the pane is ~470px wide). */
function displayDetail(ev: ActivityEvent): string {
  if ((ev.kind === "file_read" || ev.kind === "file_edit") && ev.detail.length > 42) {
    const parts = ev.detail.split("/").filter(Boolean);
    if (parts.length > 3) return "…/" + parts.slice(-3).join("/");
  }
  return ev.detail;
}

// 고정 폭 HH:MM:SS — ko 로케일("21시 15분 32초")은 좁은 페인에서 너무 넓다
function timeLabel(ts: string): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function LiveActivity({ agentId, contextLabel }: { agentId: string; contextLabel?: string }) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pinned, setPinned] = useState(true);
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
  // Events that existed at mount don't animate; only live-appended ones do.
  const [mountTs, setMountTs] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Load initial buffer + subscribe to live events for this agent.
  // Parent remounts via key={agentId} on assignee change — no manual reset.
  useEffect(() => {
    let alive = true;
    api.agents.activityLog(agentId).then((data) => {
      if (!alive) return;
      setEvents(data.events);
      setLastEventAt(data.lastEventAt);
      setMountTs(data.lastEventAt ?? "");
    }).catch(() => { /* agent may have no activity yet */ });

    const onActivity = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        agentId: string;
        event?: ActivityEvent; // legacy singular payload
        events?: ActivityEvent[]; // batched payload
        lastEventAt?: string;
      };
      if (!detail || detail.agentId !== agentId) return;
      const incoming = detail.events ?? (detail.event ? [detail.event] : []);
      if (incoming.length === 0) return;
      setEvents((prev) => [...prev, ...incoming].slice(-50));
      setLastEventAt(detail.lastEventAt ?? incoming[incoming.length - 1].ts);
    };
    window.addEventListener("crewdeck:agent-activity", onActivity);
    return () => {
      alive = false;
      window.removeEventListener("crewdeck:agent-activity", onActivity);
    };
  }, [agentId]);

  // Heartbeat tick — recompute elapsed every 5s
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  // Auto-scroll while pinned to the bottom; scrolling up unpins.
  useEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, pinned]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinned(true);
  };

  // Heartbeat classification: <60s recent (green pulse), <180s idle (gray), else stale (orange)
  const elapsedSec = lastEventAt
    ? Math.max(0, Math.floor((now - new Date(lastEventAt).getTime()) / 1000))
    : null;
  let dotClass = "bg-gray-300 dark:bg-gray-600";
  let heartbeatText = t("activityNone");
  let textClass = "text-gray-400 dark:text-gray-500";
  if (elapsedSec !== null) {
    if (elapsedSec < 60) {
      dotClass = "bg-green-500 animate-pulse";
      textClass = "text-green-400";
      heartbeatText = t("activityRecentSec", { n: elapsedSec });
    } else if (elapsedSec < 180) {
      dotClass = "bg-gray-400 dark:bg-gray-500";
      textClass = "text-gray-400";
      heartbeatText = t("activityRecentMin", { n: Math.floor(elapsedSec / 60) });
    } else {
      dotClass = "bg-orange-500";
      textClass = "text-orange-400";
      heartbeatText = t("activityStaleMin", { n: Math.floor(elapsedSec / 60) });
    }
  }

  const groups = useMemo(() => groupActivities(events), [events]);
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  const actionLabel = (ev: ActivityEvent): string => {
    if (ev.action) {
      const key = ACTION_LABEL_KEYS[ev.action];
      if (key) return t(key);
      return ev.action.replace(/[_-]+/g, " ");
    }
    const meta = KIND_META[ev.kind] ?? KIND_META.tool;
    return t(meta.labelKey);
  };

  const renderItemRow = (item: ActivityItem) => {
    const { ev, count } = item;
    const meta = KIND_META[ev.kind] ?? KIND_META.tool;
    const detail = displayDetail(ev);
    const animate = mountTs !== "" && ev.ts > mountTs;
    return (
      <div
        key={`${ev.ts}-${ev.kind}-${ev.detail.slice(0, 24)}`}
        className={`flex items-center gap-2 min-w-0 ${animate ? "animate-activity-in" : ""}`}
      >
        <span className="text-gray-600 shrink-0 tabular-nums">{timeLabel(ev.ts)}</span>
        <span className={`shrink-0 w-4 text-center ${meta.color}`}>{meta.icon}</span>
        <span className={`shrink-0 ${meta.color}`}>{actionLabel(ev)}</span>
        {detail && (
          <span className="text-gray-300 truncate" title={ev.detail}>{detail}</span>
        )}
        {count > 1 && (
          <span className="shrink-0 text-[10px] text-gray-500 border border-gray-700 rounded px-1">
            ×{count}
          </span>
        )}
      </div>
    );
  };

  // Collapsed step summary — per-kind glyph+count chips (dense, no prose)
  const renderSummaryChips = (group: ActivityGroup) => {
    const byKind = new Map<string, number>();
    for (const item of group.items) {
      byKind.set(item.ev.kind, (byKind.get(item.ev.kind) ?? 0) + item.count);
    }
    return (
      <span className="ml-auto shrink-0 flex items-center gap-1.5">
        {[...byKind.entries()].map(([kind, count]) => {
          const meta = KIND_META[kind] ?? KIND_META.tool;
          return (
            <span key={kind} className={`${meta.color} opacity-80`} title={t(meta.labelKey)}>
              {meta.icon}{count}
            </span>
          );
        })}
      </span>
    );
  };

  return (
    // Deliberately dark in both themes (terminal convention). Fills the pane via flex.
    <div className="rounded-lg overflow-hidden border border-gray-800 bg-[#0d1117] shadow-inner flex flex-col h-full w-full min-h-0">
      {/* Titlebar — traffic lights + title + heartbeat */}
      <div className="flex items-center gap-2 px-3 py-2 bg-[#161b22] border-b border-gray-800">
        <span className="flex gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
          <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
          <span className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
        </span>
        <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider ml-1">
          {t("liveActivityTitle")}
        </span>
        {contextLabel && (
          <span className="text-[10px] text-violet-400/90 truncate" title={contextLabel}>
            {contextLabel}
          </span>
        )}
        <span className="flex items-center gap-1.5 ml-auto">
          <span className={`inline-block w-2 h-2 rounded-full ${dotClass}`} />
          <span className={`text-[11px] ${textClass}`}>{heartbeatText}</span>
        </span>
      </div>

      {/* "Now" strip — what the agent is doing this second */}
      <div className="flex items-center gap-2 px-3 py-2 bg-[#10151c] border-b border-gray-800 font-mono text-[11px] min-w-0">
        <span className="text-[9px] uppercase tracking-wider text-gray-500 shrink-0">{t("activityNow")}</span>
        {lastEvent ? (
          <span key={lastEvent.ts} className="flex items-center gap-2 min-w-0 animate-activity-in">
            {(() => {
              const meta = KIND_META[lastEvent.kind] ?? KIND_META.tool;
              return (
                <>
                  <span className={`shrink-0 ${meta.color}`}>{meta.icon} {actionLabel(lastEvent)}</span>
                  {lastEvent.detail && (
                    <span className="text-gray-300 truncate" title={lastEvent.detail}>
                      {displayDetail(lastEvent)}
                    </span>
                  )}
                </>
              );
            })()}
            <span className="text-green-400 animate-pulse shrink-0">▋</span>
          </span>
        ) : (
          <span className="text-gray-500">
            {t("activityWaiting")}
            <span className="text-gray-300 animate-pulse"> ▋</span>
          </span>
        )}
      </div>

      {/* Flow timeline — narration-anchored steps, older steps collapsed */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed space-y-1.5"
        >
          {groups.length === 0 ? (
            <div className="text-gray-500">
              <span className="text-green-400">$</span> {t("activityWaiting")}
              <span className="text-gray-300 animate-pulse"> ▋</span>
            </div>
          ) : (
            groups.map((group, i) => {
              const isLast = i === groups.length - 1;
              const expanded = expandedKeys[group.key] ?? isLast;
              const toggle = () =>
                setExpandedKeys((prev) => ({ ...prev, [group.key]: !expanded }));
              const headTs = group.narration?.ts ?? group.items[0]?.ev.ts;
              return (
                <div key={group.key}>
                  {/* Step header: narration (or initial-activity label) — click to fold */}
                  <button
                    type="button"
                    onClick={toggle}
                    className="w-full flex items-start gap-2 text-left min-w-0 rounded hover:bg-white/5 transition-colors"
                  >
                    <span className="text-gray-600 shrink-0 tabular-nums">
                      {headTs ? timeLabel(headTs) : ""}
                    </span>
                    <span className="text-gray-500 shrink-0 w-4 text-center">{expanded ? "▾" : "▸"}</span>
                    {group.narration ? (
                      <span
                        className={`text-gray-200 min-w-0 ${expanded ? "whitespace-normal break-words" : "truncate"}`}
                        title={group.narration.detail}
                      >
                        {group.narration.detail}
                      </span>
                    ) : (
                      <span className="text-gray-500 italic shrink-0">{t("activityInitial")}</span>
                    )}
                    {!expanded && group.items.length > 0 && renderSummaryChips(group)}
                  </button>
                  {/* Step body: tool events on a left rail */}
                  {expanded && group.items.length > 0 && (
                    <div className="mt-0.5 ml-1.5 pl-2.5 border-l border-gray-800 space-y-0.5">
                      {group.items.map(renderItemRow)}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        {/* Unpinned → jump-to-latest affordance */}
        {!pinned && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-2 right-3 text-[10px] font-mono px-2 py-1 rounded-full bg-gray-700/90 text-gray-200 hover:bg-gray-600 border border-gray-600 shadow"
          >
            {t("activityNewEvents")}
          </button>
        )}
      </div>
    </div>
  );
}
