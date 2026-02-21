import { test, expect } from "bun:test"
import { createCliRenderer } from "../renderer"

test("stream mode emits setup output through onOutput", async () => {
  const chunks: Uint8Array[] = []

  const renderer = await createCliRenderer({
    outputMode: "stream",
    width: 80,
    height: 24,
    onOutput: (data) => {
      chunks.push(new Uint8Array(data))
    },
    useAlternateScreen: false,
    useConsole: false,
    openConsoleOnError: false,
    exitOnCtrlC: false,
    exitSignals: [],
  })

  const deadline = Date.now() + 250
  while (chunks.length === 0 && Date.now() < deadline) {
    await Bun.sleep(5)
  }

  expect(chunks.length).toBeGreaterThan(0)

  renderer.destroy()
  await renderer.idle()
})

test("stream mode destroy finalizes after pending async onOutput", async () => {
  let chunkCount = 0
  let resolvePending!: () => void
  let resolveDestroyed!: () => void
  let onDestroyCalled = false
  const pending = new Promise<void>((resolve) => {
    resolvePending = resolve
  })
  const destroyed = new Promise<void>((resolve) => {
    resolveDestroyed = resolve
  })

  const renderer = await createCliRenderer({
    outputMode: "stream",
    width: 80,
    height: 24,
    onOutput: () => {
      chunkCount += 1
      if (chunkCount === 1) {
        return pending
      }
    },
    onDestroy: () => {
      onDestroyCalled = true
      resolveDestroyed()
    },
    useAlternateScreen: false,
    useConsole: false,
    openConsoleOnError: false,
    exitOnCtrlC: false,
    exitSignals: [],
  })

  const startDeadline = Date.now() + 250
  while (chunkCount === 0 && Date.now() < startDeadline) {
    await Bun.sleep(5)
  }

  expect(chunkCount).toBeGreaterThan(0)

  renderer.destroy()
  await destroyed

  resolvePending()
  await Bun.sleep(0)

  expect(onDestroyCalled).toBe(true)
  expect(renderer.isDestroyed).toBe(true)
})
