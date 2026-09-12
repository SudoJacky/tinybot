import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import screenshots from './screenshots.json'

export default {
  watch: ['./screenshots.json', '../../content/public/screenshots/*.webp'],
  load() {
    return Object.fromEntries(Object.entries(screenshots).map(([id, entry]) => [id, {
      ...entry,
      available: existsSync(fileURLToPath(new URL(`../../content/public/screenshots/${id}.webp`, import.meta.url))),
    }]))
  },
}

export declare const data: Record<string, {
  number: string; title: string; capture: string; alt: string; available: boolean
}>
