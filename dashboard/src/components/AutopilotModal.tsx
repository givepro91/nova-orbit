import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalA11y } from "../hooks/useModalA11y";

type AutopilotMode = "off" | "goal" | "full";

interface AutopilotModalProps {
  currentMode: AutopilotMode;
  hasMission: boolean;
  hasCto: boolean;
  /** Number of existing todo tasks (for context when switching modes) */
  todoCount?: number;
  /** Number of tasks currently running */
  runningCount?: number;
  onConfirm: (mode: AutopilotMode) => void;
  onClose: () => void;
}

const MODES: { id: AutopilotMode; color: string; activeColor: string; border: string }[] = [
  { id: "off", color: "text-muted", activeColor: "bg-fg/10 border-line", border: "border-line" },
  { id: "goal", color: "text-accent", activeColor: "bg-accent/10 border-accent", border: "border-line" },
  { id: "full", color: "text-warning", activeColor: "bg-warning-subtle border-warning", border: "border-line" },
];

export function AutopilotModal({ currentMode, hasMission, hasCto, todoCount = 0, runningCount = 0, onConfirm, onClose }: AutopilotModalProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<AutopilotMode>(currentMode);
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);

  const fullDisabled = !hasMission || !hasCto;
  const changed = selected !== currentMode;

  return (
    <div
      className="fixed inset-0 bg-black/20 dark:bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-surface rounded-xl shadow-lg w-[480px] overflow-hidden focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-line">
          <h3 className="text-sm font-semibold text-fg">
            {t("autopilotModalTitle")}
          </h3>
          <p className="text-xs text-faint mt-1">
            {t("autopilotModalDesc")}
          </p>
        </div>

        {/* Mode Cards */}
        <div className="px-6 py-4 space-y-3">
          {MODES.map((mode) => {
            const isSelected = selected === mode.id;
            const isDisabled = mode.id === "full" && fullDisabled;

            return (
              <button
                key={mode.id}
                onClick={() => !isDisabled && setSelected(mode.id)}
                disabled={isDisabled}
                className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-all ${
                  isDisabled
                    ? "opacity-40 cursor-not-allowed border-line"
                    : isSelected
                      ? mode.activeColor
                      : `${mode.border} hover:border-line cursor-pointer`
                }`}
              >
                <div className="flex items-center gap-3">
                  {/* Radio indicator */}
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    isSelected ? "border-current" : "border-line"
                  } ${mode.color}`}>
                    {isSelected && <div className="w-2 h-2 rounded-full bg-current" />}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${mode.color}`}>
                        {t(`autopilotMode_${mode.id}`)}
                      </span>
                      {mode.id === "goal" && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-accent/10 text-accent rounded font-medium">
                          {t("recommended")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-faint mt-0.5">
                      {t(`autopilotModeDesc_${mode.id}`)}
                    </p>
                  </div>
                </div>

                {/* Full mode warnings */}
                {mode.id === "full" && fullDisabled && (
                  <div className="mt-2 ml-7 text-[11px] text-danger">
                    {!hasMission && <div>{t("autopilotFullNeedsMission")}</div>}
                    {!hasCto && <div>{t("autopilotFullNeedsCto")}</div>}
                  </div>
                )}

                {/* Full mode safety notice */}
                {mode.id === "full" && !fullDisabled && isSelected && (
                  <div className="mt-2 ml-7 text-[11px] text-warning space-y-0.5">
                    <div>{t("autopilotFullSafety1")}</div>
                    <div>{t("autopilotFullSafety2")}</div>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Transition context banners */}
        {changed && (
          <div className="px-6 pb-1 space-y-2">
            {/* off → goal/full: explain what happens to existing tasks */}
            {currentMode === "off" && selected !== "off" && todoCount > 0 && (
              <div className="px-3 py-2 bg-info-subtle border border-info rounded-lg text-[11px] text-info">
                {t("autopilotSwitchOnWithTasks", { count: todoCount })}
              </div>
            )}
            {/* goal/full → off: explain running tasks won't stop immediately */}
            {currentMode !== "off" && selected === "off" && runningCount > 0 && (
              <div className="px-3 py-2 bg-warning-subtle border border-warning rounded-lg text-[11px] text-warning">
                {t("autopilotSwitchOffWithRunning", { count: runningCount })}
              </div>
            )}
            {currentMode !== "off" && selected === "off" && runningCount === 0 && (
              <div className="px-3 py-2 bg-sunken border border-line rounded-lg text-[11px] text-muted">
                {t("autopilotSwitchOffClean")}
              </div>
            )}
            {/* goal → full or full → goal */}
            {currentMode === "goal" && selected === "full" && (
              <div className="px-3 py-2 bg-warning-subtle border border-warning rounded-lg text-[11px] text-warning">
                {t("autopilotGoalToFull")}
              </div>
            )}
            {currentMode === "full" && selected === "goal" && (
              <div className="px-3 py-2 bg-info-subtle border border-info rounded-lg text-[11px] text-info">
                {t("autopilotFullToGoal")}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-3 border-t border-line flex justify-end gap-2">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 text-muted hover:text-muted rounded"
          >
            {t("cancel")}
          </button>
          <button
            onClick={() => onConfirm(selected)}
            disabled={!changed}
            className="text-xs px-4 py-1.5 bg-fg text-canvas rounded hover:bg-fg/90 disabled:opacity-40 font-medium"
          >
            {t("apply")}
          </button>
        </div>
      </div>
    </div>
  );
}
