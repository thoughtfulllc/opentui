import { describe, expect, test } from "bun:test"
import { EventEmitter } from "events"
import { CliRenderEvents, createSlotRegistry, SlotRegistry, type CliRenderer, type Plugin } from "../renderer"

interface AppSlots {
  statusbar: { user: string }
  sidebar: { items: string[] }
}

type TestNode = string
type TestPlugin = Plugin<TestNode, AppSlots>

const hostContext = {
  appName: "slot-test-app",
  version: "1.0.0",
}

describe("SlotRegistry", () => {
  test("resolves no renderers for missing slot contributions", () => {
    const registry = new SlotRegistry<TestNode, AppSlots>(hostContext)
    expect(registry.resolve("statusbar")).toEqual([])
  })

  test("supports plugin setup and dispose lifecycles", () => {
    const calls: string[] = []
    const registry = new SlotRegistry<TestNode, AppSlots>(hostContext)

    registry.register({
      id: "lifecycle-plugin",
      setup(ctx) {
        calls.push(`setup:${ctx.appName}:${ctx.version}`)
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

    expect(calls).toEqual(["setup:slot-test-app:1.0.0", "dispose"])
  })

  test("rejects duplicate plugin ids", () => {
    const registry = new SlotRegistry<TestNode, AppSlots>(hostContext)

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
    const registry = new SlotRegistry<TestNode, AppSlots>(hostContext)

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
    const registry = new SlotRegistry<TestNode, AppSlots>(hostContext)
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
    const registry = new SlotRegistry<TestNode, AppSlots>(hostContext)

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
    const registry = new SlotRegistry<TestNode, AppSlots>(hostContext)

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
    const rendererA = new EventEmitter() as CliRenderer
    const rendererB = new EventEmitter() as CliRenderer

    const aFirst = createSlotRegistry<string, AppSlots>(rendererA, "demo-key", hostContext)
    const aSecond = createSlotRegistry<string, AppSlots>(rendererA, "demo-key", hostContext)
    const aOtherKey = createSlotRegistry<string, AppSlots>(rendererA, "other-key", hostContext)
    const bFirst = createSlotRegistry<string, AppSlots>(rendererB, "demo-key", hostContext)

    expect(aFirst).toBe(aSecond)
    expect(aFirst).not.toBe(aOtherKey)
    expect(aFirst).not.toBe(bFirst)
  })

  test("slot registry clears plugins on renderer destroy", () => {
    const renderer = new EventEmitter() as CliRenderer
    const disposeCalls: string[] = []

    const registry = createSlotRegistry<string, AppSlots>(renderer, "cleanup-key", hostContext)
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

    renderer.emit(CliRenderEvents.DESTROY)

    expect(disposeCalls).toEqual(["disposed"])

    const recreated = createSlotRegistry<string, AppSlots>(renderer, "cleanup-key", hostContext)
    expect(recreated).not.toBe(registry)
  })
})
