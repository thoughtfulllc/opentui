import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createContext, useContext } from "solid-js"
import { testRender } from "../index"
import { createSlot, createSolidSlotRegistry, type SolidPlugin } from "../src/plugins/slot"

interface AppSlots {
  statusbar: { user: string }
  sidebar: { items: string[] }
}

const hostContext = {
  appName: "solid-slot-tests",
  version: "1.0.0",
}

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("Solid Slot System", () => {
  beforeEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  it("renders fallback content when no plugin matches", async () => {
    const registry = createSolidSlotRegistry<AppSlots>(hostContext)
    const Slot = createSlot(registry)

    testSetup = await testRender(
      () => (
        <Slot name="statusbar" user="sam">
          <text>fallback-only</text>
        </Slot>
      ),
      { width: 50, height: 6 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("fallback-only")
  })

  it("appends plugin output after fallback content by default", async () => {
    const registry = createSolidSlotRegistry<AppSlots>(hostContext)
    const Slot = createSlot(registry)

    const plugin: SolidPlugin<AppSlots> = {
      id: "append-plugin",
      slots: {
        statusbar(ctx, props) {
          return <text>{`plugin:${ctx.appName}:${props.user}`}</text>
        },
      },
    }

    registry.register(plugin)

    testSetup = await testRender(
      () => (
        <Slot name="statusbar" user="ava">
          <text>base-content</text>
        </Slot>
      ),
      { width: 60, height: 6 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("base-content")
    expect(frame).toContain("plugin:solid-slot-tests:ava")
  })

  it("uses deterministic replace behavior with ordered plugins", async () => {
    const registry = createSolidSlotRegistry<AppSlots>(hostContext)
    const Slot = createSlot(registry)

    registry.register({
      id: "late",
      order: 10,
      slots: {
        statusbar() {
          return <text>late-plugin</text>
        },
      },
    })

    registry.register({
      id: "early",
      order: 0,
      slots: {
        statusbar() {
          return <text>early-plugin</text>
        },
      },
    })

    testSetup = await testRender(
      () => (
        <Slot name="statusbar" user="lee" mode="replace">
          <text>replace-fallback</text>
        </Slot>
      ),
      { width: 40, height: 6 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("early-plugin")
    expect(frame).not.toContain("late-plugin")
    expect(frame).not.toContain("replace-fallback")
  })

  it("reacts to plugin registration and unregistering", async () => {
    const registry = createSolidSlotRegistry<AppSlots>(hostContext)
    const Slot = createSlot(registry)

    const plugin: SolidPlugin<AppSlots> = {
      id: "dynamic-plugin",
      slots: {
        statusbar() {
          return <text>dynamic-plugin</text>
        },
      },
    }

    testSetup = await testRender(
      () => (
        <Slot name="statusbar" user="kai" mode="replace">
          <text>dynamic-fallback</text>
        </Slot>
      ),
      { width: 40, height: 6 },
    )

    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain("dynamic-fallback")

    registry.register(plugin)
    await testSetup.renderOnce()
    const withPlugin = testSetup.captureCharFrame()
    expect(withPlugin).toContain("dynamic-plugin")
    expect(withPlugin).not.toContain("dynamic-fallback")

    registry.unregister("dynamic-plugin")
    await testSetup.renderOnce()
    const withoutPlugin = testSetup.captureCharFrame()
    expect(withoutPlugin).toContain("dynamic-fallback")
    expect(withoutPlugin).not.toContain("dynamic-plugin")
  })

  it("renders plugin nodes within provider context", async () => {
    const ValueContext = createContext("missing")
    const registry = createSolidSlotRegistry<AppSlots>(hostContext)
    const Slot = createSlot(registry)

    const ContextReader = () => {
      const value = useContext(ValueContext)
      return <text>{`ctx:${value}`}</text>
    }

    registry.register({
      id: "context-plugin",
      slots: {
        statusbar() {
          return <ContextReader />
        },
      },
    })

    testSetup = await testRender(
      () => (
        <ValueContext.Provider value="inside-provider">
          <Slot name="statusbar" user="max" />
        </ValueContext.Provider>
      ),
      { width: 60, height: 6 },
    )

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("ctx:inside-provider")
  })
})
