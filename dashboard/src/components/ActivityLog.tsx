import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { GoalActivityEvent } from "../stores/goals";
import type { SteeringNote } from "../../../shared/types";

/** 조향(steering) 노트를 반영 스텝으로 연결하는 링크 — GoalDetail이 검증 타임라인에서 해석. */
export interface SteeringStepLink {
  taskTitle: string;
  onClick: () => void;
}

interface ActivityLogProps {
  events: GoalActivityEvent[];
  compact?: boolean;
  highlightFailures?: boolean;
  maxEvents?: number;
  className?: string;
  steeringNotes?: SteeringNote[];
  resolveSteeringStep?: (injectedStep: string) => SteeringStepLink | null;
}

type LogItem =
  | { kind: "event"; key: string; at: string; event: GoalActivityEvent }
  | { kind: "steering"; key: string; at: string; note: SteeringNote };

const COPY = {
  en: {
    empty: "No activity yet",
    failedEmpty: "No failure activity recorded",
    steeringLabel: "Steering",
    steeringPending: "Pending",
    steeringInjected: "Reflected",
    steeringReflectedAt: "Reflected at",
    steeringStepUnresolved: "Reflected step",
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
    steeringLabel: "조향",
    steeringPending: "대기 중",
    steeringInjected: "반영됨",
    steeringReflectedAt: "반영 시각",
    steeringStepUnresolved: "반영 스텝",
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
  steeringNotes,
  resolveSteeringStep,
}: ActivityLogProps) {
  const { t, i18n } = useTranslation();
  const copy = getCopy(i18n.language);
  const items = useMemo(() => {
    const merged: LogItem[] = [
      ...events.map((event, index) => ({
        kind: "event" as const,
        key: `${event.created_at}-${event.type}-${index}`,
        at: event.created_at,
        event,
      })),
      ...(steeringNotes ?? []).map((note) => ({
        kind: "steering" as const,
        key: `steering-${note.id}`,
        at: note.createdAt,
        note,
      })),
    ];
    merged.sort((a, b) => a.at.localeCompare(b.at));
    return maxEvents ? merged.slice(-maxEvents) : merged;
  }, [events, steeringNotes, maxEvents]);

  if (items.length === 0) {
    return (
      <p className={`text-xs text-faint italic ${className}`}>
        {highlightFailures ? copy.failedEmpty : copy.empty}
      </p>
    );
  }

  return (
    <div className={`space-y-1 ${className}`}>
      {items.map((item) => {
        if (item.kind === "steering") {
          const stepLink = item.note.injectedStep ? resolveSteeringStep?.(item.note.injectedStep) : null;
          return (
            <SteeringActivityRow
              key={item.key}
              note={item.note}
              compact={compact}
              copy={copy}
              stepLink={stepLink ?? null}
            />
          );
        }
        const { event } = item;
        const tone = getTone(event.type);
        const classes = toneClasses(tone);
        const showHighlight = highlightFailures && tone === "danger";
        return (
          <div
            key={item.key}
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

function SteeringActivityRow({
  note,
  compact,
  copy,
  stepLink,
}: {
  note: SteeringNote;
  compact: boolean;
  copy: ReturnType<typeof getCopy>;
  stepLink: SteeringStepLink | null;
}) {
  const badgeTone = note.injected
    ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
    : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400";
  return (
    <div className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs">
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${note.injected ? "bg-green-500" : "bg-amber-500"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate font-medium text-gray-700 dark:text-gray-300">{copy.steeringLabel}</span>
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${badgeTone}`}>
            {note.injected ? copy.steeringInjected : copy.steeringPending}
          </span>
          {!compact && (
            <span className="shrink-0 text-[10px] text-gray-300 dark:text-gray-600 tabular-nums">
              {formatTime(note.createdAt)}
            </span>
          )}
        </div>
        <p className="mt-0.5 break-words text-gray-600 dark:text-gray-400">{note.content}</p>
        {note.injected && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-gray-400 dark:text-gray-500">
            <span>
              {copy.steeringReflectedAt}: {formatTime(note.injectedAt ?? note.createdAt)}
            </span>
            {stepLink ? (
              <button
                type="button"
                onClick={stepLink.onClick}
                className="truncate text-indigo-600 underline decoration-dotted underline-offset-2 hover:text-indigo-700 dark:text-indigo-400"
              >
                → {stepLink.taskTitle}
              </button>
            ) : note.injectedStep ? (
              <span className="truncate font-mono" title={note.injectedStep}>
                {copy.steeringStepUnresolved}: {note.injectedStep.slice(0, 8)}
              </span>
            ) : null}
          </div>
        )}
      </div>
      {compact && (
        <span className="shrink-0 text-[10px] text-gray-300 dark:text-gray-600 tabular-nums">
          {formatTime(note.createdAt)}
        </span>
      )}
    </div>
  );
}
