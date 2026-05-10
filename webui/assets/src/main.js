import { initI18n } from './i18n/index.js';
import { init } from './legacy/app.js';

document.addEventListener('DOMContentLoaded', () => {
  initI18n();
  init();
});
