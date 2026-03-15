import { describe, it, expect, beforeAll } from "bun:test"
import { execSync } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const rootDir = resolve(__dirname, "..")
const distDir = join(rootDir, "dist")
const coreDistDir = resolve(rootDir, "../core/dist")

describe("@opentui/react build", { timeout: 120000 }, () => {
  beforeAll(() => {
    // Remove both dist directories to test from a clean state
    rmSync(distDir, { recursive: true, force: true })
    rmSync(coreDistDir, { recursive: true, force: true })

    // Run the build
    execSync("bun run build", {
      cwd: rootDir,
      stdio: "inherit",
      timeout: 60000,
    })
  })

  it("produces dist/index.js", () => {
    expect(existsSync(join(distDir, "index.js"))).toBe(true)
  })

  it("generates TypeScript declarations", () => {
    expect(existsSync(join(distDir, "src/index.d.ts"))).toBe(true)
  })

  it("exports createRoot", () => {
    const content = readFileSync(join(distDir, "index.js"), "utf-8")
    expect(content).toContain("createRoot")
  })

  it("exports reconciler internals (_render, reconciler, ErrorBoundary)", () => {
    const content = readFileSync(join(distDir, "index.js"), "utf-8")
    expect(content).toContain("_render")
    expect(content).toContain("reconciler")
    expect(content).toContain("ErrorBoundary")
  })

  it("builds successfully even without @opentui/core dist pre-existing", () => {
    // The beforeAll already tested this — if we got here, the build
    // auto-generated core/dist before running its own tsc.
    // Verify core/dist was created as a side effect.
    expect(existsSync(join(coreDistDir, "index.d.ts"))).toBe(true)
  })
})
