import { BaseRenderable } from "../Renderable"
import type { CliRenderer } from "../renderer"
import { createSlotRegistry, SlotRegistry, type SlotRegistryOptions } from "./registry"
import type { Plugin, PluginContext, PluginErrorEvent } from "./types"

export type CoreSlotMode = "append" | "replace"

type CoreSlotProps<TSlotName extends string> = {
  [K in TSlotName]: undefined
}

export type CoreSlotRegistry<TSlotName extends string, TContext extends PluginContext = PluginContext> = SlotRegistry<
  BaseRenderable,
  CoreSlotProps<TSlotName>,
  TContext
>

export interface CorePlugin<TSlotName extends string, TContext extends PluginContext = PluginContext> {
  id: string
  order?: number
  setup?: (ctx: Readonly<TContext>, renderer: CliRenderer) => void
  dispose?: () => void
  slots: Partial<Record<TSlotName, (ctx: Readonly<TContext>) => BaseRenderable>>
}

export interface CoreResolvedSlotRenderer<TContext extends PluginContext = PluginContext> {
  id: string
  renderer: (ctx: Readonly<TContext>) => BaseRenderable
}

type FallbackNodes = BaseRenderable | BaseRenderable[] | undefined

export type CoreSlotFailurePlaceholder<TContext extends PluginContext = PluginContext> = (
  failure: PluginErrorEvent,
  ctx: Readonly<TContext>,
) => FallbackNodes

export interface CoreSlotMountOptions<
  TSlotName extends string,
  K extends TSlotName,
  TContext extends PluginContext = PluginContext,
> {
  registry: CoreSlotRegistry<TSlotName, TContext>
  name: K
  mount: BaseRenderable
  mode?: CoreSlotMode
  fallback?: FallbackNodes | (() => FallbackNodes)
  pluginFailurePlaceholder?: CoreSlotFailurePlaceholder<TContext>
}

export interface CoreSlotHandle {
  refresh: () => void
  setMode: (mode: CoreSlotMode) => void
  dispose: () => void
}

function toCorePlugin<TSlotName extends string, TContext extends PluginContext = PluginContext>(
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
    throw new Error(`Plugin "${pluginId}" did not return a renderable node`)
  }

  if (typeof (node as { then?: unknown }).then === "function") {
    throw new Error(`Plugin "${pluginId}" returned an async value. Core slots require synchronous renderers.`)
  }

  if (!(node instanceof BaseRenderable)) {
    throw new Error(`Plugin "${pluginId}" must return a BaseRenderable`)
  }

  if (node === mount) {
    throw new Error(`Plugin "${pluginId}" returned the slot mount container as its node`)
  }

  if (node.parent && node.parent !== mount) {
    throw new Error(`Plugin "${pluginId}" returned a renderable already attached to another parent`)
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

export function createCoreSlotRegistry<TSlotName extends string, TContext extends PluginContext = PluginContext>(
  renderer: CliRenderer,
  context: TContext,
  options: SlotRegistryOptions = {},
): CoreSlotRegistry<TSlotName, TContext> {
  return createSlotRegistry<BaseRenderable, CoreSlotProps<TSlotName>, TContext>(
    renderer,
    "core:slot-registry",
    context,
    options,
  )
}

export function registerCorePlugin<TSlotName extends string, TContext extends PluginContext = PluginContext>(
  registry: CoreSlotRegistry<TSlotName, TContext>,
  plugin: CorePlugin<TSlotName, TContext>,
): () => void {
  return registry.register(toCorePlugin(plugin))
}

export function resolveCoreSlot<
  TSlotName extends string,
  K extends TSlotName,
  TContext extends PluginContext = PluginContext,
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
  TContext extends PluginContext = PluginContext,
>(options: CoreSlotMountOptions<TSlotName, K, TContext>): CoreSlotHandle {
  let mode: CoreSlotMode = options.mode ?? "append"
  let disposed = false
  let mountedNodes: BaseRenderable[] = []
  const pluginNodes = new Map<string, BaseRenderable[]>()
  let fallbackNodes: BaseRenderable[] | null = null
  const slotName = String(options.name)

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
    for (const [pluginId, nodes] of pluginNodes) {
      if (activePluginIds.has(pluginId)) {
        continue
      }

      for (const node of nodes) {
        removeFromParent(node, options.mount)
        destroyNode(node)
      }
      pluginNodes.delete(pluginId)
    }
  }

  const resolvePluginFailurePlaceholder = (failure: PluginErrorEvent): BaseRenderable[] => {
    if (!options.pluginFailurePlaceholder) {
      return []
    }

    try {
      const placeholderSource = options.pluginFailurePlaceholder(failure, options.registry.context)
      const placeholderNodes = asArray(placeholderSource)

      for (const node of placeholderNodes) {
        ensureValidNode(node, `${failure.pluginId}:error-placeholder`, options.mount)
      }

      return placeholderNodes
    } catch (placeholderError) {
      options.registry.reportPluginError({
        pluginId: failure.pluginId,
        slot: slotName,
        phase: "error_placeholder",
        source: "core",
        error: placeholderError,
      })
      return []
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

      try {
        const node = entry.renderer(options.registry.context)
        ensureValidNode(node, entry.id, options.mount)
        pluginNodes.set(entry.id, [node])
      } catch (error) {
        const failure = options.registry.reportPluginError({
          pluginId: entry.id,
          slot: slotName,
          phase: "render",
          source: "core",
          error,
        })

        pluginNodes.set(entry.id, resolvePluginFailurePlaceholder(failure))
      }
    }

    const desiredNodes: BaseRenderable[] = []

    if (mode === "append" || activeEntries.length === 0) {
      desiredNodes.push(...ensureFallbackNodes())
    }

    for (const entry of activeEntries) {
      const nodes = pluginNodes.get(entry.id)
      if (nodes) {
        desiredNodes.push(...nodes)
      }
    }

    if (mode === "replace" && desiredNodes.length === 0) {
      desiredNodes.push(...ensureFallbackNodes())
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

    for (const nodes of pluginNodes.values()) {
      for (const node of nodes) {
        removeFromParent(node, options.mount)
        destroyNode(node)
      }
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
