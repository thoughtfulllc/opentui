import { test, expect } from "bun:test"
import { EventEmitter } from "events"
import type { ServerChannel } from "ssh2"
import { SSHSession } from "../src/session.ts"

function createMockStream() {
  const emitter = new EventEmitter()
  const writes: Buffer[] = []

  const stream = Object.assign(emitter, {
    writable: true,
    write: (chunk: Buffer, callback?: () => void) => {
      writes.push(Buffer.from(chunk))
      callback?.()
      return true
    },
    end: () => {
      stream.writable = false
    },
    exit: (_code?: number) => {},
  })

  return { stream: stream as unknown as ServerChannel, writes }
}

test("SSHSession writes terminal setup output during create", async () => {
  const { stream, writes } = createMockStream()

  const session = await SSHSession.create(
    stream,
    { term: "xterm", width: 80, height: 24 },
    { username: "testuser" },
    "127.0.0.1",
  )

  const deadline = Date.now() + 250
  while (writes.length === 0 && Date.now() < deadline) {
    await Bun.sleep(5)
  }

  expect(writes.length).toBeGreaterThan(0)

  session.close()
  await new Promise<void>((resolve) => session.once("close", () => resolve()))
})
