import { describe, expect, test } from "bun:test"
import { EventEmitter } from "events"
import { createSlotRegistry, SlotRegistry } from "../plugins/registry"
import type { Plugin } from "../plugins/types"
import type { CliRenderer } from "../renderer"

interface AppSlots {
  statusbar: { user: string }
  sidebar: { items: string[] }
}

type TestNode = string
type AppContext = {
  appName: string
  version: string
}

type TestPlugin = Plugin<TestNode, AppSlots, AppContext>

const hostContext: AppContext = {
  appName: "slot-test-app",
  version: "1.0.0",
}

function createMockRenderer(): CliRenderer {
  return new EventEmitter() as CliRenderer
}

describe("SlotRegistry", () => {
  test("resolves no renderers for missing slot contributions", () => {
    const registry = new SlotRegistry<TestNode, AppSlots, AppContext>(createMockRenderer(), hostContext)
    expect(registry.resolve("statusbar")).toEqual([])
  })

  test("supports plugin setup and dispose lifecycles", () => {
    const calls: string[] = []
    const renderer = createMockRenderer()
    const registry = new SlotRegistry<TestNode, AppSlots, AppContext>(renderer, hostContext)

    registry.register({
      id: "lifecycle-plugin",
      setup(ctx, setupRenderer) {
        calls.push(`setup:${ctx.appName}:${ctx.version}:${setupRenderer === renderer ? "same" : "different"}`)
      },
      dispose() {
        calls.push("dispose")
      },
      slots: {
        statusbar(_ctx, props) {
          return `status:${props.user}`
        },
      },
    })

    registry.unregister("lifecycle-plugin")

    expect(calls).toEqual(["setup:slot-test-app:1.0.0:same", "dispose"])
  })

  test("register accepts class-based plugin instances", () => {
    const renderer = createMockRenderer()
    const registry = new SlotRegistry<TestNode, AppSlots, AppContext>(renderer, hostContext)

    class ClassPlugin implements Plugin<TestNode, AppSlots, AppContext> {
      id = "class-plugin"
      order = 0
      setupCalls = 0
      disposeCalls = 0
      rendererSeen: CliRenderer | null = null
      prefix = "class"

      setup(ctx: Readonly<AppContext>, setupRenderer: CliRenderer): void {
        this.setupCalls++
        this.rendererSeen = setupRenderer
        this.prefix = ctx.appName
      }

      dispose(): void {
        this.disposeCalls++
      }

      slots = {
        statusbar: (_ctx: Readonly<AppContext>, props: AppSlots["statusbar"]) => `${this.prefix}:${props.user}`,
      }
    }

    const plugin = new ClassPlugin()
    registry.register(plugin)

    const output = registry.resolve("statusbar")[0](hostContext, { user: "sam" })
    registry.unregister(plugin.id)

    expect(output).toBe("slot-test-app:sam")
    expect(plugin.setupCalls).toBe(1)
    expect(plugin.disposeCalls).toBe(1)
    expect(plugin.rendererSeen).toBe(renderer)
  })

  test("rejects duplicate plugin ids", () => {
    const registry = new SlotRegistry<TestNode, AppSlots, AppContext>(createMockRenderer(), hostContext)

    const plugin: TestPlugin = {
      id: "duplicate",
      slots: {
        statusbar(_ctx, props) {
          return props.user
        },
      },
    }

    registry.register(plugin)

    expect(() => {
      registry.register(plugin)
    }).toThrow('Plugin with id "duplicate" is already registered')
  })

  test("sorts renderers deterministically by order then registration order", () => {
    const registry = new SlotRegistry<TestNode, AppSlots, AppContext>(createMockRenderer(), hostContext)

    registry.register({
      id: "z-registered-first",
      order: 0,
      slots: {
        statusbar() {
          return "z-first"
        },
      },
    })

    registry.register({
      id: "a-registered-second",
      order: 0,
      slots: {
        statusbar() {
          return "a-second"
        },
      },
    })

    registry.register({
      id: "high-order",
      order: 10,
      slots: {
        statusbar() {
          return "high"
        },
      },
    })

    registry.register({
      id: "low-order",
      order: -10,
      slots: {
        statusbar() {
          return "low"
        },
      },
    })

    const output = registry.resolve("statusbar").map((renderer) => renderer(hostContext, { user: "sam" }))
    expect(output).toEqual(["low", "z-first", "a-second", "high"])
  })

  test("supports order updates and emits subscription notifications", () => {
    const registry = new SlotRegistry<TestNode, AppSlots, AppContext>(createMockRenderer(), hostContext)
    let notifyCount = 0

    const unsubscribe = registry.subscribe(() => {
      notifyCount++
    })

    registry.register({
      id: "first",
      order: 5,
      slots: {
        statusbar() {
          return "first"
        },
      },
    })

    registry.register({
      id: "second",
      order: 10,
      slots: {
        statusbar() {
          return "second"
        },
      },
    })

    const changed = registry.updateOrder("second", 0)
    expect(changed).toBe(true)

    const output = registry.resolve("statusbar").map((renderer) => renderer(hostContext, { user: "sam" }))
    expect(output).toEqual(["second", "first"])

    unsubscribe()
    registry.unregister("first")

    expect(notifyCount).toBe(3)
  })

  test("supports multiple slot contributions per plugin", () => {
    const registry = new SlotRegistry<TestNode, AppSlots, AppContext>(createMockRenderer(), hostContext)

    registry.register({
      id: "multi-slot",
      slots: {
        statusbar(_ctx, props) {
          return `status:${props.user}`
        },
        sidebar(_ctx, props) {
          return `sidebar:${props.items.join(",")}`
        },
      },
    })

    const statusbarRenderer = registry.resolve("statusbar")[0]
    const sidebarRenderer = registry.resolve("sidebar")[0]

    expect(statusbarRenderer(hostContext, { user: "ava" })).toBe("status:ava")
    expect(sidebarRenderer(hostContext, { items: ["a", "b"] })).toBe("sidebar:a,b")
  })

  test("resolveEntries returns sorted plugin ids with renderers", () => {
    const registry = new SlotRegistry<TestNode, AppSlots, AppContext>(createMockRenderer(), hostContext)

    registry.register({
      id: "plugin-b",
      order: 2,
      slots: {
        statusbar() {
          return "b"
        },
      },
    })

    registry.register({
      id: "plugin-a",
      order: 1,
      slots: {
        statusbar() {
          return "a"
        },
      },
    })

    const entries = registry.resolveEntries("statusbar")
    expect(entries.map((entry) => entry.id)).toEqual(["plugin-a", "plugin-b"])
    expect(entries.map((entry) => entry.renderer(hostContext, { user: "sam" }))).toEqual(["a", "b"])
  })

  test("slot registries are isolated per renderer and key", () => {
    const rendererA = createMockRenderer()
    const rendererB = createMockRenderer()

    const aFirst = createSlotRegistry<string, AppSlots, AppContext>(rendererA, "demo-key", hostContext)
    const aSecond = createSlotRegistry<string, AppSlots, AppContext>(rendererA, "demo-key", hostContext)
    const aOtherKey = createSlotRegistry<string, AppSlots, AppContext>(rendererA, "other-key", hostContext)
    const bFirst = createSlotRegistry<string, AppSlots, AppContext>(rendererB, "demo-key", hostContext)

    expect(aFirst).toBe(aSecond)
    expect(aFirst).not.toBe(aOtherKey)
    expect(aFirst).not.toBe(bFirst)

    expect(() => {
      createSlotRegistry<string, AppSlots, AppContext>(rendererA, "demo-key", {
        appName: "other-app",
        version: "2.0.0",
      })
    }).toThrow("different context")
  })

  test("slot registry clears plugins on renderer destroy", () => {
    const renderer = createMockRenderer()
    const disposeCalls: string[] = []

    const registry = createSlotRegistry<string, AppSlots, AppContext>(renderer, "cleanup-key", hostContext)
    registry.register({
      id: "cleanup-plugin",
      dispose() {
        disposeCalls.push("disposed")
      },
      slots: {
        statusbar() {
          return "cleanup"
        },
      },
    })

    renderer.emit("destroy")

    expect(disposeCalls).toEqual(["disposed"])

    const recreated = createSlotRegistry<string, AppSlots, AppContext>(renderer, "cleanup-key", hostContext)
    expect(recreated).not.toBe(registry)
  })

  test("does not register plugin when setup throws", () => {
    const registry = new SlotRegistry<TestNode, AppSlots, AppContext>(createMockRenderer(), hostContext)
    let notifyCount = 0
    registry.subscribe(() => {
      notifyCount++
    })

    expect(() => {
      registry.register({
        id: "setup-failure",
        setup() {
          throw new Error("setup failed")
        },
        slots: {
          statusbar() {
            return "should-not-register"
          },
        },
      })
    }).toThrow("setup failed")

    expect(registry.resolve("statusbar")).toEqual([])
    expect(notifyCount).toBe(0)

    registry.register({
      id: "setup-failure",
      slots: {
        statusbar() {
          return "registered-after-failure"
        },
      },
    })

    expect(registry.resolve("statusbar").map((renderer) => renderer(hostContext, { user: "sam" }))).toEqual([
      "registered-after-failure",
    ])
  })

  test("unregister removes plugin and notifies even if dispose throws", () => {
    const registry = new SlotRegistry<TestNode, AppSlots, AppContext>(createMockRenderer(), hostContext)
    let notifyCount = 0
    registry.subscribe(() => {
      notifyCount++
    })

    registry.register({
      id: "dispose-failure",
      dispose() {
        throw new Error("dispose failed")
      },
      slots: {
        statusbar() {
          return "present-before-unregister"
        },
      },
    })

    expect(() => {
      registry.unregister("dispose-failure")
    }).toThrow("dispose failed")

    expect(registry.resolve("statusbar")).toEqual([])
    expect(notifyCount).toBe(2)
  })

  test("clear disposes every plugin and throws first dispose error", () => {
    const registry = new SlotRegistry<TestNode, AppSlots, AppContext>(createMockRenderer(), hostContext)
    const disposeCalls: string[] = []

    registry.register({
      id: "first-error",
      dispose() {
        disposeCalls.push("first-error")
        throw new Error("first dispose error")
      },
      slots: {
        statusbar() {
          return "first"
        },
      },
    })

    registry.register({
      id: "second-error",
      dispose() {
        disposeCalls.push("second-error")
        throw new Error("second dispose error")
      },
      slots: {
        statusbar() {
          return "second"
        },
      },
    })

    registry.register({
      id: "clean-dispose",
      dispose() {
        disposeCalls.push("clean-dispose")
      },
      slots: {
        statusbar() {
          return "third"
        },
      },
    })

    expect(() => {
      registry.clear()
    }).toThrow("first dispose error")

    expect(disposeCalls).toEqual(["first-error", "second-error", "clean-dispose"])
    expect(registry.resolve("statusbar")).toEqual([])
  })
})
