import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface RateLimitInfo {
  agentName: string;
  waitMs: number;
  message: string;
}

export function RateLimitBanner() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<RateLimitInfo | null>(null);
  const [remainingSec, setRemainingSec] = useState(0);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<RateLimitInfo>).detail;
      setInfo(detail);
      setRemainingSec(Math.ceil((detail.waitMs ?? 60000) / 1000));
    };
    window.addEventListener("crewdeck:rate-limit", handler);
    return () => window.removeEventListener("crewdeck:rate-limit", handler);
  }, []);

  // Countdown timer
  useEffect(() => {
    if (remainingSec <= 0) {
      if (info) setInfo(null);
      return;
    }
    const timer = setTimeout(() => setRemainingSec((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [remainingSec, info]);

  if (!info) return null;

  return (
    <div className="bg-warning-subtle border-b border-warning px-4 py-2 flex items-center gap-3">
      <span className="text-warning text-sm shrink-0">
        ⚠️
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-warning font-medium">
          {t("rateLimitTitle")}
        </p>
        <p className="text-[10px] text-warning">
          {t("rateLimitDesc", { agent: info.agentName || t("agentUnnamed"), seconds: remainingSec })}
        </p>
      </div>
      <button
        onClick={() => setInfo(null)}
        className="text-warning hover:text-warning shrink-0"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
