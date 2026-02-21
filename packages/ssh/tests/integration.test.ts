import { test, expect, describe } from "bun:test"
import { EventEmitter } from "events"
import type { ServerChannel } from "ssh2"
import { TextRenderable, RGBA } from "@opentui/core"
import { SSHSession } from "../src/session.ts"

function createMockStream() {
  const emitter = new EventEmitter()
  const writes: Buffer[] = []

  const stream = Object.assign(emitter, {
    writable: true,
    write: (chunk: Buffer, callback?: (err?: Error | null) => void) => {
      writes.push(Buffer.from(chunk))
      callback?.(null)
      return true
    },
    end: () => {
      stream.writable = false
    },
    exit: (_code?: number) => {},
  })

  return { stream: stream as unknown as ServerChannel, writes }
}

async function createSession() {
  const { stream, writes } = createMockStream()
  const session = await SSHSession.create(
    stream,
    { term: "xterm", width: 80, height: 24 },
    { username: "test" },
    "127.0.0.1",
  )
  return { session, stream, writes }
}

describe("SSH integration", () => {
  test("forwards stream input to renderer key handlers", async () => {
    const { session, stream } = await createSession()
    let keypressReceived = false

    session.renderer.keyInput.on("keypress", (key: any) => {
      if (key.name === "a") {
        keypressReceived = true
      }
    })

    stream.emit("data", Buffer.from("a"))
    await Bun.sleep(20)

    expect(keypressReceived).toBe(true)
    await session.close()
  })

  test("propagates renderer output to stream writes", async () => {
    const { session, writes } = await createSession()

    const initialWrites = writes.length
    const text = new TextRenderable(session.renderer, {
      id: "integration-text",
      content: "hello over ssh",
      fg: RGBA.fromInts(255, 255, 255, 255),
    })
    session.renderer.root.add(text)

    session.renderer.requestRender()

    const deadline = Date.now() + 300
    while (writes.length <= initialWrites && Date.now() < deadline) {
      await Bun.sleep(10)
    }

    expect(writes.length).toBeGreaterThan(initialWrites)
    await session.close()
  })

  test("propagates resize to renderer dimensions", async () => {
    const { session } = await createSession()

    session.handleResize(100, 30)

    const deadline = Date.now() + 300
    while ((session.renderer.width !== 100 || session.renderer.height !== 30) && Date.now() < deadline) {
      await Bun.sleep(10)
    }

    expect(session.renderer.width).toBe(100)
    expect(session.renderer.height).toBe(30)
    await session.close()
  })

  test("close() tears down renderer lifecycle", async () => {
    const { session } = await createSession()

    await session.close()

    expect(session.renderer.isDestroyed).toBe(true)
  })
})
