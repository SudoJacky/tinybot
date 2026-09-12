import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import HelpHome from './HelpHome.vue'
import AppScreenshot from './AppScreenshot.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HelpHome', HelpHome)
    app.component('AppScreenshot', AppScreenshot)
  },
} satisfies Theme
