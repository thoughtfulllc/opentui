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
  public readonly port: number
  private readonly host: string
  private readonly requirePty: boolean
  private readonly middleware: Middleware
  private readonly hostKey: Buffer
  private readonly rendererOptions: SSHServerConfig["rendererOptions"]
  private server: SSH2Server | null = null
  private _listening = false

  constructor(private config: SSHServerConfig) {
    super()
    this.port = config.port
    this.host = config.host ?? "0.0.0.0"
    this.requirePty = config.requirePty ?? true
    this.rendererOptions = config.rendererOptions
    this.hostKey = ensureHostKey(config.hostKeyPath)
    this.middleware = config.middleware?.length ? compose(...config.middleware) : async (_, next) => next()
  }

  public async listen(): Promise<void> {
    if (this._listening) return

    return new Promise((resolve, reject) => {
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

  public close(): void {
    if (this.server) {
      this.server.close()
      this.server = null
      this._listening = false
      this.emit("close")
    }
  }

  private handleConnection(client: Connection, info: ClientInfo): void {
    const remoteAddress = info.ip
    let authenticatedUser: UserInfo | null = null

    client.on("authentication", (ctx: AuthContext) => {
      // ssh2 can emit "ready"/"session" synchronously after accept; set user before calling accept.
      const originalAccept = ctx.accept.bind(ctx)
      ctx.accept = () => {
        authenticatedUser = {
          username: ctx.username,
          publicKey: ctx.method === "publickey" && ctx.key ? ctx.key.algo : undefined,
        }
        originalAccept()
      }

      this.handleAuth(ctx, remoteAddress, client).catch((err) => {
        this.emit("error", err)
        ctx.reject()
      })
    })

    client.on("ready", () => {
      client.on("session", (accept, _reject) => {
        const sshSession = accept()
        this.handleSession(sshSession, authenticatedUser!, remoteAddress, client)
      })
    })

    client.on("error", (err: Error) => {
      this.emit("error", err)
    })
  }

  private async handleAuth(ctx: AuthContext, remoteAddress: string, connection: Connection): Promise<UserInfo | null> {
    const middlewareCtx: MiddlewareContext = {
      phase: "auth",
      connection,
      username: ctx.username,
      clientKey: ctx.method === "publickey" ? ctx.key : undefined,
      remoteAddress,
      state: {},
      log: (message: string) => process.stdout.write(message + "\n"),
    }

    let accepted = false
    let rejected = false

    middlewareCtx.accept = () => {
      accepted = true
      ctx.accept()
    }

    middlewareCtx.reject = (allowedMethods?: string[]) => {
      rejected = true
      ctx.reject(allowedMethods as AuthenticationType[] | undefined)
    }

    await this.middleware(middlewareCtx, () => {
      // Default: reject if no middleware accepted
      if (!accepted && !rejected) {
        ctx.reject(["publickey"] as AuthenticationType[])
      }
    })

    if (accepted) {
      return {
        username: ctx.username,
        publicKey: ctx.method === "publickey" && ctx.key ? ctx.key.algo : undefined,
      }
    }

    return null
  }

  private handleSession(sshSession: Session, user: UserInfo, remoteAddress: string, connection: Connection): void {
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
      if (this.requirePty && !ptyInfo) {
        reject?.()
        return
      }

      const stream = accept()
      if (!stream) return

      // Run middleware for session phase (enables onConnect/onDisconnect logging)
      const middlewareCtx: MiddlewareContext = {
        phase: "session",
        connection,
        username: user.username,
        remoteAddress,
        state: {},
        log: (message: string) => process.stdout.write(message + "\n"),
      }
      // Start middleware with error handling (non-blocking)
      Promise.resolve(this.middleware(middlewareCtx, () => Promise.resolve())).catch((err: Error) => {
        this.emit("error", err)
      })

      // Use PTY dimensions or default to 80x24
      const finalPty = ptyInfo ?? { term: "xterm", width: 80, height: 24 }

      // Create session asynchronously
      SSHSession.create(stream, finalPty, user, remoteAddress, this.rendererOptions)
        .then((session) => {
          // Handle window-change on the ssh session (not stream)
          sshSession.on("window-change", (accept, _reject, info) => {
            session.handleResize(info.cols, info.rows)
            accept?.()
          })

          this.emit("session", session)
        })
        .catch((err) => {
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
        console.log(
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
