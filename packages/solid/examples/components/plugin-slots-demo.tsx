import type { PluginErrorEvent } from "@opentui/core"
import {
  createSlot,
  createSolidSlotRegistry,
  type SlotMode,
  type SolidPlugin,
  useKeyboard,
  useRenderer,
} from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"

type DemoSlots = {
  statusbar: { label: string }
  sidebar: { section: string }
}

const hostContext = {
  appName: "solid-plugin-slots-demo",
  version: "1.0.0",
}

function formatPluginError(event: PluginErrorEvent): string {
  return `${event.pluginId} [${event.phase}/${event.source}] @ ${event.slot ?? "<none>"}: ${event.error.message}`
}

const CrashNode = (props: { pluginId: string }) => {
  throw new Error(`Forced subtree crash in ${props.pluginId}`)
  return null as unknown as JSX.Element
}

function createClockPlugin(crash: boolean): SolidPlugin<DemoSlots, typeof hostContext> {
  return {
    id: "clock-plugin",
    order: 0,
    slots: {
      statusbar(_ctx, props) {
        if (crash) {
          return <CrashNode pluginId="clock-plugin" />
        }

        return (
          <box
            border
            borderStyle="single"
            borderColor="#2563eb"
            marginLeft={1}
            paddingLeft={1}
            paddingRight={1}
            height={3}
          >
            <text fg="#93c5fd">{`Clock plugin -> ${props.label}`}</text>
          </box>
        )
      },
      sidebar() {
        return (
          <box
            border
            borderStyle="single"
            borderColor="#0ea5e9"
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg="#38bdf8">Clock Sidebar</text>
            <text fg="#e2e8f0">Healthy</text>
          </box>
        )
      },
    },
  }
}

function createActivityPlugin(crash: boolean): SolidPlugin<DemoSlots, typeof hostContext> {
  return {
    id: "activity-plugin",
    order: 10,
    slots: {
      statusbar() {
        if (crash) {
          throw new Error("Forced activity render failure")
        }

        return (
          <box
            border
            borderStyle="single"
            borderColor="#16a34a"
            marginLeft={1}
            paddingLeft={1}
            paddingRight={1}
            height={3}
          >
            <text fg="#86efac">Activity plugin healthy</text>
          </box>
        )
      },
    },
  }
}

export default function PluginSlotsDemo() {
  const renderer = useRenderer()
  const registry = createSolidSlotRegistry<DemoSlots, typeof hostContext>(renderer, hostContext)

  const [statusbarMode, setStatusbarMode] = createSignal<SlotMode>("append")
  const [clockEnabled, setClockEnabled] = createSignal(true)
  const [activityEnabled, setActivityEnabled] = createSignal(true)
  const [clockCrashEnabled, setClockCrashEnabled] = createSignal(false)
  const [activityCrashEnabled, setActivityCrashEnabled] = createSignal(false)
  const [showPlaceholder, setShowPlaceholder] = createSignal(true)
  const [refreshNonce, setRefreshNonce] = createSignal(0)
  const [errorLines, setErrorLines] = createSignal<string[]>([])

  const SlotWithPlaceholder = createSlot(registry, {
    pluginFailurePlaceholder(failure) {
      return (
        <box border borderStyle="single" borderColor="#fb7185" marginLeft={1} paddingLeft={1} paddingRight={1}>
          <text fg="#fecaca">{`Plugin error: ${failure.pluginId}`}</text>
          <text fg="#fca5a5">{`${failure.phase}/${failure.source} @ ${failure.slot ?? "unknown"}`}</text>
        </box>
      )
    },
  })

  const SlotWithoutPlaceholder = createSlot(registry)

  onMount(() => {
    renderer.setBackgroundColor("#000000")
  })

  const unsubscribePluginErrors = registry.onPluginError((event) => {
    setErrorLines((current) => [formatPluginError(event), ...current].slice(0, 6))
  })
  onCleanup(unsubscribePluginErrors)

  createEffect(() => {
    refreshNonce()
    const unregisterCallbacks: Array<() => void> = []

    if (clockEnabled()) {
      unregisterCallbacks.push(registry.register(createClockPlugin(clockCrashEnabled())))
    }

    if (activityEnabled()) {
      unregisterCallbacks.push(registry.register(createActivityPlugin(activityCrashEnabled())))
    }

    onCleanup(() => {
      for (const unregister of unregisterCallbacks.reverse()) {
        unregister()
      }
    })
  })

  useKeyboard((key) => {
    switch (key.name) {
      case "1":
        setClockEnabled((current) => !current)
        return
      case "2":
        setActivityEnabled((current) => !current)
        return
      case "m":
        setStatusbarMode((current) => (current === "append" ? "replace" : "append"))
        return
      case "e":
        setClockCrashEnabled((current) => !current)
        return
      case "d":
        setActivityCrashEnabled((current) => !current)
        return
      case "p":
        setShowPlaceholder((current) => !current)
        return
      case "r":
        setRefreshNonce((current) => current + 1)
        return
      case "x":
        setClockCrashEnabled(false)
        setActivityCrashEnabled(false)
        setErrorLines([])
        registry.clearPluginErrors()
        setRefreshNonce((current) => current + 1)
        return
      case "c":
        if (key.ctrl) {
          key.preventDefault()
          renderer.destroy()
        }
        return
    }
  })

  const info = createMemo(() => {
    return [
      "Solid Plugin Slot Demo",
      "",
      `Statusbar mode: ${statusbarMode().toUpperCase()} (press m)`,
      `Clock plugin: ${clockEnabled() ? "ON" : "OFF"} (press 1)`,
      `Activity plugin: ${activityEnabled() ? "ON" : "OFF"} (press 2)`,
      `Clock subtree crash: ${clockCrashEnabled() ? "ON" : "OFF"} (press e)`,
      `Activity throw: ${activityCrashEnabled() ? "ON" : "OFF"} (press d)`,
      `Show placeholders: ${showPlaceholder() ? "YES" : "NO"} (press p)`,
      "",
      "Press r to re-register active plugins.",
      "Press x to reset errors and clear history.",
      "",
      "Recent plugin errors:",
      ...(errorLines().length > 0 ? errorLines() : ["(none)"]),
    ].join("\n")
  })

  const renderStatusbarSlot = () => {
    if (showPlaceholder()) {
      return (
        <SlotWithPlaceholder name="statusbar" label="status" mode={statusbarMode()}>
          <text fg="#94a3b8">Fallback statusbar content</text>
        </SlotWithPlaceholder>
      )
    }

    return (
      <SlotWithoutPlaceholder name="statusbar" label="status" mode={statusbarMode()}>
        <text fg="#94a3b8">Fallback statusbar content</text>
      </SlotWithoutPlaceholder>
    )
  }

  const renderSidebarSlot = () => {
    if (showPlaceholder()) {
      return (
        <SlotWithPlaceholder name="sidebar" section="left" mode="replace">
          <text fg="#94a3b8">No sidebar plugin active</text>
        </SlotWithPlaceholder>
      )
    }

    return (
      <SlotWithoutPlaceholder name="sidebar" section="left" mode="replace">
        <text fg="#94a3b8">No sidebar plugin active</text>
      </SlotWithoutPlaceholder>
    )
  }

  return (
    <box width="100%" height="100%" flexDirection="column" padding={1} backgroundColor="#020617">
      <box
        height={5}
        width="100%"
        border
        borderStyle="single"
        borderColor="#334155"
        alignItems="center"
        flexDirection="row"
        paddingLeft={1}
        marginBottom={1}
      >
        {renderStatusbarSlot()}
      </box>

      <box width="100%" flexGrow={1} flexDirection="row">
        <box
          width={36}
          border
          borderStyle="single"
          borderColor="#334155"
          flexDirection="column"
          padding={1}
          marginRight={1}
        >
          {renderSidebarSlot()}
        </box>

        <box flexGrow={1} border borderStyle="single" borderColor="#334155" flexDirection="column" padding={1}>
          <text fg="#e2e8f0" content={info()} />
        </box>
      </box>
    </box>
  )
}
