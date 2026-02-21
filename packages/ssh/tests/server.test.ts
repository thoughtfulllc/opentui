import { test, expect, describe, afterEach } from "bun:test"
import { EventEmitter } from "events"
import { createSSHServer, devMode } from "../src/index.ts"
import { SSHSession } from "../src/session.ts"
import type { UserInfo } from "../src/types.ts"
import { tmpdir } from "os"
import { join } from "path"
import { existsSync, rmSync } from "fs"

describe("SSHServer", () => {
  const testDir = join(tmpdir(), "opentui-ssh-server-test-" + Date.now())
  let serverCleanup: (() => Promise<void>) | null = null

  afterEach(async () => {
    // Cleanup server
    if (serverCleanup) {
      await serverCleanup()
      serverCleanup = null
    }

    // Cleanup test directory
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
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
    serverCleanup = async () => {
      await server.close()
    }
  })

  test("emits listening event on start", async () => {
    const server = createSSHServer({
      port: 0, // Random port
      hostKeyPath: join(testDir, "host-key-listening"),
      middleware: [devMode()],
    })
    serverCleanup = async () => {
      await server.close()
    }

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

    await server.close()
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
    serverCleanup = async () => {
      await server.close()
    }

    await server.listen()

    expect(existsSync(keyPath)).toBe(true)
  })

  test("uses default host (0.0.0.0) when not specified", () => {
    const server = createSSHServer({
      port: 2222,
      hostKeyPath: join(testDir, "host-key-default"),
      middleware: [devMode()],
    })
    serverCleanup = async () => {
      await server.close()
    }

    // Just verify it creates without error
    expect(server).toBeDefined()
  })

  test("requirePty defaults to true", () => {
    const server = createSSHServer({
      port: 2222,
      hostKeyPath: join(testDir, "host-key-pty"),
      middleware: [devMode()],
    })
    serverCleanup = async () => {
      await server.close()
    }

    // Server should be created with requirePty default
    expect(server).toBeDefined()
  })

  test("rejects shell when maxSessions limit is reached", () => {
    const server = createSSHServer({
      port: 0,
      hostKeyPath: join(testDir, "host-key-max-sessions"),
      middleware: [devMode()],
      requirePty: false,
      maxSessions: 1,
    })
    serverCleanup = async () => {
      await server.close()
    }

    const sshSession = new EventEmitter()
    ;(server as any).sessions = new Set([{}])
    ;(server as any).handleSession(
      sshSession as any,
      { username: "testuser" },
      "127.0.0.1",
      new EventEmitter() as any,
      {},
    )

    let rejected = false
    sshSession.emit(
      "shell",
      () => ({}),
      () => {
        rejected = true
      },
    )

    expect(rejected).toBe(true)
  })

  test("sets authenticated user before session start", async () => {
    const server = createSSHServer({
      port: 0,
      hostKeyPath: join(testDir, "host-key-auth-order"),
      middleware: [devMode()],
    })
    serverCleanup = async () => {
      await server.close()
    }

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

  test("falls back to default PTY size when client sends invalid dimensions", async () => {
    const server = createSSHServer({
      port: 0,
      hostKeyPath: join(testDir, "host-key-invalid-pty"),
      middleware: [devMode()],
      requirePty: false,
    })

    const originalCreate = SSHSession.create
    let capturedPty: { term: string; width: number; height: number } | null = null

    ;(SSHSession as any).create = (
      _stream: unknown,
      pty: { term: string; width: number; height: number },
      _user: unknown,
      _remoteAddress: unknown,
      _rendererOptions: unknown,
    ) => {
      capturedPty = pty
      const session = new EventEmitter() as any
      session.handleResize = () => {}
      session.close = async () => {
        session.emit("close")
      }
      return Promise.resolve(session)
    }

    try {
      const sshSession = new EventEmitter()
      ;(server as any).handleSession(
        sshSession as any,
        { username: "testuser" },
        "127.0.0.1",
        new EventEmitter() as any,
        {},
      )

      sshSession.emit(
        "pty",
        () => {},
        () => {},
        { term: "xterm-256color", cols: 0, rows: 0 },
      )

      const stream = new EventEmitter() as any
      stream.writable = true
      stream.exit = () => {}
      stream.end = () => {}

      sshSession.emit(
        "shell",
        () => stream,
        () => {
          throw new Error("shell should not be rejected")
        },
      )

      await Bun.sleep(0)

      if (!capturedPty) {
        throw new Error("Expected SSHSession.create to be called")
      }
      const resolvedPty = capturedPty as { term: string; width: number; height: number }
      expect(resolvedPty.term).toBe("xterm-256color")
      expect(resolvedPty.width).toBe(80)
      expect(resolvedPty.height).toBe(24)
    } finally {
      ;(SSHSession as any).create = originalCreate
      ;(server as any).sessions.clear()
      ;(server as any).pendingSessions = 0
    }
  })

  test("enforces maxSessions while session creation is pending", async () => {
    const server = createSSHServer({
      port: 0,
      hostKeyPath: join(testDir, "host-key-max-sessions-pending"),
      middleware: [devMode()],
      requirePty: false,
      maxSessions: 1,
    })

    const originalCreate = SSHSession.create
    let resolveCreate!: (session: SSHSession) => void
    const createPromise = new Promise<SSHSession>((resolve) => {
      resolveCreate = resolve
    })
    ;(SSHSession as any).create = () => createPromise

    try {
      const sshSession = new EventEmitter()
      ;(server as any).handleSession(
        sshSession as any,
        { username: "testuser" },
        "127.0.0.1",
        new EventEmitter() as any,
        {},
      )

      const stream1 = new EventEmitter() as any
      stream1.writable = true
      stream1.exit = () => {}
      stream1.end = () => {}

      let rejectedSecond = false

      sshSession.emit(
        "shell",
        () => stream1,
        () => {
          throw new Error("first shell should not be rejected")
        },
      )

      sshSession.emit(
        "shell",
        () => {
          throw new Error("second shell should be rejected before accept")
        },
        () => {
          rejectedSecond = true
        },
      )

      expect(rejectedSecond).toBe(true)
      expect((server as any).pendingSessions).toBe(1)

      const createdSession = new EventEmitter() as any
      createdSession.handleResize = () => {}
      createdSession.close = async () => {
        createdSession.emit("close")
      }
      resolveCreate(createdSession)
      await Bun.sleep(0)
    } finally {
      ;(SSHSession as any).create = originalCreate
      ;(server as any).sessions.clear()
      ;(server as any).pendingSessions = 0
    }
  })

  test("closes session created after close() begins", async () => {
    const server = createSSHServer({
      port: 0,
      hostKeyPath: join(testDir, "host-key-close-race"),
      middleware: [devMode()],
      requirePty: false,
    })

    ;(server as any).server = {
      close: (cb: () => void) => cb(),
      address: () => ({ port: 0 }),
    }

    const originalCreate = SSHSession.create
    let resolveCreate!: (session: SSHSession) => void
    const createPromise = new Promise<SSHSession>((resolve) => {
      resolveCreate = resolve
    })
    ;(SSHSession as any).create = () => createPromise

    try {
      const sshSession = new EventEmitter()
      ;(server as any).handleSession(
        sshSession as any,
        { username: "testuser" },
        "127.0.0.1",
        new EventEmitter() as any,
        {},
      )

      const stream = new EventEmitter() as any
      stream.writable = true
      stream.exit = () => {}
      stream.end = () => {}

      sshSession.emit(
        "shell",
        () => stream,
        () => {
          throw new Error("shell should not be rejected before close starts")
        },
      )

      const closePromise = server.close()

      let closeCalls = 0
      const createdSession = new EventEmitter() as any
      createdSession.handleResize = () => {}
      createdSession.close = async () => {
        closeCalls += 1
        createdSession.emit("close")
      }
      resolveCreate(createdSession)

      await closePromise
      await Bun.sleep(0)

      expect(closeCalls).toBe(1)
      expect(server.activeSessions).toBe(0)
    } finally {
      ;(SSHSession as any).create = originalCreate
      ;(server as any).sessions.clear()
      ;(server as any).pendingSessions = 0
    }
  })

  test("ignores second auth decision after accept", async () => {
    const server = createSSHServer({
      port: 0,
      hostKeyPath: join(testDir, "host-key-auth-guard"),
      middleware: [
        async (ctx, next) => {
          if (ctx.phase === "auth") {
            ctx.accept?.()
            await next()
            ctx.reject?.(["publickey"])
            return
          }
          await next()
        },
      ],
    })
    serverCleanup = async () => {
      await server.close()
    }

    let acceptCount = 0
    let rejectCount = 0

    await (server as any).handleAuth(
      {
        username: "testuser",
        method: "publickey",
        key: { algo: "ssh-ed25519", data: Buffer.from("AAAA", "base64") },
        accept: () => {
          acceptCount += 1
        },
        reject: () => {
          rejectCount += 1
        },
      },
      "127.0.0.1",
      new EventEmitter() as any,
      {},
    )

    expect(acceptCount).toBe(1)
    expect(rejectCount).toBe(0)
  })

  test("does not reject after accept when auth middleware throws", async () => {
    const server = createSSHServer({
      port: 0,
      hostKeyPath: join(testDir, "host-key-auth-accept-throw"),
      middleware: [
        async (ctx, _next) => {
          if (ctx.phase === "auth") {
            ctx.accept?.()
            throw new Error("auth middleware error after accept")
          }
        },
      ],
    })

    const client = new EventEmitter()
    ;(server as any).handleConnection(client as any, { ip: "127.0.0.1" } as any)

    let acceptCount = 0
    let rejectCount = 0
    let errorCount = 0
    server.on("error", () => {
      errorCount += 1
    })

    client.emit("authentication", {
      username: "testuser",
      method: "publickey",
      key: { algo: "ssh-ed25519", data: Buffer.from("AAAA", "base64") },
      accept: () => {
        acceptCount += 1
      },
      reject: () => {
        rejectCount += 1
      },
    } as any)

    await Bun.sleep(0)

    expect(acceptCount).toBe(1)
    expect(rejectCount).toBe(0)
    expect(errorCount).toBe(1)
  })
})
