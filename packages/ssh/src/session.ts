import { EventEmitter } from "events"
import { createCliRenderer, type CliRenderer, type CliRendererConfig } from "@opentui/core"
import type { ServerChannel } from "ssh2"
import type { PtyInfo, UserInfo } from "./types.ts"

export interface SSHSessionEvents {
  close: () => void
  resize: (width: number, height: number) => void
}

// Declaration merging for typed events
export interface SSHSession {
  on<K extends keyof SSHSessionEvents>(event: K, listener: SSHSessionEvents[K]): this
  once<K extends keyof SSHSessionEvents>(event: K, listener: SSHSessionEvents[K]): this
  off<K extends keyof SSHSessionEvents>(event: K, listener: SSHSessionEvents[K]): this
  emit<K extends keyof SSHSessionEvents>(event: K, ...args: Parameters<SSHSessionEvents[K]>): boolean
}

export class SSHSession extends EventEmitter {
  public readonly renderer: CliRenderer
  public readonly user: UserInfo
  public readonly remoteAddress: string

  private _pty: PtyInfo
  private _stream: ServerChannel
  private _closed = false
  private _closePromise: Promise<void> | null = null

  private static readonly MAX_WIDTH = 500
  private static readonly MAX_HEIGHT = 200
  private static readonly IDLE_TIMEOUT_MS = 5000

  public get pty(): Readonly<PtyInfo> {
    return this._pty
  }

  private constructor(
    renderer: CliRenderer,
    stream: ServerChannel,
    ptyInfo: PtyInfo,
    user: UserInfo,
    remoteAddress: string,
  ) {
    super()
    this.renderer = renderer
    this._stream = stream
    this._pty = { ...ptyInfo }
    this.user = user
    this.remoteAddress = remoteAddress
  }

  static async create(
    stream: ServerChannel,
    ptyInfo: PtyInfo,
    user: UserInfo,
    remoteAddress: string,
    rendererOptions: Partial<
      Omit<CliRendererConfig, "stdin" | "stdout" | "outputMode" | "onOutput" | "width" | "height" | "feedOptions">
    > = {},
  ): Promise<SSHSession> {
    // Create placeholder for the session so we can reference it in onOutput.
    // Note: `session` is null during createCliRenderer(). The optional chaining
    // (`session?.`) evaluates to undefined (falsy), allowing initial setup output
    // to flow through to the stream. This is intentional — the SSH stream is
    // writable before the SSHSession wrapper is constructed.
    let session: SSHSession | null = null

    const renderer = await createCliRenderer({
      ...rendererOptions,
      outputMode: "stream",
      width: ptyInfo.width,
      height: ptyInfo.height,
      useAlternateScreen: rendererOptions.useAlternateScreen ?? true,
      openConsoleOnError: false,
      useConsole: false,
      exitOnCtrlC: false,
      exitSignals: [],
      onOutput: (buffer: Uint8Array) => {
        // Guard: skip write if session is closed or stream is not writable
        if (session?._closed || !stream.writable) {
          return
        }
        // Zero-copy write to SSH stream:
        // Buffer.from(arrayBuffer, offset, length) creates a VIEW over the same memory,
        // NOT a copy. This was validated in Bun runtime - modifications to either the
        // original Uint8Array or the Buffer reflect in both.
        // The native buffer stays pinned until the returned Promise resolves.
        const out = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        return new Promise<void>((resolve) => {
          // Wrap stream.write in try/catch to guarantee resolution even on error
          try {
            stream.write(out, (err) => {
              if (err) {
                console.error(`[SSH] Stream write error: ${err.message}`)
              }
              resolve()
            })
          } catch (err) {
            // stream.write can throw synchronously if stream is destroyed
            console.error(`[SSH] Stream write threw: ${err instanceof Error ? err.message : String(err)}`)
            resolve()
          }
        })
      },
    })

    session = new SSHSession(renderer, stream, ptyInfo, user, remoteAddress)

    // Wire SSH input -> renderer
    stream.on("data", (data: Buffer) => {
      if (!session!._closed) {
        renderer.input(data)
      }
    })

    // Handle stream errors
    stream.on("error", (err: Error) => {
      console.error(`[SSH] Stream error: ${err.message}`)
      session!._cleanup()
    })

    // Wire cleanup on stream close
    stream.once("close", () => {
      session!._cleanup()
    })

    return session
  }

  /** Internal cleanup when stream closes/errors - idempotent */
  private _cleanup(): void {
    void this.beginClose({ closeStream: false })
  }

  private async waitForRendererIdleWithTimeout(): Promise<void> {
    await Promise.race([
      this.renderer.idle(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SSHSession.IDLE_TIMEOUT_MS)
      }),
    ])
  }

  private beginClose(options: { closeStream: boolean; exitCode?: number }): Promise<void> {
    if (this._closePromise) {
      return this._closePromise
    }

    this._closed = true

    this._closePromise = (async () => {
      try {
        if (options.closeStream) {
          try {
            this._stream.exit(options.exitCode ?? 0)
            this._stream.end()
          } catch (err) {
            console.error(`[SSH] Error while closing stream: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        this.renderer.stop()

        try {
          await this.waitForRendererIdleWithTimeout()
        } catch (err) {
          console.error(
            `[SSH] Error while waiting for renderer idle: ${err instanceof Error ? err.message : String(err)}`,
          )
        }

        try {
          this.renderer.destroy()
        } catch (err) {
          console.error(`[SSH] Error during renderer destroy: ${err instanceof Error ? err.message : String(err)}`)
        }
      } finally {
        this.emit("close")
      }
    })()

    return this._closePromise
  }

  public handleResize(width: number, height: number): void {
    if (this._closed) return
    // Validate dimensions - reject invalid values from malicious/buggy clients
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > SSHSession.MAX_WIDTH ||
      height > SSHSession.MAX_HEIGHT
    ) {
      return
    }
    this._pty.width = width
    this._pty.height = height
    this.renderer.resize(width, height)
    this.emit("resize", width, height)
  }

  public close(exitCode: number = 0): Promise<void> {
    return this.beginClose({ closeStream: true, exitCode })
  }
}
