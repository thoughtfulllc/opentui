import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { createSolidTransformPlugin } from "../scripts/solid-plugin"

type ResolveResult = { path: string; namespace?: string } | void
type ResolveCallback = (args: { path: string; importer: string }) => ResolveResult | Promise<ResolveResult>
type LoadCallback = (args: { path: string }) => unknown | Promise<unknown>
type ModuleCallback = () => unknown | Promise<unknown>

type ResolveHandler = {
  filter: RegExp
  callback: ResolveCallback
}

type LoadHandler = {
  filter: RegExp
  callback: LoadCallback
}

type MockBuild = {
  onResolve: (args: { filter: RegExp }, callback: ResolveCallback) => void
  onLoad: (args: { filter: RegExp }, callback: LoadCallback) => void
  module: (path: string, callback: ModuleCallback) => void
}

const createMockBuild = (): {
  build: MockBuild
  resolveHandlers: ResolveHandler[]
  loadHandlers: LoadHandler[]
  modules: Map<string, ModuleCallback>
} => {
  const resolveHandlers: ResolveHandler[] = []
  const loadHandlers: LoadHandler[] = []
  const modules = new Map<string, ModuleCallback>()

  const build: MockBuild = {
    onResolve(args, callback) {
      resolveHandlers.push({ filter: args.filter, callback })
    },
    onLoad(args, callback) {
      loadHandlers.push({ filter: args.filter, callback })
    },
    module(path, callback) {
      modules.set(path, callback)
    },
  }

  return { build, resolveHandlers, loadHandlers, modules }
}

const resolveSpecifier = async (handlers: ResolveHandler[], specifier: string): Promise<ResolveResult> => {
  for (const handler of handlers) {
    if (!handler.filter.test(specifier)) continue

    const result = await handler.callback({
      path: specifier,
      importer: import.meta.path,
    })

    if (result) {
      return result
    }
  }

  return undefined
}

describe("solid transform plugin", () => {
  it("canonicalizes @opentui imports in runtime mode", async () => {
    const { build, resolveHandlers } = createMockBuild()
    createSolidTransformPlugin({ mode: "runtime" }).setup(build as any)

    const solid = await resolveSpecifier(resolveHandlers, "@opentui/solid/runtime-plugin-support")
    const core = await resolveSpecifier(resolveHandlers, "@opentui/core/testing")

    expect(solid).toEqual({ path: import.meta.resolve("@opentui/solid/runtime-plugin-support") })
    expect(core).toEqual({ path: import.meta.resolve("@opentui/core/testing") })
  })

  it("does not register runtime canonical resolvers in build mode", async () => {
    const { build, resolveHandlers } = createMockBuild()
    createSolidTransformPlugin({ mode: "build" }).setup(build as any)

    const solid = await resolveSpecifier(resolveHandlers, "@opentui/solid/runtime-plugin-support")
    const core = await resolveSpecifier(resolveHandlers, "@opentui/core/testing")

    expect(solid).toBeUndefined()
    expect(core).toBeUndefined()
  })

  it("registers runtime modules and resolves additional specifiers", async () => {
    const { build, resolveHandlers, modules } = createMockBuild()

    createSolidTransformPlugin({
      mode: "runtime",
      runtimeModules: {
        solid: { marker: "solid" },
        core: { marker: "core" },
        additional: {
          "fixture-sync": { value: "sync-value" },
          "@fixture/async-module": async () => ({ value: "async-value" }),
        },
      },
    }).setup(build as any)

    const solidResolution = await resolveSpecifier(resolveHandlers, "@opentui/solid")
    const coreResolution = await resolveSpecifier(resolveHandlers, "@opentui/core")
    const syncResolution = await resolveSpecifier(resolveHandlers, "fixture-sync")
    const asyncResolution = await resolveSpecifier(resolveHandlers, "@fixture/async-module")

    expect(solidResolution).toBeDefined()
    expect(coreResolution).toBeDefined()
    expect(syncResolution).toBeDefined()
    expect(asyncResolution).toBeDefined()

    if (!solidResolution || !coreResolution || !syncResolution || !asyncResolution) {
      throw new Error("Expected all runtime module resolutions to be defined")
    }

    const solidModule = modules.get(solidResolution.path)
    const coreModule = modules.get(coreResolution.path)
    const syncModule = modules.get(syncResolution.path)
    const asyncModule = modules.get(asyncResolution.path)

    expect(solidModule).toBeDefined()
    expect(coreModule).toBeDefined()
    expect(syncModule).toBeDefined()
    expect(asyncModule).toBeDefined()

    if (!solidModule || !coreModule || !syncModule || !asyncModule) {
      throw new Error("Expected all runtime module factories to be registered")
    }

    expect(await solidModule()).toEqual({ exports: { marker: "solid" }, loader: "object" })
    expect(await coreModule()).toEqual({ exports: { marker: "core" }, loader: "object" })
    expect(await syncModule()).toEqual({ exports: { value: "sync-value" }, loader: "object" })
    expect(await asyncModule()).toEqual({ exports: { value: "async-value" }, loader: "object" })
  })

  it("resolves runtime additional modules end-to-end in a subprocess", () => {
    const fixturePath = join(import.meta.dir, "solid-plugin.fixture.ts")
    const result = Bun.spawnSync([process.execPath, fixturePath], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })

    const stdout = result.stdout.toString().trim()
    const stderr = result.stderr.toString().trim()

    if (stdout) {
      console.debug(`[solid-plugin.fixture] stdout:\n${stdout}`)
    }

    if (stderr) {
      console.debug(`[solid-plugin.fixture] stderr:\n${stderr}`)
    }

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("sync=sync-value;async=async-value")
  })
})
