import { useTranslation } from "react-i18next";

interface Step {
  icon: string;
  titleKey: string;
  descKey: string;
}

const STEPS: Step[] = [
  { icon: "📁", titleKey: "welcomeStep1Title", descKey: "welcomeStep1Desc" },
  { icon: "🤖", titleKey: "welcomeStep2Title", descKey: "welcomeStep2Desc" },
  { icon: "🎯", titleKey: "welcomeStep3Title", descKey: "welcomeStep3Desc" },
  { icon: "▶️", titleKey: "welcomeStep4Title", descKey: "welcomeStep4Desc" },
];

interface WelcomeGuideProps {
  embedded?: boolean;
}

export function WelcomeGuide({ embedded }: WelcomeGuideProps) {
  const { t } = useTranslation();

  const handleNewProject = () => {
    window.dispatchEvent(new CustomEvent("crewdeck:open-new-project"));
  };

  const handleImport = () => {
    window.dispatchEvent(new CustomEvent("crewdeck:open-import"));
  };

  const card = (
    <div className="w-full max-w-sm bg-surface border border-line rounded-2xl shadow-sm p-8">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">🚀</div>
          <h1 className="text-xl font-bold text-fg mb-1">
            {t("welcomeTitle")}
          </h1>
          <p className="text-sm text-muted">
            {t("welcomeSubtitle")}
          </p>
        </div>

        {/* Steps */}
        <div className="space-y-3 mb-8">
          {STEPS.map((step, index) => (
            <div
              key={step.titleKey}
              className="flex items-start gap-3 p-3 border border-line-soft rounded-lg bg-sunken"
            >
              <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center text-xs font-bold text-faint border border-line rounded-full">
                {index + 1}
              </div>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-base leading-none">{step.icon}</span>
                <div>
                  <span className="text-sm font-medium text-fg">
                    {t(step.titleKey)}
                  </span>
                  <span className="text-xs text-faint ml-1">
                    — {t(step.descKey)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={handleNewProject}
            className="flex-1 py-2 text-sm font-medium bg-fg text-canvas rounded-lg hover:bg-fg/90 transition-colors"
          >
            + {t("newProject").replace("+ ", "")}
          </button>
          <button
            onClick={handleImport}
            className="flex-1 py-2 text-sm font-medium border border-line text-muted rounded-lg hover:bg-fg/5 transition-colors"
          >
            {t("importLocal")}
          </button>
        </div>

        {/* CmdK hint */}
        <p className="text-center text-xs text-faint">
          {t("welcomeCmdK")}
        </p>
      </div>
  );

  if (embedded) return card;

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      {card}
    </div>
  );
}
