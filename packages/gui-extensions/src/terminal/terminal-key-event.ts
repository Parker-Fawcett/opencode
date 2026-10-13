export function terminalKeyInput(event: KeyboardEvent) {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return

  if (event.key.toLowerCase() !== "backspace") return

  return "\x15"
}

export function consumeTerminalMetaKey(
  event: KeyboardEvent,
  options?: {
    copy?: () => boolean
  },
) {
  if (!event.metaKey || event.ctrlKey || event.altKey) return false

  const key = event.key.toLowerCase()

  // ghostty-web only exempts physical KeyV from KeyEncoder.encode; on non-QWERTY
  // layouts where "v" lives on another physical key, let the browser paste fire
  // without encoding a literal "v" to the PTY.
  if (key === "v") {
    if (event.code === "KeyV") return false

    allowBrowserDefault(event)

    return true
  }

  if (!event.shiftKey && key === "c") {
    if (options?.copy?.()) return true

    if (event.code === "KeyC") return false

    allowBrowserDefault(event)

    return true
  }

  // ghostty-web passes ASCII `utf8` to KeyEncoder.encode, which ignores Mods.SUPER
  // in standard VT100 mode and emits the raw character to the PTY.
  return event.key.length === 1
}

function allowBrowserDefault(event: KeyboardEvent) {
  Object.defineProperty(event, "preventDefault", {
    value: () => {},
    configurable: true,
  })
}
