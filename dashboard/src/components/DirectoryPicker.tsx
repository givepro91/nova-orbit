import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getApiKey } from "../lib/api";

interface DirectoryPickerProps {
  onSubmit: (path: string) => void;
  onCancel: () => void;
}

interface BrowseResult {
  path: string;
  dirs: string[];
  isGitRepo: boolean;
}

export function DirectoryPicker({ onSubmit, onCancel }: DirectoryPickerProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const browse = async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = path ? `?path=${encodeURIComponent(path)}` : "";
      const key = getApiKey();
      const res = await fetch(`/api/fs/browse${params}`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error);
        return;
      }
      setData(await res.json());
    } catch {
      setError("Failed to browse directory");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    browse();
  }, []);

  const parentPath = data?.path.split("/").slice(0, -1).join("/") || "/";

  return (
    <div
      className="fixed inset-0 bg-black/20 dark:bg-black/50 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="bg-surface rounded-xl shadow-lg w-[480px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-line-soft">
          <h3 className="text-sm font-semibold text-fg mb-2">
            {t("selectDirectory")}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => browse(parentPath)}
              disabled={data?.path === "/"}
              className="text-xs px-2 py-1 text-muted hover:bg-fg/5 rounded disabled:opacity-30"
            >
              ↑
            </button>
            <div className="flex-1 px-2 py-1 text-xs text-muted bg-sunken rounded border border-line truncate font-mono">
              {data?.path ?? "..."}
            </div>
          </div>
        </div>

        {/* Directory list */}
        <div className="h-[300px] overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center h-full text-xs text-faint">
              Loading...
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-full text-xs text-danger">
              {error}
            </div>
          )}
          {!loading && !error && data && (
            <>
              {data.dirs.length === 0 ? (
                <div className="flex items-center justify-center h-full text-xs text-faint">
                  {t("noSubdirectories")}
                </div>
              ) : (
                <div className="py-1">
                  {data.dirs.map((dir) => (
                    <button
                      key={dir}
                      onClick={() => browse(`${data.path}/${dir}`)}
                      className="w-full text-left px-5 py-1.5 text-sm flex items-center gap-2 hover:bg-fg/5 transition-colors"
                    >
                      <span className="text-base">📁</span>
                      <span className="truncate text-muted">
                        {dir}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-line-soft flex items-center justify-between">
          <div className="text-xs text-faint">
            {data?.isGitRepo && (
              <span className="text-success">✓ Git repo</span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="text-xs px-3 py-1.5 text-muted hover:text-fg rounded"
            >
              {t("cancel")}
            </button>
            <button
              onClick={() => data && onSubmit(data.path)}
              disabled={!data}
              className="text-xs px-4 py-1.5 bg-accent text-on-accent rounded hover:bg-accent-hover disabled:opacity-40"
            >
              {t("selectThisFolder")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
