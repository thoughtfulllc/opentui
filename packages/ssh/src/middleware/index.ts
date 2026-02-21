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

      // Set up disconnect listener
      if (onDisconnect) {
        ctx.connection.on("close", () => {
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
  // Load authorized keys
  let authorizedKeys = options.authorizedKeys ?? []

  // Load from file if path provided
  if (options.authorizedKeysPath) {
    const keyPath = options.authorizedKeysPath.replace(/^~/, homedir())
    if (existsSync(keyPath)) {
      const content = readFileSync(keyPath, "utf-8")
      const parsedKeys = parseAuthorizedKeys(content)
      authorizedKeys = [...authorizedKeys, ...parsedKeys.map((k) => `${k.type} ${k.key}`)]
    }
  }

  // Parse all keys once
  const parsedAuthorizedKeys = authorizedKeys
    .map((keyStr) => {
      const parts = keyStr.split(" ")
      if (parts.length >= 2) {
        return { type: parts[0], key: parts[1], comment: parts.slice(2).join(" ") || undefined }
      }
      return null
    })
    .filter((k): k is NonNullable<typeof k> => k !== null)

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
    const isAuthorized = matchesKey(clientKeyType, clientKeyData, parsedAuthorizedKeys)

    if (isAuthorized) {
      ctx.accept?.()
    } else {
      ctx.reject?.(["publickey"])
    }

    // Always call next() to allow outer middleware (like logging) to complete
    // and let the default handler run (which is a no-op if we already decided)
    await next()
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
