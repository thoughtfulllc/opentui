import { utils } from "ssh2"
import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, statSync } from "fs"
import { dirname } from "path"

export function ensureHostKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    const mode = statSync(keyPath).mode & 0o777
    if ((mode & 0o077) !== 0) {
      chmodSync(keyPath, 0o600)
    }
    return readFileSync(keyPath)
  }

  const dir = dirname(keyPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  // Use ssh2's key generation to ensure OpenSSH format compatibility
  const keypair = utils.generateKeyPairSync("ed25519")

  writeFileSync(keyPath, keypair.private, { mode: 0o600 })
  chmodSync(keyPath, 0o600)

  return Buffer.from(keypair.private, "utf-8")
}
