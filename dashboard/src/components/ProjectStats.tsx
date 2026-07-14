import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

interface VerificationStats {
  total: number;
  passed: number;
  conditional: number;
  failed: number;
  passRate: number | null;
  avgRetries: number | null;
}

interface Task {
  status: string;
  verification_id?: string | null;
}

interface ProjectStatsProps {
  tasks: Task[];
  projectId?: string;
}

export function ProjectStats({ tasks, projectId }: ProjectStatsProps) {
  const { t } = useTranslation();
  // baseCost: loaded from REST API (historical sessions)
  const [baseCostUsd, setBaseCostUsd] = useState(0);
  const [baseTokens, setBaseTokens] = useState(0);
  // 이 프로젝트 누적 비용 중 토큰 역산 추정치(codex)의 합. >0이면 총액을 ≈로 표기한다.
  const [baseEstimatedCost, setBaseEstimatedCost] = useState(0);
  // deltaCost: accumulated from live WebSocket usage events
  const [deltaCostUsd, setDeltaCostUsd] = useState(0);
  const [deltaTokens, setDeltaTokens] = useState(0);
  const [verifStats, setVerifStats] = useState<VerificationStats | null>(null);

  // Track which project's base cost is already loaded to avoid double-counting
  const loadedProjectRef = useRef<string | null>(null);

  // Load historical cost from REST API when project changes
  useEffect(() => {
    if (!projectId) return;
    setDeltaCostUsd(0);
    setDeltaTokens(0);
    setBaseCostUsd(0);
    setBaseTokens(0);
    setBaseEstimatedCost(0);
    setVerifStats(null);
    loadedProjectRef.current = projectId;

    api.projects.getCost(projectId).then((data) => {
      if (loadedProjectRef.current !== projectId) return;
      const totalCost = data.costs.reduce((sum, c) => sum + (c.totalCost ?? 0), 0);
      const totalTok = data.costs.reduce((sum, c) => sum + (c.totalTokens ?? 0), 0);
      const estimated = data.costs.reduce((sum, c) => sum + (c.estimatedCost ?? 0), 0);
      setBaseCostUsd(totalCost);
      setBaseTokens(totalTok);
      setBaseEstimatedCost(estimated);
    }).catch(() => {
      // Non-fatal — REST cost unavailable, delta from WS still works
    });

    api.verifications.stats(projectId).then((data) => {
      if (loadedProjectRef.current !== projectId) return;
      setVerifStats(data);
    }).catch(() => {
      // Non-fatal — verification stats unavailable
    });
  }, [projectId]);

  // Accumulate live usage events from WebSocket
  useEffect(() => {
    const handler = (e: Event) => {
      const payload = (e as CustomEvent<any>).detail;
      const u = payload.usage;
      setDeltaCostUsd((prev) => prev + (u?.totalCostUsd ?? payload.costUsd ?? 0));
      const tokens = u
        ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheCreationTokens ?? 0)
        : (payload.totalTokens ?? 0);
      setDeltaTokens((prev) => prev + tokens);
    };
    window.addEventListener("crewdeck:task-usage", handler);
    return () => window.removeEventListener("crewdeck:task-usage", handler);
  }, []);

  const totalCostUsd = baseCostUsd + deltaCostUsd;
  const totalTokens = baseTokens + deltaTokens;

  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "done").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const verified = tasks.filter((t) => t.verification_id != null).length;

  // 추정치가 섞였으면 ≈로 표기해 CLI 실보고 비용과 구분한다(Codex는 토큰 역산 추정).
  const hasEstimatedCost = baseEstimatedCost > 0;
  const costLabel =
    totalCostUsd > 0
      ? `${hasEstimatedCost ? "≈" : ""}$${totalCostUsd.toFixed(4)}`
      : t("noCostData");
  const tokenLabel =
    totalTokens > 0
      ? t("contextTokens", { count: (totalTokens / 1000).toFixed(1) })
      : t("noCostData");

  const passRateColor = (() => {
    if (verifStats?.passRate == null) return "text-faint";
    if (verifStats.passRate >= 80) return "text-success";
    if (verifStats.passRate >= 50) return "text-warning";
    return "text-danger";
  })();

  const passRateLabel = (() => {
    if (verifStats == null) return t("noCostData");
    if (verifStats.passRate == null) return t("noCostData");
    return `${verifStats.passRate}%`;
  })();

  const passRateDetail = (() => {
    if (verifStats == null || verifStats.total === 0) return null;
    return `${verifStats.passed + verifStats.conditional}/${verifStats.total}`;
  })();

  const avgRetriesLabel = verifStats?.avgRetries != null
    ? String(verifStats.avgRetries)
    : t("noCostData");

  const stats = [
    {
      value: total,
      label: t("statTotalTasks"),
      color: "text-muted",
      labelColor: "text-faint",
    },
    {
      value: completed,
      label: t("statCompleted"),
      color: "text-success",
      labelColor: "text-faint",
    },
    {
      value: inProgress,
      label: t("statInProgress"),
      color: "text-accent",
      labelColor: "text-faint",
    },
    {
      value: verified,
      label: t("statVerified"),
      color: "text-accent",
      labelColor: "text-faint",
    },
  ];

  return (
    <div className="flex items-center gap-6 py-3 px-4 bg-sunken border border-line rounded-lg mb-6">
      {stats.map((stat, index) => (
        <div key={stat.label} className="flex items-center gap-4">
          <div className="text-center">
            <span className={`text-lg font-bold ${stat.color}`}>{stat.value}</span>
            <p className={`text-[11px] leading-none mt-0.5 ${stat.labelColor}`}>{stat.label}</p>
          </div>
          {index < stats.length - 1 && (
            <div className="w-px h-8 bg-line" />
          )}
        </div>
      ))}
      <div className="w-px h-8 bg-line" />
      <div className="text-center">
        <div className="flex items-baseline gap-1 justify-center">
          <span className={`text-lg font-bold ${passRateColor}`}>{passRateLabel}</span>
          {passRateDetail && (
            <span className="text-[11px] text-faint">{passRateDetail}</span>
          )}
        </div>
        <p className="text-[11px] leading-none mt-0.5 text-faint">{t("statPassRate")}</p>
      </div>
      <div className="w-px h-8 bg-line" />
      <div className="text-center">
        <span className="text-lg font-bold text-muted">{avgRetriesLabel}</span>
        <p className="text-[11px] leading-none mt-0.5 text-faint">{t("statAvgRetries")}</p>
      </div>
      <div className="w-px h-8 bg-line" />
      <div className="text-center">
        <span
          className="text-lg font-bold text-warning"
          title={hasEstimatedCost ? t("costEstimatedNote") : undefined}
        >{costLabel}</span>
        <p className="text-[11px] leading-none mt-0.5 text-faint">{t("totalCost")}</p>
      </div>
      <div className="w-px h-8 bg-line" />
      <div className="text-center">
        <span className="text-sm font-medium text-muted">{tokenLabel}</span>
        <p className="text-[11px] leading-none mt-0.5 text-faint">{t("totalTokens")}</p>
      </div>
    </div>
  );
}
