import { transformAsync } from "@babel/core"
// @ts-expect-error - Types not important.
import ts from "@babel/preset-typescript"
// @ts-expect-error - Types not important.
import moduleResolver from "babel-plugin-module-resolver"
// @ts-expect-error - Types not important.
import solid from "babel-preset-solid"
import { type BunPlugin } from "bun"

type Mode = "runtime" | "build"

const resolved = (specifier: string): string => {
  return import.meta.resolve(specifier)
}

export function createSolidTransformPlugin(input: { mode?: Mode } = {}): BunPlugin {
  const mode = input.mode ?? "runtime"
  const runtime = mode === "runtime"

  return {
    name: "bun-plugin-solid",
    setup: (build) => {
      const moduleName = runtime ? resolved("@opentui/solid") : "@opentui/solid"

      if (runtime) {
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
