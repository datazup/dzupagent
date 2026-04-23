import type { AsyncPersonaResolver } from '@dzupagent/flow-compiler'

import type { PersonaStore } from './persona-store.js'

export interface PersonaStoreResolver extends AsyncPersonaResolver {
  list(): string[]
}

/**
 * Adapt a PersonaStore into the compiler's persona-resolver contract.
 *
 * The resolver refreshes its in-memory id cache on every resolve() call so the
 * optional synchronous list() method can still provide "did you mean" support
 * to the semantic stage without requiring a separate async catalogue fetch API.
 */
export function createPersonaStoreResolver(store: PersonaStore): PersonaStoreResolver {
  let cachedIds: string[] = []

  return {
    async resolve(ref: string): Promise<boolean> {
      const personas = await store.list()
      cachedIds = personas.map((persona) => persona.id)
      return cachedIds.includes(ref)
    },
    list(): string[] {
      return [...cachedIds]
    },
  }
}
