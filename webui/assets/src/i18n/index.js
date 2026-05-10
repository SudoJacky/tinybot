import zhCN from './zh-CN.js';
import enUS from './en-US.js';

export const messages = {
  zh: zhCN,
  en: enUS,
  'zh-CN': zhCN,
  'en-US': enUS,
};

let currentLang = 'zh';

export function detectLanguage() {
  const stored = localStorage.getItem('tinybot-lang');
  if (stored && (stored === 'zh' || stored === 'en' || stored === 'zh-CN' || stored === 'en-US')) {
    return stored === 'zh-CN' ? 'zh' : stored === 'en-US' ? 'en' : stored;
  }
  const browserLang = navigator.language || navigator.userLanguage;
  if (browserLang && browserLang.toLowerCase().startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}

export function t(key) {
  const trans = messages[currentLang];
  if (trans && trans[key]) {
    return trans[key];
  }
  return key;
}

export function setLanguage(lang) {
  if (lang === 'zh-CN') lang = 'zh';
  if (lang === 'en-US') lang = 'en';
  if (lang !== 'zh' && lang !== 'en') {
    lang = 'zh';
  }
  currentLang = lang;
  localStorage.setItem('tinybot-lang', lang);
  applyTranslations();
  window.dispatchEvent(new CustomEvent('languagechange', { detail: { lang } }));
}

export function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = t(key);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    el.title = t(key);
  });
  document.querySelectorAll('[data-i18n-help]').forEach((el) => {
    const key = el.getAttribute('data-i18n-help');
    el.setAttribute('data-help', t(key));
  });
}

export function getLanguage() {
  return currentLang;
}

export function initI18n() {
  currentLang = detectLanguage();
  applyTranslations();
}

Object.assign(window, { t, setLanguage, getLanguage, initI18n, applyTranslations });
