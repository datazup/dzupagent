/**
 * Framework adaptation engine.
 * Maps file paths and provides adaptation guides between frameworks.
 *
 * Extracted from apps/api framework-adaptation.service.ts and made generic/pluggable.
 */

import { PathMapper } from './path-mapper.js'

// ---- Built-in backend path mappings -----------------------------------------

const BACKEND_MAPPINGS: Record<string, Record<string, string>> = {
  'express->nextjs': {
    'routes/(.*)\\.routes\\.ts': 'app/api/$1/route.ts',
    'controllers/(.*)\\.controller\\.ts': 'app/api/$1/route.ts',
    'services/(.*)\\.service\\.ts': 'lib/services/$1.service.ts',
    'schemas/(.*)\\.schemas\\.ts': 'lib/schemas/$1.schemas.ts',
    'middleware/(.*)\\.ts': 'lib/middleware/$1.ts',
  },
  'express->sveltekit': {
    'routes/(.*)\\.routes\\.ts': 'src/routes/api/$1/\\+server.ts',
    'controllers/(.*)\\.controller\\.ts': 'src/routes/api/$1/\\+server.ts',
    'services/(.*)\\.service\\.ts': 'src/lib/server/services/$1.service.ts',
    'schemas/(.*)\\.schemas\\.ts': 'src/lib/schemas/$1.schemas.ts',
  },
  'express->fastify': {
    'routes/(.*)\\.routes\\.ts': 'src/routes/$1.routes.ts',
    'controllers/(.*)\\.controller\\.ts': 'src/routes/$1.routes.ts',
    'services/(.*)\\.service\\.ts': 'src/services/$1.service.ts',
    'middleware/(.*)\\.ts': 'src/plugins/$1.plugin.ts',
  },
  'nextjs->express': {
    'app/api/(.*)/route\\.ts': 'src/routes/$1.routes.ts',
    'lib/services/(.*)\\.service\\.ts': 'src/services/$1.service.ts',
    'lib/schemas/(.*)\\.schemas\\.ts': 'src/schemas/$1.schemas.ts',
  },
}

// ---- Built-in frontend adaptation guides ------------------------------------

const FRONTEND_GUIDES: Record<string, string> = {
  'vue3->react': [
    '- ref() / reactive() -> useState()',
    '- computed() -> useMemo()',
    '- watch() / watchEffect() -> useEffect()',
    '- onMounted() -> useEffect(() => { ... }, [])',
    '- defineProps<{}>() -> function Component({ prop }: Props)',
    '- defineEmits<{}>() -> callback props',
    '- <template> -> JSX return',
    '- v-if -> {condition && <Element />}',
    '- v-for -> {items.map(item => <Element key={item.id} />)}',
    '- @click -> onClick',
    '- v-model -> value + onChange',
    '- Pinia store -> React context or Zustand',
  ].join('\n'),

  'react->vue3': [
    '- useState() -> ref() / reactive()',
    '- useMemo() -> computed()',
    '- useEffect() -> watch() / watchEffect() / onMounted()',
    '- Props interface -> defineProps<{}>()',
    '- Callback props -> defineEmits<{}>()',
    '- JSX -> <template> with Vue directives',
    '- {condition && <El />} -> v-if',
    '- {items.map(...)} -> v-for',
    '- onClick -> @click',
    '- value + onChange -> v-model',
    '- Context/Zustand -> Pinia store',
  ].join('\n'),

  'vue3->svelte': [
    '- ref() -> $state rune or let variable',
    '- computed() -> $derived rune',
    '- watch() -> $effect rune',
    '- defineProps -> export let (Svelte 4) or $props rune (Svelte 5)',
    '- defineEmits -> createEventDispatcher',
    '- <template> -> Svelte HTML with {#if} {#each}',
    '- v-if -> {#if}',
    '- v-for -> {#each}',
    '- @click -> on:click',
    '- <script setup> -> <script> with export default',
  ].join('\n'),

  'react->svelte': [
    '- useState -> $state rune or let variable',
    '- useMemo -> $derived rune',
    '- useEffect -> $effect rune / onMount',
    '- Props -> export let',
    '- JSX -> Svelte template',
    '- {condition && <El />} -> {#if condition}<El />{/if}',
    '- {items.map()} -> {#each items as item}',
    '- onClick -> on:click',
  ].join('\n'),
}

// ---- FrameworkAdapter -------------------------------------------------------

interface BackendMappingEntry {
  source: string
  target: string
  mapper: PathMapper
}

interface FrontendGuideEntry {
  source: string
  target: string
  guide: string
}

export class FrameworkAdapter {
  private backendMappings: BackendMappingEntry[] = []
  private frontendGuides: FrontendGuideEntry[] = []

  constructor() {
    this.loadBuiltinMappings()
    this.loadBuiltinGuides()
  }

  /** Add a backend path mapping between two frameworks. */
  addBackendMapping(source: string, target: string, mapper: PathMapper): this {
    this.backendMappings.push({ source, target, mapper })
    return this
  }

  /** Add a frontend adaptation guide between two frameworks. */
  addFrontendGuide(source: string, target: string, guide: string): this {
    this.frontendGuides.push({ source, target, guide })
    return this
  }

  /** Map a file path from source framework to target framework. */
  mapPath(path: string, source: string, target: string): string | null {
    for (const entry of this.backendMappings) {
      if (entry.source === source && entry.target === target) {
        const mapped = entry.mapper.map(path)
        if (mapped !== null) return mapped
      }
    }
    return null
  }

  /** Get the adaptation guide text for a source->target framework pair. */
  getAdaptationGuide(source: string, target: string): string | null {
    for (const entry of this.frontendGuides) {
      if (entry.source === source && entry.target === target) {
        return entry.guide
      }
    }
    return null
  }

  // ---- Built-in loading -----------------------------------------------------

  private loadBuiltinMappings(): void {
    for (const [key, rules] of Object.entries(BACKEND_MAPPINGS)) {
      const [source, target] = key.split('->')
      if (!source || !target) continue

      const mapper = new PathMapper()
      for (const [pattern, replacement] of Object.entries(rules)) {
        mapper.addMapping(pattern, replacement)
      }
      this.backendMappings.push({ source, target, mapper })
    }
  }

  private loadBuiltinGuides(): void {
    for (const [key, guide] of Object.entries(FRONTEND_GUIDES)) {
      const [source, target] = key.split('->')
      if (!source || !target) continue
      this.frontendGuides.push({ source, target, guide })
    }
  }
}
