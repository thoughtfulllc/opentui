import { transformAsync } from "@babel/core"
import { readFile } from "node:fs/promises"
// @ts-expect-error - Types not important.
import ts from "@babel/preset-typescript"
// @ts-expect-error - Types not important.
import moduleResolver from "babel-plugin-module-resolver"
// @ts-expect-error - Types not important.
import solid from "babel-preset-solid"
import { type BunPlugin } from "bun"

type Mode = "runtime" | "build"

type RuntimeModuleExports = Record<string, unknown>
type RuntimeModuleLoader = () => RuntimeModuleExports | Promise<RuntimeModuleExports>

type RuntimeModuleMap = {
  solid?: RuntimeModuleExports
  core?: RuntimeModuleExports
  solidJs?: RuntimeModuleExports
  solidJsStore?: RuntimeModuleExports
  additional?: Record<string, RuntimeModuleExports | RuntimeModuleLoader>
}

type RuntimeModuleBinding = {
  specifier: string
  moduleId: string
  moduleExports?: RuntimeModuleExports
}

const SOLID_RUNTIME_MODULE = "opentui:solid-runtime"
const CORE_RUNTIME_MODULE = "opentui:core-runtime"
const SOLID_JS_RUNTIME_MODULE = "opentui:solid-js-runtime"
const SOLID_JS_STORE_RUNTIME_MODULE = "opentui:solid-js-store-runtime"
const RUNTIME_MODULE_PREFIX = "opentui:runtime-module:"

// runtime mode is used by @opentui/solid/preload inside apps.
// It canonicalizes @opentui/* imports so external TSX/plugin modules resolve
// to the same runtime instance and share RendererContext.
// build mode is used only when building this package for npm.
// It avoids runtime canonicalization so dist output keeps normal externals
// and does not bake resolved paths into the published artifact.

const resolved = (specifier: string): string => {
  return import.meta.resolve(specifier)
}

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const exactSpecifierFilter = (specifier: string): RegExp => {
  return new RegExp(`^${escapeRegExp(specifier)}$`)
}

const CANONICAL_RUNTIME_FILTERS = [/^@opentui\/solid(?:\/.*)?$/, /^@opentui\/core(?:\/.*)?$/]

const runtimeModuleIdForSpecifier = (specifier: string): string => {
  return `${RUNTIME_MODULE_PREFIX}${encodeURIComponent(specifier)}`
}

const resolveRuntimeModuleExports = async (
  moduleEntry: RuntimeModuleExports | RuntimeModuleLoader,
): Promise<RuntimeModuleExports> => {
  if (typeof moduleEntry === "function") {
    return await moduleEntry()
  }

  return moduleEntry
}

export function createSolidTransformPlugin(input: { mode?: Mode; runtimeModules?: RuntimeModuleMap } = {}): BunPlugin {
  const mode = input.mode ?? "runtime"
  const runtime = mode === "runtime"
  const runtimeModules = input.runtimeModules
  const injectedRuntimeModules = runtime && runtimeModules?.solid ? runtimeModules : null
  const injectedSolidRuntime = Boolean(injectedRuntimeModules)

  const runtimeModuleBindings: RuntimeModuleBinding[] = injectedRuntimeModules
    ? [
        {
          specifier: "@opentui/solid",
          moduleId: SOLID_RUNTIME_MODULE,
          moduleExports: injectedRuntimeModules.solid,
        },
        {
          specifier: "@opentui/core",
          moduleId: CORE_RUNTIME_MODULE,
          moduleExports: injectedRuntimeModules.core,
        },
        {
          specifier: "solid-js",
          moduleId: SOLID_JS_RUNTIME_MODULE,
          moduleExports: injectedRuntimeModules.solidJs,
        },
        {
          specifier: "solid-js/store",
          moduleId: SOLID_JS_STORE_RUNTIME_MODULE,
          moduleExports: injectedRuntimeModules.solidJsStore,
        },
      ]
    : []

  return {
    name: "bun-plugin-solid",
    setup: (build) => {
      const moduleName = runtime
        ? injectedSolidRuntime
          ? SOLID_RUNTIME_MODULE
          : resolved("@opentui/solid")
        : "@opentui/solid"

      // Runtime transform points JSX factories at the host-resolved module.
      // Build transform must keep the public package specifier.

      if (injectedRuntimeModules) {
        for (const runtimeModule of runtimeModuleBindings) {
          const moduleExports = runtimeModule.moduleExports
          if (!moduleExports) continue

          build.module(runtimeModule.moduleId, () => ({ exports: moduleExports, loader: "object" }))
          build.onResolve({ filter: exactSpecifierFilter(runtimeModule.specifier) }, () => ({
            path: runtimeModule.moduleId,
          }))
        }

        for (const [specifier, moduleEntry] of Object.entries(injectedRuntimeModules.additional ?? {})) {
          const moduleId = runtimeModuleIdForSpecifier(specifier)

          build.module(moduleId, async () => ({
            exports: await resolveRuntimeModuleExports(moduleEntry),
            loader: "object",
          }))

          build.onResolve({ filter: exactSpecifierFilter(specifier) }, () => ({ path: moduleId }))
        }
      } else if (runtime) {
        for (const filter of CANONICAL_RUNTIME_FILTERS) {
          build.onResolve({ filter }, (args) => {
            return {
              path: resolved(args.path),
            }
          })
        }
      }

      const resolve = (path: string) => {
        if (!runtime) return null

        if (injectedSolidRuntime) {
          for (const runtimeModule of runtimeModuleBindings) {
            if (!runtimeModule.moduleExports) continue
            if (path === runtimeModule.specifier) {
              return runtimeModule.moduleId
            }
          }

          if (injectedRuntimeModules?.additional?.[path]) {
            return runtimeModuleIdForSpecifier(path)
          }

          return null
        }

        if (path.startsWith("@opentui/solid")) {
          return resolved(path)
        }

        if (path.startsWith("@opentui/core")) {
          return resolved(path)
        }

        return null
      }

      build.onLoad({ filter: /\/node_modules\/solid-js\/dist\/server\.js$/ }, async (args) => {
        const path = args.path.replace("server.js", "solid.js")
        const file = Bun.file(path)
        const code = await file.text()
        return { contents: code, loader: "js" }
      })

      build.onLoad({ filter: /\/node_modules\/solid-js\/store\/dist\/server\.js$/ }, async (args) => {
        const path = args.path.replace("server.js", "store.js")
        const file = Bun.file(path)
        const code = await file.text()
        return { contents: code, loader: "js" }
      })

      build.onLoad({ filter: /\.(js|ts)x$/ }, async (args) => {
        const file = Bun.file(args.path)
        const code = await file.text()
        // Module resolver rewrite is runtime-only for the same reason.
        const plugins = runtime
          ? [
              [
                moduleResolver,
                {
                  resolvePath(path: string) {
                    return resolve(path)
                  },
                },
              ],
            ]
          : []

        const transforms = await transformAsync(code, {
          filename: args.path,
          plugins,
          presets: [
            [
              solid,
              {
                moduleName,
                generate: "universal",
              },
            ],
            [ts],
          ],
        })

        return {
          contents: transforms?.code ?? "",
          loader: "js",
        }
      })
    },
  }
}

const solidTransformPlugin = createSolidTransformPlugin()

export default solidTransformPlugin
