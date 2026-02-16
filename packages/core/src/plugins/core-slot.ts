import { BaseRenderable } from "../Renderable"
import type { CliRenderer } from "../renderer"
import { createSlotRegistry, SlotRegistry, type SlotRegistryOptions } from "./registry"
import type { Plugin, PluginContext, PluginErrorEvent } from "./types"

export type CoreSlotMode = "append" | "replace" | "single_winner"

type CoreSlotProps<TSlotName extends string> = {
  [K in TSlotName]: undefined
}

export type CoreSlotRegistry<TSlotName extends string, TContext extends PluginContext = PluginContext> = SlotRegistry<
  BaseRenderable,
  CoreSlotProps<TSlotName>,
  TContext
>

export type CoreSlotRenderer<TContext extends PluginContext = PluginContext> = (
  ctx: Readonly<TContext>,
) => BaseRenderable

export interface CoreManagedSlot<TContext extends PluginContext = PluginContext> {
  render: CoreSlotRenderer<TContext>
  onActivate?: (ctx: Readonly<TContext>) => void
  onDeactivate?: (ctx: Readonly<TContext>) => void
  onDispose?: (ctx: Readonly<TContext>) => void
}

export type CoreSlotContribution<TContext extends PluginContext = PluginContext> =
  | CoreSlotRenderer<TContext>
  | CoreManagedSlot<TContext>

export interface CorePlugin<TSlotName extends string, TContext extends PluginContext = PluginContext> {
  id: string
  order?: number
  setup?: (ctx: Readonly<TContext>, renderer: CliRenderer) => void
  dispose?: () => void
  slots: Partial<Record<TSlotName, CoreSlotContribution<TContext>>>
}

export interface CoreResolvedSlotRenderer<TContext extends PluginContext = PluginContext> {
  id: string
  renderer: CoreSlotRenderer<TContext>
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

type CoreSlotOwnership = "host" | "plugin"

type WrappedCoreSlotRenderer<TContext extends PluginContext = PluginContext> = ((
  ctx: Readonly<TContext>,
  props: undefined,
) => BaseRenderable) & {
  __coreSlotOwnership?: CoreSlotOwnership
  __coreManagedSlot?: CoreManagedSlot<TContext>
}

interface ResolvedCoreSlotEntry<TContext extends PluginContext = PluginContext>
  extends CoreResolvedSlotRenderer<TContext> {
  ownership: CoreSlotOwnership
  managedSlot?: CoreManagedSlot<TContext>
}

interface SlotNodeState<TContext extends PluginContext = PluginContext> {
  nodes: BaseRenderable[]
  ownership: CoreSlotOwnership
  managedSlot?: CoreManagedSlot<TContext>
}

function isCoreManagedSlot<TContext extends PluginContext = PluginContext>(
  contribution: CoreSlotContribution<TContext>,
): contribution is CoreManagedSlot<TContext> {
  return typeof contribution === "object" && contribution !== null && "render" in contribution
}

function toCorePlugin<TSlotName extends string, TContext extends PluginContext = PluginContext>(
  plugin: CorePlugin<TSlotName, TContext>,
): Plugin<BaseRenderable, CoreSlotProps<TSlotName>, TContext> {
  const slots: Partial<Record<TSlotName, WrappedCoreSlotRenderer<TContext>>> = {}

  for (const [slotName, contribution] of Object.entries(plugin.slots) as Array<
    [TSlotName, CoreSlotContribution<TContext>]
  >) {
    const wrappedRenderer: WrappedCoreSlotRenderer<TContext> = (ctx: Readonly<TContext>) => {
      if (isCoreManagedSlot(contribution)) {
        return contribution.render(ctx)
      }

      return contribution(ctx)
    }

    if (isCoreManagedSlot(contribution)) {
      wrappedRenderer.__coreSlotOwnership = "plugin"
      wrappedRenderer.__coreManagedSlot = contribution
    } else {
      wrappedRenderer.__coreSlotOwnership = "host"
    }

    slots[slotName] = wrappedRenderer
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

export function createCoreSlotRegistry<TSlotName extends string, TContext extends PluginContext = PluginContext>(
  renderer: CliRenderer,
  context: TContext,
  options: SlotRegistryOptions = {},
): CoreSlotRegistry<TSlotName, TContext> {
  // Core slots intentionally use one registry key per renderer instance.
  // Use createSlotRegistry with your own key if you need multiple independent registries.
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
  return resolveCoreSlotEntries(registry, slot).map((entry) => {
    return {
      id: entry.id,
      renderer: entry.renderer,
    }
  })
}

function resolveCoreSlotEntries<
  TSlotName extends string,
  K extends TSlotName,
  TContext extends PluginContext = PluginContext,
>(registry: CoreSlotRegistry<TSlotName, TContext>, slot: K): Array<ResolvedCoreSlotEntry<TContext>> {
  return registry.resolveEntries(slot).map((entry) => {
    const wrappedRenderer = entry.renderer as WrappedCoreSlotRenderer<TContext>

    return {
      id: entry.id,
      renderer: (ctx: Readonly<TContext>) => wrappedRenderer(ctx, undefined),
      ownership: wrappedRenderer.__coreSlotOwnership ?? "host",
      managedSlot: wrappedRenderer.__coreManagedSlot,
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
  const pluginNodes = new Map<string, SlotNodeState<TContext>>()
  let activePluginIds = new Set<string>()
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

  const callManagedHook = (
    pluginId: string,
    managedSlot: CoreManagedSlot<TContext> | undefined,
    hook: "onActivate" | "onDeactivate" | "onDispose",
    phase: "setup" | "dispose",
  ): void => {
    const callback = managedSlot?.[hook]
    if (!callback) {
      return
    }

    try {
      callback(options.registry.context)
    } catch (error) {
      options.registry.reportPluginError({
        pluginId,
        slot: slotName,
        phase,
        source: "core",
        error,
      })
    }
  }

  const detachNodeFromMount = (node: BaseRenderable): void => {
    if (node.parent === options.mount) {
      options.mount.remove(node.id)
    }
  }

  const cleanupInactivePluginNodes = (nextActivePluginIds: Set<string>, registeredPluginIds: Set<string>): void => {
    for (const [pluginId, state] of pluginNodes) {
      if (nextActivePluginIds.has(pluginId)) {
        continue
      }

      if (activePluginIds.has(pluginId)) {
        callManagedHook(pluginId, state.managedSlot, "onDeactivate", "dispose")
      }

      for (const node of state.nodes) {
        detachNodeFromMount(node)
      }

      if (!registeredPluginIds.has(pluginId)) {
        callManagedHook(pluginId, state.managedSlot, "onDispose", "dispose")

        if (state.ownership === "host") {
          for (const node of state.nodes) {
            node.destroyRecursively()
          }
        }

        pluginNodes.delete(pluginId)
        continue
      }

      if (state.ownership === "host") {
        for (const node of state.nodes) {
          node.destroyRecursively()
        }
        pluginNodes.delete(pluginId)
        continue
      }

      state.nodes = []
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
        if (node.parent === options.mount) {
          options.mount.remove(node.id)
        }
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

    const allEntries = resolveCoreSlotEntries(options.registry, options.name)
    const activeEntries = mode === "single_winner" && allEntries.length > 0 ? [allEntries[0]] : allEntries
    const nextActivePluginIds = new Set(activeEntries.map((entry) => entry.id))
    const registeredPluginIds = new Set(allEntries.map((entry) => entry.id))

    cleanupInactivePluginNodes(nextActivePluginIds, registeredPluginIds)

    for (const entry of activeEntries) {
      let state = pluginNodes.get(entry.id)

      if (!state || (state.ownership === "plugin" && state.nodes.length === 0)) {
        try {
          const node = entry.renderer(options.registry.context)
          ensureValidNode(node, entry.id, options.mount)
          state = {
            nodes: [node],
            ownership: entry.ownership,
            managedSlot: entry.managedSlot ?? state?.managedSlot,
          }
        } catch (error) {
          const failure = options.registry.reportPluginError({
            pluginId: entry.id,
            slot: slotName,
            phase: "render",
            source: "core",
            error,
          })

          state = {
            nodes: resolvePluginFailurePlaceholder(failure),
            ownership: "host",
            managedSlot: entry.managedSlot ?? state?.managedSlot,
          }
        }

        pluginNodes.set(entry.id, state)
      }

      if (!activePluginIds.has(entry.id)) {
        callManagedHook(entry.id, state.managedSlot, "onActivate", "setup")
      }
    }

    const desiredNodes: BaseRenderable[] = []

    if (mode === "append" || activeEntries.length === 0) {
      desiredNodes.push(...ensureFallbackNodes())
    }

    for (const entry of activeEntries) {
      const state = pluginNodes.get(entry.id)
      if (state) {
        desiredNodes.push(...state.nodes)
      }
    }

    if (mode !== "append" && desiredNodes.length === 0) {
      desiredNodes.push(...ensureFallbackNodes())
    }

    reconcileMountedNodes(desiredNodes)
    activePluginIds = nextActivePluginIds
  }

  const unsubscribe = options.registry.subscribe(refresh)

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true

    unsubscribe()

    for (const [pluginId, state] of pluginNodes) {
      if (activePluginIds.has(pluginId)) {
        callManagedHook(pluginId, state.managedSlot, "onDeactivate", "dispose")
      }

      callManagedHook(pluginId, state.managedSlot, "onDispose", "dispose")

      for (const node of state.nodes) {
        detachNodeFromMount(node)
      }

      if (state.ownership === "host") {
        for (const node of state.nodes) {
          node.destroyRecursively()
        }
      }
    }

    pluginNodes.clear()
    activePluginIds = new Set()

    if (fallbackNodes) {
      for (const node of fallbackNodes) {
        node.destroyRecursively()
      }
      fallbackNodes = null
    }

    mountedNodes = []
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
