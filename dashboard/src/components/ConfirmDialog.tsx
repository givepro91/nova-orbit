import { useTranslation } from "react-i18next";
import { useModalA11y } from "../hooks/useModalA11y";

interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useModalA11y<HTMLDivElement>(onCancel);

  return (
    <div
      className="fixed inset-0 bg-black/20 dark:bg-black/50 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-surface rounded-xl shadow-lg w-[380px] overflow-hidden focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-5">
          <p className="text-sm text-muted">{message}</p>
        </div>
        <div className="px-5 py-3 border-t border-line-soft flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 text-muted hover:text-fg rounded"
          >
            {t("cancel")}
          </button>
          <button
            onClick={onConfirm}
            className="text-xs px-4 py-1.5 bg-danger text-white rounded hover:opacity-90"
          >
            {t("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
