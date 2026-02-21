# @opentui/ssh

SSH server for hosting OpenTUI terminal applications over SSH connections.

## Installation

```bash
bun add @opentui/ssh
```

## Quick Start

```typescript
import { createSSHServer, logging, devMode } from "@opentui/ssh"
import { TextRenderable, BoxRenderable, RGBA } from "@opentui/core"

const server = createSSHServer({
  port: 2222,
  hostKeyPath: "./.ssh/host_key",
  middleware: [
    logging(),
    devMode(), // Accept all connections (for development only!)
  ],
})

server.on("session", (session) => {
  const { renderer } = session

  // Create your UI using OpenTUI renderables
  const text = new TextRenderable(renderer, {
    id: "hello",
    content: `Hello, ${session.user.username}!`,
    fg: RGBA.fromInts(255, 255, 255, 255),
  })
  renderer.root.add(text)

  // Handle keyboard input
  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "q") {
      session.close()
    }
  })

  // Start rendering
  renderer.start()
})

server.on("listening", () => {
  console.log(`SSH server running on port ${server.port}`)
})

await server.listen()
```

## API

### `createSSHServer(config: SSHServerConfig): SSHServer`

Creates a new SSH server instance.

#### Config Options

- `port` (required): Port to listen on
- `host`: Host to bind to (default: `"0.0.0.0"`)
- `hostKeyPath` (required): Path to host key file (auto-generated if missing)
- `middleware`: Array of middleware functions for auth/session handling
- `requirePty`: Require PTY allocation (default: `true`)
- `rendererOptions`: Options passed to `createCliRenderer`

`SSHSession` always uses renderer `outputMode: "stream"` internally and manages `onOutput` for channel writes.
`rendererOptions` intentionally excludes transport-owned fields (`stdin`, `stdout`, `outputMode`, `onOutput`, `width`, `height`).

### `SSHServer`

#### Events

- `listening`: Emitted when server starts listening
- `session(session: SSHSession)`: Emitted when a new session is established
- `error(error: Error)`: Emitted on server errors
- `close`: Emitted when server closes

#### Methods

- `listen(): Promise<void>`: Start listening for connections
- `close(): void`: Stop the server

### `SSHSession`

#### Properties

- `renderer`: The `CliRenderer` instance for this session
- `user`: User info (`{ username, publicKey? }`)
  - `publicKey` currently stores the key algorithm (e.g. `ssh-ed25519`).
    Planned: expose a stable key fingerprint for auditing and logging.
- `remoteAddress`: Client IP address
- `pty`: PTY info (`{ term, width, height }`)

#### Events

- `resize(width, height)`: Emitted when terminal is resized
- `close`: Emitted when session ends

#### Methods

- `close(exitCode?: number)`: Close the session
- `handleResize(width, height)`: Manually trigger resize

## Middleware

Middleware uses a Koa-style onion model with `compose()`. Each middleware receives a context and a `next` function to call the next middleware in the chain.

### Middleware Phases

Middleware runs in two phases:

- **`auth`**: Called for each authentication attempt. Use `ctx.accept()` or `ctx.reject()` to make a decision.
- **`session`**: Called once after authentication succeeds, when the shell session starts.

### Middleware Context

```typescript
interface MiddlewareContext {
  phase: "auth" | "session"
  connection: Connection // SSH2 connection object
  username: string // Attempting username
  clientKey?: PublicKey // Client's public key (if publickey auth)
  remoteAddress: string // Client IP address
  state: Record<string, unknown> // Shared state between middleware
  accept?: () => void // Accept auth (auth phase only)
  reject?: (methods?: string[]) => void // Reject auth (auth phase only)
  log: (message: string) => void // Log helper
}
```

### Middleware Order

Middleware executes in array order using the onion model:

```typescript
middleware: [
  logging(), // 1. Runs first, wraps accept/reject, calls next()
  publicKey(), // 2. Makes auth decision, calls next()
] //    Control returns to logging for post-processing
```

**Important**: Place `logging()` first so it can observe auth decisions made by subsequent middleware.

### Built-in Middleware

#### `logging(options?)`

Logs authentication attempts and connections. Should be placed **first** in the middleware array.

```typescript
logging({
  onAuthAttempt: (ctx, accepted) => console.log(`Auth: ${ctx.username} - ${accepted}`),
  onConnect: (ctx) => console.log(`Connected: ${ctx.username}`),
  onDisconnect: (ctx) => console.log(`Disconnected: ${ctx.username}`),
})
```

#### `publicKey(options)`

Public key authentication using OpenSSH authorized_keys format.

```typescript
publicKey({
  authorizedKeysPath: "~/.ssh/authorized_keys",
  // OR provide keys directly
  authorizedKeys: ["ssh-ed25519 AAAA... user@host"],
})
```

#### `devMode()`

Accepts all authentication attempts. **For development only!** Prints a security warning on startup.

```typescript
devMode()
```

### Custom Middleware

#### Auth Middleware Pattern

```typescript
const myAuth: Middleware = async (ctx, next) => {
  if (ctx.phase !== "auth") {
    await next()
    return
  }

  // Make your auth decision
  if (isValid(ctx.username)) {
    ctx.accept?.()
  } else {
    ctx.reject?.(["publickey", "password"]) // Allowed methods for retry
  }

  // ALWAYS call next() after auth decision
  // This allows outer middleware (like logging) to complete
  await next()
}
```

#### Session Middleware Pattern

```typescript
const sessionSetup: Middleware = async (ctx, next) => {
  if (ctx.phase === "session") {
    // Set up session-specific state
    ctx.state.startTime = Date.now()

    // Listen for disconnect
    ctx.connection.on("close", () => {
      console.log(`Session lasted ${Date.now() - ctx.state.startTime}ms`)
    })
  }

  await next()
}
```

#### Combining Multiple Auth Methods

```typescript
middleware: [
  logging(),
  publicKey({ authorizedKeysPath: "~/.ssh/authorized_keys" }),
  passwordAuth({ users: { admin: "secret" } }), // hypothetical
]
```

If `publicKey` doesn't handle the attempt (no client key provided), it calls `next()` to let `passwordAuth` try. If no middleware accepts, the server rejects by default.

### Default Behavior

If no middleware calls `accept()` or `reject()`, the server automatically rejects the authentication attempt. This ensures connections are never left in a pending state.

## Compatibility

### Ghostty Terminal

[Ghostty](https://ghostty.org) includes an `ssh-terminfo` shell integration feature that attempts to install its terminfo entry on remote hosts before starting an interactive session. This runs an `exec` command via SSH before requesting a shell.

**Server-side handling**: This package accepts `exec` requests and immediately returns exit code 1, allowing Ghostty's preflight to complete quickly without hanging.

**Client-side alternative**: If you prefer to disable this on the client, add to your Ghostty config:

```ini
# ~/.config/ghostty/config
shell-integration-features = no-ssh-terminfo
```

This disables automatic terminfo installation while keeping other shell integration features.

### Terminal Compatibility

The server advertises `xterm-256color` compatibility by default. For best results:

- Clients should use `TERM=xterm-256color` or similar
- The renderer supports truecolor (24-bit) output

## Examples

See [`examples/counter.ts`](./examples/counter.ts) for a complete interactive example.

```bash
# Run the example
cd packages/ssh
bun examples/counter.ts

# Connect from another terminal
ssh -p 2222 localhost
```

## License

MIT
