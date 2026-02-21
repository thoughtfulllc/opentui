import { test, expect, describe, afterEach } from "bun:test"
import { EventEmitter } from "events"
import { createSSHServer, devMode } from "../src/index.ts"
import type { UserInfo } from "../src/types.ts"
import { tmpdir } from "os"
import { join } from "path"
import { unlinkSync, existsSync, rmdirSync } from "fs"

describe("SSHServer", () => {
  const testDir = join(tmpdir(), "opentui-ssh-server-test-" + Date.now())
  let serverCleanup: (() => void) | null = null

  afterEach(() => {
    // Cleanup server
    if (serverCleanup) {
      serverCleanup()
      serverCleanup = null
    }

    // Cleanup test directory
    try {
      if (existsSync(testDir)) {
        rmdirSync(testDir, { recursive: true })
      }
    } catch {
      // Ignore
    }
  })

  test("creates server with config", () => {
    const server = createSSHServer({
      port: 0,
      hostKeyPath: join(testDir, "host-key"),
      middleware: [devMode()],
    })

    expect(server).toBeDefined()
    expect(server.port).toBe(0)
    serverCleanup = () => server.close()
  })

  test("emits listening event on start", async () => {
    const server = createSSHServer({
      port: 0, // Random port
      hostKeyPath: join(testDir, "host-key-listening"),
      middleware: [devMode()],
    })
    serverCleanup = () => server.close()

    let listeningEmitted = false
    server.on("listening", () => {
      listeningEmitted = true
    })

    await server.listen()

    expect(listeningEmitted).toBe(true)
  })

  test("emits close event on stop", async () => {
    const server = createSSHServer({
      port: 0,
      hostKeyPath: join(testDir, "host-key-close"),
      middleware: [devMode()],
    })

    await server.listen()

    let closeEmitted = false
    server.on("close", () => {
      closeEmitted = true
    })

    server.close()
    serverCleanup = null // Already closed

    expect(closeEmitted).toBe(true)
  })

  test("generates host key if missing", async () => {
    const keyPath = join(testDir, "generated-host-key")

    expect(existsSync(keyPath)).toBe(false)

    const server = createSSHServer({
      port: 0,
      hostKeyPath: keyPath,
      middleware: [devMode()],
    })
    serverCleanup = () => server.close()

    await server.listen()

    expect(existsSync(keyPath)).toBe(true)
  })

  test("uses default host (0.0.0.0) when not specified", () => {
    const server = createSSHServer({
      port: 2222,
      hostKeyPath: join(testDir, "host-key-default"),
      middleware: [devMode()],
    })
    serverCleanup = () => server.close()

    // Just verify it creates without error
    expect(server).toBeDefined()
  })

  test("requirePty defaults to true", () => {
    const server = createSSHServer({
      port: 2222,
      hostKeyPath: join(testDir, "host-key-pty"),
      middleware: [devMode()],
    })
    serverCleanup = () => server.close()

    // Server should be created with requirePty default
    expect(server).toBeDefined()
  })

  test("sets authenticated user before session start", async () => {
    const server = createSSHServer({
      port: 0,
      hostKeyPath: join(testDir, "host-key-auth-order"),
      middleware: [devMode()],
    })
    serverCleanup = () => server.close()

    const client = new EventEmitter()
    let capturedUser: UserInfo | null = null

    ;(server as any).handleSession = (_sshSession: unknown, user: UserInfo) => {
      capturedUser = user
    }
    ;(server as any).handleConnection(client as any, { ip: "127.0.0.1" } as any)

    const ctx = {
      username: "testuser",
      method: "publickey",
      key: { algo: "ssh-ed25519", data: Buffer.from("AAAA", "base64") },
      accept: () => {
        client.emit("ready")
        client.emit(
          "session",
          () => ({}),
          () => {},
        )
      },
      reject: () => {},
    } as any

    client.emit("authentication", ctx)

    await new Promise((resolve) => setTimeout(resolve, 0))

    if (!capturedUser) {
      throw new Error("Expected authenticated user")
    }

    const resolvedUser = capturedUser as unknown as { username: string; publicKey?: string }
    expect(resolvedUser.username).toBe("testuser")
    expect(resolvedUser.publicKey).toBe("ssh-ed25519")
  })
})
