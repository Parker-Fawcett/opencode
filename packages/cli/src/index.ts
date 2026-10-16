#!/usr/bin/env bun

import { ensurePluginRuntime } from "@opencode/plugin/runtime"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Effect } from "effect"
import { getErrorReported } from "effect/Runtime"
import { Commands } from "./commands/commands"
import { Runtime } from "./framework/runtime"
import { Observability } from "@opencode/util/observability"
import { Updater } from "./services/updater"
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_LOCAL, OPENCODE_VERSION } from "./version"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Config } from "./config"
import { Npm } from "@opencode/util/npm"
import { EffectFlock } from "@opencode/util/effect-flock"
import { Heap } from "./heap"
import { CpuProfile } from "./cpu-profile"
import fs from "node:fs"
import { format } from "node:util"

// `packages/cli/bunfig.toml` loads `@opentui/solid/preload`, which leaves stdout
// and stderr nonblocking. A single write larger than one pipe buffer is then
// silently truncated past 65536 bytes (`--completions fish` is ~68 KiB, so
// its tail was lost when piped). Retrying full pipes in guarded chunks keeps
// that output from being lost.
// See https://github.com/anomalyco/opencode/issues/55525
const WRITE_CHUNK = 16 * 1024
const WRITE_WAIT = new Int32Array(new SharedArrayBuffer(4))
const WRITE_TIMEOUT_MS = 5_000
function writeAll(fd: number, buffer: string | Buffer) {
  const data = typeof buffer === "string" ? Buffer.from(buffer) : buffer
  const deadline = Date.now() + WRITE_TIMEOUT_MS
  let offset = 0
  while (offset < data.length) {
    let written: number | undefined
    try {
      written = fs.writeSync(fd, data, offset, Math.min(WRITE_CHUNK, data.length - offset))
    } catch (error) {
      // a closed or broken pipe (EPIPE etc.) is not retryable; only pause on
      // a temporarily full one (EAGAIN) so the real exit code still wins.
      if ((error as NodeJS.ErrnoException)?.code !== "EAGAIN") return
    }
    if (written === undefined || written <= 0) {
      if (Date.now() > deadline) return
      Atomics.wait(WRITE_WAIT, 0, 0, 1)
      continue
    }
    offset += written
  }
}
for (const [stream, fd] of [
  [process.stdout, 1],
  [process.stderr, 2],
] as const) {
  const write = stream.write.bind(stream)
  stream.write = ((chunk: string | Uint8Array, ...args: Array<string | (() => void)>) => {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array))
      return (write as (...args: Array<unknown>) => boolean)(chunk, ...args)
    const lastArg = args.length > 0 ? args[args.length - 1] : undefined
    const hasCallback = typeof lastArg === "function"
    const callback = hasCallback ? (lastArg as () => void) : undefined
    const encoding = typeof args[0] === "string" ? (args[0] as BufferEncoding) : "utf8"
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk)
    if (buffer.length <= WRITE_CHUNK) return (write as (...args: Array<unknown>) => boolean)(chunk, ...args)
    writeAll(fd, buffer)
    if (callback) queueMicrotask(callback)
    return true
  }) as typeof stream.write
}
const defaultConsole = globalThis.console

// Console output does not go through the stream wrappers above under Bun.
console.log = ((...args: Array<unknown>) => {
  const text = format(...args) + "\n"
  if (text.length <= WRITE_CHUNK) return defaultConsole.log(...args)
  writeAll(1, text)
}) as typeof defaultConsole.log
console.info = ((...args: Array<unknown>) => {
  const text = format(...args) + "\n"
  if (text.length <= WRITE_CHUNK) return defaultConsole.info(...args)
  writeAll(1, text)
}) as typeof defaultConsole.info
console.debug = ((...args: Array<unknown>) => {
  const text = format(...args) + "\n"
  if (text.length <= WRITE_CHUNK) return defaultConsole.debug(...args)
  writeAll(1, text)
}) as typeof defaultConsole.debug
console.warn = ((...args: Array<unknown>) => {
  const text = format(...args) + "\n"
  if (text.length <= WRITE_CHUNK) return defaultConsole.warn(...args)
  writeAll(2, text)
}) as typeof defaultConsole.warn
console.error = ((...args: Array<unknown>) => {
  const text = format(...args) + "\n"
  if (text.length <= WRITE_CHUNK) return defaultConsole.error(...args)
  writeAll(2, text)
}) as typeof defaultConsole.error

ensurePluginRuntime()

if (process.env.OPENCODE_SSH_ASKPASS_PORT) {
  const { askpass } = await import("./ssh-askpass")
  process.exit(await Effect.runPromise(askpass.pipe(Effect.provide(NodeServices.layer))))
}

const Handlers = Runtime.handlers(Commands, {
  $: () => import("./commands/handlers/default"),
  upgrade: () => import("./commands/handlers/upgrade"),
  uninstall: () => import("./commands/handlers/uninstall"),
  acp: () => import("./commands/handlers/acp"),
  api: () => import("./commands/handlers/api"),
  auth: {
    list: () => import("./commands/handlers/auth/list"),
    login: () => import("./commands/handlers/auth/login"),
    logout: () => import("./commands/handlers/auth/logout"),
    export: () => import("./commands/handlers/auth/export"),
    import: () => import("./commands/handlers/auth/import"),
    switch: () => import("./commands/handlers/auth/switch"),
  },
  debug: {
    agents: () => import("./commands/handlers/debug/agents"),
    config: () => import("./commands/handlers/debug/config"),
    paths: () => import("./commands/handlers/debug/paths"),
  },
  mcp: {
    list: () => import("./commands/handlers/mcp/list"),
    add: () => import("./commands/handlers/mcp/add"),
    auth: () => import("./commands/handlers/mcp/auth"),
    logout: () => import("./commands/handlers/mcp/logout"),
  },
  plugin: {
    list: () => import("./commands/handlers/plugin/list"),
    add: () => import("./commands/handlers/plugin/add"),
    check: () => import("./commands/handlers/plugin/check"),
    update: () => import("./commands/handlers/plugin/update"),
    remove: () => import("./commands/handlers/plugin/remove"),
  },
  models: () => import("./commands/handlers/models"),
  stats: () => import("./commands/handlers/stats"),
  mini: () => import("./commands/handlers/mini"),
  run: () => import("./commands/handlers/run"),
  pair: () => import("./commands/handlers/pair"),
  reload: () => import("./commands/handlers/reload"),
  session: {
    list: () => import("./commands/handlers/session/list"),
    delete: () => import("./commands/handlers/session/delete"),
    export: () => import("./commands/handlers/session/export"),
    import: () => import("./commands/handlers/session/import"),
  },
  service: {
    start: () => import("./commands/handlers/service/start"),
    restart: () => import("./commands/handlers/service/restart"),
    status: () => import("./commands/handlers/service/status"),
    stop: () => import("./commands/handlers/service/stop"),
    get: () => import("./commands/handlers/service/get"),
    set: () => import("./commands/handlers/service/set"),
    unset: () => import("./commands/handlers/service/unset"),
  },
  serve: () => import("./commands/handlers/serve"),
})

Effect.gen(function* () {
  yield* Heap.listen
  yield* CpuProfile.listen
  const runFork = Effect.runForkWith(yield* Effect.context<never>())
  const uncaughtException = (cause: Error, origin: "uncaughtException" | "unhandledRejection") => {
    runFork(Effect.logError("uncaught exception", { cause, origin }))
  }
  const unhandledRejection = (cause: unknown) => {
    runFork(Effect.logError("unhandled rejection", { cause }))
  }
  process.on("uncaughtException", uncaughtException)
  process.on("unhandledRejection", unhandledRejection)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      process.off("uncaughtException", uncaughtException)
      process.off("unhandledRejection", unhandledRejection)
    }),
  )
  yield* Effect.logInfo("cli starting", {
    version: OPENCODE_VERSION,
    channel: OPENCODE_CHANNEL,
    local: OPENCODE_LOCAL,
    args: process.argv.slice(2),
  })
  return yield* Runtime.run(Commands, Handlers, { version: OPENCODE_VERSION })
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logError("cli process failed", {
      cause,
      args: process.argv.slice(2),
    }).pipe(Effect.andThen(Effect.failCause(cause))),
  ),
  Effect.annotateLogs({ role: "cli" }),
  Effect.provide(Config.layer),
  Effect.provide(Updater.layer),
  Effect.provide(
    LayerNode.compile(LayerNode.group([Global.node, AppProcess.node, Npm.node, EffectFlock.node]), {
      replacements: [
        Global.node.replace(
          Global.layerWith(process.env.OPENCODE_CONFIG_DIR ? { config: process.env.OPENCODE_CONFIG_DIR } : {}),
        ),
      ],
    }),
  ),
  Effect.provide(
    Observability.layer({
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
      client: process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT,
      version: OPENCODE_VERSION,
      channel: OPENCODE_CHANNEL,
    }),
  ),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  Effect.tap(() => Effect.sync(() => process.exit(process.exitCode ?? 0))),
  // runMain's default reporter logs the fatal cause to stdout. Write it to stderr instead: the
  // desktop and `Service.ensure` only capture stderr from `serve --service`, so this is the only
  // channel through which a startup failure's reason reaches the user.
  Effect.tapCause((cause) =>
    Effect.sync(() => {
      if (Cause.hasInterruptsOnly(cause)) return
      if (!getErrorReported(Cause.squash(cause))) return
      process.stderr.write(Cause.pretty(cause) + "\n")
    }),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
