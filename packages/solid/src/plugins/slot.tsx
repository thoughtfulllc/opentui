import { createSlotRegistry, SlotRegistry } from "@opentui/core/plugins"
import type { CliRenderer, Plugin, PluginContext } from "@opentui/core"
import { createMemo, createSignal, onCleanup, splitProps, type JSX } from "solid-js"

export type SlotMode = "replace" | "append"
type SlotMap = Record<string, object>

export type SolidPlugin<TSlots extends SlotMap, TContext extends PluginContext = PluginContext> = Plugin<
  JSX.Element,
  TSlots,
  TContext
>

export type SolidSlotProps<TSlots extends SlotMap, K extends keyof TSlots> = {
  name: K
  mode?: SlotMode
  children?: JSX.Element
} & TSlots[K]

export type SolidSlotComponent<TSlots extends SlotMap> = <K extends keyof TSlots>(
  props: SolidSlotProps<TSlots, K>,
) => JSX.Element

export function createSolidSlotRegistry<TSlots extends SlotMap, TContext extends PluginContext = PluginContext>(
  renderer: CliRenderer,
  context: TContext,
): SlotRegistry<JSX.Element, TSlots, TContext> {
  return createSlotRegistry<JSX.Element, TSlots, TContext>(renderer, "solid:slot-registry", context)
}

export function createSlot<TSlots extends SlotMap, TContext extends PluginContext = PluginContext>(
  registry: SlotRegistry<JSX.Element, TSlots, TContext>,
): SolidSlotComponent<TSlots> {
  return function Slot<K extends keyof TSlots>(props: SolidSlotProps<TSlots, K>): JSX.Element {
    const [local, slotProps] = splitProps(props as SolidSlotProps<TSlots, K>, ["name", "mode", "children"])
    const [version, setVersion] = createSignal(0)

    const unsubscribe = registry.subscribe(() => {
      setVersion((current) => current + 1)
    })
    onCleanup(unsubscribe)

    const renderers = createMemo(() => {
      version()
      return registry.resolve(local.name)
    })

    return (
      <>
        {(() => {
          const resolvedRenderers = renderers()

          if (resolvedRenderers.length === 0) {
            return local.children
          }

          if (local.mode === "replace") {
            return resolvedRenderers[0](registry.context, slotProps as TSlots[K])
          }

          return (
            <>
              {local.children}
              {resolvedRenderers.map((renderer) => renderer(registry.context, slotProps as TSlots[K]))}
            </>
          )
        })()}
      </>
    )
  }
}
