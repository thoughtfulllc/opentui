import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createTestRenderer, type TestRendererOptions } from "@opentui/core/testing"
import { createContext, createComponent, useContext, type JSX } from "solid-js"
import { createSlot, createSolidSlotRegistry, type SolidPlugin } from "../src/plugins/slot"
import { _render as renderInternal } from "../src/reconciler"
import { RendererContext } from "../src/elements"

interface AppSlots {
  statusbar: { user: string }
  sidebar: { items: string[] }
}

const hostContext = {
  appName: "solid-slot-tests",
  version: "1.0.0",
}

let testSetup: Awaited<ReturnType<typeof createTestRenderer>>

async function setupSlotTest(
  createNode: (registry: ReturnType<typeof createSolidSlotRegistry<AppSlots>>) => JSX.Element,
  options: TestRendererOptions,
) {
  let isDisposed = false
  let dispose: (() => void) | undefined

  const setup = await createTestRenderer({
    ...options,
    onDestroy: () => {
      if (!isDisposed) {
        isDisposed = true
        dispose?.()
      }
      options.onDestroy?.()
    },
  })

  const registry = createSolidSlotRegistry<AppSlots>(setup.renderer, hostContext)

  dispose = renderInternal(
    () =>
      createComponent(RendererContext.Provider, {
        get value() {
          return setup.renderer
        },
        get children() {
          return createNode(registry)
        },
      }),
    setup.renderer.root,
  )

  return { setup, registry }
}

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
    const plugin: SolidPlugin<AppSlots, typeof hostContext> = {
      id: "append-plugin",
      slots: {
        statusbar(ctx, props) {
          return <text>{`plugin:${ctx.appName}:${props.user}`}</text>
        },
      },
    }

    const { setup } = await setupSlotTest(
      (registry) => {
        registry.register(plugin)
        const Slot = createSlot(registry)
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
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("base-content")
    expect(frame).toContain("plugin:solid-slot-tests:ava")
  })

  it("uses deterministic replace behavior with ordered plugins", async () => {
    const { setup } = await setupSlotTest(
      (registry) => {
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

        const Slot = createSlot(registry)
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

    const plugin: SolidPlugin<AppSlots> = {
      id: "dynamic-plugin",
      slots: {
        statusbar() {
          return <text>dynamic-plugin</text>
        },
      },
    }

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

    const ContextReader = () => {
      const value = useContext(ValueContext)
      return <text>{`ctx:${value}`}</text>
    }

    const { setup } = await setupSlotTest(
      (registry) => {
        registry.register({
          id: "context-plugin",
          slots: {
            statusbar() {
              return <ContextReader />
            },
          },
        })

        const Slot = createSlot(registry)
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
})
