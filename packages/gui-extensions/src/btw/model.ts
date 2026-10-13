import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { MountedSession, SetupContext } from "../sdk"
import type Btw from "./index"
import type { PromptInput } from "@opencode/schema/prompt-input"

const instructions = [
  "The user is asking a quick side question about the conversation so far.",
  "Answer directly and concisely in markdown from what you already know.",
  "Do not call any tools and do not take any actions.",
].join(" ")

/** One-shot side questions per session, one tab each, stored until the tab closes. */
export function createBtw(ctx: SetupContext<typeof Btw>) {
  const controllers = new Map<string, AbortController>()
  const attachments = new Map<string, PromptInput.Prompt["files"]>()
  const [requests, setRequests] = createStore<{ pending: string[] }>({ pending: [] })
  const saved = (session: MountedSession) => ctx.stores.chats(session)

  const stop = (id: string) => {
    controllers.get(id)?.abort()
    controllers.delete(id)
    setRequests("pending", (list) => list.filter((item) => item !== id))
  }

  // In-flight questions keep running when the user leaves their session and answer into its store; only a reload,
  // closing the question's tab or disposing the extension abandons one, which leaves it retryable.
  onCleanup(() => {
    Array.from(controllers.keys()).forEach(stop)
    attachments.clear()
  })

  const entry = (session: MountedSession, id: string) => saved(session).value?.chats.find((item) => item.id === id)
  const pending = (id: string) => requests.pending.includes(id)

  const generate = (session: MountedSession, id: string, question: string, files?: PromptInput.Prompt["files"]) => {
    if (pending(id)) return

    const store = saved(session)
    const controller = new AbortController()
    controllers.set(id, controller)
    setRequests("pending", (list) => [...list, id])

    return (
      session.server.client.session
        .generate(
          { sessionID: session.id, prompt: [instructions, question].join("\n\n"), files },
          { signal: controller.signal },
        )
        .then((result) => {
          if (ctx.signal.aborted || controller.signal.aborted) return
          store.update((draft) => {
            const chat = draft.chats.find((item) => item.id === id)

            if (chat) chat.answer = result.text.trim()
          })
        })
        // A missing answer is the retry state; no transient error flag is stored.
        .catch(() => undefined)
        .finally(() => {
          if (controllers.get(id) === controller) stop(id)
        })
    )
  }

  const ask = async (value?: string, files?: PromptInput.Prompt["files"]) => {
    const question = value?.trim()

    if (!question) throw new Error(ctx.t("question.required"))

    const session = ctx.sessions.current()

    if (!session?.id) return

    const id = crypto.randomUUID()

    // Image data stays in memory: browser session stores have a much smaller quota than attachments.
    await saved(session).update((draft) => {
      draft.chats.push({ id, question })
    })

    if (ctx.signal.aborted) return

    if (files?.length) attachments.set(id, files.slice())

    ctx.layout.open(`${ctx.id}:${id}`, session, { tab: "select" })
    void generate(session, id, question, files)
  }

  return {
    ask,
    saved,
    pending,
    question: (session: MountedSession, id: string) => entry(session, id)?.question,
    answer: (session: MountedSession, id: string) => entry(session, id)?.answer,
    error: (session: MountedSession, id: string) => {
      const item = entry(session, id)

      return !!item && item.answer === undefined && !pending(id)
    },
    retry: (session: MountedSession, id: string) => {
      const chat = entry(session, id)

      if (chat) void generate(session, id, chat.question, attachments.get(id))
    },
    /** Closing a tab forgets its question and answer. */
    remove: (session: MountedSession, id: string) => {
      stop(id)
      attachments.delete(id)
      saved(session).update((draft) => {
        draft.chats = draft.chats.filter((item) => item.id !== id)
      })
    },
  }
}

export type BtwModel = ReturnType<typeof createBtw>
