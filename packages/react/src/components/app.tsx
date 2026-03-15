import type { KeyHandler } from "@opentui/core"
import type { CliRenderer } from "@opentui/core/native"
import { createContext, useContext } from "react"

interface AppContext {
  keyHandler: KeyHandler | null
  renderer: CliRenderer | null
}

export const AppContext = createContext<AppContext>({
  keyHandler: null,
  renderer: null,
})

export const useAppContext = () => {
  return useContext(AppContext)
}
