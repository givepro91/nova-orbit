import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { GoalActivityEvent } from "../stores/goals";

interface ActivityLogProps {
  events: GoalActivityEvent[];
  compact?: boolean;
  highlightFailures?: boolean;
  maxEvents?: number;
  className?: string;
}

const COPY = {
  en: {
    empty: "No activity yet",
    failedEmpty: "No failure activity recorded",
    eventTypes: {
      agent_started: "Agent started",
      agent_stopped: "Agent stopped",
      git_error: "Apply failed",
      git_warning: "Apply warning",
      goal_merged: "Goal applied",
      goal_squash_resolved: "Overlap resolved",
      system_error: "Error",
      task_completed: "Task completed",
      task_git: "Change saved",
      task_started: "Task started",
      verification_fail: "Verification failed",
      verification_pass: "Verification passed",
    },
  },
  ko: {
    empty: "아직 활동이 없습니다",
    failedEmpty: "실패 활동 기록이 없습니다",
    eventTypes: {
      agent_started: "에이전트 시작",
      agent_stopped: "에이전트 종료",
      git_error: "반영 실패",
      git_warning: "반영 경고",
      goal_merged: "목표 반영 완료",
      goal_squash_resolved: "변경 겹침 해결",
      system_error: "오류",
      task_completed: "태스크 완료",
      task_git: "변경 저장",
      task_started: "태스크 시작",
      verification_fail: "검증 실패",
      verification_pass: "검증 통과",
    },
  },
};

function getCopy(language: string) {
  return language.startsWith("ko") ? COPY.ko : COPY.en;
}

function normalizeDate(value: string): string {
  if (value.endsWith("Z") || value.includes("+")) return value;
  return `${value}Z`;
}

function formatTime(value: string): string {
  const date = new Date(normalizeDate(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getTone(type: string): "danger" | "success" | "warning" | "neutral" {
  const normalized = type.toLowerCase();
  if (normalized.includes("fail") || normalized.includes("error") || normalized.includes("blocked")) {
    return "danger";
  }
  if (normalized.includes("pass") || normalized.includes("complete") || normalized.includes("merged")) {
    return "success";
  }
  if (normalized.includes("approval") || normalized.includes("squash") || normalized.includes("warning")) {
    return "warning";
  }
  return "neutral";
}

function humanizeMessage(message: string): string {
  return message
    .replace(/\[CLI_EXIT_NONZERO\]:\s*/gi, "Agent run failed: ")
    .replace(/Agent CLI exited with code \d+/gi, "Agent exited unexpectedly")
    .replace(/rate limit/gi, "usage limit")
    .replace(/worktree/gi, "isolated workspace")
    .replace(/branch/gi, "save point")
    .replace(/merge/gi, "apply");
}

function parseMessageData(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { value: raw };
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, String(value)]),
    );
  } catch {
    return { value: raw };
  }
}

function translateStoredMessage(
  message: string,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  const separator = message.indexOf(":");
  if (separator <= 0) return humanizeMessage(message);

  const key = message.slice(0, separator);
  const rawData = message.slice(separator + 1).trim();
  const looksLikeKey = /^[a-z][a-zA-Z0-9_.-]*$/.test(key);
  if (!looksLikeKey) return humanizeMessage(message);

  const translated = t(key, parseMessageData(rawData));
  if (translated === key) {
    return humanizeMessage(rawData || message);
  }
  return translated;
}

function formatType(type: string, labels: Record<string, string>): string {
  const key = type.replace(/[:.-]+/g, "_");
  return labels[key] ?? key.replace(/_/g, " ");
}

function toneClasses(tone: ReturnType<typeof getTone>): {
  dot: string;
  text: string;
  row: string;
} {
  switch (tone) {
    case "danger":
      return {
        dot: "bg-danger",
        text: "text-danger",
        row: "bg-danger-subtle",
      };
    case "success":
      return {
        dot: "bg-success",
        text: "text-success",
        row: "bg-success-subtle",
      };
    case "warning":
      return {
        dot: "bg-warning",
        text: "text-warning",
        row: "bg-warning-subtle",
      };
    case "neutral":
      return {
        dot: "bg-line",
        text: "text-muted",
        row: "",
      };
  }
}

export function ActivityLog({
  events,
  compact = false,
  highlightFailures = false,
  maxEvents,
  className = "",
}: ActivityLogProps) {
  const { t, i18n } = useTranslation();
  const copy = getCopy(i18n.language);
  const visibleEvents = useMemo(
    () => (maxEvents ? events.slice(-maxEvents) : events),
    [events, maxEvents],
  );

  if (visibleEvents.length === 0) {
    return (
      <p className={`text-xs text-faint italic ${className}`}>
        {highlightFailures ? copy.failedEmpty : copy.empty}
      </p>
    );
  }

  return (
    <div className={`space-y-1 ${className}`}>
      {visibleEvents.map((event, index) => {
        const tone = getTone(event.type);
        const classes = toneClasses(tone);
        const showHighlight = highlightFailures && tone === "danger";
        return (
          <div
            key={`${event.created_at}-${event.type}-${index}`}
            className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-xs ${
              showHighlight ? classes.row : ""
            }`}
          >
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${classes.dot}`} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className={`truncate font-medium ${classes.text}`}>
                  {formatType(event.type, copy.eventTypes)}
                </span>
                {!compact && (
                  <span className="shrink-0 text-[10px] text-faint tabular-nums">
                    {formatTime(event.created_at)}
                  </span>
                )}
              </div>
              <p className="mt-0.5 break-words text-muted">
                {translateStoredMessage(event.message, t)}
              </p>
            </div>
            {compact && (
              <span className="shrink-0 text-[10px] text-faint tabular-nums">
                {formatTime(event.created_at)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
