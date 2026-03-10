import { Slot, createSolidSlotRegistry, type SlotMode, useKeyboard, useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { loadExternalPlugin, type ExternalPluginContext, type ExternalPluginSlots } from "../.plugin/index.tsx"

const STATUSBAR_LABEL = "host-status"
const SIDEBAR_SECTION = "external-plugins"

const hostContext: ExternalPluginContext = {
  appName: "solid-external-plugin-demo",
  version: "1.0.0",
}

function nextStatusbarMode(mode: SlotMode): SlotMode {
  if (mode === "append") {
    return "replace"
  }

  if (mode === "replace") {
    return "single_winner"
  }

  return "append"
}

export default function ExternalPluginSlotsDemo() {
  const renderer = useRenderer()
  const registry = createSolidSlotRegistry<ExternalPluginSlots, ExternalPluginContext>(renderer, hostContext)
  const AppSlot = Slot<ExternalPluginSlots, ExternalPluginContext>

  const [statusbarMode, setStatusbarMode] = createSignal<SlotMode>("append")
  const [pluginEnabled, setPluginEnabled] = createSignal(true)
  const [reloadNonce, setReloadNonce] = createSignal(0)

  onMount(() => {
    renderer.setBackgroundColor("#000000")
  })

  createEffect(
    on(
      [pluginEnabled, reloadNonce],
      ([currentPluginEnabled]) => {
        if (!currentPluginEnabled) {
          return
        }

        const unregister = registry.register(loadExternalPlugin())
        onCleanup(unregister)
      },
      { defer: false },
    ),
  )

  useKeyboard((key) => {
    switch (key.name) {
      case "m":
        setStatusbarMode((current) => nextStatusbarMode(current))
        return
      case "p":
        setPluginEnabled((current) => !current)
        return
      case "r":
        setReloadNonce((current) => current + 1)
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
      "Solid External Plugin Slot Demo",
      "",
      "External plugin entry: .plugin/index.tsx",
      `Plugin enabled: ${pluginEnabled() ? "ON" : "OFF"} (press p)`,
      `Statusbar mode: ${statusbarMode().toUpperCase()} (press m to cycle)`,
      "Press r to re-register the external plugin.",
      "",
      `Statusbar slot label: ${STATUSBAR_LABEL}`,
      `Sidebar slot section: ${SIDEBAR_SECTION}`,
      "",
      "The plugin renders external JSX components for both slots.",
    ].join("\n")
  })

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
        <Show when={statusbarMode()} keyed>
          {(currentMode) => (
            <AppSlot registry={registry} name="statusbar" label={STATUSBAR_LABEL} mode={currentMode}>
              <text fg="#94a3b8">Fallback statusbar content</text>
            </AppSlot>
          )}
        </Show>
      </box>

      <box width="100%" flexGrow={1} flexDirection="row">
        <box
          width={44}
          border
          borderStyle="single"
          borderColor="#334155"
          flexDirection="column"
          padding={1}
          marginRight={1}
        >
          <AppSlot registry={registry} name="sidebar" section={SIDEBAR_SECTION} mode="replace">
            <text fg="#94a3b8">No external sidebar plugin loaded</text>
          </AppSlot>
        </box>

        <box flexGrow={1} border borderStyle="single" borderColor="#334155" flexDirection="column" padding={1}>
          <text fg="#e2e8f0" content={info()} />
        </box>
      </box>
    </box>
  )
}
