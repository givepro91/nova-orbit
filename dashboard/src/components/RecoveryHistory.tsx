import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  type RecoveryDecision,
  type RecoveryIncident,
  type RecoveryPhase,
} from "../lib/api";

const PHASE_LABEL_KEYS: Record<RecoveryPhase, string> = {
  implementation: "recoveryPhaseImplementation",
  verification: "recoveryPhaseVerification",
  fix: "recoveryPhaseFix",
  approval: "recoveryPhaseApproval",
};

const DECISION_LABEL_KEYS: Record<RecoveryDecision, string> = {
  resume: "recoveryDecisionResume",
  advance: "recoveryDecisionAdvance",
  wait_approval: "recoveryDecisionWaitApproval",
  blocked: "recoveryDecisionBlocked",
};

const DECISION_TONES: Record<RecoveryDecision, string> = {
  resume: "bg-info-subtle text-info",
  advance: "bg-success-subtle text-success",
  wait_approval: "bg-warning-subtle text-warning",
  blocked: "bg-danger-subtle text-danger",
};

interface RecoveryHistoryProps {
  goalId: string;
}

function formatIncidentDate(value: string, formatter: Intl.DateTimeFormat): string {
  const normalized = value.endsWith("Z") || value.includes("+") ? value : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : formatter.format(date);
}

export function RecoveryHistory({ goalId }: RecoveryHistoryProps) {
  const { t, i18n } = useTranslation();
  const [incidents, setIncidents] = useState<RecoveryIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      setLoading(true);
      api.recovery.incidents()
        .then(({ incidents: next }) => {
          if (cancelled) return;
          setIncidents(next.filter((incident) => incident.goal_id === goalId));
          setError(false);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    load();
    window.addEventListener("crewdeck:refresh", load);
    return () => {
      cancelled = true;
      window.removeEventListener("crewdeck:refresh", load);
    };
  }, [goalId]);

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "short",
      timeStyle: "short",
    }),
    [i18n.language],
  );

  return (
    <div className="mt-3 border-t border-line-soft pt-3" data-testid="recovery-history">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          {t("recoveryHistory")}
        </h4>
        {!loading && !error && incidents.length > 0 && (
          <span className="rounded-full bg-sunken px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted">
            {incidents.length}
          </span>
        )}
      </div>

      {loading && (
        <p className="mt-2 text-[11px] text-faint">{t("loading")}</p>
      )}

      {!loading && error && (
        <p className="mt-2 rounded border border-danger bg-danger-subtle px-2.5 py-2 text-[11px] text-danger">
          {t("recoveryHistoryLoadFailed")}
        </p>
      )}

      {!loading && !error && incidents.length === 0 && (
        <p className="mt-2 text-[11px] text-faint">{t("recoveryHistoryEmpty")}</p>
      )}

      {!loading && !error && incidents.length > 0 && (
        <ol className="mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {incidents.map((incident) => (
            <li
              key={incident.id}
              className={`rounded-md border px-2.5 py-2 ${
                incident.decision === "blocked"
                  ? "border-danger bg-danger-subtle"
                  : "border-line bg-sunken"
              }`}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-sunken px-1.5 py-0.5 text-[9px] font-medium text-muted">
                  {t(PHASE_LABEL_KEYS[incident.phase])}
                </span>
                <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${DECISION_TONES[incident.decision]}`}>
                  {t(DECISION_LABEL_KEYS[incident.decision])}
                </span>
                <time
                  dateTime={incident.created_at}
                  className="ml-auto text-[9px] tabular-nums text-faint"
                >
                  {formatIncidentDate(incident.created_at, dateFormatter)}
                </time>
              </div>
              <p className="mt-1 break-words text-[11px] leading-relaxed text-muted">
                {incident.reason}
              </p>
              {incident.user_action && (
                <div className="mt-1.5 flex min-w-0 items-start gap-1.5 rounded bg-warning-subtle px-2 py-1.5 text-[11px] text-warning">
                  <span className="shrink-0 font-semibold">{t("recoveryUserAction")}</span>
                  <span className="min-w-0 break-words">{incident.user_action}</span>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
