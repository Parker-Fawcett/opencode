import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { isolatedEnv } from "../test/fixture/environment"
import { tmpdir } from "../test/fixture/tmpdir"

const CLI = path.join(import.meta.dir, "index.ts")
const END_MARKER = "###-end-opencode-completions-###"

// https://github.com/anomalyco/opencode/issues/55525
// Fish completions are ~68 KiB: larger than one OS pipe buffer, so an
// unguarded write lost everything past 65536 bytes when piped. Bun's own
// spawn pipes use larger buffers and mask the bug; piped runs shell out to a
// real OS pipe built by /bin/sh (skipped on Windows, where that shell is
// unavailable and writes are not observed to truncate).
function shell(command: string, env: NodeJS.ProcessEnv): string {
  return execFileSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    env,
  })
}

const posixOnly = process.platform === "win32" ? test.skip : test

posixOnly(
  "piped stdout matches file stdout",
  async () => {
    await using directory = await tmpdir()
    const env = isolatedEnv(directory.path)
    const file = path.join(directory.path, "completions.fish")

    shell(`${process.execPath} ${JSON.stringify(CLI)} --completions fish 2>/dev/null > ${JSON.stringify(file)}`, env)
    const expected = await fs.readFile(file, "utf8")
    expect(Buffer.byteLength(expected)).toBeGreaterThan(65536)
    expect(expected.trimEnd().endsWith(END_MARKER)).toBe(true)

    const piped = shell(`${process.execPath} ${JSON.stringify(CLI)} --completions fish 2>/dev/null | cat`, env)
    expect(piped).toBe(expected)
  },
  60_000,
)
