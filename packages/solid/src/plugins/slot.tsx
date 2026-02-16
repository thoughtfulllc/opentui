import { createSlotRegistry, SlotRegistry, type SlotRegistryOptions } from "@opentui/core/plugins"
import type { CliRenderer, Plugin, PluginContext, PluginErrorEvent } from "@opentui/core"
import { createMemo, createSignal, ErrorBoundary, onCleanup, splitProps, type JSX } from "solid-js"

export type SlotMode = "append" | "replace" | "single_winner"
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

export interface SolidSlotOptions {
  pluginFailurePlaceholder?: (failure: PluginErrorEvent) => JSX.Element
}

export function createSolidSlotRegistry<TSlots extends SlotMap, TContext extends PluginContext = PluginContext>(
  renderer: CliRenderer,
  context: TContext,
  options: SlotRegistryOptions = {},
): SlotRegistry<JSX.Element, TSlots, TContext> {
  return createSlotRegistry<JSX.Element, TSlots, TContext>(renderer, "solid:slot-registry", context, options)
}

export function createSlot<TSlots extends SlotMap, TContext extends PluginContext = PluginContext>(
  registry: SlotRegistry<JSX.Element, TSlots, TContext>,
  options: SolidSlotOptions = {},
): SolidSlotComponent<TSlots> {
  return function Slot<K extends keyof TSlots>(props: SolidSlotProps<TSlots, K>): JSX.Element {
    const [local, slotProps] = splitProps(props as SolidSlotProps<TSlots, K>, ["name", "mode", "children"])
    const [version, setVersion] = createSignal(0)

    const unsubscribe = registry.subscribe(() => {
      setVersion((current) => current + 1)
    })
    onCleanup(unsubscribe)

    const entries = createMemo(() => {
      version()
      return registry.resolveEntries(local.name)
    })

    const slotName = () => String(local.name)

    const renderPluginFailurePlaceholder = (failure: PluginErrorEvent, fallbackValue: JSX.Element): JSX.Element => {
      if (!options.pluginFailurePlaceholder) {
        return fallbackValue
      }

      try {
        return options.pluginFailurePlaceholder(failure)
      } catch (error) {
        registry.reportPluginError({
          pluginId: failure.pluginId,
          slot: failure.slot ?? slotName(),
          phase: "error_placeholder",
          source: "solid",
          error,
        })

        return fallbackValue
      }
    }

    const renderEntry = (
      entry: {
        id: string
        renderer: (ctx: Readonly<TContext>, props: TSlots[K]) => JSX.Element
      },
      fallbackOnError?: JSX.Element,
    ): JSX.Element => {
      const fallbackValue = fallbackOnError ?? (null as unknown as JSX.Element)
      let initialRender: JSX.Element

      try {
        initialRender = entry.renderer(registry.context, slotProps as TSlots[K])
      } catch (error) {
        const failure = registry.reportPluginError({
          pluginId: entry.id,
          slot: slotName(),
          phase: "render",
          source: "solid",
          error,
        })

        return renderPluginFailurePlaceholder(failure, fallbackValue)
      }

      return (
        <ErrorBoundary
          fallback={(error) => {
            const failure = registry.reportPluginError({
              pluginId: entry.id,
              slot: slotName(),
              phase: "render",
              source: "solid",
              error,
            })

            return renderPluginFailurePlaceholder(failure, fallbackValue)
          }}
        >
          {initialRender}
        </ErrorBoundary>
      )
    }

    return (
      <>
        {(() => {
          const resolvedEntries = entries()

          if (resolvedEntries.length === 0) {
            return local.children
          }

          if (local.mode === "single_winner") {
            return renderEntry(resolvedEntries[0], local.children as JSX.Element)
          }

          if (local.mode === "replace") {
            const renderedEntries = resolvedEntries.map((entry) => renderEntry(entry))
            const hasPluginOutput = renderedEntries.some(
              (entry) => entry !== null && entry !== undefined && entry !== false,
            )

            if (!hasPluginOutput) {
              return local.children as JSX.Element
            }

            return <>{renderedEntries}</>
          }

          return (
            <>
              {local.children}
              {resolvedEntries.map((entry) => renderEntry(entry))}
            </>
          )
        })()}
      </>
    )
  }
}
