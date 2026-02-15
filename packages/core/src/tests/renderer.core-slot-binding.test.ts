import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Renderable } from "../Renderable"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer"
import { createCoreSlotRegistry, mountCoreSlot, registerCorePlugin } from "../plugins/slot"

type AppSlot = "statusbar"

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
    const first = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const second = createCoreSlotRegistry<AppSlot>(renderer, { appName: "other", version: "2.0.0" })

    expect(first).toBe(second)
    expect(first.context.appName).toBe("core-only")
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

  test("replace mode swaps active plugin without recreating previous active instance", () => {
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
      mode: "replace",
    })

    expect(pluginACreateCount).toBe(1)
    expect(pluginBCreateCount).toBe(0)
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-a-1"])

    registry.updateOrder("plugin-b", -1)

    expect(pluginACreateCount).toBe(1)
    expect(pluginBCreateCount).toBe(1)
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-b-1"])

    registry.updateOrder("plugin-a", -2)

    expect(pluginACreateCount).toBe(1)
    expect(pluginBCreateCount).toBe(1)
    expect(slotMount.getChildren().map((child) => child.id)).toEqual(["plugin-a-1"])

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

  test("throws for async plugin renderers", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })

    registerCorePlugin(registry, {
      id: "plugin-async",
      slots: {
        statusbar() {
          return Promise.resolve(new TestRenderable(renderer, "plugin-async")) as unknown as TestRenderable
        },
      },
    })

    expect(() => {
      mountCoreSlot({
        registry,
        name: "statusbar",
        mount: slotMount,
      })
    }).toThrow("async value")
  })

  test("throws for non-renderable plugin values", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })

    registerCorePlugin(registry, {
      id: "plugin-invalid",
      slots: {
        statusbar() {
          return "not-a-renderable" as unknown as TestRenderable
        },
      },
    })

    expect(() => {
      mountCoreSlot({
        registry,
        name: "statusbar",
        mount: slotMount,
      })
    }).toThrow("must return a BaseRenderable")
  })

  test("throws when plugin returns mount container", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })

    registerCorePlugin(registry, {
      id: "plugin-self",
      slots: {
        statusbar() {
          return slotMount
        },
      },
    })

    expect(() => {
      mountCoreSlot({
        registry,
        name: "statusbar",
        mount: slotMount,
      })
    }).toThrow("mount container")
  })

  test("throws when plugin returns node attached to another parent", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
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

    expect(() => {
      mountCoreSlot({
        registry,
        name: "statusbar",
        mount: slotMount,
      })
    }).toThrow("already attached to another parent")

    expect(attachedNode.parent).toBe(otherParent)
    expect(slotMount.getChildren()).toEqual([])
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
