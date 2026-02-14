import { BaseRenderable } from "../Renderable"
import { SlotRegistry } from "../renderer"
import type { HostContext, Plugin } from "../renderer"

export type CoreSlotMode = "append" | "replace"

type CoreSlotProps<TSlotName extends string> = {
  [K in TSlotName]: undefined
}

export type CoreSlotRegistry<TSlotName extends string, TContext extends HostContext = HostContext> = SlotRegistry<
  BaseRenderable,
  CoreSlotProps<TSlotName>,
  TContext
>

export interface CorePlugin<TSlotName extends string, TContext extends HostContext = HostContext> {
  id: string
  order?: number
  setup?: (ctx: Readonly<TContext>) => void
  dispose?: () => void
  slots: Partial<Record<TSlotName, (ctx: Readonly<TContext>) => BaseRenderable>>
}

export interface CoreResolvedSlotRenderer<TContext extends HostContext = HostContext> {
  id: string
  renderer: (ctx: Readonly<TContext>) => BaseRenderable
}

type FallbackNodes = BaseRenderable | BaseRenderable[] | undefined

export interface CoreSlotMountOptions<
  TSlotName extends string,
  K extends TSlotName,
  TContext extends HostContext = HostContext,
> {
  registry: CoreSlotRegistry<TSlotName, TContext>
  name: K
  mount: BaseRenderable
  mode?: CoreSlotMode
  fallback?: FallbackNodes | (() => FallbackNodes)
}

export interface CoreSlotHandle {
  refresh: () => void
  setMode: (mode: CoreSlotMode) => void
  dispose: () => void
}

function toCorePlugin<TSlotName extends string, TContext extends HostContext = HostContext>(
  plugin: CorePlugin<TSlotName, TContext>,
): Plugin<BaseRenderable, CoreSlotProps<TSlotName>, TContext> {
  const slots: Partial<Record<TSlotName, (ctx: Readonly<TContext>, props: undefined) => BaseRenderable>> = {}

  for (const [slotName, renderer] of Object.entries(plugin.slots) as Array<
    [TSlotName, (ctx: Readonly<TContext>) => BaseRenderable]
  >) {
    slots[slotName] = (ctx: Readonly<TContext>) => renderer(ctx)
  }

  return {
    id: plugin.id,
    order: plugin.order,
    setup: plugin.setup,
    dispose: plugin.dispose,
    slots,
  }
}

function asArray(value: FallbackNodes): BaseRenderable[] {
  if (!value) {
    return []
  }

  return Array.isArray(value) ? [...value] : [value]
}

function ensureValidNode(node: unknown, pluginId: string, mount: BaseRenderable): asserts node is BaseRenderable {
  if (!node) {
    throw new Error(`Plugin \"${pluginId}\" did not return a renderable node`)
  }

  if (typeof (node as { then?: unknown }).then === "function") {
    throw new Error(`Plugin \"${pluginId}\" returned an async value. Core slots require synchronous renderers.`)
  }

  if (!(node instanceof BaseRenderable)) {
    throw new Error(`Plugin \"${pluginId}\" must return a BaseRenderable`)
  }

  if (node === mount) {
    throw new Error(`Plugin \"${pluginId}\" returned the slot mount container as its node`)
  }

  if (node.parent && node.parent !== mount) {
    throw new Error(`Plugin \"${pluginId}\" returned a renderable already attached to another parent`)
  }
}

function removeFromParent(node: BaseRenderable, mount: BaseRenderable): void {
  if (node.parent === mount) {
    mount.remove(node.id)
  }
}

function destroyNode(node: BaseRenderable): void {
  node.destroyRecursively()
}

export function createCoreSlotRegistry<TSlotName extends string, TContext extends HostContext = HostContext>(
  context: TContext,
): CoreSlotRegistry<TSlotName, TContext> {
  return new SlotRegistry<BaseRenderable, CoreSlotProps<TSlotName>, TContext>(context)
}

export function registerCorePlugin<TSlotName extends string, TContext extends HostContext = HostContext>(
  registry: CoreSlotRegistry<TSlotName, TContext>,
  plugin: CorePlugin<TSlotName, TContext>,
): () => void {
  return registry.register(toCorePlugin(plugin))
}

export function resolveCoreSlot<
  TSlotName extends string,
  K extends TSlotName,
  TContext extends HostContext = HostContext,
>(registry: CoreSlotRegistry<TSlotName, TContext>, slot: K): Array<CoreResolvedSlotRenderer<TContext>> {
  return registry.resolveEntries(slot).map((entry) => {
    return {
      id: entry.id,
      renderer: (ctx: Readonly<TContext>) => entry.renderer(ctx, undefined),
    }
  })
}

export function mountCoreSlot<
  TSlotName extends string,
  K extends TSlotName,
  TContext extends HostContext = HostContext,
>(options: CoreSlotMountOptions<TSlotName, K, TContext>): CoreSlotHandle {
  let mode: CoreSlotMode = options.mode ?? "append"
  let disposed = false
  let mountedNodes: BaseRenderable[] = []
  const pluginNodes = new Map<string, BaseRenderable>()
  let fallbackNodes: BaseRenderable[] | null = null

  const ensureFallbackNodes = (): BaseRenderable[] => {
    if (fallbackNodes !== null) {
      return fallbackNodes
    }

    const source = typeof options.fallback === "function" ? options.fallback() : options.fallback
    const nodes = asArray(source)
    for (const node of nodes) {
      ensureValidNode(node, "fallback", options.mount)
    }

    fallbackNodes = nodes
    return fallbackNodes
  }

  const cleanupRemovedPluginNodes = (activePluginIds: Set<string>): void => {
    for (const [pluginId, node] of pluginNodes) {
      if (activePluginIds.has(pluginId)) {
        continue
      }

      removeFromParent(node, options.mount)
      destroyNode(node)
      pluginNodes.delete(pluginId)
    }
  }

  const reconcileMountedNodes = (desiredNodes: BaseRenderable[]): void => {
    const desiredNodeSet = new Set(desiredNodes)

    for (const node of mountedNodes) {
      if (!desiredNodeSet.has(node)) {
        removeFromParent(node, options.mount)
      }
    }

    for (let index = 0; index < desiredNodes.length; index++) {
      const node = desiredNodes[index]

      if (node.parent !== options.mount) {
        options.mount.add(node, index)
        continue
      }

      const childAtIndex = options.mount.getChildren()[index]
      if (childAtIndex?.id !== node.id) {
        options.mount.add(node, index)
      }
    }

    mountedNodes = [...desiredNodes]
  }

  const refresh = (): void => {
    if (disposed) {
      return
    }

    const allEntries = resolveCoreSlot(options.registry, options.name)
    cleanupRemovedPluginNodes(new Set(allEntries.map((entry) => entry.id)))

    const activeEntries = mode === "replace" && allEntries.length > 0 ? [allEntries[0]] : allEntries

    for (const entry of activeEntries) {
      if (pluginNodes.has(entry.id)) {
        continue
      }

      const node = entry.renderer(options.registry.context)
      ensureValidNode(node, entry.id, options.mount)
      pluginNodes.set(entry.id, node)
    }

    const desiredNodes: BaseRenderable[] = []

    if (mode === "append" || activeEntries.length === 0) {
      desiredNodes.push(...ensureFallbackNodes())
    }

    for (const entry of activeEntries) {
      const node = pluginNodes.get(entry.id)
      if (node) {
        desiredNodes.push(node)
      }
    }

    reconcileMountedNodes(desiredNodes)
  }

  const unsubscribe = options.registry.subscribe(refresh)

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true

    unsubscribe()

    for (const node of mountedNodes) {
      removeFromParent(node, options.mount)
    }
    mountedNodes = []

    for (const node of pluginNodes.values()) {
      removeFromParent(node, options.mount)
      destroyNode(node)
    }
    pluginNodes.clear()

    if (fallbackNodes) {
      for (const node of fallbackNodes) {
        removeFromParent(node, options.mount)
        destroyNode(node)
      }
      fallbackNodes = null
    }
  }

  try {
    refresh()
  } catch (error) {
    dispose()
    throw error
  }

  return {
    refresh,
    setMode(nextMode: CoreSlotMode): void {
      mode = nextMode
      refresh()
    },
    dispose,
  }
}
