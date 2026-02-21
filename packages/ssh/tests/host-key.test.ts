import { test, expect, describe, afterEach } from "bun:test"
import { ensureHostKey } from "../src/utils/host-key.ts"
import { unlinkSync, existsSync, statSync, mkdirSync, writeFileSync, rmdirSync } from "fs"
import { tmpdir } from "os"
import { join, dirname } from "path"

describe("ensureHostKey", () => {
  const testDir = join(tmpdir(), "opentui-ssh-test-" + Date.now())
  const cleanupPaths: string[] = []

  afterEach(() => {
    // Cleanup test files
    for (const path of cleanupPaths) {
      try {
        if (existsSync(path)) {
          unlinkSync(path)
        }
      } catch {
        // Ignore cleanup errors
      }
    }
    cleanupPaths.length = 0

    // Cleanup test directory
    try {
      if (existsSync(testDir)) {
        rmdirSync(testDir, { recursive: true })
      }
    } catch {
      // Ignore
    }
  })

  test("generates new Ed25519 key if file does not exist", () => {
    const keyPath = join(testDir, "new-host-key")
    cleanupPaths.push(keyPath)

    const key = ensureHostKey(keyPath)

    expect(existsSync(keyPath)).toBe(true)
    expect(key).toBeInstanceOf(Buffer)
    // ssh2 generates OpenSSH format keys
    expect(key.toString()).toContain("-----BEGIN OPENSSH PRIVATE KEY-----")
    expect(key.toString()).toContain("-----END OPENSSH PRIVATE KEY-----")
  })

  test("loads existing key if file exists", () => {
    const keyPath = join(testDir, "existing-key")
    cleanupPaths.push(keyPath)

    // Create directory and write a dummy key
    mkdirSync(dirname(keyPath), { recursive: true })
    const dummyKey = "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----"
    writeFileSync(keyPath, dummyKey, { mode: 0o600 })

    const key = ensureHostKey(keyPath)

    expect(key.toString()).toBe(dummyKey)
  })

  test("creates parent directory if it does not exist", () => {
    const keyPath = join(testDir, "nested", "deep", "host-key")
    cleanupPaths.push(keyPath)

    ensureHostKey(keyPath)

    expect(existsSync(keyPath)).toBe(true)
    expect(existsSync(dirname(keyPath))).toBe(true)
  })

  test("sets correct file permissions (0o600)", () => {
    const keyPath = join(testDir, "perms-test-key")
    cleanupPaths.push(keyPath)

    ensureHostKey(keyPath)

    const stat = statSync(keyPath)
    const mode = stat.mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("returns same content when called twice for same path", () => {
    const keyPath = join(testDir, "idempotent-key")
    cleanupPaths.push(keyPath)

    const key1 = ensureHostKey(keyPath)
    const key2 = ensureHostKey(keyPath)

    expect(key1.equals(key2)).toBe(true)
  })

  test("generates valid OpenSSH format key", () => {
    const keyPath = join(testDir, "openssh-format-key")
    cleanupPaths.push(keyPath)

    const key = ensureHostKey(keyPath)
    const keyStr = key.toString().trim()

    // Check OpenSSH format (ssh2 generates this format)
    const lines = keyStr.split("\n")
    expect(lines[0]).toBe("-----BEGIN OPENSSH PRIVATE KEY-----")
    expect(lines[lines.length - 1]).toBe("-----END OPENSSH PRIVATE KEY-----")

    // Check base64 content exists
    const base64Content = lines.slice(1, -1).join("")
    expect(base64Content.length).toBeGreaterThan(0)
  })
})
