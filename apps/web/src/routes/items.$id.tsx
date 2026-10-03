import { useEffect, useRef } from "react"
import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react"
import { toast } from "sonner"
import type { ItemDetail, ThreadEntry } from "@workspace/types"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { AccountLink, ReportText } from "@/components/account-link"
import { ItemBadges } from "@/components/item-badges"
import { AgentMessage } from "@/components/thread/agent-message"
import { Composer } from "@/components/thread/composer"
import { FixPanel } from "@/components/thread/fix-panel"
import { TriageLine } from "@/components/thread/triage-line"
import { itemQuery, useItemAction } from "@/lib/api"
import { cost, when } from "@/lib/format"

export const Route = createFileRoute("/items/$id")({
  params: {
    parse: (p) => ({ id: Number(p.id) }),
    stringify: (p) => ({ id: String(p.id) }),
  },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(itemQuery(params.id)),
  component: ItemPage,
  errorComponent: ({ error }) => <p className="text-destructive p-6 text-sm">{error instanceof Error ? error.message : String(error)}</p>,
})

function Post({ item }: { item: ItemDetail }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
        {item.source === "bluesky"
          ? `@${item.author} on Bluesky`
          : item.source === "classifier"
            ? `Filed by the ${item.author} classifier`
            : "In-app report"}
        {item.reporter && (
          <>
            {" "}
            by <AccountLink account={item.reporter} />
          </>
        )}{" "}
        · {when(item.receivedAt)}
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="hover:text-foreground inline-flex items-center gap-0.5">
          open <ExternalLinkIcon className="size-3" />
        </a>
      </span>
      <div className="bg-card rounded-xl border px-4 py-3">
        {item.subject && (
          <div className="mb-2 text-sm">
            <AccountLink account={item.subject} />
          </div>
        )}
        <ReportText item={item} className="text-sm whitespace-pre-wrap" />
        {item.images.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {item.images.map((src) => (
              <a key={src} href={src} target="_blank" rel="noopener noreferrer">
                <img src={src} alt="Attached to the post" className="max-h-40 rounded-md border" loading="lazy" />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Entry({ entry }: { entry: ThreadEntry }) {
  if (entry.kind === "event") {
    return (
      <p
        className={cn(
          "mx-auto max-w-[90%] text-center text-xs",
          entry.tone === "bad" ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {entry.tone === "live" && <span className="bg-primary mr-2 inline-block size-2 animate-pulse rounded-full motion-reduce:animate-none" />}
        {entry.text}
      </p>
    )
  }
  if (entry.kind === "user") {
    return (
      <div className="flex max-w-[85%] flex-col items-end gap-1 self-end">
        <span className="text-muted-foreground text-xs">You</span>
        <div className="bg-primary text-primary-foreground rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap">{entry.text}</div>
      </div>
    )
  }
  return <AgentMessage entry={entry} />
}

function ItemPage() {
  const { id } = Route.useParams()
  const { data: item } = useSuspenseQuery(itemQuery(id))
  const act = useItemAction(id)
  const bottom = useRef<HTMLDivElement>(null)
  const length = item.thread.length + (item.fix ? 1 : 0)

  // Open at the latest message, like a chat.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" })
  }, [id])

  // Follow the conversation as it grows, unless the reader has scrolled up.
  useEffect(() => {
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 240
    if (nearBottom) bottom.current?.scrollIntoView({ block: "end" })
  }, [length])

  const action = (name: "investigate" | "done" | "dismiss", label: string) => (
    <Button
      variant="outline"
      size="sm"
      disabled={act.isPending}
      onClick={() => act.mutate({ action: name }, { onError: (e) => toast.error(e.message) })}
    >
      {label}
    </Button>
  )

  return (
    <main className="mx-auto flex max-w-3xl flex-col px-4 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" render={<Link to="/" search={{ view: "inbox" }} />}>
          <ArrowLeftIcon /> Queue
        </Button>
        <div className="flex gap-2">
          {!item.hasSession && item.status !== "investigate" && item.status !== "investigating" && action("investigate", "Investigate")}
          {item.status !== "done" && action("done", "Mark done")}
          {item.status !== "dismissed" && action("dismiss", "Dismiss")}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">#{item.id}</h1>
        <div className="flex items-center gap-2">
          <ItemBadges item={item} />
          {item.cost > 0 && <span className="text-muted-foreground text-xs tabular-nums">{cost(item.cost)}</span>}
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-4">
        <Post item={item} />
        <TriageLine item={item} />
        {item.thread.map((entry, i) => (
          <Entry key={i} entry={entry} />
        ))}
        {item.fix && <FixPanel itemId={item.id} fix={item.fix} />}
        <div ref={bottom} />
      </div>

      <Composer itemId={item.id} hasSession={item.hasSession} busy={item.busy} />
    </main>
  )
}
