// Shared brand symbol, isRenderable check, and late-bound helpers.
// Extracted to break the circular dependency between Renderable.ts and vnode.ts.
// Both sides import from here; neither imports a value from the other.

export const BrandedRenderable: unique symbol = Symbol.for("@opentui/core/Renderable") as any

export function isRenderable(obj: any): boolean {
  return !!obj?.[BrandedRenderable]
}

// Late-bound maybeMakeRenderable — vnode.ts registers the real implementation
// at module init time, and Renderable.ts calls it at runtime.
let _maybeMakeRenderable: ((ctx: any, node: any) => any) | null = null

export function registerMaybeMakeRenderable(fn: (ctx: any, node: any) => any) {
  _maybeMakeRenderable = fn
}

export function maybeMakeRenderable(ctx: any, node: any): any {
  return _maybeMakeRenderable?.(ctx, node) ?? null
}
