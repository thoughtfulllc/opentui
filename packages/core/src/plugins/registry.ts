import type { CliRenderer } from "../renderer"
import type { HostContext, Plugin, ResolvedSlotRenderer, SlotRenderer } from "./types"

interface RegisteredPlugin<TNode, TSlots extends object, TContext extends HostContext = HostContext> {
  plugin: Plugin<TNode, TSlots, TContext>
  registrationOrder: number
}

export class SlotRegistry<TNode, TSlots extends object, TContext extends HostContext = HostContext> {
  private plugins: RegisteredPlugin<TNode, TSlots, TContext>[] = []
  private listeners: Set<() => void> = new Set()
  private registrationOrder = 0
  private hostContext: Readonly<TContext>

  constructor(context: TContext) {
    this.hostContext = context
  }

  public get context(): Readonly<TContext> {
    return this.hostContext
  }

  public register(plugin: Plugin<TNode, TSlots, TContext>): () => void {
    if (this.plugins.some((entry) => entry.plugin.id === plugin.id)) {
      throw new Error(`Plugin with id \"${plugin.id}\" is already registered`)
    }

    plugin.setup?.(this.hostContext)

    this.plugins.push({
      plugin,
      registrationOrder: this.registrationOrder++,
    })

    this.notifyListeners()

    return () => {
      this.unregister(plugin.id)
    }
  }

  public unregister(id: string): boolean {
    const index = this.plugins.findIndex((entry) => entry.plugin.id === id)
    if (index === -1) {
      return false
    }

    const [entry] = this.plugins.splice(index, 1)

    let disposeError: unknown
    try {
      entry?.plugin.dispose?.()
    } catch (error) {
      disposeError = error
    }

    this.notifyListeners()

    if (disposeError) {
      throw disposeError
    }

    return true
  }

  public updateOrder(id: string, order: number): boolean {
    const entry = this.plugins.find((pluginEntry) => pluginEntry.plugin.id === id)
    if (!entry) {
      return false
    }

    if ((entry.plugin.order ?? 0) === order) {
      return true
    }

    entry.plugin.order = order
    this.notifyListeners()
    return true
  }

  public clear(): void {
    if (this.plugins.length === 0) {
      return
    }

    const plugins = [...this.plugins]
    this.plugins = []

    let firstError: unknown
    for (const entry of plugins) {
      try {
        entry.plugin.dispose?.()
      } catch (error) {
        if (!firstError) {
          firstError = error
        }
      }
    }

    this.notifyListeners()

    if (firstError) {
      throw firstError
    }
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public resolve<K extends keyof TSlots>(slot: K): Array<SlotRenderer<TNode, TSlots[K], TContext>> {
    return this.resolveEntries(slot).map((entry) => entry.renderer)
  }

  public resolveEntries<K extends keyof TSlots>(slot: K): Array<ResolvedSlotRenderer<TNode, TSlots[K], TContext>> {
    const slotRenderers: Array<ResolvedSlotRenderer<TNode, TSlots[K], TContext>> = []

    for (const entry of this.getSortedPlugins()) {
      const renderer = entry.plugin.slots[slot]
      if (renderer) {
        slotRenderers.push({
          id: entry.plugin.id,
          renderer: renderer as SlotRenderer<TNode, TSlots[K], TContext>,
        })
      }
    }

    return slotRenderers
  }

  private getSortedPlugins(): RegisteredPlugin<TNode, TSlots, TContext>[] {
    return [...this.plugins].sort((left, right) => {
      const leftOrder = left.plugin.order ?? 0
      const rightOrder = right.plugin.order ?? 0

      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder
      }

      if (left.registrationOrder !== right.registrationOrder) {
        return left.registrationOrder - right.registrationOrder
      }

      return left.plugin.id.localeCompare(right.plugin.id)
    })
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}

const slotRegistriesByRenderer = new WeakMap<CliRenderer, Map<string, SlotRegistry<any, any, any>>>()

function getSlotRegistryStore(renderer: CliRenderer): Map<string, SlotRegistry<any, any, any>> {
  const existingStore = slotRegistriesByRenderer.get(renderer)
  if (existingStore) {
    return existingStore
  }

  const createdStore = new Map<string, SlotRegistry<any, any, any>>()
  slotRegistriesByRenderer.set(renderer, createdStore)

  renderer.once("destroy", () => {
    for (const registry of createdStore.values()) {
      try {
        registry.clear()
      } catch (error) {
        console.error("Error disposing slot registry:", error)
      }
    }

    createdStore.clear()
    slotRegistriesByRenderer.delete(renderer)
  })

  return createdStore
}

export function createSlotRegistry<TNode, TSlots extends object, TContext extends HostContext = HostContext>(
  renderer: CliRenderer,
  key: string,
  context: TContext,
): SlotRegistry<TNode, TSlots, TContext> {
  const store = getSlotRegistryStore(renderer)
  const existing = store.get(key)

  if (existing) {
    return existing as SlotRegistry<TNode, TSlots, TContext>
  }

  const created = new SlotRegistry<TNode, TSlots, TContext>(context)
  store.set(key, created as SlotRegistry<any, any, any>)
  return created
}
