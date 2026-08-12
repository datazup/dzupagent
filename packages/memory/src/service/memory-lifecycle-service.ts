import { performExplain, performQuery } from './read-operations.js'
import type {
  InternalMemoryLifecycleExplanationV1,
  InternalMemoryLifecycleQueryInputV1,
  InternalMemoryLifecycleQueryResultV1,
  InternalMemoryLifecycleWriteInputV1,
  InternalMemoryLifecycleWriteResultV1,
  MemoryAdapterCapabilitiesV1,
  MemoryInvalidationPort,
  MemoryLifecycleStorePort,
} from './types.js'
import { decodeMemoryAdapterCapabilitiesV1 } from './validation.js'
import { performWrite } from './write-operation.js'

/** Opt-in canonical lifecycle facade. Existing MemoryService CRUD is unchanged. */
export class MemoryLifecycleService {
  private readonly store: MemoryLifecycleStorePort
  private readonly capabilities: MemoryAdapterCapabilitiesV1
  private readonly invalidationPort: MemoryInvalidationPort | undefined

  constructor(
    store: MemoryLifecycleStorePort,
    options: { readonly invalidationPort?: MemoryInvalidationPort } = {},
  ) {
    this.store = store
    this.capabilities = decodeMemoryAdapterCapabilitiesV1(store.capabilities)
    this.invalidationPort = options.invalidationPort
  }

  async remember(
    input: InternalMemoryLifecycleWriteInputV1,
  ): Promise<InternalMemoryLifecycleWriteResultV1> {
    return performWrite(this.store, this.capabilities, this.invalidationPort, 'remember', input)
  }

  async correct(
    input: InternalMemoryLifecycleWriteInputV1,
  ): Promise<InternalMemoryLifecycleWriteResultV1> {
    return performWrite(this.store, this.capabilities, this.invalidationPort, 'correct', input)
  }

  async forget(
    input: InternalMemoryLifecycleWriteInputV1,
  ): Promise<InternalMemoryLifecycleWriteResultV1> {
    return performWrite(this.store, this.capabilities, this.invalidationPort, 'revoke', input)
  }

  async revoke(
    input: InternalMemoryLifecycleWriteInputV1,
  ): Promise<InternalMemoryLifecycleWriteResultV1> {
    return performWrite(this.store, this.capabilities, this.invalidationPort, 'revoke', input)
  }

  async queryLifecycle(
    input: InternalMemoryLifecycleQueryInputV1,
  ): Promise<InternalMemoryLifecycleQueryResultV1> {
    return performQuery(this.store, input)
  }

  async explain(
    input: InternalMemoryLifecycleQueryInputV1,
  ): Promise<InternalMemoryLifecycleExplanationV1> {
    return performExplain(this.store, this.capabilities, input)
  }
}
