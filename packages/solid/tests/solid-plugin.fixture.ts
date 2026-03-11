import { rmSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createSolidTransformPlugin } from "../scripts/solid-plugin"

const tempRoot = mkdtempSync(join(tmpdir(), "solid-plugin-fixture-"))
const entryPath = join(tempRoot, "entry.tsx")

const source = [
  'import { value as syncValue } from "fixture-sync"',
  'import { value as asyncValue } from "@fixture/async-module"',
  "console.log(`sync=${syncValue};async=${asyncValue}`)",
  "export const noop = 1",
].join("\n")

writeFileSync(entryPath, source)

registerPlugin.clearAll()

registerPlugin(
  createSolidTransformPlugin({
    mode: "runtime",
    runtimeModules: {
      solid: {},
      additional: {
        "fixture-sync": { value: "sync-value" },
        "@fixture/async-module": async () => ({ value: "async-value" }),
      },
    },
  }),
)

try {
  await import(entryPath)
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
