<script setup lang="ts">
import { withBase } from 'vitepress'

const chapters = [
  { number: '01', title: '连接你的模型', text: '配置 Provider、API Key 和默认模型。', link: '/guide/models.html', tag: '基础设置' },
  { number: '02', title: '把任务交给 Tinybot', text: '发送消息与附件，查看过程和结果。', link: '/guide/chat.html', tag: '日常操作' },
  { number: '03', title: '在工作区中协作', text: '选择文件夹，把相关会话放在一起。', link: '/guide/workspaces.html', tag: '文件与项目' },
  { number: '04', title: '接入新的能力', text: '了解插件、Skills 和 MCP 各自的用途。', link: '/guide/extensions.html', tag: '扩展能力' },
  { number: '05', title: '搭建可复用的流程', text: '从三个节点开始创建 Agent Graph。', link: '/guide/agent-graph.html', tag: '进阶使用' },
  { number: '06', title: '让它待在你身边', text: '调整桌面宠物的显示、尺寸和外观。', link: '/guide/desktop-pet.html', tag: '桌面伙伴' },
]
</script>

<template>
  <main class="help-home">
    <section class="help-hero" aria-labelledby="help-title">
      <div class="hero-copy">
        <p class="eyebrow"><span></span> TINYBOT HANDBOOK</p>
        <h1 id="help-title">从一个问题，<br>到一件完成的事。</h1>
        <p class="hero-description">连接模型，带上你的文件，把任务交给 Tinybot。<br class="desktop-break">这份手册陪你完成第一次对话，也陪你探索更多用法。</p>
        <div class="hero-actions">
          <a class="primary-link" :href="withBase('/guide/getting-started.html')">开始使用 <span aria-hidden="true">↗</span></a>
          <a class="secondary-link" :href="withBase('/concepts/how-it-works.html')">先了解工作原理 <span aria-hidden="true">→</span></a>
        </div>
        <p class="hero-note">中文操作手册 <span> / </span> 按步骤学习 <span> / </span> 随时查阅</p>
      </div>
      <aside class="first-task" aria-label="第一次使用的三个步骤">
        <div class="first-task-heading"><span>你的第一次任务</span><span aria-hidden="true">↗</span></div>
        <ol>
          <li><span class="step-index">1</span><div><strong>连接</strong><p>配置一个可用的模型</p></div></li>
          <li><span class="step-index">2</span><div><strong>描述</strong><p>说清楚想做什么、需要什么结果</p></div></li>
          <li><span class="step-index">3</span><div><strong>检查</strong><p>查看回复、执行记录和输出文件</p></div></li>
        </ol>
        <div class="example-task"><span>试着这样开始</span><p>“请用三句话介绍你能帮我做什么。”</p></div>
      </aside>
    </section>

    <section class="chapter-section" aria-labelledby="chapters-title">
      <div class="section-heading"><div><p class="eyebrow">EXPLORE THE GUIDE</p><h2 id="chapters-title">你想先了解什么？</h2></div><p>从眼前的任务开始，按需阅读。</p></div>
      <div class="chapter-grid">
        <a v-for="chapter in chapters" :key="chapter.number" :href="withBase(chapter.link)" class="chapter-link">
          <div class="chapter-meta"><span>{{ chapter.number }}</span><span>{{ chapter.tag }}</span></div>
          <h3>{{ chapter.title }} <span aria-hidden="true">↗</span></h3><p>{{ chapter.text }}</p>
        </a>
      </div>
    </section>

    <section class="help-bottom" aria-label="更多帮助">
      <div><span class="eyebrow">WHEN YOU GET STUCK</span><h2>卡住了？从这里继续。</h2><p>模型连接、文件访问、插件配置，都有可以先检查的地方。</p></div>
      <a class="secondary-link" :href="withBase('/faq.html')">查看常见问题 <span aria-hidden="true">→</span></a>
    </section>
  </main>
</template>
