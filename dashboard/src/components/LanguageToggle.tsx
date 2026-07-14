import { useTranslation } from "react-i18next";

export function LanguageToggle() {
  const { i18n } = useTranslation();
  const current = i18n.language.startsWith("ko") ? "ko" : "en";

  const toggle = () => {
    const next = current === "en" ? "ko" : "en";
    i18n.changeLanguage(next);
    localStorage.setItem("crewdeck-lang", next);
  };

  return (
    <button
      onClick={toggle}
      className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-line text-faint hover:text-muted hover:border-line transition-colors"
    >
      {current === "en" ? "KO" : "EN"}
    </button>
  );
}
