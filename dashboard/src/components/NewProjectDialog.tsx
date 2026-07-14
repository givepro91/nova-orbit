import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DirectoryPicker } from "./DirectoryPicker";

interface NewProjectDialogProps {
  onSubmit: (name: string, mission: string, workdir: string, autoAgents: boolean) => void;
  onCancel: () => void;
}

export function NewProjectDialog({ onSubmit, onCancel }: NewProjectDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [mission, setMission] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [autoAgents, setAutoAgents] = useState(true);
  const [showBrowser, setShowBrowser] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (name.trim() && workdir.trim()) onSubmit(name.trim(), mission.trim(), workdir.trim(), autoAgents);
  };

  if (showBrowser) {
    return (
      <DirectoryPicker
        onSubmit={(path) => {
          setWorkdir(path);
          setShowBrowser(false);
        }}
        onCancel={() => setShowBrowser(false)}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 bg-black/20 dark:bg-black/50 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="bg-surface rounded-xl shadow-lg w-[460px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 space-y-3">
          <h3 className="text-sm font-semibold text-fg">
            {t("newProject")}
          </h3>
          <div>
            <label className="text-xs text-muted mb-1 block">
              {t("promptProjectName")} *
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
              placeholder={t("promptProjectNameHint")}
              className="w-full px-3 py-2 text-sm border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">
              {t("promptWorkdir")} *
            </label>
            <div className="flex gap-2">
              <div
                onClick={() => setShowBrowser(true)}
                className="flex-1 px-3 py-2 text-sm border border-line rounded-lg bg-sunken text-fg font-mono cursor-pointer hover:border-accent transition-colors truncate"
              >
                {workdir || (
                  <span className="text-faint">
                    {t("promptWorkdirHint")}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowBrowser(true)}
                className="px-3 py-2 text-xs font-medium border border-line rounded-lg hover:bg-fg/5 text-muted transition-colors shrink-0"
              >
                {t("browse")}
              </button>
            </div>
            <p className="text-[10px] text-faint mt-1">
              {t("promptWorkdirDesc")}
            </p>
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">
              {t("promptMission")}
            </label>
            <input
              type="text"
              value={mission}
              onChange={(e) => setMission(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
                if (e.key === "Escape") onCancel();
              }}
              placeholder={t("promptMissionHint")}
              className="w-full px-3 py-2 text-sm border border-line rounded-lg bg-sunken text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          {/* Auto-create agents toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoAgents}
              onChange={(e) => setAutoAgents(e.target.checked)}
              className="w-4 h-4 rounded border-line text-accent focus:ring-accent"
            />
            <span className="text-xs text-muted">
              {t("autoCreateAgents")}
            </span>
          </label>
        </div>
        <div className="px-5 py-3 border-t border-line-soft flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 text-muted hover:text-fg rounded"
          >
            {t("cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || !workdir.trim()}
            className="text-xs px-4 py-1.5 bg-accent text-on-accent rounded hover:bg-accent-hover disabled:opacity-40"
          >
            {t("create")}
          </button>
        </div>
      </div>
    </div>
  );
}
