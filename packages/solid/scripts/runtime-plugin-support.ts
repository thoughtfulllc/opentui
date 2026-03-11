import { plugin as registerBunPlugin } from "bun"
import * as coreRuntime from "@opentui/core"
import { createRuntimePlugin, runtimeModuleIdForSpecifier, type RuntimeModuleEntry } from "@opentui/core/runtime-plugin"
import * as solidJsRuntime from "solid-js"
import * as solidJsStoreRuntime from "solid-js/store"
import * as solidRuntime from "../index"
import { createSolidTransformPlugin } from "./solid-plugin"

const runtimePluginSupportInstalledKey = "__opentuiSolidRuntimePluginSupportInstalled__"

type RuntimePluginSupportState = typeof globalThis & {
  [runtimePluginSupportInstalledKey]?: boolean
}

const additionalRuntimeModules: Record<string, RuntimeModuleEntry> = {
  "@opentui/solid": solidRuntime as Record<string, unknown>,
  "solid-js": solidJsRuntime as Record<string, unknown>,
  "solid-js/store": solidJsStoreRuntime as Record<string, unknown>,
  "@opentui/core/3d": async () => (await import("@opentui/core/3d")) as Record<string, unknown>,
  "@opentui/core/testing": async () => (await import("@opentui/core/testing")) as Record<string, unknown>,
}

const runtimeResolvedSpecifiers = new Set<string>(["@opentui/core", ...Object.keys(additionalRuntimeModules)])

const resolveRuntimeSpecifier = (specifier: string): string | null => {
  if (!runtimeResolvedSpecifiers.has(specifier)) {
    return null
  }

  return runtimeModuleIdForSpecifier(specifier)
}

export function ensureRuntimePluginSupport(): boolean {
  const state = globalThis as RuntimePluginSupportState

  if (state[runtimePluginSupportInstalledKey]) {
    return false
  }

  registerBunPlugin(
    createSolidTransformPlugin({
      moduleName: runtimeModuleIdForSpecifier("@opentui/solid"),
      resolvePath(specifier) {
        return resolveRuntimeSpecifier(specifier)
      },
    }),
  )

  registerBunPlugin(
    createRuntimePlugin({
      core: coreRuntime as Record<string, unknown>,
      additional: additionalRuntimeModules,
    }),
  )

  state[runtimePluginSupportInstalledKey] = true
  return true
}

ensureRuntimePluginSupport()
