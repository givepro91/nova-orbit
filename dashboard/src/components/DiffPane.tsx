import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

/**
 * goal worktree의 unified diff를 파일별·라인 색으로 렌더한다 (읽기 전용).
 * hunk별 유지/되돌리기 + 인라인 코멘트는 Phase 3b(후속).
 */
export function DiffPane({ goalId, workspaceId }: { goalId?: string | null; workspaceId?: string | null }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ diff: string; truncated: boolean } | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const onBridge = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
      if (!workspaceId || detail.workspaceId === workspaceId) setRevision((value) => value + 1);
    };
    window.addEventListener("crewdeck:terminal-bridge", onBridge);
    return () => window.removeEventListener("crewdeck:terminal-bridge", onBridge);
  }, [workspaceId]);

  useEffect(() => {
    let alive = true;
    const request = workspaceId
      ? api.workspaces.getDiff(workspaceId)
      : api.goals.getDiff(goalId!);
    request
      .then((r) => { if (alive) setResult(r); })
      .catch(() => { if (alive) setResult({ diff: "", truncated: false }); });
    return () => { alive = false; };
  }, [goalId, revision, workspaceId]);

  if (result === null) return <div className="p-4 text-xs text-faint">{t("loading")}</div>;
  if (!result.diff) return <div className="p-4 text-xs text-faint">{t("wsDiffEmpty")}</div>;
  const { diff, truncated } = result;

  // 파일 단위 분할: "diff --git" 경계 (앞을 lookahead로 남겨 헤더 보존)
  const files = diff.split(/(?=^diff --git )/m).filter((f) => f.trim());

  return (
    <div className="text-xs font-mono h-full">
      {truncated && (
        <div className="px-3 py-1 text-warning bg-warning-subtle">
          {t("wsDiffTruncated")}
        </div>
      )}
      {files.map((f, i) => <DiffFile key={i} text={f} />)}
    </div>
  );
}

function DiffFile({ text }: { text: string }) {
  const lines = text.split("\n");
  const header = lines[0]?.replace("diff --git a/", "").replace(/ b\/.*/, "") ?? "file";
  return (
    <div className="border-b border-line-soft">
      <div className="sticky top-0 px-3 py-1.5 bg-sunken font-semibold text-muted border-b border-line-soft truncate">
        {header}
      </div>
      <div>
        {lines.slice(1).map((ln, i) => {
          const cls =
            ln.startsWith("+") && !ln.startsWith("+++")
              ? "bg-success-subtle text-success"
              : ln.startsWith("-") && !ln.startsWith("---")
                ? "bg-danger-subtle text-danger"
                : ln.startsWith("@@")
                  ? "text-accent bg-accent/10"
                  : "text-muted";
          return (
            <div key={i} className={`px-3 whitespace-pre-wrap break-all ${cls}`}>
              {ln || " "}
            </div>
          );
        })}
      </div>
    </div>
  );
}
