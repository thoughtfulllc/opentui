import { test, expect } from "bun:test"
import { createTestRenderer } from "../testing/test-renderer"

test("stream output mode requires onOutput", async () => {
  await expect(createTestRenderer({ outputMode: "stream" })).rejects.toThrow('outputMode "stream" requires onOutput')
})
