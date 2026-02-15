import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createTestRenderer, type TestRendererOptions } from "@opentui/core/testing"
import { createContext, useContext, useEffect, useState } from "react"
import { act, type ReactNode } from "react"
import { createReactSlotRegistry, createSlot, type ReactPlugin } from "../src/plugins/slot"
import { createRoot, type Root } from "../src/reconciler/renderer"

interface AppSlots {
  statusbar: { user: string }
  sidebar: { items: string[] }
}

const hostContext = {
  appName: "react-slot-tests",
  version: "1.0.0",
}

let testSetup: Awaited<ReturnType<typeof createTestRenderer>>

function setIsReactActEnvironment(isReactActEnvironment: boolean) {
  // @ts-expect-error - this is a test environment
  globalThis.IS_REACT_ACT_ENVIRONMENT = isReactActEnvironment
}

async function setupSlotTest(
  createNode: (registry: ReturnType<typeof createReactSlotRegistry<AppSlots>>) => ReactNode,
  options: TestRendererOptions,
) {
  let root: Root | null = null
  setIsReactActEnvironment(true)

  const setup = await createTestRenderer({
    ...options,
    onDestroy() {
      act(() => {
        if (root) {
          root.unmount()
          root = null
        }
      })
      options.onDestroy?.()
      setIsReactActEnvironment(false)
    },
  })

  const registry = createReactSlotRegistry<AppSlots>(setup.renderer, hostContext)
  root = createRoot(setup.renderer)

  act(() => {
    if (root) {
      root.render(createNode(registry))
    }
  })

  return { setup, registry }
}

describe("React Slot System", () => {
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

  it("reuses one registry per renderer and rejects different context", async () => {
    const setup = await createTestRenderer({ width: 20, height: 4 })
    testSetup = setup

    const context = { appName: "react-slot-tests", version: "1.0.0" }
    const first = createReactSlotRegistry<AppSlots, typeof context>(setup.renderer, context)
    const second = createReactSlotRegistry<AppSlots, typeof context>(setup.renderer, context)

    expect(first).toBe(second)

    expect(() => {
      createReactSlotRegistry<AppSlots, typeof context>(setup.renderer, { appName: "other", version: "2.0.0" })
    }).toThrow("different context")
  })

  it("renders fallback content when no plugin matches", async () => {
    const { setup } = await setupSlotTest(
      (registry) => {
        const Slot = createSlot(registry)
        return (
          <Slot name="statusbar" user="sam">
            <text>fallback-only</text>
          </Slot>
        )
      },
      { width: 50, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("fallback-only")
  })

  it("appends plugin output after fallback content by default", async () => {
    const plugin: ReactPlugin<AppSlots, typeof hostContext> = {
      id: "append-plugin",
      slots: {
        statusbar(ctx, props) {
          return <text>{`plugin:${ctx.appName}:${props.user}`}</text>
        },
      },
    }

    const { setup, registry } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register(plugin)
        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="ava">
            <text>base-content</text>
          </Slot>
        )
      },
      { width: 60, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("base-content")
    expect(frame).toContain("plugin:react-slot-tests:ava")
  })

  it("replace mode hides fallback and renders all ordered plugins", async () => {
    const { setup, registry } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "late",
          order: 10,
          slots: {
            statusbar() {
              return <text>late-plugin</text>
            },
          },
        })

        slotRegistry.register({
          id: "early",
          order: 0,
          slots: {
            statusbar() {
              return <text>early-plugin</text>
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="lee" mode="replace">
            <text>replace-fallback</text>
          </Slot>
        )
      },
      { width: 40, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("early-plugin")
    expect(frame).toContain("late-plugin")
    expect(frame).not.toContain("replace-fallback")
  })

  it("single_winner mode renders only the highest-priority plugin", async () => {
    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "late",
          order: 10,
          slots: {
            statusbar() {
              return <text>late-plugin</text>
            },
          },
        })

        slotRegistry.register({
          id: "early",
          order: 0,
          slots: {
            statusbar() {
              return <text>early-plugin</text>
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="lee" mode="single_winner">
            <text>single-fallback</text>
          </Slot>
        )
      },
      { width: 40, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("early-plugin")
    expect(frame).not.toContain("late-plugin")
    expect(frame).not.toContain("single-fallback")
  })

  it("replace mode keeps healthy plugin output when another plugin fails", async () => {
    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "broken-plugin",
          order: 0,
          slots: {
            statusbar() {
              throw new Error("broken render")
            },
          },
        })

        slotRegistry.register({
          id: "healthy-plugin",
          order: 10,
          slots: {
            statusbar() {
              return <text>healthy-plugin</text>
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="lee" mode="replace">
            <text>replace-fallback</text>
          </Slot>
        )
      },
      { width: 50, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("healthy-plugin")
    expect(frame).not.toContain("replace-fallback")
  })

  it("single_winner mode falls back when highest-priority plugin fails", async () => {
    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "broken-winner",
          order: 0,
          slots: {
            statusbar() {
              throw new Error("winner failed")
            },
          },
        })

        slotRegistry.register({
          id: "healthy-second",
          order: 10,
          slots: {
            statusbar() {
              return <text>healthy-second</text>
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="lee" mode="single_winner">
            <text>single-fallback</text>
          </Slot>
        )
      },
      { width: 50, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("single-fallback")
    expect(frame).not.toContain("healthy-second")
  })

  it("reacts to plugin registration and unregistering", async () => {
    const { setup, registry } = await setupSlotTest(
      (slotRegistry) => {
        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="kai" mode="replace">
            <text>dynamic-fallback</text>
          </Slot>
        )
      },
      { width: 40, height: 6 },
    )
    testSetup = setup

    const plugin: ReactPlugin<AppSlots> = {
      id: "dynamic-plugin",
      slots: {
        statusbar() {
          return <text>dynamic-plugin</text>
        },
      },
    }

    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain("dynamic-fallback")

    act(() => {
      registry.register(plugin)
    })
    await testSetup.renderOnce()
    const withPlugin = testSetup.captureCharFrame()
    expect(withPlugin).toContain("dynamic-plugin")
    expect(withPlugin).not.toContain("dynamic-fallback")

    act(() => {
      registry.unregister("dynamic-plugin")
    })
    await testSetup.renderOnce()
    const withoutPlugin = testSetup.captureCharFrame()
    expect(withoutPlugin).toContain("dynamic-fallback")
    expect(withoutPlugin).not.toContain("dynamic-plugin")
  })

  it("renders plugin nodes within provider context", async () => {
    const ValueContext = createContext("missing")

    function ContextReader() {
      const value = useContext(ValueContext)
      return <text>{`ctx:${value}`}</text>
    }

    const { setup, registry } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "context-plugin",
          slots: {
            statusbar() {
              return <ContextReader />
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <ValueContext.Provider value="inside-provider">
            <Slot name="statusbar" user="max" />
          </ValueContext.Provider>
        )
      },
      { width: 60, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("ctx:inside-provider")
  })

  it("keeps plugin identity stable when append order changes", async () => {
    const mountLog: string[] = []

    function StatefulPluginNode({ pluginId }: { pluginId: string }) {
      const [createdBy] = useState(pluginId)

      useEffect(() => {
        mountLog.push(`mount:${pluginId}:${createdBy}`)
        return () => {
          mountLog.push(`unmount:${pluginId}:${createdBy}`)
        }
      }, [pluginId, createdBy])

      return <text>{`${pluginId}:${createdBy}`}</text>
    }

    const { setup, registry } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "alpha",
          order: 0,
          slots: {
            statusbar() {
              return <StatefulPluginNode pluginId="alpha" />
            },
          },
        })

        slotRegistry.register({
          id: "beta",
          order: 10,
          slots: {
            statusbar() {
              return <StatefulPluginNode pluginId="beta" />
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return <Slot name="statusbar" user="sam" />
      },
      { width: 80, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const beforeReorder = testSetup.captureCharFrame()

    expect(beforeReorder).toContain("alpha:alpha")
    expect(beforeReorder).toContain("beta:beta")

    act(() => {
      registry.updateOrder("beta", -1)
    })

    await testSetup.renderOnce()
    const afterReorder = testSetup.captureCharFrame()

    expect(afterReorder).toContain("beta:beta")
    expect(afterReorder).toContain("alpha:alpha")
    expect(afterReorder).not.toContain("beta:alpha")
    expect(afterReorder).not.toContain("alpha:beta")
    expect(mountLog).toEqual(["mount:alpha:alpha", "mount:beta:beta"])
  })

  it("captures plugin render invocation errors and reports plugin metadata", async () => {
    const errors: string[] = []

    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.onPluginError((event) => {
          errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.source}:${event.error.message}`)
        })

        slotRegistry.register({
          id: "broken-plugin",
          slots: {
            statusbar() {
              throw new Error("render failed")
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="sam">
            <text>fallback-visible</text>
          </Slot>
        )
      },
      { width: 70, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("fallback-visible")
    expect(errors).toEqual(["broken-plugin:statusbar:render:react:render failed"])
  })

  it("replace mode falls back when plugin fails and no placeholder is configured", async () => {
    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "broken-plugin",
          slots: {
            statusbar() {
              throw new Error("render failed")
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="sam" mode="replace">
            <text>replace-fallback-visible</text>
          </Slot>
        )
      },
      { width: 70, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("replace-fallback-visible")
  })

  it("catches plugin subtree errors via per-plugin boundary", async () => {
    const errors: string[] = []

    function ExplodingPluginNode() {
      throw new Error("component exploded")
    }

    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.onPluginError((event) => {
          errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.error.message}`)
        })

        slotRegistry.register({
          id: "exploding-component-plugin",
          slots: {
            statusbar() {
              return <ExplodingPluginNode />
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="sam">
            <text>safe-host-content</text>
          </Slot>
        )
      },
      { width: 80, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("safe-host-content")
    expect(errors).toEqual(["exploding-component-plugin:statusbar:render:component exploded"])
  })

  it("renders optional plugin failure placeholder when configured", async () => {
    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "broken-plugin",
          slots: {
            statusbar() {
              throw new Error("render failed")
            },
          },
        })

        const Slot = createSlot(slotRegistry, {
          pluginFailurePlaceholder(failure) {
            return <text>{`plugin-error:${failure.pluginId}:${failure.slot}`}</text>
          },
        })

        return (
          <Slot name="statusbar" user="sam">
            <text>fallback-visible</text>
          </Slot>
        )
      },
      { width: 80, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("fallback-visible")
    expect(frame).toContain("plugin-error:broken-plugin:statusbar")
  })
})
