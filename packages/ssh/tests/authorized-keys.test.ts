import { test, expect, describe } from "bun:test"
import { parseAuthorizedKeys, matchesKey } from "../src/utils/authorized-keys.ts"

describe("parseAuthorizedKeys", () => {
  test("parses valid ssh-ed25519 key", () => {
    const content = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host"
    const keys = parseAuthorizedKeys(content)

    expect(keys).toHaveLength(1)
    expect(keys[0].type).toBe("ssh-ed25519")
    expect(keys[0].key).toBe("AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl")
    expect(keys[0].comment).toBe("user@host")
  })

  test("parses multiple keys", () => {
    const content = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user1@host
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user2@host`

    const keys = parseAuthorizedKeys(content)
    expect(keys).toHaveLength(2)
  })

  test("skips comment lines", () => {
    const content = `# This is a comment
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host
# Another comment`

    const keys = parseAuthorizedKeys(content)
    expect(keys).toHaveLength(1)
  })

  test("skips empty lines", () => {
    const content = `
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host

`
    const keys = parseAuthorizedKeys(content)
    expect(keys).toHaveLength(1)
  })

  test("handles key without comment", () => {
    const content = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
    const keys = parseAuthorizedKeys(content)

    expect(keys).toHaveLength(1)
    expect(keys[0].comment).toBeUndefined()
  })

  test("handles options prefix", () => {
    const content = `command="/bin/echo" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl restricted`
    const keys = parseAuthorizedKeys(content)

    expect(keys).toHaveLength(1)
    expect(keys[0].type).toBe("ssh-ed25519")
    expect(keys[0].comment).toBe("restricted")
  })

  test("rejects invalid key format", () => {
    const content = "invalid-key-type AAAA123 badkey"
    const keys = parseAuthorizedKeys(content)

    expect(keys).toHaveLength(0)
  })

  test("handles mixed valid and invalid keys", () => {
    const content = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl valid
invalid-type BADKEY invalid
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl another-valid`

    const keys = parseAuthorizedKeys(content)
    expect(keys).toHaveLength(2)
  })
})

describe("matchesKey", () => {
  test("returns true for matching key", () => {
    const keys = parseAuthorizedKeys(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host",
    )

    const result = matchesKey(
      "ssh-ed25519",
      "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
      keys,
    )

    expect(result).toBe(true)
  })

  test("returns false for non-matching key type", () => {
    const keys = parseAuthorizedKeys(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host",
    )

    const result = matchesKey("ssh-rsa", "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl", keys)

    expect(result).toBe(false)
  })

  test("returns false for non-matching key data", () => {
    const keys = parseAuthorizedKeys(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host",
    )

    const result = matchesKey("ssh-ed25519", "DIFFERENT_KEY_DATA", keys)

    expect(result).toBe(false)
  })

  test("returns false for empty authorized keys list", () => {
    const result = matchesKey("ssh-ed25519", "AAAA", [])
    expect(result).toBe(false)
  })

  test("finds match among multiple keys", () => {
    // Use the same valid key twice with different comments to test matching
    const content = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl key1
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl key2`

    const keys = parseAuthorizedKeys(content)

    // Should match both (they're the same key)
    const result = matchesKey(
      "ssh-ed25519",
      "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
      keys,
    )

    expect(result).toBe(true)
  })
})
