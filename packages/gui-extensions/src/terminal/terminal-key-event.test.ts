import { describe, expect, test } from "bun:test"
import { consumeTerminalMetaKey, terminalKeyInput } from "./terminal-key-event"

function keyEvent(init: KeyboardEventInit) {
  return new KeyboardEvent("keydown", { cancelable: true, ...init })
}

describe("terminalKeyEvent", () => {
  test("maps unmodified Command+Backspace to line kill", () => {
    expect(terminalKeyInput(keyEvent({ key: "Backspace", code: "Backspace", metaKey: true }))).toBe("\x15")
    expect(terminalKeyInput(keyEvent({ key: "Backspace", code: "Backspace", metaKey: true, shiftKey: true }))).toBeUndefined()
    expect(terminalKeyInput(keyEvent({ key: "Backspace", code: "Backspace", ctrlKey: true }))).toBeUndefined()
  })

  test("consumes printable Command chords without blocking paste or copy across layouts", () => {
    const qwertyPaste = keyEvent({ key: "v", code: "KeyV", metaKey: true })
    expect(consumeTerminalMetaKey(qwertyPaste)).toBe(false)

    const dvorakPaste = keyEvent({ key: "v", code: "Period", metaKey: true })
    expect(consumeTerminalMetaKey(dvorakPaste)).toBe(true)
    dvorakPaste.preventDefault()
    expect(dvorakPaste.defaultPrevented).toBe(false)

    const dvorakPeriodOnKeyV = keyEvent({ key: ".", code: "KeyV", metaKey: true })
    expect(consumeTerminalMetaKey(dvorakPeriodOnKeyV)).toBe(true)
    dvorakPeriodOnKeyV.preventDefault()
    expect(dvorakPeriodOnKeyV.defaultPrevented).toBe(true)

    const cmdK = keyEvent({ key: "k", code: "KeyK", metaKey: true })
    expect(consumeTerminalMetaKey(cmdK)).toBe(true)

    let copied = 0
    const dvorakCopyWithSelection = keyEvent({ key: "c", code: "KeyI", metaKey: true })
    expect(
      consumeTerminalMetaKey(dvorakCopyWithSelection, {
        copy: () => {
          copied += 1

          return true
        },
      }),
    ).toBe(true)
    expect(copied).toBe(1)

    const dvorakCopyWithoutSelection = keyEvent({ key: "c", code: "KeyI", metaKey: true })
    expect(consumeTerminalMetaKey(dvorakCopyWithoutSelection, { copy: () => false })).toBe(true)
    dvorakCopyWithoutSelection.preventDefault()
    expect(dvorakCopyWithoutSelection.defaultPrevented).toBe(false)

    const cmdLeft = keyEvent({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true })
    expect(consumeTerminalMetaKey(cmdLeft)).toBe(false)
  })
})
