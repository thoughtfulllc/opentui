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

  it("uses deterministic replace behavior with ordered plugins", async () => {
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
    expect(frame).not.toContain("late-plugin")
    expect(frame).not.toContain("replace-fallback")
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
})
