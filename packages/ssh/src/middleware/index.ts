import { readFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { Middleware, LoggingOptions, PublicKeyOptions } from "../types.ts"
import { parseAuthorizedKeys, matchesKey } from "../utils/authorized-keys.ts"

export function compose(...middlewares: Middleware[]): Middleware {
  return async (ctx, next) => {
    let index = -1

    async function dispatch(i: number): Promise<void> {
      if (i <= index) throw new Error("next() called multiple times")
      index = i

      const fn = middlewares[i]
      if (!fn) {
        await next()
        return
      }

      await fn(ctx, () => dispatch(i + 1))
    }

    await dispatch(0)
  }
}

export function logging(options: LoggingOptions = {}): Middleware {
  const { onAuthAttempt, onConnect, onDisconnect } = options

  return async (ctx, next) => {
    if (ctx.phase === "auth") {
      // Wrap accept/reject to track auth result
      const originalAccept = ctx.accept
      const originalReject = ctx.reject
      let authResult: boolean | null = null

      if (originalAccept) {
        ctx.accept = () => {
          authResult = true
          originalAccept()
        }
      }

      if (originalReject) {
        ctx.reject = (allowedMethods) => {
          authResult = false
          originalReject(allowedMethods)
        }
      }

      await next()

      // Log auth attempt after middleware chain completes
      if (authResult !== null && onAuthAttempt) {
        onAuthAttempt(ctx, authResult)
      }
    } else if (ctx.phase === "session") {
      // Log connection
      if (onConnect) {
        onConnect(ctx)
      }

      // Set up disconnect listener (once — connection only closes once)
      if (onDisconnect) {
        ctx.connection.once("close", () => {
          onDisconnect(ctx)
        })
      }

      await next()
    } else {
      await next()
    }
  }
}

export function publicKey(options: PublicKeyOptions): Middleware {
  const parsedAuthorizedKeys = new Map<string, { type: string; key: string; comment?: string }>()

  const addParsedKeys = (rawKeys: string[]) => {
    if (rawKeys.length === 0) return

    const parsed = parseAuthorizedKeys(rawKeys.join("\n"))
    for (const key of parsed) {
      parsedAuthorizedKeys.set(`${key.type}:${key.key}`, key)
    }
  }

  addParsedKeys(options.authorizedKeys ?? [])

  // Load from file if path provided
  if (options.authorizedKeysPath) {
    const keyPath = options.authorizedKeysPath.replace(/^~/, homedir())
    if (existsSync(keyPath)) {
      const content = readFileSync(keyPath, "utf-8")
      addParsedKeys(content.split("\n"))
    } else if (parsedAuthorizedKeys.size === 0) {
      console.warn(
        `[SSH] authorizedKeysPath "${keyPath}" not found and no authorizedKeys provided` +
          " \u2014 all public key auth will be rejected",
      )
    } else {
      console.warn(`[SSH] authorizedKeysPath "${keyPath}" not found, using inline keys only`)
    }
  }

  const keys = Array.from(parsedAuthorizedKeys.values())

  return async (ctx, next) => {
    if (ctx.phase !== "auth") {
      await next()
      return
    }

    // Only handle publickey auth
    if (!ctx.clientKey) {
      // Not a publickey auth attempt, let other middleware handle it
      await next()
      return
    }

    // Get client key info
    const clientKeyType = ctx.clientKey.algo
    const clientKeyData = ctx.clientKey.data.toString("base64")

    // Check if key is authorized
    const isAuthorized = matchesKey(clientKeyType, clientKeyData, keys)

    if (isAuthorized) {
      ctx.accept?.()
    } else {
      ctx.reject?.(["publickey"])
    }

    // Do NOT call next() after accept/reject — downstream middleware could
    // override the auth decision. Outer middleware (like logging) completes
    // when control returns up the Koa onion stack, not via next() here.
  }
}

export function devMode(): Middleware {
  // Security warning - this middleware accepts ALL authentication attempts
  console.warn(
    "\x1b[33m[SSH WARNING]\x1b[0m devMode() middleware is enabled - ALL authentication attempts will be accepted!\n" +
      "             DO NOT use this in production.",
  )

  return async (ctx, next) => {
    if (ctx.phase === "auth" && ctx.accept) {
      ctx.accept()
    }
    await next()
  }
}
