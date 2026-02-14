import { createSlotRegistry, SlotRegistry } from "@opentui/core"
import type { CliRenderer, HostContext, Plugin } from "@opentui/core"
import { createMemo, createSignal, onCleanup, splitProps, type JSX } from "solid-js"

export type SlotMode = "replace" | "append"
type SlotMap = Record<string, object>

export type SolidPlugin<TSlots extends SlotMap, TContext extends HostContext = HostContext> = Plugin<
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

export function createSolidSlotRegistry<TSlots extends SlotMap, TContext extends HostContext = HostContext>(
  renderer: CliRenderer,
  context: TContext,
  key: string = "solid:slot-registry",
): SlotRegistry<JSX.Element, TSlots, TContext> {
  return createSlotRegistry<JSX.Element, TSlots, TContext>(renderer, key, context)
}

export function createSlot<TSlots extends SlotMap, TContext extends HostContext = HostContext>(
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
