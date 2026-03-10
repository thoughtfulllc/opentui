import { transformAsync } from "@babel/core"
// @ts-expect-error - Types not important.
import ts from "@babel/preset-typescript"
// @ts-expect-error - Types not important.
import moduleResolver from "babel-plugin-module-resolver"
// @ts-expect-error - Types not important.
import solid from "babel-preset-solid"
import { type BunPlugin } from "bun"

type Mode = "runtime" | "build"

type RuntimeModuleMap = {
  solid?: Record<string, unknown>
  core?: Record<string, unknown>
  solidJs?: Record<string, unknown>
  solidJsStore?: Record<string, unknown>
}

const SOLID_RUNTIME_MODULE = "opentui:solid-runtime"
const CORE_RUNTIME_MODULE = "opentui:core-runtime"
const SOLID_JS_RUNTIME_MODULE = "opentui:solid-js-runtime"
const SOLID_JS_STORE_RUNTIME_MODULE = "opentui:solid-js-store-runtime"

// runtime mode is used by @opentui/solid/preload inside apps.
// It canonicalizes @opentui/* imports so external TSX/plugin modules resolve
// to the same runtime instance and share RendererContext.
// build mode is used only when building this package for npm.
// It avoids runtime canonicalization so dist output keeps normal externals
// and does not bake resolved paths into the published artifact.

const resolved = (specifier: string): string => {
  return import.meta.resolve(specifier)
}

export function createSolidTransformPlugin(input: { mode?: Mode; runtimeModules?: RuntimeModuleMap } = {}): BunPlugin {
  const mode = input.mode ?? "runtime"
  const runtime = mode === "runtime"
  const runtimeModules = input.runtimeModules
  const injectedSolidRuntime = runtime && Boolean(runtimeModules?.solid)

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

      if (runtime && injectedSolidRuntime) {
        build.module(SOLID_RUNTIME_MODULE, () => ({ exports: runtimeModules.solid ?? {}, loader: "object" }))

        if (runtimeModules?.core) {
          build.module(CORE_RUNTIME_MODULE, () => ({ exports: runtimeModules.core ?? {}, loader: "object" }))
        }

        if (runtimeModules?.solidJs) {
          build.module(SOLID_JS_RUNTIME_MODULE, () => ({ exports: runtimeModules.solidJs ?? {}, loader: "object" }))
        }

        if (runtimeModules?.solidJsStore) {
          build.module(SOLID_JS_STORE_RUNTIME_MODULE, () => ({
            exports: runtimeModules.solidJsStore ?? {},
            loader: "object",
          }))
        }

        build.onResolve({ filter: /^@opentui\/solid(?:\/.*)?$/ }, () => ({ path: SOLID_RUNTIME_MODULE }))

        if (runtimeModules?.core) {
          build.onResolve({ filter: /^@opentui\/core(?:\/.*)?$/ }, () => ({ path: CORE_RUNTIME_MODULE }))
        }

        if (runtimeModules?.solidJs) {
          build.onResolve({ filter: /^solid-js$/ }, () => ({ path: SOLID_JS_RUNTIME_MODULE }))
        }

        if (runtimeModules?.solidJsStore) {
          build.onResolve({ filter: /^solid-js\/store(?:\/.*)?$/ }, () => ({ path: SOLID_JS_STORE_RUNTIME_MODULE }))
        }
      } else if (runtime) {
        const canonical = [/^@opentui\/solid(?:\/.*)?$/, /^@opentui\/core(?:\/.*)?$/]

        for (const filter of canonical) {
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
          if (path.startsWith("@opentui/solid")) {
            return SOLID_RUNTIME_MODULE
          }

          if (path.startsWith("@opentui/core") && runtimeModules?.core) {
            return CORE_RUNTIME_MODULE
          }

          if (path === "solid-js" && runtimeModules?.solidJs) {
            return SOLID_JS_RUNTIME_MODULE
          }

          if ((path === "solid-js/store" || path.startsWith("solid-js/store/")) && runtimeModules?.solidJsStore) {
            return SOLID_JS_STORE_RUNTIME_MODULE
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
