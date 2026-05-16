import { getLanguage, initI18n, setLanguage } from "./src/i18n/index.js";

const THEME_KEY = "tinybot-theme";

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", nextTheme);
  localStorage.setItem(THEME_KEY, nextTheme);
}

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || "light");
}

function playThemeTransition() {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const root = document.documentElement;
  root.classList.remove("theme-switching");
  void root.offsetWidth;
  root.classList.add("theme-switching");
  window.setTimeout(() => root.classList.remove("theme-switching"), 620);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute("data-theme") || "light";
  playThemeTransition();
  applyTheme(currentTheme === "light" ? "dark" : "light");
}

function updateLanguageButton() {
  const languageToggle = document.getElementById("language-toggle");
  if (!languageToggle) {
    return;
  }
  languageToggle.textContent = getLanguage() === "zh" ? "EN" : "中文";
}

function bindTocLinks() {
  document.querySelectorAll(".toc-item").forEach((link) => {
    link.addEventListener("click", (event) => {
      const targetSelector = link.getAttribute("href");
      const target = targetSelector ? document.querySelector(targetSelector) : null;
      if (!target) {
        return;
      }
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function initDocs() {
  initTheme();
  initI18n();
  updateLanguageButton();

  document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);
  document.getElementById("language-toggle")?.addEventListener("click", () => {
    setLanguage(getLanguage() === "zh" ? "en" : "zh");
    updateLanguageButton();
  });
  window.addEventListener("languagechange", updateLanguageButton);
  bindTocLinks();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initDocs, { once: true });
} else {
  initDocs();
}
