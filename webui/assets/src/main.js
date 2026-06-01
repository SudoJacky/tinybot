import { initI18n } from './i18n/index.js';
import { init } from './legacy/app.js';
import { runWhenDocumentReady } from './app-startup.js';

runWhenDocumentReady(document, () => {
  initI18n();
  init();
});
