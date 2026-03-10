import { type SolidPlugin } from "@opentui/solid"
import { ExternalSidebarPanel, ExternalStatusCard } from "./slot-components.tsx"

export type ExternalPluginSlots = {
  statusbar: { label: string }
  sidebar: { section: string }
}

export type ExternalPluginContext = {
  appName: string
  version: string
}

const CAPABILITIES = ["statusbar extension", "sidebar extension", "external jsx components"]

export function loadExternalPlugin(): SolidPlugin<ExternalPluginSlots, ExternalPluginContext> {
  return {
    id: "external-jsx-plugin",
    order: 20,
    slots: {
      statusbar(ctx, props) {
        return <ExternalStatusCard host={ctx.appName} label={props.label} version={ctx.version} />
      },
      sidebar(_ctx, props) {
        return <ExternalSidebarPanel section={props.section} capabilities={CAPABILITIES} />
      },
    },
  }
}
