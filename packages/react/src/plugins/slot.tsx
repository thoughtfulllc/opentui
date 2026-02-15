import { createSlotRegistry, SlotRegistry } from "@opentui/core/plugins"
import type { CliRenderer, Plugin, PluginContext } from "@opentui/core"
import { Fragment, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"

export type SlotMode = "replace" | "append"
type SlotMap = Record<string, object>

export type ReactPlugin<TSlots extends SlotMap, TContext extends PluginContext = PluginContext> = Plugin<
  ReactNode,
  TSlots,
  TContext
>

export type ReactSlotProps<TSlots extends SlotMap, K extends keyof TSlots> = {
  name: K
  mode?: SlotMode
  children?: ReactNode
} & TSlots[K]

export type ReactSlotComponent<TSlots extends SlotMap> = <K extends keyof TSlots>(
  props: ReactSlotProps<TSlots, K>,
) => ReactNode

export function createReactSlotRegistry<TSlots extends SlotMap, TContext extends PluginContext = PluginContext>(
  renderer: CliRenderer,
  context: TContext,
): SlotRegistry<ReactNode, TSlots, TContext> {
  return createSlotRegistry<ReactNode, TSlots, TContext>(renderer, "react:slot-registry", context)
}

function getSlotProps<TSlots extends SlotMap, K extends keyof TSlots>(props: ReactSlotProps<TSlots, K>): TSlots[K] {
  const { children: _children, mode: _mode, name: _name, ...slotProps } = props
  return slotProps as TSlots[K]
}

export function createSlot<TSlots extends SlotMap, TContext extends PluginContext = PluginContext>(
  registry: SlotRegistry<ReactNode, TSlots, TContext>,
): ReactSlotComponent<TSlots> {
  return function Slot<K extends keyof TSlots>(props: ReactSlotProps<TSlots, K>): ReactNode {
    const [version, setVersion] = useState(0)

    useEffect(() => {
      return registry.subscribe(() => {
        setVersion((current) => current + 1)
      })
    }, [registry])

    const entries = useMemo(() => registry.resolveEntries(props.name), [registry, props.name, version])
    const slotProps = getSlotProps(props)

    if (entries.length === 0) {
      return <>{props.children}</>
    }

    if (props.mode === "replace") {
      return <>{entries[0].renderer(registry.context, slotProps)}</>
    }

    return (
      <>
        {props.children}
        {entries.map((entry) => (
          <Fragment key={`${String(props.name)}:${entry.id}`}>{entry.renderer(registry.context, slotProps)}</Fragment>
        ))}
      </>
    )
  }
}
