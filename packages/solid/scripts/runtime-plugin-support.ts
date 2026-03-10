import { plugin as registerBunPlugin } from "bun"
import * as coreRuntime from "@opentui/core"
import * as solidJsRuntime from "solid-js"
import * as solidJsStoreRuntime from "solid-js/store"
import * as solidRuntime from "../index"
import { createSolidTransformPlugin } from "./solid-plugin"

const runtimePluginSupportInstalledKey = "__opentuiSolidRuntimePluginSupportInstalled__"

type RuntimePluginSupportState = typeof globalThis & {
  [runtimePluginSupportInstalledKey]?: boolean
}

export function ensureRuntimePluginSupport(): boolean {
  const state = globalThis as RuntimePluginSupportState

  if (state[runtimePluginSupportInstalledKey]) {
    return false
  }

  const pluginOptions = {
    mode: "runtime" as const,
    runtimeModules: {
      solid: solidRuntime as Record<string, unknown>,
      core: coreRuntime as Record<string, unknown>,
      solidJs: solidJsRuntime as Record<string, unknown>,
      solidJsStore: solidJsStoreRuntime as Record<string, unknown>,
      additional: {
        "@opentui/core/3d": async () => (await import("@opentui/core/3d")) as Record<string, unknown>,
        "@opentui/core/testing": async () => (await import("@opentui/core/testing")) as Record<string, unknown>,
      },
    },
  }

  registerBunPlugin(createSolidTransformPlugin(pluginOptions as Parameters<typeof createSolidTransformPlugin>[0]))

  state[runtimePluginSupportInstalledKey] = true
  return true
}

ensureRuntimePluginSupport()
