import type { CliRenderer } from "../renderer"

export interface PluginContext {}

export type SlotRenderer<TNode, TProps, TContext extends PluginContext = PluginContext> = (
  ctx: Readonly<TContext>,
  props: TProps,
) => TNode

export interface Plugin<TNode, TSlots extends object, TContext extends PluginContext = PluginContext> {
  id: string
  order?: number
  setup?: (ctx: Readonly<TContext>, renderer: CliRenderer) => void
  dispose?: () => void
  slots: {
    [K in keyof TSlots]?: SlotRenderer<TNode, TSlots[K], TContext>
  }
}

export interface ResolvedSlotRenderer<TNode, TProps, TContext extends PluginContext = PluginContext> {
  id: string
  renderer: SlotRenderer<TNode, TProps, TContext>
}
