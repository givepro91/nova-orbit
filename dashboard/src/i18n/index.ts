import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en";
import ko from "./ko";

const savedLang = localStorage.getItem("crewdeck-lang");
const browserLang = navigator.language.startsWith("ko") ? "ko" : "en";
const defaultLang = savedLang ?? browserLang;

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ko: { translation: ko },
  },
  lng: defaultLang,
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
