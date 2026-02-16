import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Renderable } from "../Renderable"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer"
import { createCoreSlotRegistry, mountCoreSlot, registerCorePlugin } from "../plugins/core-slot"

type AppSlot = "statusbar"
type AppContext = { appName: string; version: string }

class TestRenderable extends Renderable {
  constructor(renderer: TestRenderer, id: string) {
    super(renderer, { id })
  }
}

let renderer: TestRenderer
let slotMount: TestRenderable

beforeEach(async () => {
  ;({ renderer } = await createTestRenderer({}))
  slotMount = new TestRenderable(renderer, "slot-mount")
  renderer.root.add(slotMount)
})

afterEach(() => {
  renderer.destroy()
})

describe("Core slot binding", () => {
  test("creates renderer-scoped registry by default", () => {
    const context = { appName: "core-only", version: "1.0.0" }
    const first = createCoreSlotRegistry<AppSlot, AppContext>(renderer, context)
    const second = createCoreSlotRegistry<AppSlot, AppContext>(renderer, context)

    expect(first).toBe(second)
    expect(first.context.appName).toBe("core-only")

    expect(() => {
      createCoreSlotRegistry<AppSlot, AppContext>(renderer, { appName: "other", version: "2.0.0" })
    }).toThrow("different context")
  })

  test("uses fallback when no plugin is registered", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let fallbackCreateCount = 0

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      fallback: () => {
        fallbackCreateCount++
        return new TestRenderable(renderer, "fallback")
      },
    })

    expect(fallbackCreateCount).toBe(1)
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["fallback"])

    handle.refresh()

    expect(fallbackCreateCount).toBe(1)
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["fallback"])

    handle.dispose()
  })

  test("creates plugin node once and reuses it on refresh", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let pluginCreateCount = 0
    let pluginNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-a",
      slots: {
        statusbar() {
          pluginCreateCount++
          pluginNode = new TestRenderable(renderer, `plugin-a-${pluginCreateCount}`)
          return pluginNode
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
    })

    expect(pluginCreateCount).toBe(1)
    expect(slotMount.getChildren()[0]).toBe(pluginNode)

    handle.refresh()
    registry.updateOrder("plugin-a", 10)

    expect(pluginCreateCount).toBe(1)
    expect(slotMount.getChildren()[0]).toBe(pluginNode)

    handle.dispose()
  })

  test("single_winner mode recreates plugins that re-enter as winner", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let pluginACreateCount = 0
    let pluginBCreateCount = 0

    registerCorePlugin(registry, {
      id: "plugin-a",
      order: 0,
      slots: {
        statusbar() {
          pluginACreateCount++
          return new TestRenderable(renderer, `plugin-a-${pluginACreateCount}`)
        },
      },
    })

    registerCorePlugin(registry, {
      id: "plugin-b",
      order: 10,
      slots: {
        statusbar() {
          pluginBCreateCount++
          return new TestRenderable(renderer, `plugin-b-${pluginBCreateCount}`)
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      mode: "single_winner",
    })

    expect(pluginACreateCount).toBe(1)
    expect(pluginBCreateCount).toBe(0)
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-a-1"])

    registry.updateOrder("plugin-b", -1)

    expect(pluginACreateCount).toBe(1)
    expect(pluginBCreateCount).toBe(1)
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-b-1"])

    registry.updateOrder("plugin-a", -2)

    expect(pluginACreateCount).toBe(2)
    expect(pluginBCreateCount).toBe(1)
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-a-2"])

    handle.dispose()
  })

  test("single_winner destroys non-winning plugin nodes when winner changes", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let pluginACreateCount = 0
    let pluginBCreateCount = 0
    const pluginANodes: TestRenderable[] = []
    const pluginBNodes: TestRenderable[] = []

    registerCorePlugin(registry, {
      id: "plugin-a",
      order: 0,
      slots: {
        statusbar() {
          pluginACreateCount++
          const node = new TestRenderable(renderer, `plugin-a-${pluginACreateCount}`)
          pluginANodes.push(node)
          return node
        },
      },
    })

    registerCorePlugin(registry, {
      id: "plugin-b",
      order: 10,
      slots: {
        statusbar() {
          pluginBCreateCount++
          const node = new TestRenderable(renderer, `plugin-b-${pluginBCreateCount}`)
          pluginBNodes.push(node)
          return node
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      mode: "single_winner",
    })

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-a-1"])
    expect(pluginANodes[0]?.isDestroyed).toBe(false)

    registry.updateOrder("plugin-b", -1)

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-b-1"])
    expect(pluginANodes[0]?.isDestroyed).toBe(true)
    expect(pluginBNodes[0]?.isDestroyed).toBe(false)

    registry.updateOrder("plugin-a", -2)

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-a-2"])
    expect(pluginACreateCount).toBe(2)
    expect(pluginBCreateCount).toBe(1)
    expect(pluginANodes[1]?.isDestroyed).toBe(false)
    expect(pluginBNodes[0]?.isDestroyed).toBe(true)

    handle.dispose()

    expect(pluginANodes[1]?.isDestroyed).toBe(true)
    expect(pluginBNodes[0]?.isDestroyed).toBe(true)
  })

  test("single_winner object slots use activate/deactivate lifecycle and are not host-destroyed", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const lifecycleEvents: string[] = []
    let pluginARenderCount = 0
    let pluginBRenderCount = 0
    let pluginANode: TestRenderable | null = null
    let pluginBNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-a",
      order: 0,
      slots: {
        statusbar: {
          render() {
            pluginARenderCount++
            if (!pluginANode) {
              pluginANode = new TestRenderable(renderer, "plugin-a-object")
            }
            return pluginANode
          },
          onActivate() {
            lifecycleEvents.push("a:activate")
          },
          onDeactivate() {
            lifecycleEvents.push("a:deactivate")
          },
          onDispose() {
            lifecycleEvents.push("a:dispose")
          },
        },
      },
    })

    registerCorePlugin(registry, {
      id: "plugin-b",
      order: 10,
      slots: {
        statusbar: {
          render() {
            pluginBRenderCount++
            if (!pluginBNode) {
              pluginBNode = new TestRenderable(renderer, "plugin-b-object")
            }
            return pluginBNode
          },
          onActivate() {
            lifecycleEvents.push("b:activate")
          },
          onDeactivate() {
            lifecycleEvents.push("b:deactivate")
          },
          onDispose() {
            lifecycleEvents.push("b:dispose")
          },
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      mode: "single_winner",
    })

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-a-object"])

    registry.updateOrder("plugin-b", -1)

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-b-object"])
    expect(pluginANode?.isDestroyed).toBe(false)

    registry.updateOrder("plugin-a", -2)

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-a-object"])
    expect(pluginARenderCount).toBe(2)
    expect(pluginBRenderCount).toBe(1)

    handle.dispose()

    expect(pluginANode?.isDestroyed).toBe(false)
    expect(pluginBNode?.isDestroyed).toBe(false)
    expect(lifecycleEvents).toEqual([
      "a:activate",
      "a:deactivate",
      "b:activate",
      "b:deactivate",
      "a:activate",
      "a:deactivate",
      "a:dispose",
      "b:dispose",
    ])
  })

  test("single_winner object slot dispose runs on unregister", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const lifecycleEvents: string[] = []
    let pluginNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-object",
      slots: {
        statusbar: {
          render() {
            if (!pluginNode) {
              pluginNode = new TestRenderable(renderer, "plugin-object")
            }
            return pluginNode
          },
          onActivate() {
            lifecycleEvents.push("activate")
          },
          onDeactivate() {
            lifecycleEvents.push("deactivate")
          },
          onDispose() {
            lifecycleEvents.push("dispose")
          },
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      mode: "single_winner",
    })

    registry.unregister("plugin-object")

    expect(slotMount.getChildren()).toEqual([])
    expect(pluginNode?.isDestroyed).toBe(false)
    expect(lifecycleEvents).toEqual(["activate", "deactivate", "dispose"])

    handle.dispose()
  })

  test("reports managed slot lifecycle hook failures without crashing", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const lifecycleErrors: string[] = []

    registry.onPluginError((event) => {
      lifecycleErrors.push(`${event.phase}:${event.error.message}`)
    })

    registerCorePlugin(registry, {
      id: "managed-errors",
      slots: {
        statusbar: {
          render() {
            return new TestRenderable(renderer, "managed-errors")
          },
          onActivate() {
            throw new Error("activate failed")
          },
          onDeactivate() {
            throw new Error("deactivate failed")
          },
          onDispose() {
            throw new Error("dispose failed")
          },
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      mode: "single_winner",
    })

    registry.unregister("managed-errors")

    expect(slotMount.getChildren()).toEqual([])
    expect(lifecycleErrors).toEqual(["setup:activate failed", "dispose:deactivate failed", "dispose:dispose failed"])

    handle.dispose()
  })

  test("replace mode hides fallback and renders all ordered plugins", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })

    registerCorePlugin(registry, {
      id: "late",
      order: 10,
      slots: {
        statusbar() {
          return new TestRenderable(renderer, "late-plugin")
        },
      },
    })

    registerCorePlugin(registry, {
      id: "early",
      order: 0,
      slots: {
        statusbar() {
          return new TestRenderable(renderer, "early-plugin")
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      mode: "replace",
      fallback: () => new TestRenderable(renderer, "replace-fallback"),
    })

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["early-plugin", "late-plugin"])

    handle.dispose()
  })

  test("replace mode keeps healthy plugins when one plugin render fails", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })

    registerCorePlugin(registry, {
      id: "broken-plugin",
      order: 0,
      slots: {
        statusbar() {
          throw new Error("broken render")
        },
      },
    })

    registerCorePlugin(registry, {
      id: "healthy-plugin",
      order: 10,
      slots: {
        statusbar() {
          return new TestRenderable(renderer, "healthy-plugin")
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      mode: "replace",
      fallback: () => new TestRenderable(renderer, "replace-fallback"),
    })

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["healthy-plugin"])

    handle.dispose()
  })

  test("single_winner mode falls back when winning plugin fails", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })

    registerCorePlugin(registry, {
      id: "broken-winner",
      order: 0,
      slots: {
        statusbar() {
          throw new Error("winner failed")
        },
      },
    })

    registerCorePlugin(registry, {
      id: "healthy-second",
      order: 10,
      slots: {
        statusbar() {
          return new TestRenderable(renderer, "healthy-second")
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      mode: "single_winner",
      fallback: () => new TestRenderable(renderer, "single-fallback"),
    })

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["single-fallback"])

    handle.dispose()
  })

  test("unregister removes and destroys plugin node while keeping fallback", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let fallbackCreateCount = 0
    let pluginNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-a",
      slots: {
        statusbar() {
          pluginNode = new TestRenderable(renderer, "plugin-a")
          return pluginNode
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      mode: "append",
      fallback: () => {
        fallbackCreateCount++
        return new TestRenderable(renderer, "fallback")
      },
    })

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["fallback", "plugin-a"])

    registry.unregister("plugin-a")

    expect(fallbackCreateCount).toBe(1)
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["fallback"])
    expect(pluginNode?.isDestroyed).toBe(true)

    handle.dispose()
  })

  test("clear removes mounted plugin nodes and restores fallback", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let fallbackCreateCount = 0
    let pluginNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-a",
      slots: {
        statusbar() {
          pluginNode = new TestRenderable(renderer, "plugin-a")
          return pluginNode
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      mode: "replace",
      fallback: () => {
        fallbackCreateCount++
        return new TestRenderable(renderer, "fallback")
      },
    })

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-a"])

    registry.clear()

    expect(fallbackCreateCount).toBe(1)
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["fallback"])
    expect(pluginNode?.isDestroyed).toBe(true)

    handle.dispose()
  })

  test("setMode transitions reconcile mounted output", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let pluginACreateCount = 0
    let pluginBCreateCount = 0

    registerCorePlugin(registry, {
      id: "plugin-a",
      order: 0,
      slots: {
        statusbar() {
          pluginACreateCount++
          return new TestRenderable(renderer, `plugin-a-${pluginACreateCount}`)
        },
      },
    })

    registerCorePlugin(registry, {
      id: "plugin-b",
      order: 10,
      slots: {
        statusbar() {
          pluginBCreateCount++
          return new TestRenderable(renderer, `plugin-b-${pluginBCreateCount}`)
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      mode: "append",
      fallback: () => new TestRenderable(renderer, "fallback"),
    })

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["fallback", "plugin-a-1", "plugin-b-1"])

    handle.setMode("replace")
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-a-1", "plugin-b-1"])

    handle.setMode("single_winner")
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-a-1"])

    handle.setMode("replace")
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-a-1", "plugin-b-2"])

    handle.setMode("append")
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["fallback", "plugin-a-1", "plugin-b-2"])

    handle.dispose()
  })

  test("dispose clears mounted nodes and unsubscribes from registry updates", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let fallbackNode: TestRenderable | null = null
    let pluginNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-a",
      slots: {
        statusbar() {
          pluginNode = new TestRenderable(renderer, "plugin-a")
          return pluginNode
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      fallback: () => {
        fallbackNode = new TestRenderable(renderer, "fallback")
        return fallbackNode
      },
    })

    expect(slotMount.getChildren().length).toBe(2)

    handle.dispose()

    expect(slotMount.getChildren().length).toBe(0)
    expect(fallbackNode?.isDestroyed).toBe(true)
    expect(pluginNode?.isDestroyed).toBe(true)

    registerCorePlugin(registry, {
      id: "plugin-b",
      slots: {
        statusbar() {
          return new TestRenderable(renderer, "plugin-b")
        },
      },
    })

    expect(slotMount.getChildren().length).toBe(0)
  })

  test("captures async plugin renderer failures without crashing", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const errors: string[] = []
    registry.onPluginError((event) => {
      errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.error.message}`)
    })

    registerCorePlugin(registry, {
      id: "plugin-async",
      slots: {
        statusbar() {
          return Promise.resolve(new TestRenderable(renderer, "plugin-async")) as unknown as TestRenderable
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      fallback: () => new TestRenderable(renderer, "fallback"),
    })

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["fallback"])
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("plugin-async:statusbar:render")
    expect(errors[0]).toContain("async value")

    handle.refresh()
    expect(errors.length).toBe(1)

    handle.dispose()
  })

  test("captures non-renderable plugin values without crashing", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const errors: string[] = []
    registry.onPluginError((event) => {
      errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.error.message}`)
    })

    registerCorePlugin(registry, {
      id: "plugin-invalid",
      slots: {
        statusbar() {
          return "not-a-renderable" as unknown as TestRenderable
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
    })

    expect(slotMount.getChildren()).toEqual([])
    expect(errors).toEqual(['plugin-invalid:statusbar:render:Plugin "plugin-invalid" must return a BaseRenderable'])

    handle.dispose()
  })

  test("captures plugin self-mount failures", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const errors: string[] = []
    registry.onPluginError((event) => {
      errors.push(event.error.message)
    })

    registerCorePlugin(registry, {
      id: "plugin-self",
      slots: {
        statusbar() {
          return slotMount
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
    })

    expect(slotMount.getChildren()).toEqual([])
    expect(errors[0]).toContain("mount container")

    handle.dispose()
  })

  test("captures failures when plugin returns node attached to another parent", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const errors: string[] = []
    registry.onPluginError((event) => {
      errors.push(event.error.message)
    })
    const otherParent = new TestRenderable(renderer, "other-parent")
    const attachedNode = new TestRenderable(renderer, "attached-node")
    renderer.root.add(otherParent)
    otherParent.add(attachedNode)

    registerCorePlugin(registry, {
      id: "plugin-attached",
      slots: {
        statusbar() {
          return attachedNode
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
    })

    expect(attachedNode.parent).toBe(otherParent)
    expect(slotMount.getChildren()).toEqual([])
    expect(errors[0]).toContain("already attached to another parent")

    handle.dispose()
  })

  test("renders plugin failure placeholder only when configured", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })

    registerCorePlugin(registry, {
      id: "broken-plugin",
      slots: {
        statusbar() {
          throw new Error("plugin exploded")
        },
      },
    })

    const handleWithoutPlaceholder = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      fallback: () => new TestRenderable(renderer, "fallback"),
    })

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["fallback"])
    handleWithoutPlaceholder.dispose()

    const handleWithPlaceholder = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      fallback: () => new TestRenderable(renderer, "fallback"),
      pluginFailurePlaceholder(failure) {
        return new TestRenderable(renderer, `error-${failure.pluginId}`)
      },
    })

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["fallback", "error-broken-plugin"])
    handleWithPlaceholder.dispose()
  })

  test("replace mode uses fallback when plugin fails and no placeholder is configured", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })

    registerCorePlugin(registry, {
      id: "broken-plugin",
      slots: {
        statusbar() {
          throw new Error("plugin exploded")
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      mode: "replace",
      fallback: () => new TestRenderable(renderer, "fallback"),
    })

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["fallback"])
    handle.dispose()
  })

  test("reports placeholder renderer failures separately", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const errors: string[] = []
    registry.onPluginError((event) => {
      errors.push(`${event.phase}:${event.error.message}`)
    })

    registerCorePlugin(registry, {
      id: "broken-plugin",
      slots: {
        statusbar() {
          throw new Error("plugin render failed")
        },
      },
    })

    const handle = mountCoreSlot({
      registry,
      name: "statusbar",
      mount: slotMount,
      fallback: () => new TestRenderable(renderer, "fallback"),
      pluginFailurePlaceholder() {
        throw new Error("placeholder failed")
      },
    })

    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["fallback"])
    expect(errors).toEqual(["render:plugin render failed", "error_placeholder:placeholder failed"])

    handle.dispose()
  })

  test("cleans up plugin nodes when fallback renderer fails", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let pluginNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-a",
      slots: {
        statusbar() {
          pluginNode = new TestRenderable(renderer, "plugin-a")
          return pluginNode
        },
      },
    })

    expect(() => {
      mountCoreSlot({
        registry,
        name: "statusbar",
        mount: slotMount,
        mode: "append",
        fallback: () => {
          return Promise.resolve(new TestRenderable(renderer, "fallback")) as unknown as TestRenderable
        },
      })
    }).toThrow("async value")

    expect(pluginNode?.isDestroyed).toBe(true)
    expect(slotMount.getChildren()).toEqual([])
  })
})
