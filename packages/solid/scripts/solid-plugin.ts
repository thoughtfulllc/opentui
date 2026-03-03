import { fileURLToPath } from "node:url"

import { transformAsync } from "@babel/core"
import { readFile } from "node:fs/promises"
// @ts-expect-error - Types not important.
import ts from "@babel/preset-typescript"
// @ts-expect-error - Types not important.
import moduleResolver from "babel-plugin-module-resolver"
// @ts-expect-error - Types not important.
import solid from "babel-preset-solid"
import { type BunPlugin } from "bun"

const toFilePath = (resolvedPath: string): string => {
  if (resolvedPath.startsWith("file://")) {
    return fileURLToPath(resolvedPath)
  }

  return resolvedPath
}

const resolvePath = (specifier: string): string => {
  return toFilePath(import.meta.resolve(specifier))
}

const solidTransformPlugin: BunPlugin = {
  name: "bun-plugin-solid",
  setup: (build) => {
    const moduleName = resolvePath("@opentui/solid")
    const canonical = [/^@opentui\/solid(?:\/.*)?$/, /^@opentui\/core(?:\/.*)?$/, /^solid-js(?:\/.*)?$/]

    for (const filter of canonical) {
      build.onResolve({ filter }, (args) => {
        return {
          path: resolvePath(args.path),
        }
      })
    }

    const resolve = (path: string) => {
      if (path.startsWith("@opentui/solid")) {
        return resolvePath(path)
      }
      if (path.startsWith("@opentui/core")) {
        return resolvePath(path)
      }
      if (path === "solid-js" || path.startsWith("solid-js/")) {
        return resolvePath(path)
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
