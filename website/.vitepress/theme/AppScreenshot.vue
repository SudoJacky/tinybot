<script setup lang="ts">
import { computed } from 'vue'
import { withBase } from 'vitepress'
import { data } from './screenshots.data'

const props = defineProps<{ id: string }>()
const shot = computed(() => {
  const entry = data[props.id]
  if (!entry) throw new Error(`Unknown help screenshot: ${props.id}`)
  return entry
})
</script>

<template>
  <figure class="app-screenshot">
    <a v-if="shot.available" class="screenshot-link" :href="withBase(`/screenshots/${id}.webp`)"
      target="_blank" rel="noopener" :aria-label="`查看原图：${shot.title}（新标签页）`">
      <img :src="withBase(`/screenshots/${id}.webp`)"
        :alt="shot.alt" loading="lazy" decoding="async" />
    </a>
    <div v-else class="screenshot-placeholder" role="img" :aria-label="`截图待补充：${shot.title}。${shot.alt}`">
      <div class="screenshot-label"><span class="screenshot-number">{{ shot.number }}</span> 应用截图 · 待补充</div>
      <strong>{{ shot.title }}</strong>
      <p>{{ shot.alt }}</p>
      <span class="screenshot-frame" aria-hidden="true">▧</span>
    </div>
    <figcaption>图 {{ shot.number }} · {{ shot.title }}<span v-if="shot.available"> · 点击图片查看原图</span></figcaption>
  </figure>
</template>
