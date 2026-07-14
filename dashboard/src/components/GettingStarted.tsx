import { useTranslation } from "react-i18next";

interface GettingStartedProps {
  onClose?: () => void;
}

const STEP_COLORS = [
  "bg-blue-500",
  "bg-purple-500",
  "bg-green-500",
  "bg-orange-500",
  "bg-red-500",
];

export function GettingStarted({ onClose }: GettingStartedProps) {
  const { t } = useTranslation();

  const steps = [
    { num: 1, titleKey: "guideStep1Title", detailKey: "guideStep1Detail" },
    { num: 2, titleKey: "guideStep2Title", detailKey: "guideStep2Detail" },
    { num: 3, titleKey: "guideStep3Title", detailKey: "guideStep3Detail" },
    { num: 4, titleKey: "guideStep4Title", detailKey: "guideStep4Detail" },
    { num: 5, titleKey: "guideStep5Title", detailKey: "guideStep5Detail" },
  ];

  return (
    <div className="max-w-5xl mx-auto py-8 px-6">
      {onClose && (
        <button
          onClick={onClose}
          className="flex items-center gap-1 mb-6 text-sm text-muted hover:text-fg transition-colors"
        >
          {t("backToProject")}
        </button>
      )}

      <h1 className="text-2xl font-bold text-fg mb-1">
        {t("guideTitle")}
      </h1>
      <p className="text-muted mb-8">
        {t("guideSubtitle")}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {steps.map((step, idx) => (
          <div
            key={step.num}
            className="border border-line rounded-xl p-5 bg-surface flex flex-col gap-3"
          >
            <div className="flex items-center gap-3">
              <span
                className={`w-7 h-7 rounded-full ${STEP_COLORS[idx]} text-white flex items-center justify-center text-xs font-bold shrink-0`}
              >
                {step.num}
              </span>
              <h2 className="text-sm font-semibold text-fg leading-snug">
                {t(step.titleKey)}
              </h2>
            </div>
            <p className="text-xs text-muted leading-relaxed">
              {t(step.detailKey)}
            </p>
          </div>
        ))}

        {/* 팁 카드 — 6번째 카드 */}
        <div className="border border-info rounded-xl p-5 bg-info-subtle flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="w-7 h-7 rounded-full bg-info text-white flex items-center justify-center text-xs font-bold shrink-0">
              💡
            </span>
            <h2 className="text-sm font-semibold text-info leading-snug">
              {t("guideTipsTitle")}
            </h2>
          </div>
          <ul className="text-xs text-info space-y-1.5 leading-relaxed">
            <li>{t("guideTip1")}</li>
            <li>{t("guideTip2")}</li>
            <li>{t("guideTip3")}</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
