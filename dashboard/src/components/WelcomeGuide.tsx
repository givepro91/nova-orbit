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
    <div className="w-full max-w-sm bg-white dark:bg-[#25253d] border border-gray-200 dark:border-gray-700 rounded-2xl shadow-sm p-8">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">🚀</div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-1">
            {t("welcomeTitle")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("welcomeSubtitle")}
          </p>
        </div>

        {/* Steps */}
        <div className="space-y-3 mb-8">
          {STEPS.map((step, index) => (
            <div
              key={step.titleKey}
              className="flex items-start gap-3 p-3 border border-gray-100 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-[#1e1e2e]"
            >
              <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center text-xs font-bold text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-600 rounded-full">
                {index + 1}
              </div>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-base leading-none">{step.icon}</span>
                <div>
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
                    {t(step.titleKey)}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">
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
            className="flex-1 py-2 text-sm font-medium bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-lg hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors"
          >
            + {t("newProject").replace("+ ", "")}
          </button>
          <button
            onClick={handleImport}
            className="flex-1 py-2 text-sm font-medium border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            {t("importLocal")}
          </button>
        </div>

        {/* CmdK hint */}
        <p className="text-center text-xs text-gray-400 dark:text-gray-500">
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
