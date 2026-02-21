// packages/ssh/examples/counter.ts
import { createSSHServer, logging, devMode } from "../src"
import { TextRenderable, BoxRenderable, RGBA, type KeyEvent } from "@opentui/core"

const server = createSSHServer({
  port: 2222,
  hostKeyPath: "./.ssh/host_key",
  rendererOptions: {
    useAlternateScreen: true,
  },
  middleware: [
    logging({
      onAuthAttempt: (ctx, accepted) => ctx.log(`[Auth] ${ctx.username}: ${accepted ? "accepted" : "rejected"}`),
      onConnect: (ctx) => ctx.log(`[Connect] ${ctx.username} from ${ctx.remoteAddress}`),
      onDisconnect: (ctx) => ctx.log(`[Disconnect] ${ctx.username}`),
    }),
    devMode(), // Accept all for testing
  ],
})

server.on("session", (session) => {
  let count = 0
  const { renderer } = session

  // Set background color
  renderer.setBackgroundColor(RGBA.fromInts(0, 0, 0, 255))

  // Create a container box
  const container = new BoxRenderable(renderer, {
    id: "container",
    width: "100%",
    height: "100%",
    padding: 2,
  })
  renderer.root.add(container)

  // Counter display
  const counterText = new TextRenderable(renderer, {
    id: "counter",
    content: `Counter: ${count}`,
    fg: RGBA.fromInts(255, 255, 255, 255),
  })
  container.add(counterText)

  // Instructions
  const instructions = new TextRenderable(renderer, {
    id: "instructions",
    content: "\nPress +/- to change counter, q to quit",
    fg: RGBA.fromInts(128, 128, 128, 255),
  })
  container.add(instructions)

  // Terminal info
  const terminalInfo = new TextRenderable(renderer, {
    id: "terminal-info",
    content: `\n\nTerminal: ${session.pty.width}x${session.pty.height} (${session.pty.term})`,
    fg: RGBA.fromInts(80, 80, 80, 255),
  })
  container.add(terminalInfo)

  // User info
  const userInfo = new TextRenderable(renderer, {
    id: "user-info",
    content: `User: ${session.user.username} from ${session.remoteAddress}`,
    fg: RGBA.fromInts(80, 80, 80, 255),
  })
  container.add(userInfo)

  function updateDisplay() {
    counterText.content = `Counter: ${count}`
    terminalInfo.content = `\n\nTerminal: ${session.pty.width}x${session.pty.height} (${session.pty.term})`
  }

  // Handle keyboard input
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.name === "+" || key.name === "=") {
      count++
      updateDisplay()
    } else if (key.name === "-" || key.name === "_") {
      count--
      updateDisplay()
    } else if (key.name === "q") {
      // Only quit on 'q' - removed ctrl+c to avoid accidental close from control sequences
      session.close()
    }
  })

  // Handle resize
  session.on("resize", () => updateDisplay())

  // Handle disconnect
  session.on("close", () => {
    console.log(`Session closed: ${session.user.username}`)
  })

  // Start the renderer
  renderer.start()
})

server.on("listening", () => {
  console.log(`SSH Counter running on port ${server.port}`)
  console.log(`Connect with: ssh -p ${server.port} localhost`)
})

server.on("error", (err) => {
  console.error(`[SSH Server Error] ${err.message}`)
})

await server.listen()
