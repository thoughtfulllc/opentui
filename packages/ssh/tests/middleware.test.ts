import { test, expect, describe } from "bun:test"
import { EventEmitter } from "events"
import { compose, devMode, logging, publicKey } from "../src/middleware/index.ts"
import type { MiddlewareContext, Middleware } from "../src/types.ts"
import type { PublicKey } from "ssh2"

function createMockContext(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    phase: "auth",
    connection: {} as any,
    username: "testuser",
    remoteAddress: "127.0.0.1",
    state: {},
    ...overrides,
  }
}

describe("compose", () => {
  test("executes middlewares in order (before next)", async () => {
    const order: string[] = []

    const mw1: Middleware = async (_ctx, next) => {
      order.push("mw1-before")
      await next()
      order.push("mw1-after")
    }

    const mw2: Middleware = async (_ctx, next) => {
      order.push("mw2-before")
      await next()
      order.push("mw2-after")
    }

    const mw3: Middleware = async (_ctx, next) => {
      order.push("mw3-before")
      await next()
      order.push("mw3-after")
    }

    const composed = compose(mw1, mw2, mw3)
    const ctx = createMockContext()

    await composed(ctx, () => {
      order.push("final")
    })

    expect(order).toEqual(["mw1-before", "mw2-before", "mw3-before", "final", "mw3-after", "mw2-after", "mw1-after"])
  })

  test("passes context through middleware chain", async () => {
    const mw1: Middleware = async (ctx, next) => {
      ctx.state.mw1 = true
      await next()
    }

    const mw2: Middleware = async (ctx, next) => {
      ctx.state.mw2 = ctx.state.mw1 ? "saw-mw1" : "no-mw1"
      await next()
    }

    const composed = compose(mw1, mw2)
    const ctx = createMockContext()

    await composed(ctx, () => {})

    expect(ctx.state.mw1).toBe(true)
    expect(ctx.state.mw2).toBe("saw-mw1")
  })

  test("throws error when next() called multiple times", async () => {
    const badMw: Middleware = async (_ctx, next) => {
      await next()
      await next()
    }

    const composed = compose(badMw)
    const ctx = createMockContext()

    await expect(composed(ctx, () => {})).rejects.toThrow("next() called multiple times")
  })

  test("works with empty middleware array", async () => {
    const composed = compose()
    const ctx = createMockContext()
    let finalCalled = false

    await composed(ctx, () => {
      finalCalled = true
    })

    expect(finalCalled).toBe(true)
  })

  test("middleware can short-circuit by not calling next", async () => {
    const order: string[] = []

    const mw1: Middleware = async (_ctx, next) => {
      order.push("mw1-before")
      await next()
      order.push("mw1-after")
    }

    const shortCircuit: Middleware = async (_ctx, _next) => {
      order.push("short-circuit")
      // Don't call next()
    }

    const mw3: Middleware = async (_ctx, next) => {
      order.push("mw3-before")
      await next()
      order.push("mw3-after")
    }

    const composed = compose(mw1, shortCircuit, mw3)
    const ctx = createMockContext()

    await composed(ctx, () => {
      order.push("final")
    })

    expect(order).toEqual(["mw1-before", "short-circuit", "mw1-after"])
  })
})

describe("devMode", () => {
  test("accepts auth requests", async () => {
    const mw = devMode()
    let accepted = false

    const ctx = createMockContext({
      phase: "auth",
      accept: () => {
        accepted = true
      },
    })

    await mw(ctx, () => {})

    expect(accepted).toBe(true)
  })

  test("does not accept on session phase", async () => {
    const mw = devMode()
    let accepted = false

    const ctx = createMockContext({
      phase: "session",
      accept: () => {
        accepted = true
      },
    })

    await mw(ctx, () => {})

    expect(accepted).toBe(false)
  })

  test("calls next after accepting", async () => {
    const mw = devMode()
    let nextCalled = false

    const ctx = createMockContext({
      phase: "auth",
      accept: () => {},
    })

    await mw(ctx, () => {
      nextCalled = true
    })

    expect(nextCalled).toBe(true)
  })
})

describe("logging", () => {
  test("calls onAuthAttempt with success on accept", async () => {
    let authResult: boolean | undefined
    const mw = logging({
      onAuthAttempt: (_ctx, success) => {
        authResult = success
      },
    })

    const ctx = createMockContext({
      phase: "auth",
      accept: () => {},
    })

    // Simulate acceptance by another middleware
    const composed = compose(mw, devMode())
    await composed(ctx, () => {})

    expect(authResult).toBe(true)
  })

  test("calls onAuthAttempt with failure on reject", async () => {
    let authResult: boolean | undefined
    const mw = logging({
      onAuthAttempt: (_ctx, success) => {
        authResult = success
      },
    })

    const ctx = createMockContext({
      phase: "auth",
      accept: () => {},
      reject: () => {},
    })

    // Simulate rejection
    const rejectMw: Middleware = async (ctx, next) => {
      ctx.reject?.()
      await next()
    }

    const composed = compose(mw, rejectMw)
    await composed(ctx, () => {})

    expect(authResult).toBe(false)
  })

  test("calls onConnect on session phase", async () => {
    let connectCalled = false
    const mw = logging({
      onConnect: () => {
        connectCalled = true
      },
    })

    const mockConnection = new EventEmitter()
    const ctx = createMockContext({
      phase: "session",
      connection: mockConnection as any,
    })

    await mw(ctx, () => {})

    expect(connectCalled).toBe(true)
  })

  test("sets up onDisconnect listener", async () => {
    let disconnectCalled = false
    const mw = logging({
      onDisconnect: () => {
        disconnectCalled = true
      },
    })

    const mockConnection = new EventEmitter()
    const ctx = createMockContext({
      phase: "session",
      connection: mockConnection as any,
    })

    await mw(ctx, () => {})

    // Trigger close event
    mockConnection.emit("close")

    expect(disconnectCalled).toBe(true)
  })
})

describe("publicKey", () => {
  // Valid Ed25519 key for testing
  const validKeyType = "ssh-ed25519"
  const validKeyData = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
  const validKeyString = `${validKeyType} ${validKeyData} test@host`

  function createClientKey(algo: string, dataBase64: string): PublicKey {
    return {
      algo,
      data: Buffer.from(dataBase64, "base64"),
    }
  }

  test("accepts authorized key", async () => {
    const mw = publicKey({
      authorizedKeys: [validKeyString],
    })

    let accepted = false
    const ctx = createMockContext({
      phase: "auth",
      clientKey: createClientKey(validKeyType, validKeyData),
      accept: () => {
        accepted = true
      },
      reject: () => {},
    })

    await mw(ctx, () => {})

    expect(accepted).toBe(true)
  })

  test("rejects unauthorized key", async () => {
    const mw = publicKey({
      authorizedKeys: [validKeyString],
    })

    let rejected = false
    const ctx = createMockContext({
      phase: "auth",
      clientKey: createClientKey("ssh-ed25519", "DIFFERENT_KEY_DATA"),
      accept: () => {},
      reject: () => {
        rejected = true
      },
    })

    await mw(ctx, () => {})

    expect(rejected).toBe(true)
  })

  test("rejects when no keys authorized", async () => {
    const mw = publicKey({
      authorizedKeys: [],
    })

    let rejected = false
    const ctx = createMockContext({
      phase: "auth",
      clientKey: createClientKey(validKeyType, validKeyData),
      accept: () => {},
      reject: () => {
        rejected = true
      },
    })

    await mw(ctx, () => {})

    expect(rejected).toBe(true)
  })

  test("passes through non-auth phases", async () => {
    const mw = publicKey({
      authorizedKeys: [],
    })

    let nextCalled = false
    let accepted = false
    let rejected = false

    const ctx = createMockContext({
      phase: "session",
      accept: () => {
        accepted = true
      },
      reject: () => {
        rejected = true
      },
    })

    await mw(ctx, () => {
      nextCalled = true
    })

    expect(nextCalled).toBe(true)
    expect(accepted).toBe(false)
    expect(rejected).toBe(false)
  })

  test("passes through non-publickey auth", async () => {
    const mw = publicKey({
      authorizedKeys: [validKeyString],
    })

    let nextCalled = false
    let accepted = false
    let rejected = false

    const ctx = createMockContext({
      phase: "auth",
      clientKey: undefined, // No client key = not publickey auth
      accept: () => {
        accepted = true
      },
      reject: () => {
        rejected = true
      },
    })

    await mw(ctx, () => {
      nextCalled = true
    })

    expect(nextCalled).toBe(true)
    expect(accepted).toBe(false)
    expect(rejected).toBe(false)
  })
})
