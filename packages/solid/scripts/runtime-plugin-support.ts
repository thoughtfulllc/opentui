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

  registerBunPlugin(
    createSolidTransformPlugin({
      mode: "runtime",
      runtimeModules: {
        solid: solidRuntime as Record<string, unknown>,
        core: coreRuntime as Record<string, unknown>,
        solidJs: solidJsRuntime as Record<string, unknown>,
        solidJsStore: solidJsStoreRuntime as Record<string, unknown>,
      },
    }),
  )

  state[runtimePluginSupportInstalledKey] = true
  return true
}

ensureRuntimePluginSupport()
