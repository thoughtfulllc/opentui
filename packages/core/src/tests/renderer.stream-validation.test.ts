import { test, expect } from "bun:test"
import { createCliRenderer } from "../renderer"

test("stream output mode requires onOutput", async () => {
  await expect(createCliRenderer({ outputMode: "stream" } as any)).rejects.toThrow(
    'outputMode "stream" requires onOutput',
  )
})

test("stream output mode requires width", async () => {
  await expect(
    createCliRenderer({
      outputMode: "stream",
      height: 24,
      onOutput: () => {},
    } as any),
  ).rejects.toThrow('outputMode "stream" requires width to be a positive integer')
})

test("stream output mode requires height", async () => {
  await expect(
    createCliRenderer({
      outputMode: "stream",
      width: 80,
      onOutput: () => {},
    } as any),
  ).rejects.toThrow('outputMode "stream" requires height to be a positive integer')
})

test("stream output mode requires integer dimensions", async () => {
  await expect(
    createCliRenderer({
      outputMode: "stream",
      width: 80.5,
      height: 24,
      onOutput: () => {},
    }),
  ).rejects.toThrow('outputMode "stream" requires width to be a positive integer')

  await expect(
    createCliRenderer({
      outputMode: "stream",
      width: 80,
      height: 0,
      onOutput: () => {},
    }),
  ).rejects.toThrow('outputMode "stream" requires height to be a positive integer')
})
