import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { GoalSpecLegacyContent, GoalSpecVersionSnapshot, SpecFields } from "../../../shared/types";
import { ApiError, api } from "../lib/api";
import type { GoalSpecState } from "../lib/api";
import { useGoalSpecStore } from "../stores/goalSpecs";
import { ConfirmDialog } from "./ConfirmDialog";

interface GoalSpecPanelProps {
  goalId: string;
  goalTitle?: string;
  onClose: () => void;
  onGeneratingClose?: () => void;
}

const emptyDraft = (): SpecFields => ({
  scope: "",
  out_of_scope: "",
  acceptance_criteria: [""],
  expected_tasks: [""],
  verification_methods: [""],
});

function toDraft(version: GoalSpecVersionSnapshot | undefined): SpecFields {
  if (!version) return emptyDraft();
  return {
    scope: version.scope,
    out_of_scope: version.out_of_scope,
    acceptance_criteria: [...version.acceptance_criteria],
    expected_tasks: [...version.expected_tasks],
    verification_methods: [...version.verification_methods],
  };
}

function TextListEditor({
  field,
  label,
  values,
  disabled,
  error,
  onChange,
}: {
  field: keyof SpecFields;
  label: string;
  values: string[];
  disabled: boolean;
  error?: string;
  onChange: (values: string[]) => void;
}) {
  const errorId = error ? `spec-${field.replaceAll("_", "-")}-error` : undefined;
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-2 text-xs font-semibold text-muted">{label}</legend>
      {values.map((value, index) => (
        <div className="flex items-start gap-2" key={index}>
          <textarea
            aria-label={`${label} ${index + 1}`}
            aria-invalid={error ? true : undefined}
            aria-describedby={errorId}
            rows={2}
            value={value}
            onChange={(event) => {
              const next = [...values];
              next[index] = event.target.value;
              onChange(next);
            }}
            className="min-w-0 flex-1 resize-y rounded-lg border border-line bg-sunken px-3 py-2 text-sm text-muted outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-sunken disabled:text-muted"
          />
          {!disabled && values.length > 1 && (
            <button
              type="button"
              aria-label={`${label} ${index + 1} remove`}
              onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
              className="rounded p-2 text-faint hover:bg-danger-subtle hover:text-danger focus:outline-none focus:ring-2 focus:ring-danger"
            >
              ×
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <button
          type="button"
          onClick={() => onChange([...values, ""])}
          className="rounded px-2 py-1 text-xs text-accent hover:bg-accent/10 focus:outline-none focus:ring-2 focus:ring-accent"
        >
          + {label}
        </button>
      )}
      {error && <p id={errorId} role="alert" className="text-xs font-normal text-danger">{error}</p>}
    </fieldset>
  );
}

export function GoalSpecFieldError({
  field,
  location,
  message,
}: {
  field: keyof SpecFields;
  location: keyof SpecFields | null;
  message: string | null;
}) {
  if (field !== location || !message) return null;
  return <p id={`spec-${field.replaceAll("_", "-")}-error`} role="alert" className="mt-1 text-xs font-normal text-danger">{message}</p>;
}

const specFieldLocations = new Set<keyof SpecFields>([
  "scope",
  "out_of_scope",
  "acceptance_criteria",
  "expected_tasks",
  "verification_methods",
]);

function getSpecErrorLocation(error: unknown): keyof SpecFields | null {
  if (!(error instanceof ApiError) || !specFieldLocations.has(error.location as keyof SpecFields)) return null;
  return error.location as keyof SpecFields;
}

export function GoalSpecEmptyState({ title, hint, createLabel, generateLabel, error, disabled, onCreate, onGenerate }: {
  title: string;
  hint: string;
  createLabel: string;
  generateLabel: string;
  error: string | null;
  disabled: boolean;
  onCreate: () => void;
  onGenerate: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm font-medium text-muted">{title}</p>
      <p className="max-w-md text-xs text-muted">{hint}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <button type="button" onClick={onCreate} className="rounded-lg border border-accent px-4 py-2 text-xs font-medium text-accent hover:bg-accent/10 focus:outline-none focus:ring-2 focus:ring-accent">{createLabel}</button>
        <button type="button" onClick={onGenerate} disabled={disabled} className="rounded-lg bg-accent px-4 py-2 text-xs font-medium text-on-accent hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50">{generateLabel}</button>
      </div>
      {error && <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** 두 스냅샷의 단일 텍스트 필드를 나란히(모바일은 세로) 비교 — 다르면 강조한다. */
function CompareTextField({ label, baseValue, targetValue, baseHeading, targetHeading, changedLabel }: {
  label: string;
  baseValue: string;
  targetValue: string;
  baseHeading: string;
  targetHeading: string;
  changedLabel: string;
}) {
  const changed = baseValue.trim() !== targetValue.trim();
  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-muted">
        {label}
        {changed && <span className="ml-2 rounded-full bg-warning-subtle px-1.5 py-0.5 text-[10px] font-medium text-warning">{changedLabel}</span>}
      </p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <div className={`rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap ${changed ? "border-danger bg-danger-subtle text-danger" : "border-line bg-sunken text-muted"}`}>
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide opacity-60">{baseHeading}</span>
          {baseValue.trim() || "—"}
        </div>
        <div className={`rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap ${changed ? "border-success bg-success-subtle text-success" : "border-line bg-sunken text-muted"}`}>
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide opacity-60">{targetHeading}</span>
          {targetValue.trim() || "—"}
        </div>
      </div>
    </div>
  );
}

/** 문자열 목록의 추가·삭제·유지 차이를 통합 diff로 표시한다. */
function CompareListField({ label, baseValues, targetValues, changedLabel, unchangedLabel }: {
  label: string;
  baseValues: string[];
  targetValues: string[];
  changedLabel: string;
  unchangedLabel: string;
}) {
  const clean = (values: string[]) => values.map((value) => value.trim()).filter(Boolean);
  const base = clean(baseValues);
  const target = clean(targetValues);
  const baseSet = new Set(base);
  const targetSet = new Set(target);
  const unchanged = base.filter((value) => targetSet.has(value));
  const removed = base.filter((value) => !targetSet.has(value));
  const added = target.filter((value) => !baseSet.has(value));
  const hasDiff = removed.length > 0 || added.length > 0;
  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-muted">
        {label}
        <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${hasDiff ? "bg-warning-subtle text-warning" : "bg-sunken text-muted"}`}>
          {hasDiff ? changedLabel : unchangedLabel}
        </span>
      </p>
      <ul className="space-y-1 text-sm">
        {unchanged.map((value, index) => (
          <li key={`unchanged-${index}`} className="rounded-md bg-sunken px-3 py-1.5 text-muted">{value}</li>
        ))}
        {removed.map((value, index) => (
          <li key={`removed-${index}`} className="rounded-md bg-danger-subtle px-3 py-1.5 text-danger line-through">− {value}</li>
        ))}
        {added.map((value, index) => (
          <li key={`added-${index}`} className="rounded-md bg-success-subtle px-3 py-1.5 text-success">+ {value}</li>
        ))}
      </ul>
    </div>
  );
}

/** 버전 비교 뷰 — 기준/비교 버전을 keyboard로 선택하고 구조화 필드 diff를 본다. */
function VersionCompareView({ versions, baseId, targetId, onBaseChange, onTargetChange, onExit, t }: {
  versions: GoalSpecVersionSnapshot[];
  baseId: string | null;
  targetId: string | null;
  onBaseChange: (id: string) => void;
  onTargetChange: (id: string) => void;
  onExit: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const base = versions.find((version) => version.id === baseId);
  const target = versions.find((version) => version.id === targetId);
  const baseHeading = base ? t("specVersion", { version: base.version }) : "—";
  const targetHeading = target ? t("specVersion", { version: target.version }) : "—";
  const changedLabel = t("specCompareChanged");
  const unchangedLabel = t("specCompareUnchanged");
  return (
    <div className="space-y-5" data-testid="spec-compare-view">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold text-muted">
          {t("specCompareBase")}
          <select
            aria-label={t("specCompareBase")}
            value={baseId ?? ""}
            onChange={(event) => onBaseChange(event.target.value)}
            className="mt-1 block rounded-lg border border-line bg-sunken px-2 py-1.5 text-xs text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>{t("specVersion", { version: version.version })} · {version.state === "approved" ? t("specApproved") : t("specDraft")}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold text-muted">
          {t("specCompareTarget")}
          <select
            aria-label={t("specCompareTarget")}
            value={targetId ?? ""}
            onChange={(event) => onTargetChange(event.target.value)}
            className="mt-1 block rounded-lg border border-line bg-sunken px-2 py-1.5 text-xs text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>{t("specVersion", { version: version.version })} · {version.state === "approved" ? t("specApproved") : t("specDraft")}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={onExit} className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted hover:bg-fg/5 focus:outline-none focus:ring-2 focus:ring-accent">
          {t("specCompareExit")}
        </button>
      </div>
      {!base || !target ? (
        <p className="text-sm text-muted">{t("specCompareNeedsTwo")}</p>
      ) : (
        <div className="space-y-5">
          <CompareTextField label={t("specScope")} baseValue={base.scope} targetValue={target.scope} baseHeading={baseHeading} targetHeading={targetHeading} changedLabel={changedLabel} />
          <CompareTextField label={t("specOutOfScope")} baseValue={base.out_of_scope} targetValue={target.out_of_scope} baseHeading={baseHeading} targetHeading={targetHeading} changedLabel={changedLabel} />
          <CompareListField label={t("specAcceptanceCriteria")} baseValues={base.acceptance_criteria} targetValues={target.acceptance_criteria} changedLabel={changedLabel} unchangedLabel={unchangedLabel} />
          <CompareListField label={t("specExpectedTasks")} baseValues={base.expected_tasks} targetValues={target.expected_tasks} changedLabel={changedLabel} unchangedLabel={unchangedLabel} />
          <CompareListField label={t("specVerificationMethods")} baseValues={base.verification_methods} targetValues={target.verification_methods} changedLabel={changedLabel} unchangedLabel={unchangedLabel} />
        </div>
      )}
    </div>
  );
}

/**
 * 사람이 읽는 문서 뷰 — flat 5필드를 폼이 아니라 한 장짜리 기획 문서로 렌더한다.
 * "이 기획이 무엇인지 누구에게나 설명할 수 있는" 읽기 밀도가 목표(표현 계층만, 생성 로직 불변).
 */
function SpecDocumentView({ title, fields, t }: {
  title?: string;
  fields: SpecFields;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const clean = (values: string[]) => values.map((value) => value.trim()).filter(Boolean);
  const acceptance = clean(fields.acceptance_criteria);
  const tasks = clean(fields.expected_tasks);
  const verification = clean(fields.verification_methods);
  const scope = fields.scope.trim();
  const outOfScope = fields.out_of_scope.trim();

  const Section = ({ label, children }: { label: string; children: ReactNode }) => (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</h3>
      {children}
    </section>
  );

  return (
    <article className="mx-auto max-w-2xl space-y-6">
      {title && (
        <header className="space-y-1 border-b border-line-soft pb-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-accent">{t("specHeaderTitle")}</p>
          <h2 className="text-lg font-semibold leading-snug text-fg">{title}</h2>
        </header>
      )}

      <Section label={t("specScope")}>
        {scope
          ? <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{scope}</p>
          : <p className="text-sm italic text-faint">—</p>}
      </Section>

      {outOfScope && (
        <Section label={t("specOutOfScope")}>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{outOfScope}</p>
        </Section>
      )}

      <Section label={t("specAcceptanceCriteria")}>
        {acceptance.length > 0 ? (
          <ul className="space-y-1.5">
            {acceptance.map((item, index) => (
              <li key={index} className="flex gap-2 text-sm leading-relaxed text-muted">
                <span aria-hidden="true" className="mt-0.5 shrink-0 text-success">✓</span>
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm italic text-faint">—</p>}
      </Section>

      <Section label={t("specExpectedTasks")}>
        {tasks.length > 0 ? (
          <ol className="space-y-1.5">
            {tasks.map((item, index) => (
              <li key={index} className="flex gap-2 text-sm leading-relaxed text-muted">
                <span aria-hidden="true" className="mt-0.5 w-4 shrink-0 text-right tabular-nums text-faint">{index + 1}.</span>
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ol>
        ) : <p className="text-sm italic text-faint">—</p>}
      </Section>

      <Section label={t("specVerificationMethods")}>
        {verification.length > 0 ? (
          <ul className="space-y-1.5">
            {verification.map((item, index) => (
              <li key={index} className="flex gap-2 text-sm leading-relaxed text-muted">
                <span aria-hidden="true" className="mt-0.5 shrink-0 text-faint">•</span>
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm italic text-faint">—</p>}
      </Section>
    </article>
  );
}

/**
 * 구 형식(legacy goal_specs) PRD 를 읽기 전용으로 렌더. versioned workflow 이전에
 * 완료된 goal 은 실체가 legacy 테이블에만 있어 새 5필드 뷰로 표현되지 않는다.
 * 모든 섹션은 값이 있을 때만 표시하고, 배열/필드는 방어적으로 접근한다.
 */
function LegacySpecView({ title, spec, t }: {
  title?: string;
  spec: GoalSpecLegacyContent;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const prd = spec.prd_summary ?? {};
  const successMetrics = (prd.success_metrics ?? []).map((value) => value.trim()).filter(Boolean);
  const features = (spec.feature_specs ?? []).filter((feature) => feature && (feature.name || feature.description));
  const flow = (spec.user_flow ?? []).filter((step) => step && (step.action || step.expected));
  const acceptance = (spec.acceptance_criteria ?? []).map((value) => value.trim()).filter(Boolean);
  const tech = (spec.tech_considerations ?? []).map((value) => value.trim()).filter(Boolean);

  const Section = ({ label, children }: { label: string; children: ReactNode }) => (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</h3>
      {children}
    </section>
  );
  const Para = ({ text, muted }: { text: string; muted?: boolean }) => (
    <p className={`whitespace-pre-wrap text-sm leading-relaxed ${muted ? "text-muted" : "text-muted"}`}>{text}</p>
  );

  return (
    <article className="mx-auto max-w-2xl space-y-6">
      {title && (
        <header className="space-y-1 border-b border-line-soft pb-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-accent">{t("specHeaderTitle")}</p>
          <h2 className="text-lg font-semibold leading-snug text-fg">{title}</h2>
        </header>
      )}

      <p className="rounded-lg bg-sunken px-3 py-2 text-xs text-muted">{t("specLegacyNotice")}</p>

      {prd.background && <Section label={t("specBackground")}><Para text={prd.background} /></Section>}
      {prd.objective && <Section label={t("specObjective")}><Para text={prd.objective} /></Section>}
      {prd.scope && <Section label={t("specScope")}><Para text={prd.scope} /></Section>}

      {successMetrics.length > 0 && (
        <Section label={t("specSuccessMetrics")}>
          <ul className="space-y-1.5">
            {successMetrics.map((item, index) => (
              <li key={index} className="flex gap-2 text-sm leading-relaxed text-muted">
                <span aria-hidden="true" className="mt-0.5 shrink-0 text-accent">◆</span>
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {features.length > 0 && (
        <Section label={t("specFeatures")}>
          <div className="space-y-3">
            {features.map((feature, index) => (
              <div key={index} className="rounded-lg border border-line-soft p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-fg">{feature.name || "—"}</span>
                  {feature.priority && (
                    <span className="rounded-full bg-sunken px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{feature.priority}</span>
                  )}
                </div>
                {feature.description && <p className="mt-1 text-xs leading-relaxed text-muted">{feature.description}</p>}
                {(feature.requirements ?? []).filter(Boolean).length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {(feature.requirements ?? []).filter(Boolean).map((requirement, ri) => (
                      <li key={ri} className="flex gap-2 text-xs leading-relaxed text-muted">
                        <span aria-hidden="true" className="mt-0.5 shrink-0 text-faint">·</span>
                        <span className="min-w-0">{requirement}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {flow.length > 0 && (
        <Section label={t("specUserFlow")}>
          <ol className="space-y-2">
            {flow.map((step, index) => (
              <li key={index} className="flex gap-2 text-sm leading-relaxed text-muted">
                <span aria-hidden="true" className="mt-0.5 w-4 shrink-0 text-right tabular-nums text-faint">{step.step ?? index + 1}.</span>
                <span className="min-w-0">
                  {step.action}
                  {step.expected && <span className="mt-0.5 block text-xs text-muted">→ {step.expected}</span>}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {acceptance.length > 0 && (
        <Section label={t("specAcceptanceCriteria")}>
          <ul className="space-y-1.5">
            {acceptance.map((item, index) => (
              <li key={index} className="flex gap-2 text-sm leading-relaxed text-muted">
                <span aria-hidden="true" className="mt-0.5 shrink-0 text-success">✓</span>
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {tech.length > 0 && (
        <Section label={t("specTechConsiderations")}>
          <ul className="space-y-1.5">
            {tech.map((item, index) => (
              <li key={index} className="flex gap-2 text-sm leading-relaxed text-muted">
                <span aria-hidden="true" className="mt-0.5 shrink-0 text-faint">•</span>
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </article>
  );
}

export default function GoalSpecPanel({ goalId, goalTitle, onClose, onGeneratingClose }: GoalSpecPanelProps) {
  const { t } = useTranslation();
  const state = useGoalSpecStore((store) => store.byGoalId[goalId] ?? null);
  const loading = useGoalSpecStore((store) =>
    store.loadingByGoalId[goalId] ?? store.byGoalId[goalId] === undefined,
  );
  const saving = useGoalSpecStore((store) => store.savingByGoalId[goalId] ?? false);
  const approving = useGoalSpecStore((store) => store.approvingByGoalId[goalId] ?? false);
  const fetchGoalSpec = useGoalSpecStore((store) => store.fetchGoalSpec);
  const saveGoalSpec = useGoalSpecStore((store) => store.saveGoalSpec);
  const approveGoalSpec = useGoalSpecStore((store) => store.approveGoalSpec);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [draft, setDraft] = useState<SpecFields>(emptyDraft);
  const [generating, setGenerating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorLocation, setErrorLocation] = useState<keyof SpecFields | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [compareBaseId, setCompareBaseId] = useState<string | null>(null);
  const [compareTargetId, setCompareTargetId] = useState<string | null>(null);
  // 문서 보기(read) ↔ 편집(edit). 열거나 버전을 고르면 읽기 문서가 기본, 편집은 명시적으로.
  const [mode, setMode] = useState<"read" | "edit">("read");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

  const latestVersion = state?.versions.at(-1);
  const selectedVersion = useMemo(
    () => creatingNew ? undefined : state?.versions.find((version) => version.id === selectedVersionId) ?? latestVersion,
    [creatingNew, latestVersion, selectedVersionId, state?.versions],
  );
  const readOnly = selectedVersion?.state === "approved";
  const busy = saving || approving || generating;

  const applyState = useCallback((next: GoalSpecState) => {
    const latest = next.versions.at(-1);
    setSelectedVersionId(latest?.id ?? null);
    setCreatingNew(false);
    setCompareMode(false);
    setDraft(toDraft(latest));
    setDirty(false);
    setErrorLocation(null);
    setMode("read");
  }, []);

  const stopPolling = useCallback(() => {
    if (!pollRef.current) return;
    clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const generation = await api.goals.getSpecGenerationState(goalId);
        if (generation.generation_status === "generating") return;
        stopPolling();
        const next = await fetchGoalSpec(goalId);
        if (generation.generation_status === "idle" && next.versions.length === 0) {
          setGenerating(false);
          setError("Spec generation completed without a snapshot");
          setErrorLocation(null);
        } else {
          applyState(next);
          setGenerating(false);
          setError(generation.generation_status === "failed" ? generation.generation_error : null);
        }
      } catch (pollError) {
        stopPolling();
        setGenerating(false);
        setError(pollError instanceof Error ? pollError.message : t("specGenerateFailed"));
        setErrorLocation(null);
      }
    }, 3000);
  }, [applyState, fetchGoalSpec, goalId, stopPolling, t]);

  const loadSpec = useCallback(async () => {
    try {
      const [next, generation] = await Promise.all([
        fetchGoalSpec(goalId),
        api.goals.getSpecGenerationState(goalId),
      ]);
      applyState(next);
      setGenerating(generation.generation_status === "generating");
      setError(generation.generation_status === "failed" ? generation.generation_error : null);
      if (generation.generation_status === "generating") startPolling();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load blueprint");
      setErrorLocation(null);
    }
  }, [applyState, fetchGoalSpec, goalId, startPolling]);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => void loadSpec(), 0);
    return () => {
      window.clearTimeout(loadTimer);
      stopPolling();
    };
  }, [loadSpec, stopPolling]);

  useEffect(() => {
    if (!busy) return;
    const preventUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [busy]);

  const selectVersion = (version: GoalSpecVersionSnapshot) => {
    setCreatingNew(false);
    setCompareMode(false);
    setSelectedVersionId(version.id);
    setDraft(toDraft(version));
    setDirty(false);
    setError(null);
    setErrorLocation(null);
    setMode("read");
  };

  const enterCompare = () => {
    const versions = state?.versions ?? [];
    if (versions.length < 2) return;
    const latest = versions.at(-1);
    const previous = versions[versions.length - 2];
    setCompareBaseId(previous?.id ?? null);
    setCompareTargetId(latest?.id ?? null);
    setCompareMode(true);
    setError(null);
    setErrorLocation(null);
  };

  const updateDraft = (next: SpecFields) => {
    setDraft(next);
    setDirty(true);
    setError(null);
    setErrorLocation(null);
  };

  const showRequestError = (requestError: unknown, fallback: string) => {
    const location = getSpecErrorLocation(requestError);
    setError(requestError instanceof Error ? requestError.message : fallback);
    setErrorLocation(location);
    // 필드 단위 오류는 편집 폼에서만 강조되므로, 문서 보기 중이면 편집 모드로 전환해 사용자가 고칠 수 있게 한다.
    if (location) setMode("edit");
  };

  const saveDraft = async () => {
    setError(null);
    setErrorLocation(null);
    try {
      applyState(await saveGoalSpec(goalId, draft));
    } catch (saveError) {
      showRequestError(saveError, "Failed to save blueprint");
    }
  };

  const approveDraft = async () => {
    if (!selectedVersion || selectedVersion.state !== "draft") return;
    setError(null);
    setErrorLocation(null);
    try {
      applyState(await approveGoalSpec(goalId, selectedVersion.id));
      window.setTimeout(() => dialogRef.current?.focus(), 0);
    } catch (approveError) {
      showRequestError(approveError, "Failed to approve blueprint");
    }
  };

  const generate = async () => {
    setGenerating(true);
    setError(null);
    setErrorLocation(null);
    try {
      await api.goals.generateSpec(goalId);
      startPolling();
    } catch (generateError) {
      setGenerating(false);
      setError(generateError instanceof Error ? generateError.message : t("specGenerateFailed"));
      setErrorLocation(null);
    }
  };

  const close = () => {
    if (busy) setConfirmClose(true);
    else onClose();
  };

  const startNewDraft = () => {
    setCreatingNew(true);
    setCompareMode(false);
    setSelectedVersionId(null);
    setDraft(toDraft(selectedVersion ?? latestVersion));
    setDirty(true);
    setError(null);
    setErrorLocation(null);
    setMode("edit");
  };

  // 모달 접근성 — 열릴 때 첫 의미 있는 컨트롤로 포커스 이동, Tab 순환, Escape 닫기.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const focusable = node.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? node).focus();
  }, []);

  const onDialogKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const node = dialogRef.current;
    if (!node) return;
    const focusables = Array.from(
      node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey) {
      if (active === first || !node.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !node.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm sm:p-6" onClick={close}>
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="goal-spec-title"
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        className="flex h-[min(760px,92vh)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <h2 id="goal-spec-title" className="truncate text-sm font-semibold text-fg">{t("specHeaderTitle")}</h2>
            <p className="text-xs text-muted">
              {selectedVersion
                ? `${t("specVersion", { version: selectedVersion.version })} · ${selectedVersion.state}`
                : state?.legacy_spec ? t("specLegacyBadge") : t("specEmpty")}
              {selectedVersion && state && selectedVersion.id === state.execution_spec_version_id && (
                <span className="ml-1 font-medium text-success"> · {t("specExecutionPin")}</span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {generating && <span className="text-xs text-warning">{t("specGenerating")}</span>}
            {state && state.status !== "missing" && !creatingNew && !compareMode && !generating && !readOnly && (
              <button type="button" onClick={() => setMode(mode === "read" ? "edit" : "read")} className="rounded-lg bg-sunken px-3 py-1.5 text-xs text-muted hover:bg-fg/10 focus:outline-none focus:ring-2 focus:ring-accent">
                {mode === "read" ? t("specEdit") : t("specDocView")}
              </button>
            )}
            {state && state.versions.length >= 2 && !compareMode && (
              <button type="button" onClick={enterCompare} className="rounded-lg bg-sunken px-3 py-1.5 text-xs text-muted hover:bg-fg/10 focus:outline-none focus:ring-2 focus:ring-accent">
                {t("specCompareEnter")}
              </button>
            )}
            <button type="button" onClick={generate} disabled={busy} className="rounded-lg bg-accent/10 px-3 py-1.5 text-xs text-accent hover:bg-accent/20 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50">
              {state?.versions.length ? t("specRegenerate") : t("specGenerate")}
            </button>
            <button type="button" onClick={close} aria-label="Close" className="rounded-lg p-1.5 text-faint hover:bg-fg/5 focus:outline-none focus:ring-2 focus:ring-accent">×</button>
          </div>
        </header>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">Loading...</div>
        ) : !state ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p role="alert" className="text-sm text-danger">{error ?? "Failed to load blueprint"}</p>
            <button type="button" onClick={() => void loadSpec()} className="rounded-lg bg-accent px-4 py-2 text-xs font-medium text-on-accent hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent">Retry</button>
          </div>
        ) : (
          <div data-spec-status={state.status} className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[190px_minmax(0,1fr)]">
            <nav aria-label="Blueprint versions" className="overflow-y-auto border-b border-line bg-sunken p-3 md:border-b-0 md:border-r">
              <button
                type="button"
                onClick={startNewDraft}
                className="mb-3 w-full rounded-lg border border-dashed border-accent px-3 py-2 text-left text-xs text-accent hover:bg-accent/10 focus:outline-none focus:ring-2 focus:ring-accent"
              >
                + {t("specCreateDraft")}
              </button>
              <div className="flex gap-2 overflow-x-auto md:flex-col md:overflow-visible">
                {[...(state?.versions ?? [])].reverse().map((version) => (
                  <button
                    type="button"
                    key={version.id}
                    onClick={() => selectVersion(version)}
                    className={`min-w-32 rounded-lg px-3 py-2 text-left text-xs focus:outline-none focus:ring-2 focus:ring-accent md:min-w-0 ${selectedVersion?.id === version.id ? "bg-accent/10 text-accent" : "text-muted hover:bg-fg/5"}`}
                  >
                    <span className="block font-medium">{t("specVersion", { version: version.version })}</span>
                    <span className="text-[10px] opacity-70">{version.state === "approved" ? t("specApproved") : t("specDraft")}</span>
                    {state && version.id === state.execution_spec_version_id && (
                      <span
                        className="mt-1 block rounded-full bg-success-subtle px-1.5 py-0.5 text-[9px] font-medium text-success"
                        title={t("specExecutionPinHint")}
                      >
                        {t("specExecutionPin")}
                        <span className="sr-only"> — {t("specExecutionPinHint")}</span>
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </nav>

            <main className="min-w-0 overflow-y-auto p-4 sm:p-6">
              {compareMode && state.versions.length >= 2 ? (
                <VersionCompareView
                  versions={state.versions}
                  baseId={compareBaseId}
                  targetId={compareTargetId}
                  onBaseChange={setCompareBaseId}
                  onTargetChange={setCompareTargetId}
                  onExit={() => setCompareMode(false)}
                  t={t}
                />
              ) : generating && !state?.versions.length ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                  <span className="text-3xl">🧠</span>
                  <p className="text-sm font-medium text-muted">{t("specGenerating")}</p>
                  <p className="max-w-md text-xs text-muted">{t("specGeneratingHint")}</p>
                </div>
              ) : state.status === "missing" && state.legacy_spec && !creatingNew ? (
                <LegacySpecView title={goalTitle} spec={state.legacy_spec} t={t} />
              ) : state.status === "missing" && !creatingNew ? (
                <GoalSpecEmptyState title={t("specEmpty")} hint={t("specEmptyHint")} createLabel={t("specCreateDraft")} generateLabel={t("specGenerate")} error={error} disabled={busy} onCreate={startNewDraft} onGenerate={generate} />
              ) : (
                <div className="space-y-5">
                  {/* 승인 게이트 배너 — 미승인 최신 draft면 크게: 실행이 막혀 있다는 사실 + 승인 CTA */}
                  {!creatingNew && selectedVersion?.state === "draft" && selectedVersion.id === latestVersion?.id && (
                    <div className="rounded-lg border border-warning bg-warning-subtle px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="min-w-0 text-xs font-medium text-warning">
                          {state.status === "changes_pending" ? t("specChangesPending") : t("specApproveGate")}
                        </p>
                        {!dirty ? (
                          <button type="button" onClick={approveDraft} disabled={approving} className="shrink-0 rounded-lg bg-success px-4 py-1.5 text-xs font-medium text-white hover:bg-success/90 focus:outline-none focus:ring-2 focus:ring-success disabled:opacity-50">
                            {approving ? "..." : t("specApproveNow")}
                          </button>
                        ) : (
                          <span className="shrink-0 text-xs text-warning">{t("specSaveBeforeApprove")}</span>
                        )}
                      </div>
                    </div>
                  )}
                  {readOnly && <p className="rounded-lg bg-success-subtle px-3 py-2 text-xs text-success">{t("specApprovedReadOnly")}</p>}
                  {mode === "read" && !creatingNew ? (
                    <SpecDocumentView title={goalTitle} fields={draft} t={t} />
                  ) : (
                    <>
                      <label className="block text-xs font-semibold text-muted">
                        {t("specScope")}
                        <textarea rows={4} disabled={readOnly} value={draft.scope} aria-invalid={errorLocation === "scope" ? true : undefined} aria-describedby={errorLocation === "scope" ? "spec-scope-error" : undefined} onChange={(event) => updateDraft({ ...draft, scope: event.target.value })} className="mt-2 w-full resize-y rounded-lg border border-line bg-sunken px-3 py-2 text-sm font-normal text-muted outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-sunken disabled:text-muted" />
                        <GoalSpecFieldError field="scope" location={errorLocation} message={error} />
                      </label>
                      <label className="block text-xs font-semibold text-muted">
                        {t("specOutOfScope")}
                        <textarea rows={3} disabled={readOnly} value={draft.out_of_scope} aria-invalid={errorLocation === "out_of_scope" ? true : undefined} aria-describedby={errorLocation === "out_of_scope" ? "spec-out-of-scope-error" : undefined} onChange={(event) => updateDraft({ ...draft, out_of_scope: event.target.value })} className="mt-2 w-full resize-y rounded-lg border border-line bg-sunken px-3 py-2 text-sm font-normal text-muted outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-sunken disabled:text-muted" />
                        <GoalSpecFieldError field="out_of_scope" location={errorLocation} message={error} />
                      </label>
                      <TextListEditor field="acceptance_criteria" label={t("specAcceptanceCriteria")} values={draft.acceptance_criteria} disabled={readOnly} error={errorLocation === "acceptance_criteria" ? error ?? undefined : undefined} onChange={(values) => updateDraft({ ...draft, acceptance_criteria: values })} />
                      <TextListEditor field="expected_tasks" label={t("specExpectedTasks")} values={draft.expected_tasks} disabled={readOnly} error={errorLocation === "expected_tasks" ? error ?? undefined : undefined} onChange={(values) => updateDraft({ ...draft, expected_tasks: values })} />
                      <TextListEditor field="verification_methods" label={t("specVerificationMethods")} values={draft.verification_methods} disabled={readOnly} error={errorLocation === "verification_methods" ? error ?? undefined : undefined} onChange={(values) => updateDraft({ ...draft, verification_methods: values })} />
                    </>
                  )}
                  {error && !errorLocation && <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>}
                </div>
              )}
            </main>
          </div>
        )}

        {!loading && !generating && !compareMode && (
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-6">
            <span className="text-xs text-muted">{dirty ? t("specUnsaved") : state?.status === "changes_pending" ? t("specChangesPending") : ""}</span>
            <div className="flex gap-2">
              {!readOnly && (
                <button type="button" onClick={saveDraft} disabled={saving || !dirty} className="rounded-lg bg-accent px-4 py-2 text-xs font-medium text-on-accent hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50">
                  {saving ? "..." : t("specSave")}
                </button>
              )}
              {selectedVersion?.state === "draft" && !dirty && (
                <button type="button" onClick={approveDraft} disabled={approving} className="rounded-lg bg-success px-4 py-2 text-xs font-medium text-white hover:bg-success/90 focus:outline-none focus:ring-2 focus:ring-success disabled:opacity-50">
                  {approving ? "..." : t("specApprove")}
                </button>
              )}
            </div>
          </footer>
        )}
      </section>

      {confirmClose && (
        <ConfirmDialog
          message={t("specCloseWhileBusy")}
          onConfirm={() => { onGeneratingClose?.(); onClose(); }}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </div>
  );
}
