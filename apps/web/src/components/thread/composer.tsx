import { useRef, useState } from "react"
import { ArrowUpIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@workspace/ui/components/button"
import { Textarea } from "@workspace/ui/components/textarea"
import { useItemAction } from "@/lib/api"

/** The one message box. What you write goes to the item's agent; it decides what to do. */
export function Composer({ itemId, hasSession, busy }: { itemId: number; hasSession: boolean; busy: boolean }) {
  const [message, setMessage] = useState("")
  const form = useRef<HTMLFormElement>(null)
  const act = useItemAction(itemId)

  const send = () => {
    const text = message.trim()
    if (!text || act.isPending) return
    act.mutate(
      { action: "messages", body: { message: text } },
      { onSuccess: () => setMessage(""), onError: (err) => toast.error(err.message) }
    )
  }

  return (
    <div className="from-background via-background sticky bottom-0 bg-gradient-to-t from-70% to-transparent pt-6 pb-4">
      <form
        ref={form}
        className="bg-card focus-within:ring-ring/50 flex items-end gap-2 rounded-2xl border p-2 shadow-sm focus-within:ring-3"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={
            hasSession
              ? "Message the agent. Ask about the problem, ask it to fix it, or to change the fix."
              : "Message the agent. It investigates first, then answers."
          }
          aria-label="Message the agent"
          className="max-h-[40vh] min-h-12 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <Button type="submit" size="icon" disabled={!message.trim() || act.isPending} aria-label="Send">
          <ArrowUpIcon />
        </Button>
      </form>
      <p className="text-muted-foreground mt-1.5 px-2 text-xs">
        {busy ? "The agent is working; a message now is answered when it finishes." : "Cmd or Ctrl + Enter to send"}
      </p>
    </div>
  )
}
