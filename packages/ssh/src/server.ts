import { EventEmitter } from "events"
import {
  Server as SSH2Server,
  type Connection,
  type AuthContext,
  type Session,
  type ClientInfo,
  type AuthenticationType,
} from "ssh2"
import type { SSHServerConfig, MiddlewareContext, Middleware, PtyInfo, UserInfo } from "./types.ts"
import { SSHSession } from "./session.ts"
import { ensureHostKey } from "./utils/host-key.ts"
import { compose } from "./middleware/index.ts"

export interface SSHServerEvents {
  session: (session: SSHSession) => void
  listening: () => void
  error: (error: Error) => void
  close: () => void
}

// Declaration merging for typed events
export interface SSHServer {
  on<K extends keyof SSHServerEvents>(event: K, listener: SSHServerEvents[K]): this
  once<K extends keyof SSHServerEvents>(event: K, listener: SSHServerEvents[K]): this
  off<K extends keyof SSHServerEvents>(event: K, listener: SSHServerEvents[K]): this
  emit<K extends keyof SSHServerEvents>(event: K, ...args: Parameters<SSHServerEvents[K]>): boolean
}

export class SSHServer extends EventEmitter {
  private readonly _configPort: number
  private readonly host: string
  private readonly requirePty: boolean
  private readonly maxSessions: number
  private readonly middleware: Middleware
  private readonly hostKey: Buffer
  private readonly rendererOptions: SSHServerConfig["rendererOptions"]
  private server: SSH2Server | null = null
  private _listening = false
  private _closing = false
  private sessions = new Set<SSHSession>()
  private pendingSessions = 0

  private static readonly DEFAULT_PTY_WIDTH = 80
  private static readonly DEFAULT_PTY_HEIGHT = 24

  private normalizePtyInfo(pty: PtyInfo | null): PtyInfo {
    const width = pty && Number.isInteger(pty.width) && pty.width > 0 ? pty.width : SSHServer.DEFAULT_PTY_WIDTH
    const height = pty && Number.isInteger(pty.height) && pty.height > 0 ? pty.height : SSHServer.DEFAULT_PTY_HEIGHT

    return {
      term: pty?.term || "xterm",
      width,
      height,
    }
  }

  private createAuthDecision(
    ctx: AuthContext,
    onAccept?: () => void,
  ): {
    accept: () => void
    reject: (allowedMethods?: AuthenticationType[]) => void
    isResolved: () => boolean
  } {
    let resolved = false

    return {
      accept: () => {
        if (resolved) return
        resolved = true
        onAccept?.()
        ctx.accept()
      },
      reject: (allowedMethods?: AuthenticationType[]) => {
        if (resolved) return
        resolved = true
        ctx.reject(allowedMethods)
      },
      isResolved: () => resolved,
    }
  }

  /** Returns the actual bound port (resolves port 0 after listen). */
  public get port(): number {
    const addr = this.server?.address()
    return typeof addr === "object" && addr?.port ? addr.port : this._configPort
  }

  constructor(private config: SSHServerConfig) {
    super()
    this._configPort = config.port
    this.host = config.host ?? "0.0.0.0"
    this.requirePty = config.requirePty ?? true
    this.maxSessions = config.maxSessions ?? 0
    this.rendererOptions = config.rendererOptions
    this.hostKey = ensureHostKey(config.hostKeyPath)
    this.middleware = config.middleware?.length ? compose(...config.middleware) : async (_, next) => next()
  }

  public async listen(): Promise<void> {
    if (this._listening) return

    return new Promise((resolve, reject) => {
      this._closing = false
      this.server = new SSH2Server({ hostKeys: [this.hostKey] }, (client, info) => this.handleConnection(client, info))

      this.server.on("error", (err: Error) => {
        this.emit("error", err)
        if (!this._listening) reject(err)
      })

      this.server.listen(this.port, this.host, () => {
        this._listening = true
        this.emit("listening")
        resolve()
      })
    })
  }

  public async close(): Promise<void> {
    if (!this.server) {
      return
    }

    this._closing = true

    const server = this.server
    this.server = null
    this._listening = false

    const sessions = Array.from(this.sessions)
    this.sessions.clear()

    await Promise.allSettled(sessions.map((session) => session.close()))

    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve())
      } catch {
        resolve()
      }
    })

    this.emit("close")
  }

  private trackSession(session: SSHSession): void {
    this.sessions.add(session)
    session.once("close", () => this.sessions.delete(session))
  }

  public get activeSessions(): number {
    return this.sessions.size
  }

  private handleConnection(client: Connection, info: ClientInfo): void {
    const remoteAddress = info.ip
    let authenticatedUser: UserInfo | null = null
    // Per-connection state shared across auth and session middleware phases
    const connectionState: Record<string, unknown> = {}

    client.on("authentication", (ctx: AuthContext) => {
      // ssh2 can emit "ready"/"session" synchronously after accept; set user before calling accept.
      const authDecision = this.createAuthDecision(ctx, () => {
        authenticatedUser = {
          username: ctx.username,
          publicKey: ctx.method === "publickey" && ctx.key ? ctx.key.algo : undefined,
        }
      })

      this.handleAuth(ctx, remoteAddress, client, connectionState, authDecision).catch((err) => {
        this.emit("error", err)
        authDecision.reject(["publickey"])
      })
    })

    client.on("ready", () => {
      client.on("session", (accept, reject) => {
        if (!authenticatedUser) {
          reject?.()
          return
        }

        const sshSession = accept()
        this.handleSession(sshSession, authenticatedUser, remoteAddress, client, connectionState)
      })
    })

    client.on("error", (err: Error) => {
      this.emit("error", err)
    })
  }

  private async handleAuth(
    ctx: AuthContext,
    remoteAddress: string,
    connection: Connection,
    connectionState: Record<string, unknown>,
    authDecision: {
      accept: () => void
      reject: (allowedMethods?: AuthenticationType[]) => void
      isResolved: () => boolean
    } = this.createAuthDecision(ctx),
  ): Promise<void> {
    const middlewareCtx: MiddlewareContext = {
      phase: "auth",
      connection,
      username: ctx.username,
      clientKey: ctx.method === "publickey" ? ctx.key : undefined,
      remoteAddress,
      state: connectionState,
      log: (message: string) => process.stdout.write(message + "\n"),
    }

    middlewareCtx.accept = () => {
      authDecision.accept()
    }

    middlewareCtx.reject = (allowedMethods?: string[]) => {
      authDecision.reject(allowedMethods as AuthenticationType[] | undefined)
    }

    await this.middleware(middlewareCtx, () => {
      // Default: reject if no middleware accepted
      if (!authDecision.isResolved()) {
        authDecision.reject(["publickey"])
      }
    })
  }

  private handleSession(
    sshSession: Session,
    user: UserInfo,
    remoteAddress: string,
    connection: Connection,
    connectionState: Record<string, unknown>,
  ): void {
    let ptyInfo: PtyInfo | null = null

    sshSession.on("pty", (accept, _reject, info) => {
      // PseudoTtyInfo has cols, rows, width, height, modes
      // term type comes from the info object at runtime (ssh2 types may be incomplete)
      const termInfo = info as { term?: string; cols: number; rows: number }
      ptyInfo = {
        term: termInfo.term ?? "xterm",
        width: info.cols,
        height: info.rows,
      }
      accept?.()
    })

    sshSession.on("shell", (accept, reject) => {
      if (this._closing) {
        reject?.()
        return
      }

      if (this.requirePty && !ptyInfo) {
        reject?.()
        return
      }

      // Enforce maxSessions limit (0 = unlimited)
      if (this.maxSessions > 0 && this.sessions.size + this.pendingSessions >= this.maxSessions) {
        reject?.()
        return
      }

      const stream = accept()
      if (!stream) return

      this.pendingSessions += 1

      const releasePendingSession = () => {
        this.pendingSessions = Math.max(0, this.pendingSessions - 1)
      }

      // Run middleware for session phase (enables onConnect/onDisconnect logging)
      const middlewareCtx: MiddlewareContext = {
        phase: "session",
        connection,
        username: user.username,
        remoteAddress,
        state: connectionState,
        log: (message: string) => process.stdout.write(message + "\n"),
      }
      // Start middleware with error handling (non-blocking)
      Promise.resolve(this.middleware(middlewareCtx, () => Promise.resolve())).catch((err: Error) => {
        this.emit("error", err)
      })

      // Use PTY dimensions when valid; fallback to safe defaults for buggy clients.
      const finalPty = this.normalizePtyInfo(ptyInfo)

      // Create session asynchronously
      SSHSession.create(stream, finalPty, user, remoteAddress, this.rendererOptions)
        .then((session) => {
          releasePendingSession()

          if (this._closing) {
            void session.close().catch((err) => {
              this.emit("error", err as Error)
            })
            return
          }

          this.trackSession(session)

          // Handle window-change on the ssh session (not stream)
          const windowChangeHandler = (accept: (() => void) | undefined, _reject: any, info: any) => {
            session.handleResize(info.cols, info.rows)
            accept?.()
          }
          sshSession.on("window-change", windowChangeHandler)

          // Remove window-change listener when session closes to avoid reference leak
          session.once("close", () => {
            sshSession.removeListener("window-change", windowChangeHandler)
          })

          this.emit("session", session)
        })
        .catch((err) => {
          releasePendingSession()
          this.emit("error", err as Error)
          stream.exit(1)
          stream.end()
        })
    })

    // Handle exec requests (e.g., Ghostty terminfo setup)
    // Accept and immediately exit to prevent client hang
    // Some clients (like Ghostty with ssh-terminfo) run preflight exec commands
    // Rejecting can leave them waiting; accepting + exiting completes quickly
    sshSession.on("exec", (accept, _reject, info) => {
      const stream = accept()
      if (stream) {
        // Log the exec attempt for debugging (note: we accept then exit, not reject)
        const command = (info as { command?: string }).command ?? "<unknown>"
        console.error(
          `[SSH] exec request not supported (command: ${command.substring(0, 50)}${command.length > 50 ? "..." : ""})`,
        )
        // Exit with non-zero status to indicate exec is not supported
        stream.exit(1)
        stream.end()
      }
    })
  }
}

export function createSSHServer(config: SSHServerConfig): SSHServer {
  return new SSHServer(config)
}
