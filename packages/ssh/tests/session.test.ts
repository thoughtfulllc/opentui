import { test, expect, describe } from "bun:test"
import { EventEmitter } from "events"
import type { ServerChannel } from "ssh2"
import { SSHSession } from "../src/session.ts"

function createMockStream(options: { throwOnWrite?: boolean; callbackError?: Error } = {}) {
  const emitter = new EventEmitter()
  const writes: Buffer[] = []

  const stream = Object.assign(emitter, {
    writable: true,
    write: (chunk: Buffer, callback?: (err?: Error | null) => void) => {
      if (options.throwOnWrite) {
        throw new Error("write failed")
      }
      writes.push(Buffer.from(chunk))
      callback?.(options.callbackError ?? null)
      return true
    },
    end: () => {
      stream.writable = false
    },
    exit: (_code?: number) => {},
  })

  return { stream: stream as unknown as ServerChannel, writes }
}

async function createTestSession(streamOverride?: ReturnType<typeof createMockStream>) {
  const { stream, writes } = streamOverride ?? createMockStream()
  const session = await SSHSession.create(
    stream,
    { term: "xterm", width: 80, height: 24 },
    { username: "testuser" },
    "127.0.0.1",
  )
  return { session, stream, writes }
}

function waitForClose(session: SSHSession): Promise<void> {
  return new Promise<void>((resolve) => session.once("close", () => resolve()))
}

describe("SSHSession", () => {
  test("writes terminal setup output during create", async () => {
    const { session, writes } = await createTestSession()

    const deadline = Date.now() + 250
    while (writes.length === 0 && Date.now() < deadline) {
      await Bun.sleep(5)
    }

    expect(writes.length).toBeGreaterThan(0)

    session.close()
    await waitForClose(session)
  })

  test("close() is idempotent", async () => {
    const { session } = await createTestSession()

    const closePromise = waitForClose(session)
    await session.close()
    await session.close() // second call should be a no-op
    await closePromise

    // Should not throw or double-emit
    expect(session.pty).toBeDefined()
  })

  test("handleResize skips when session is closed", async () => {
    const { session } = await createTestSession()

    await session.close()

    // Should not throw — the _closed guard skips the resize
    session.handleResize(120, 40)
    expect(session.pty.width).toBe(80) // unchanged from original
  })

  test("handleResize rejects invalid dimensions", async () => {
    const { session } = await createTestSession()

    session.handleResize(0, 24)
    expect(session.pty.width).toBe(80) // unchanged

    session.handleResize(80, -1)
    expect(session.pty.height).toBe(24) // unchanged

    session.handleResize(10001, 24)
    expect(session.pty.width).toBe(80) // unchanged

    session.handleResize(NaN, 24)
    expect(session.pty.width).toBe(80) // unchanged

    session.handleResize(80.5, 24)
    expect(session.pty.width).toBe(80) // unchanged

    await session.close()
  })

  test("handleResize updates dimensions when valid", async () => {
    const { session } = await createTestSession()

    session.handleResize(120, 40)
    expect(session.pty.width).toBe(120)
    expect(session.pty.height).toBe(40)

    await session.close()
  })

  test("_cleanup from stream close is idempotent with close()", async () => {
    const mock = createMockStream()
    const { session, stream } = await createTestSession(mock)

    const closePromise = waitForClose(session)

    // Close from the SSH side (stream close event)
    stream.emit("close")
    await closePromise

    // Calling close() after stream-driven cleanup should not throw
    await session.close()
  })

  test("create succeeds when stream.write callback reports error", async () => {
    const mock = createMockStream({ callbackError: new Error("callback failure") })
    const { session, writes } = await createTestSession(mock)

    const deadline = Date.now() + 250
    while (writes.length === 0 && Date.now() < deadline) {
      await Bun.sleep(5)
    }

    expect(writes.length).toBeGreaterThan(0)

    await session.close()
  })

  test("create succeeds when stream.write throws synchronously", async () => {
    const mock = createMockStream({ throwOnWrite: true })
    const { session } = await createTestSession(mock)

    expect(session).toBeDefined()

    await session.close()
  })

  test("create rejects when renderer cannot be created", async () => {
    const { stream } = createMockStream()

    await expect(
      SSHSession.create(stream, { term: "xterm", width: 0, height: 24 }, { username: "testuser" }, "127.0.0.1"),
    ).rejects.toThrow("width to be a positive integer")
  })
})
