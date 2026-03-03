import { transformAsync } from "@babel/core"
import { readFile } from "node:fs/promises"
// @ts-expect-error - Types not important.
import ts from "@babel/preset-typescript"
// @ts-expect-error - Types not important.
import moduleResolver from "babel-plugin-module-resolver"
// @ts-expect-error - Types not important.
import solid from "babel-preset-solid"
import { type BunPlugin } from "bun"

const solidTransformPlugin: BunPlugin = {
  name: "bun-plugin-solid",
  setup: (build) => {
    const moduleName = import.meta.resolve("@opentui/solid")
    const canonical = [/^@opentui\/solid(?:\/.*)?$/, /^@opentui\/core(?:\/.*)?$/, /^solid-js(?:\/.*)?$/]

    for (const filter of canonical) {
      build.onResolve({ filter }, (args) => {
        return {
          path: import.meta.resolve(args.path),
        }
      })
    }

    const resolve = (path: string) => {
      if (path.startsWith("@opentui/solid")) {
        return import.meta.resolve(path)
      }
      if (path.startsWith("@opentui/core")) {
        return import.meta.resolve(path)
      }
      if (path === "solid-js" || path.startsWith("solid-js/")) {
        return import.meta.resolve(path)
      }
      return null
    }

    build.onLoad({ filter: /\/node_modules\/solid-js\/dist\/server\.js$/ }, async (args) => {
      const path = args.path.replace("server.js", "solid.js")
      const code = await readFile(path, "utf8")
      return { contents: code, loader: "js" }
    })
    build.onLoad({ filter: /\/node_modules\/solid-js\/store\/dist\/server\.js$/ }, async (args) => {
      const path = args.path.replace("server.js", "store.js")
      const code = await readFile(path, "utf8")
      return { contents: code, loader: "js" }
    })
    build.onLoad({ filter: /\.(js|ts)x$/ }, async (args) => {
      const code = await readFile(args.path, "utf8")
      const transforms = await transformAsync(code, {
        filename: args.path,
        // env: {
        //   development: {
        //     plugins: [["solid-refresh/babel", { "bundler": "esm" }]],
        //   },
        // },
        // plugins: [["solid-refresh/babel", { bundler: "esm" }]],
        plugins: [
          [
            moduleResolver,
            {
              resolvePath(path: string) {
                return resolve(path)
              },
            },
          ],
        ],
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

export default solidTransformPlugin
