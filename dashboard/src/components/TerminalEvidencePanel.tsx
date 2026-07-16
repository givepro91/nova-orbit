import { CheckCircle, CircleNotch, Pulse, ShieldWarning, WarningCircle } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import type { TerminalActivity, TerminalReviewRequest } from "../../../shared/types";

interface TerminalEvidencePanelProps {
  activities: TerminalActivity[];
  review: TerminalReviewRequest | null;
}

const REVIEW_TONES: Record<TerminalReviewRequest["status"], string> = {
  pending: "border-review/30 bg-review-subtle text-review",
  running: "border-accent/30 bg-accent/10 text-accent",
  passed: "border-success/30 bg-success/10 text-success",
  fix_required: "border-danger/30 bg-danger/10 text-danger",
  conditional: "border-warning/30 bg-warning-subtle text-warning",
  error: "border-danger/30 bg-danger/10 text-danger",
  timeout: "border-warning/30 bg-warning-subtle text-warning",
};

function reviewIcon(status: TerminalReviewRequest["status"]) {
  if (status === "passed") return <CheckCircle size={14} weight="fill" />;
  if (status === "running") return <CircleNotch size={14} className="animate-spin" />;
  if (status === "fix_required" || status === "error") return <WarningCircle size={14} weight="fill" />;
  return <ShieldWarning size={14} />;
}

function timeLabel(createdAt: string): string {
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return createdAt;
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function TerminalEvidencePanel({ activities, review }: TerminalEvidencePanelProps) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="terminal-evidence-heading">
      <div className="mb-2 flex items-center justify-between">
        <h2 id="terminal-evidence-heading" className="flex items-center gap-1.5 text-[10px] font-semibold text-muted">
          <Pulse size={14} />{t("workspaceExecutionEvidence")}
        </h2>
        <span className="font-mono text-[9px] text-faint">{activities.length}</span>
      </div>

      {review && (
        <div className={`mb-2 rounded-md border px-2.5 py-2 ${REVIEW_TONES[review.status]}`} role="status">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold">
            {reviewIcon(review.status)}
            <span>{t(`workspaceReviewStatus_${review.status}`)}</span>
            <span className="ml-auto font-mono text-[8px] opacity-70">#{review.attempt}</span>
          </div>
          <p className="mt-1 text-[9px] leading-4 opacity-80">{review.errorMessage ?? review.evidence.summary}</p>
        </div>
      )}

      <div className="space-y-1.5">
        {activities.slice(0, 8).map((activity) => (
          <article key={activity.id} className="rounded-md border border-line-soft bg-surface px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[8px] uppercase tracking-wide text-faint">
              <span>{t(`workspaceActivityKind_${activity.kind}`)}</span>
              <time className="ml-auto font-mono normal-case" dateTime={activity.createdAt}>{timeLabel(activity.createdAt)}</time>
            </div>
            <p className="mt-1 text-[10px] leading-4 text-muted">{activity.summary}</p>
          </article>
        ))}
        {activities.length === 0 && (
          <p className="rounded-md border border-dashed border-line-soft px-3 py-3 text-center text-[9px] leading-4 text-faint">
            {t("workspaceNoExecutionEvidence")}
          </p>
        )}
      </div>
    </section>
  );
}
