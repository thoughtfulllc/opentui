import { createRendererScopedSlotRegistry, SlotRegistry } from "@opentui/core"
import type { CliRenderer, HostContext, Plugin } from "@opentui/core"
import { Fragment, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"

export type SlotMode = "replace" | "append"
type SlotMap = Record<string, object>

export type ReactPlugin<TSlots extends SlotMap, TContext extends HostContext = HostContext> = Plugin<
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

export function createReactSlotRegistry<TSlots extends SlotMap, TContext extends HostContext = HostContext>(
  renderer: CliRenderer,
  context: TContext,
  key: string = "react:slot-registry",
): SlotRegistry<ReactNode, TSlots, TContext> {
  return createRendererScopedSlotRegistry<ReactNode, TSlots, TContext>(renderer, key, context)
}

function getSlotProps<TSlots extends SlotMap, K extends keyof TSlots>(props: ReactSlotProps<TSlots, K>): TSlots[K] {
  const { children: _children, mode: _mode, name: _name, ...slotProps } = props
  return slotProps as TSlots[K]
}

export function createSlot<TSlots extends SlotMap, TContext extends HostContext = HostContext>(
  registry: SlotRegistry<ReactNode, TSlots, TContext>,
): ReactSlotComponent<TSlots> {
  return function Slot<K extends keyof TSlots>(props: ReactSlotProps<TSlots, K>): ReactNode {
    const [version, setVersion] = useState(0)

    useEffect(() => {
      return registry.subscribe(() => {
        setVersion((current) => current + 1)
      })
    }, [registry])

    const renderers = useMemo(() => registry.resolve(props.name), [registry, props.name, version])
    const slotProps = getSlotProps(props)

    if (renderers.length === 0) {
      return <>{props.children}</>
    }

    if (props.mode === "replace") {
      return <>{renderers[0](registry.context, slotProps)}</>
    }

    return (
      <>
        {props.children}
        {renderers.map((renderer, index) => (
          <Fragment key={`${String(props.name)}:${index}`}>{renderer(registry.context, slotProps)}</Fragment>
        ))}
      </>
    )
  }
}
