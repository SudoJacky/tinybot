import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Tinybot 帮助中心',
  description: '从第一次对话到可复用的 Agent 工作流，按步骤用好 Tinybot。',
  base: '/tinybot/',
  srcDir: './content',
  cleanUrls: false,
  lastUpdated: true,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/tinybot/logo.svg' }]],
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Tinybot / 帮助中心',
    nav: [
      { text: '操作手册', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: '工作原理', link: '/concepts/how-it-works' },
      { text: '常见问题', link: '/faq' },
      { text: '下载', link: 'https://github.com/SudoJacky/tinybot/releases' },
    ],
    sidebar: [
      { text: '开始使用', items: [
        { text: '安装与第一次对话', link: '/guide/getting-started' },
        { text: '配置 Provider 与模型', link: '/guide/models' },
        { text: 'Tinybot 如何完成任务', link: '/concepts/how-it-works' },
      ] },
      { text: '日常操作', items: [
        { text: '对话、附件与结果', link: '/guide/chat' },
        { text: '工作区与项目', link: '/guide/workspaces' },
        { text: '桌面宠物与外观', link: '/guide/desktop-pet' },
      ] },
      { text: '扩展与进阶', items: [
        { text: '插件、Skills 与 MCP', link: '/guide/extensions' },
        { text: '创建 Agent Graph', link: '/guide/agent-graph' },
      ] },
      { text: '遇到问题', items: [{ text: '排查与反馈', link: '/faq' }] },
    ],
    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdated: { text: '最后更新', formatOptions: { dateStyle: 'medium' } },
    editLink: {
      pattern: 'https://github.com/SudoJacky/tinybot/edit/master/website/content/:path',
      text: '在 GitHub 上改进此页',
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/SudoJacky/tinybot' }],
    search: {
      provider: 'local',
      options: {
        miniSearch: {
          options: {
            // VitePress serializes this function for the browser; keep it self-contained.
            tokenize: (text) => Array.from(new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text))
              .filter((part) => part.isWordLike).map((part) => part.segment),
          },
          searchOptions: { prefix: true, fuzzy: false },
        },
        locales: {
          root: { translations: {
            button: { buttonText: '搜索手册', buttonAriaLabel: '搜索帮助文档' },
            modal: {
              displayDetails: '显示详细内容', resetButtonTitle: '清空搜索',
              backButtonTitle: '关闭搜索', noResultsText: '没有找到相关内容',
              footer: { selectText: '选择', selectKeyAriaLabel: '回车',
                navigateText: '切换', navigateUpKeyAriaLabel: '上方向键',
                navigateDownKeyAriaLabel: '下方向键', closeText: '关闭', closeKeyAriaLabel: 'Esc' },
            },
          } },
        },
      },
    },
    darkModeSwitchLabel: '外观', darkModeSwitchTitle: '切换至深色模式',
    lightModeSwitchTitle: '切换至浅色模式', sidebarMenuLabel: '手册目录',
    returnToTopLabel: '返回顶部', skipToContentLabel: '跳转到内容',
    notFound: { title: '没有找到这一页', quote: '可以返回首页，或搜索你想了解的操作。',
      linkLabel: '返回帮助中心', linkText: '返回帮助中心' },
    footer: { message: 'Tinybot · 让想法成为可以完成的任务', copyright: '以 MIT 许可证发布' },
  },
})
