import { test, expect } from "bun:test"
import { createCliRenderer, RendererControlState } from "../renderer"

const streamDefaults = {
  outputMode: "stream" as const,
  width: 80,
  height: 24,
  useAlternateScreen: false,
  useConsole: false,
  openConsoleOnError: false,
  exitOnCtrlC: false,
  exitSignals: [] as NodeJS.Signals[],
}

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

test("stream mode destroy does not pause process.stdin", async () => {
  const originalPause = process.stdin.pause
  const stdinAny = process.stdin as any
  let pauseCalls = 0

  stdinAny.pause = function patchedPause() {
    pauseCalls += 1
    return process.stdin
  }

  try {
    const renderer = await createCliRenderer({
      ...streamDefaults,
      onOutput: () => {},
    })

    renderer.destroy()
    await renderer.idle()

    expect(pauseCalls).toBe(0)
  } finally {
    stdinAny.pause = originalPause
  }
})

test("stream mode input() processes data through key handlers", async () => {
  let keypressReceived = false

  const renderer = await createCliRenderer({
    ...streamDefaults,
    onOutput: () => {},
  })

  renderer.keyInput.on("keypress", (event: any) => {
    if (event.name === "a") {
      keypressReceived = true
    }
  })

  // Send the letter "a" as raw input
  renderer.input(Buffer.from("a"))
  await Bun.sleep(10)

  expect(keypressReceived).toBe(true)

  renderer.destroy()
  await renderer.idle()
})

test("stream mode resize() updates renderer dimensions", async () => {
  const renderer = await createCliRenderer({
    ...streamDefaults,
    onOutput: () => {},
  })

  expect(renderer.width).toBe(80)
  expect(renderer.height).toBe(24)

  renderer.resize(120, 40)

  const deadline = Date.now() + 300
  while ((renderer.width !== 120 || renderer.height !== 40) && Date.now() < deadline) {
    await Bun.sleep(10)
  }

  expect(renderer.width).toBe(120)
  expect(renderer.height).toBe(40)

  renderer.destroy()
  await renderer.idle()
})

test("stream mode handles mouse input through input()", async () => {
  let keypressCount = 0
  const renderer = await createCliRenderer({
    ...streamDefaults,
    onOutput: () => {},
  })

  renderer.keyInput.on("keypress", () => {
    keypressCount += 1
  })

  // SGR mouse down event: ESC [ < 0 ; 10 ; 10 M
  renderer.input(Buffer.from("\x1b[<0;10;10M"))
  await Bun.sleep(20)

  expect(keypressCount).toBe(0)

  renderer.destroy()
  await renderer.idle()
})

test("stream mode resize during active render loop remains stable", async () => {
  const renderer = await createCliRenderer({
    ...streamDefaults,
    onOutput: () => {},
  })

  renderer.start()

  renderer.resize(100, 30)
  renderer.resize(110, 35)
  renderer.resize(120, 40)

  const deadline = Date.now() + 500
  while ((renderer.width !== 120 || renderer.height !== 40) && Date.now() < deadline) {
    await Bun.sleep(10)
  }

  expect(renderer.width).toBe(120)
  expect(renderer.height).toBe(40)

  renderer.destroy()
  await renderer.idle()
})

test("stream mode double destroy is safe", async () => {
  const renderer = await createCliRenderer({
    ...streamDefaults,
    onOutput: () => {},
  })

  renderer.destroy()
  // Second destroy should be a no-op, not throw
  renderer.destroy()
  await renderer.idle()

  expect(renderer.isDestroyed).toBe(true)
})

test("stream mode input() after destroy is ignored", async () => {
  const renderer = await createCliRenderer({
    ...streamDefaults,
    onOutput: () => {},
  })

  renderer.destroy()
  renderer.input(Buffer.from("a"))
  await renderer.idle()

  expect(renderer.isDestroyed).toBe(true)
})

test("stream mode suspend/resume preserves control state", async () => {
  const renderer = await createCliRenderer({
    ...streamDefaults,
    onOutput: () => {},
  })

  renderer.start()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)

  renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)

  renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)

  renderer.destroy()
  await renderer.idle()
})

test("stream mode input() throws in stdout mode", async () => {
  const renderer = await createCliRenderer({
    useAlternateScreen: false,
    useConsole: false,
    openConsoleOnError: false,
    exitOnCtrlC: false,
    exitSignals: [],
  })

  expect(() => renderer.input(Buffer.from("a"))).toThrow("input() is only available in stream output mode")

  renderer.destroy()
  await renderer.idle()
})
