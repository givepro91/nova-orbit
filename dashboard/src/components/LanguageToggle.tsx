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
      className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-600 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-500 transition-colors"
    >
      {current === "en" ? "KO" : "EN"}
    </button>
  );
}
