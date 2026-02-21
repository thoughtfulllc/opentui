import type { CliRendererConfig } from "@opentui/core"
import type { Connection, PublicKey } from "ssh2"

export type MiddlewarePhase = "auth" | "session"

export interface MiddlewareContext {
  phase: MiddlewarePhase
  connection: Connection
  username: string
  clientKey?: PublicKey
  remoteAddress: string
  state: Record<string, unknown>
  accept?: () => void
  reject?: (allowedMethods?: string[]) => void
  /** Log helper that bypasses console capture - use in callbacks that run during renderer teardown */
  log: (message: string) => void
}

export type NextFn = () => void | Promise<void>
export type Middleware = (ctx: MiddlewareContext, next: NextFn) => void | Promise<void>

export interface SSHServerConfig {
  port: number
  host?: string
  hostKeyPath: string
  requirePty?: boolean
  // SSHSession owns stream-mode wiring (outputMode/onOutput/stdin/stdout/size).
  // rendererOptions only exposes safe app-level renderer tuning.
  rendererOptions?: Omit<
    CliRendererConfig,
    "stdin" | "stdout" | "outputMode" | "onOutput" | "width" | "height" | "feedOptions"
  >
  middleware?: Middleware[]
}

export interface PtyInfo {
  term: string
  width: number
  height: number
}

export interface UserInfo {
  username: string
  publicKey?: string
}

export interface PublicKeyOptions {
  authorizedKeysPath?: string
  authorizedKeys?: string[]
}

export interface LoggingOptions {
  onAuthAttempt?: (ctx: MiddlewareContext, success: boolean) => void
  onConnect?: (ctx: MiddlewareContext) => void
  onDisconnect?: (ctx: MiddlewareContext) => void
}

export interface AuthorizedKey {
  type: string
  key: string
  comment?: string
  options?: string
}
