import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  createCoreSlotRegistry,
  mountCoreSlot,
  registerCorePlugin,
  TextRenderable,
  type CorePlugin,
  type CoreSlotHandle,
  type CoreSlotMode,
  type CoreSlotRegistry,
  type PluginErrorEvent,
  type KeyEvent,
} from "../index"
import { setupCommonDemoKeys } from "./lib/standalone-keys"

type DemoSlot = "statusbar" | "sidebar"

interface PluginStats {
  statusbarCreates: number
  sidebarCreates: number
}

let renderer: CliRenderer | null = null
let rootContainer: BoxRenderable | null = null
let statusbarSlotMount: BoxRenderable | null = null
let sidebarSlotMount: BoxRenderable | null = null
let infoPanel: BoxRenderable | null = null
let infoText: TextRenderable | null = null

let slotRegistry: CoreSlotRegistry<DemoSlot> | null = null
let statusbarSlotHandle: CoreSlotHandle | null = null
let sidebarSlotHandle: CoreSlotHandle | null = null

let unregisterClockPlugin: (() => void) | null = null
let unregisterActivityPlugin: (() => void) | null = null

const clockStats: PluginStats = {
  statusbarCreates: 0,
  sidebarCreates: 0,
}

const activityStats: PluginStats = {
  statusbarCreates: 0,
  sidebarCreates: 0,
}

let clockPluginEnabled = false
let activityPluginEnabled = false
let orderFlipped = false
let statusbarMode: CoreSlotMode = "append"
let clockStatusbarErrorEnabled = false
let clockSidebarErrorEnabled = false
let activityStatusbarErrorEnabled = false
let showPluginFailurePlaceholder = true
let unregisterPluginErrorListener: (() => void) | null = null
let pluginErrorHistory: string[] = []
let placeholderCreateCount = 0

const MAX_PLUGIN_ERROR_HISTORY = 6

const getClockOrder = () => (orderFlipped ? 20 : 0)
const getActivityOrder = () => (orderFlipped ? -10 : 10)

function formatPluginError(event: PluginErrorEvent): string {
  const slot = event.slot ?? "<none>"
  return `${event.pluginId} [${event.phase}/${event.source}] @ ${slot}: ${event.error.message}`
}

function pushPluginError(event: PluginErrorEvent): void {
  pluginErrorHistory = [formatPluginError(event), ...pluginErrorHistory].slice(0, MAX_PLUGIN_ERROR_HISTORY)
}

function createPluginFailurePlaceholder(
  rendererInstance: CliRenderer,
  failure: PluginErrorEvent,
  color: string,
): BoxRenderable {
  placeholderCreateCount++

  const container = new BoxRenderable(rendererInstance, {
    id: `plugin-error-${failure.pluginId}-${placeholderCreateCount}`,
    border: true,
    borderStyle: "single",
    borderColor: color,
    paddingLeft: 1,
    paddingRight: 1,
    marginLeft: 1,
    backgroundColor: "#1f1115",
  })

  const title = new TextRenderable(rendererInstance, {
    id: `plugin-error-title-${failure.pluginId}-${placeholderCreateCount}`,
    content: `Plugin error: ${failure.pluginId}`,
    fg: "#fecaca",
  })

  const details = new TextRenderable(rendererInstance, {
    id: `plugin-error-details-${failure.pluginId}-${placeholderCreateCount}`,
    content: `${failure.phase}/${failure.source} @ ${failure.slot ?? "unknown"}`,
    fg: "#fca5a5",
  })

  container.add(title)
  container.add(details)
  return container
}

function remountEnabledPlugins(): void {
  if (!slotRegistry || !renderer) {
    return
  }

  if (clockPluginEnabled) {
    unregisterClockPlugin?.()
    unregisterClockPlugin = registerCorePlugin(slotRegistry, createClockPlugin(renderer))
  }

  if (activityPluginEnabled) {
    unregisterActivityPlugin?.()
    unregisterActivityPlugin = registerCorePlugin(slotRegistry, createActivityPlugin(renderer))
  }

  statusbarSlotHandle?.refresh()
  sidebarSlotHandle?.refresh()
}

function resetPluginFailureState(): void {
  clockStatusbarErrorEnabled = false
  clockSidebarErrorEnabled = false
  activityStatusbarErrorEnabled = false
  pluginErrorHistory = []
  slotRegistry?.clearPluginErrors()

  remountEnabledPlugins()
  updateInfoPanel()
}

function updateInfoPanel(): void {
  if (!infoText) {
    return
  }

  infoText.content = [
    "Core Plugin Slot Demo",
    "",
    `Statusbar mode: ${statusbarMode.toUpperCase()} (press m)`,
    `Clock plugin: ${clockPluginEnabled ? "ON" : "OFF"} (press 1)`,
    `Activity plugin: ${activityPluginEnabled ? "ON" : "OFF"} (press 2)`,
    `Order flipped: ${orderFlipped ? "YES" : "NO"} (press o)`,
    `Show error placeholders: ${showPluginFailurePlaceholder ? "YES" : "NO"} (press p)`,
    "",
    `Clock statusbar throw: ${clockStatusbarErrorEnabled ? "ON" : "OFF"} (press e)`,
    `Clock sidebar throw: ${clockSidebarErrorEnabled ? "ON" : "OFF"} (press w)`,
    `Activity statusbar throw: ${activityStatusbarErrorEnabled ? "ON" : "OFF"} (press d)`,
    "Press x to reset all forced errors.",
    "",
    `Clock create counts -> statusbar: ${clockStats.statusbarCreates}, sidebar: ${clockStats.sidebarCreates}`,
    `Activity create counts -> statusbar: ${activityStats.statusbarCreates}`,
    "",
    "Press r to force slot refresh.",
    "Plugins manage their own updates; slot host does not pass props.",
    "",
    "Statusbar fallback is always shown in APPEND mode.",
    "Sidebar fallback appears only when no sidebar plugin is active.",
    "",
    "Recent plugin errors:",
    ...(pluginErrorHistory.length > 0 ? pluginErrorHistory : ["(none)"]),
  ].join("\n")
}

function createClockPlugin(rendererInstance: CliRenderer): CorePlugin<DemoSlot> {
  let statusText: TextRenderable | null = null
  let sidebarText: TextRenderable | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  const updateClockText = () => {
    const timestamp = new Date().toLocaleTimeString()

    if (statusText) {
      statusText.content = `Clock plugin ${timestamp}`
    }

    if (sidebarText) {
      sidebarText.content = `Last tick: ${timestamp}`
    }
  }

  return {
    id: "clock-plugin",
    order: getClockOrder(),
    setup() {
      updateClockText()
      timer = setInterval(updateClockText, 1000)
    },
    dispose() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      statusText = null
      sidebarText = null
    },
    slots: {
      statusbar() {
        if (clockStatusbarErrorEnabled) {
          throw new Error("Forced clock statusbar failure")
        }

        clockStats.statusbarCreates++

        const item = new BoxRenderable(rendererInstance, {
          id: `clock-statusbar-${clockStats.statusbarCreates}`,
          border: true,
          borderStyle: "single",
          borderColor: "#2563eb",
          paddingLeft: 1,
          paddingRight: 1,
          height: 3,
          marginLeft: 1,
          backgroundColor: "#0f172a",
        })

        statusText = new TextRenderable(rendererInstance, {
          id: `clock-statusbar-text-${clockStats.statusbarCreates}`,
          content: "Clock plugin",
          fg: "#93c5fd",
        })

        item.add(statusText)
        updateClockText()
        updateInfoPanel()
        return item
      },
      sidebar() {
        if (clockSidebarErrorEnabled) {
          throw new Error("Forced clock sidebar failure")
        }

        clockStats.sidebarCreates++

        const panel = new BoxRenderable(rendererInstance, {
          id: `clock-sidebar-${clockStats.sidebarCreates}`,
          border: true,
          borderStyle: "single",
          borderColor: "#0ea5e9",
          flexDirection: "column",
          height: 6,
          marginBottom: 1,
          padding: 1,
        })

        panel.add(
          new TextRenderable(rendererInstance, {
            id: `clock-sidebar-title-${clockStats.sidebarCreates}`,
            content: "Clock Plugin",
            fg: "#38bdf8",
          }),
        )

        sidebarText = new TextRenderable(rendererInstance, {
          id: `clock-sidebar-text-${clockStats.sidebarCreates}`,
          content: "Last tick: --:--:--",
          fg: "#e2e8f0",
          marginTop: 1,
        })

        panel.add(sidebarText)
        updateClockText()
        updateInfoPanel()
        return panel
      },
    },
  }
}

function createActivityPlugin(rendererInstance: CliRenderer): CorePlugin<DemoSlot> {
  let activityText: TextRenderable | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let phase = 0

  const pulse = [".", "..", "...", "...."]

  const updateActivityText = () => {
    phase = (phase + 1) % pulse.length
    if (activityText) {
      activityText.content = `Activity${pulse[phase]}`
    }
  }

  return {
    id: "activity-plugin",
    order: getActivityOrder(),
    setup() {
      timer = setInterval(updateActivityText, 700)
      updateActivityText()
    },
    dispose() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      activityText = null
    },
    slots: {
      statusbar() {
        if (activityStatusbarErrorEnabled) {
          throw new Error("Forced activity statusbar failure")
        }

        activityStats.statusbarCreates++

        const item = new BoxRenderable(rendererInstance, {
          id: `activity-statusbar-${activityStats.statusbarCreates}`,
          border: true,
          borderStyle: "single",
          borderColor: "#16a34a",
          paddingLeft: 1,
          paddingRight: 1,
          height: 3,
          marginLeft: 1,
          backgroundColor: "#052e16",
        })

        activityText = new TextRenderable(rendererInstance, {
          id: `activity-statusbar-text-${activityStats.statusbarCreates}`,
          content: "Activity",
          fg: "#86efac",
        })

        item.add(activityText)
        updateActivityText()
        updateInfoPanel()
        return item
      },
    },
  }
}

function setClockPluginEnabled(enabled: boolean): void {
  if (!slotRegistry || !renderer) {
    return
  }

  if (enabled && !clockPluginEnabled) {
    unregisterClockPlugin = registerCorePlugin(slotRegistry, createClockPlugin(renderer))
    clockPluginEnabled = true
  } else if (!enabled && clockPluginEnabled) {
    unregisterClockPlugin?.()
    unregisterClockPlugin = null
    clockPluginEnabled = false
  }

  updateInfoPanel()
}

function setActivityPluginEnabled(enabled: boolean): void {
  if (!slotRegistry || !renderer) {
    return
  }

  if (enabled && !activityPluginEnabled) {
    unregisterActivityPlugin = registerCorePlugin(slotRegistry, createActivityPlugin(renderer))
    activityPluginEnabled = true
  } else if (!enabled && activityPluginEnabled) {
    unregisterActivityPlugin?.()
    unregisterActivityPlugin = null
    activityPluginEnabled = false
  }

  updateInfoPanel()
}

function handleKeyPress(key: KeyEvent): void {
  if (!slotRegistry) {
    return
  }

  switch (key.name) {
    case "1":
      setClockPluginEnabled(!clockPluginEnabled)
      break
    case "2":
      setActivityPluginEnabled(!activityPluginEnabled)
      break
    case "m":
      statusbarMode = statusbarMode === "append" ? "replace" : "append"
      statusbarSlotHandle?.setMode(statusbarMode)
      updateInfoPanel()
      break
    case "o":
      orderFlipped = !orderFlipped
      slotRegistry.updateOrder("clock-plugin", getClockOrder())
      slotRegistry.updateOrder("activity-plugin", getActivityOrder())
      updateInfoPanel()
      break
    case "r":
      statusbarSlotHandle?.refresh()
      sidebarSlotHandle?.refresh()
      updateInfoPanel()
      break
    case "e":
      clockStatusbarErrorEnabled = !clockStatusbarErrorEnabled
      remountEnabledPlugins()
      updateInfoPanel()
      break
    case "w":
      clockSidebarErrorEnabled = !clockSidebarErrorEnabled
      remountEnabledPlugins()
      updateInfoPanel()
      break
    case "d":
      activityStatusbarErrorEnabled = !activityStatusbarErrorEnabled
      remountEnabledPlugins()
      updateInfoPanel()
      break
    case "p":
      showPluginFailurePlaceholder = !showPluginFailurePlaceholder
      remountEnabledPlugins()
      updateInfoPanel()
      break
    case "x":
      resetPluginFailureState()
      break
  }
}

function createLayout(rendererInstance: CliRenderer): void {
  rootContainer = new BoxRenderable(rendererInstance, {
    id: "core-plugin-demo-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    backgroundColor: "#020617",
  })

  statusbarSlotMount = new BoxRenderable(rendererInstance, {
    id: "core-plugin-demo-statusbar-slot",
    width: "100%",
    height: 5,
    border: true,
    borderStyle: "single",
    borderColor: "#334155",
    alignItems: "center",
    flexDirection: "row",
    paddingLeft: 1,
    marginBottom: 1,
  })

  const body = new BoxRenderable(rendererInstance, {
    id: "core-plugin-demo-body",
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
  })

  sidebarSlotMount = new BoxRenderable(rendererInstance, {
    id: "core-plugin-demo-sidebar-slot",
    width: 36,
    border: true,
    borderStyle: "single",
    borderColor: "#334155",
    flexDirection: "column",
    padding: 1,
    marginRight: 1,
  })

  infoPanel = new BoxRenderable(rendererInstance, {
    id: "core-plugin-demo-info-panel",
    flexGrow: 1,
    border: true,
    borderStyle: "single",
    borderColor: "#334155",
    flexDirection: "column",
    padding: 1,
  })

  infoText = new TextRenderable(rendererInstance, {
    id: "core-plugin-demo-info-text",
    fg: "#e2e8f0",
    content: "",
  })

  infoPanel.add(infoText)
  body.add(sidebarSlotMount)
  body.add(infoPanel)

  rootContainer.add(statusbarSlotMount)
  rootContainer.add(body)
  rendererInstance.root.add(rootContainer)
}

export function run(rendererInstance: CliRenderer): void {
  clockStats.statusbarCreates = 0
  clockStats.sidebarCreates = 0
  activityStats.statusbarCreates = 0
  activityStats.sidebarCreates = 0

  renderer = rendererInstance
  renderer.setBackgroundColor("#000000")

  createLayout(rendererInstance)

  slotRegistry = createCoreSlotRegistry<DemoSlot>(rendererInstance, {
    appName: "core-plugin-slots-demo",
    version: "1.0.0",
  })

  if (!slotRegistry || !statusbarSlotMount || !sidebarSlotMount) {
    return
  }

  unregisterPluginErrorListener = slotRegistry.onPluginError((event) => {
    pushPluginError(event)
    updateInfoPanel()
  })

  statusbarSlotHandle = mountCoreSlot({
    registry: slotRegistry,
    name: "statusbar",
    mount: statusbarSlotMount,
    mode: statusbarMode,
    fallback: () =>
      new TextRenderable(rendererInstance, {
        id: "statusbar-fallback",
        content: "Fallback statusbar content",
        fg: "#94a3b8",
      }),
    pluginFailurePlaceholder: (failure) => {
      if (!showPluginFailurePlaceholder) {
        return undefined
      }

      return createPluginFailurePlaceholder(rendererInstance, failure, "#fb7185")
    },
  })

  sidebarSlotHandle = mountCoreSlot({
    registry: slotRegistry,
    name: "sidebar",
    mount: sidebarSlotMount,
    mode: "replace",
    fallback: () =>
      new TextRenderable(rendererInstance, {
        id: "sidebar-fallback",
        content: "No sidebar plugin active",
        fg: "#94a3b8",
      }),
    pluginFailurePlaceholder: (failure) => {
      if (!showPluginFailurePlaceholder) {
        return undefined
      }

      return createPluginFailurePlaceholder(rendererInstance, failure, "#f97316")
    },
  })

  setClockPluginEnabled(true)
  setActivityPluginEnabled(true)

  renderer.keyInput.on("keypress", handleKeyPress)
  updateInfoPanel()
}

export function destroy(rendererInstance: CliRenderer): void {
  rendererInstance.keyInput.off("keypress", handleKeyPress)
  unregisterPluginErrorListener?.()
  unregisterPluginErrorListener = null

  unregisterClockPlugin?.()
  unregisterClockPlugin = null
  unregisterActivityPlugin?.()
  unregisterActivityPlugin = null

  statusbarSlotHandle?.dispose()
  statusbarSlotHandle = null
  sidebarSlotHandle?.dispose()
  sidebarSlotHandle = null

  slotRegistry = null

  rootContainer?.destroyRecursively()

  rootContainer = null
  statusbarSlotMount = null
  sidebarSlotMount = null
  infoPanel = null
  infoText = null

  clockPluginEnabled = false
  activityPluginEnabled = false
  statusbarMode = "append"
  orderFlipped = false
  clockStatusbarErrorEnabled = false
  clockSidebarErrorEnabled = false
  activityStatusbarErrorEnabled = false
  showPluginFailurePlaceholder = true
  pluginErrorHistory = []
  placeholderCreateCount = 0

  renderer = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
}
