import { utils } from "ssh2"
import type { AuthorizedKey } from "../types.ts"

export function parseAuthorizedKeys(content: string): AuthorizedKey[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(parseLine)
    .filter((key): key is AuthorizedKey => key !== null)
}

function parseLine(line: string): AuthorizedKey | null {
  // Handle options prefix: command="...",from="..." ssh-ed25519 AAAA...
  // Key types start with "ssh-", "ecdsa-", or "sk-"
  const keyTypeMatch = line.match(/(ssh-\S+|ecdsa-\S+|sk-\S+)\s+(\S+)(\s+(.*))?/)
  if (!keyTypeMatch) return null

  const [, type, key, , comment] = keyTypeMatch

  // Validate key can be parsed by ssh2
  try {
    const parsed = utils.parseKey(`${type} ${key}`)
    if (!parsed || parsed instanceof Error) {
      return null
    }
  } catch {
    return null // Invalid key format
  }

  return { type, key, comment }
}

export function matchesKey(clientKeyType: string, clientKeyData: string, authorizedKeys: AuthorizedKey[]): boolean {
  return authorizedKeys.some((ak) => ak.type === clientKeyType && ak.key === clientKeyData)
}
