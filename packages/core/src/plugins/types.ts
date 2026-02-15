export interface HostContext {
  readonly appName: string
  readonly version: string
}

export type SlotRenderer<TNode, TProps, TContext extends HostContext = HostContext> = (
  ctx: Readonly<TContext>,
  props: TProps,
) => TNode

export interface Plugin<TNode, TSlots extends object, TContext extends HostContext = HostContext> {
  id: string
  order?: number
  setup?: (ctx: Readonly<TContext>) => void
  dispose?: () => void
  slots: {
    [K in keyof TSlots]?: SlotRenderer<TNode, TSlots[K], TContext>
  }
}

export interface ResolvedSlotRenderer<TNode, TProps, TContext extends HostContext = HostContext> {
  id: string
  renderer: SlotRenderer<TNode, TProps, TContext>
}
