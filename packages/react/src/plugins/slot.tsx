import { createSlotRegistry, SlotRegistry, type SlotRegistryOptions } from "@opentui/core/plugins"
import type { CliRenderer, Plugin, PluginContext, PluginErrorEvent } from "@opentui/core"
import React, { Fragment, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"

export type SlotMode = "append" | "replace" | "single_winner"
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

export interface ReactSlotOptions {
  pluginFailurePlaceholder?: (failure: PluginErrorEvent) => ReactNode
}

export function createReactSlotRegistry<TSlots extends SlotMap, TContext extends PluginContext = PluginContext>(
  renderer: CliRenderer,
  context: TContext,
  options: SlotRegistryOptions = {},
): SlotRegistry<ReactNode, TSlots, TContext> {
  return createSlotRegistry<ReactNode, TSlots, TContext>(renderer, "react:slot-registry", context, options)
}

function getSlotProps<TSlots extends SlotMap, K extends keyof TSlots>(props: ReactSlotProps<TSlots, K>): TSlots[K] {
  const { children: _children, mode: _mode, name: _name, ...slotProps } = props
  return slotProps as TSlots[K]
}

export function createSlot<TSlots extends SlotMap, TContext extends PluginContext = PluginContext>(
  registry: SlotRegistry<ReactNode, TSlots, TContext>,
  options: ReactSlotOptions = {},
): ReactSlotComponent<TSlots> {
  type PluginErrorBoundaryProps = {
    pluginId: string
    slotName: string
    resetToken: number
    children: ReactNode
  }

  type PluginErrorBoundaryState = {
    failure: PluginErrorEvent | null
  }

  class PluginErrorBoundary extends React.Component<PluginErrorBoundaryProps, PluginErrorBoundaryState> {
    constructor(props: PluginErrorBoundaryProps) {
      super(props)
      this.state = { failure: null }
    }

    override componentDidCatch(error: Error): void {
      const failure = registry.reportPluginError({
        pluginId: this.props.pluginId,
        slot: this.props.slotName,
        phase: "render",
        source: "react",
        error,
      })

      this.setState({ failure })
    }

    override componentDidUpdate(previousProps: PluginErrorBoundaryProps): void {
      if (previousProps.resetToken !== this.props.resetToken && this.state.failure) {
        this.setState({ failure: null })
      }
    }

    override render(): ReactNode {
      if (this.state.failure) {
        return options.pluginFailurePlaceholder ? options.pluginFailurePlaceholder(this.state.failure) : null
      }

      return this.props.children
    }
  }

  return function Slot<K extends keyof TSlots>(props: ReactSlotProps<TSlots, K>): ReactNode {
    const [version, setVersion] = useState(0)

    useEffect(() => {
      return registry.subscribe(() => {
        setVersion((current) => current + 1)
      })
    }, [registry])

    const entries = useMemo(() => registry.resolveEntries(props.name), [registry, props.name, version])
    const slotProps = getSlotProps(props)
    const slotName = String(props.name)

    const renderEntry = (entry: (typeof entries)[number]): ReactNode => {
      const key = `${slotName}:${entry.id}`

      try {
        const rendered = entry.renderer(registry.context, slotProps)
        return (
          <PluginErrorBoundary key={key} pluginId={entry.id} slotName={slotName} resetToken={version}>
            {rendered}
          </PluginErrorBoundary>
        )
      } catch (error) {
        const failure = registry.reportPluginError({
          pluginId: entry.id,
          slot: slotName,
          phase: "render",
          source: "react",
          error,
        })

        if (!options.pluginFailurePlaceholder) {
          return null
        }

        return <Fragment key={key}>{options.pluginFailurePlaceholder(failure)}</Fragment>
      }
    }

    if (entries.length === 0) {
      return <>{props.children}</>
    }

    if (props.mode === "single_winner") {
      const rendered = renderEntry(entries[0])
      if (rendered === null || rendered === undefined || rendered === false) {
        return <>{props.children}</>
      }

      return <>{rendered}</>
    }

    if (props.mode === "replace") {
      const renderedEntries = entries.map(renderEntry)
      const hasPluginOutput = renderedEntries.some((node) => node !== null && node !== undefined && node !== false)

      if (!hasPluginOutput) {
        return <>{props.children}</>
      }

      return <>{renderedEntries}</>
    }

    return (
      <>
        {props.children}
        {entries.map(renderEntry)}
      </>
    )
  }
}
