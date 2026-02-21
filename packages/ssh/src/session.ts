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
    // Create placeholder for the session so we can reference it in onOutput
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
    if (this._closed) return
    this._closed = true

    // Stop renderer and clean up asynchronously
    this.renderer.stop()
    this.renderer
      .idle()
      .then(() => {
        this.renderer.destroy()
        this.emit("close")
      })
      .catch((err) => {
        console.error(`[SSH] Error during session cleanup: ${err instanceof Error ? err.message : String(err)}`)
        // Still emit close event so listeners know the session is done
        this.emit("close")
      })
  }

  public handleResize(width: number, height: number): void {
    // Validate dimensions - reject invalid values from malicious/buggy clients
    if (width < 1 || height < 1 || width > 10000 || height > 10000) {
      return
    }
    this._pty.width = width
    this._pty.height = height
    this.renderer.resize(width, height)
    this.emit("resize", width, height)
  }

  public close(exitCode: number = 0): void {
    if (this._closed) return
    this._closed = true

    // Close the SSH stream FIRST (immediately) so the client sees the disconnect
    // This allows new connections to work without waiting for renderer cleanup
    this._stream.exit(exitCode)
    this._stream.end()

    // Then clean up the renderer asynchronously
    this.renderer.stop()
    this.renderer
      .idle()
      .then(() => {
        this.renderer.destroy()
        this.emit("close")
      })
      .catch((err) => {
        console.error(`[SSH] Error during session close: ${err instanceof Error ? err.message : String(err)}`)
        // Still emit close event so listeners know the session is done
        this.emit("close")
      })
  }
}
