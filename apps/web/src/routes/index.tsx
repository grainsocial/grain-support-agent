import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import type { View } from "@workspace/types"
import { Card } from "@workspace/ui/components/card"
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import { AccountLink } from "@/components/account-link"
import { ItemBadges } from "@/components/item-badges"
import { queueQuery } from "@/lib/api"
import { when } from "@/lib/format"

const VIEWS: View[] = ["inbox", "working", "pr", "triaged", "done", "dismissed"]

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { view: View } => ({
    view: VIEWS.includes(search.view as View) ? (search.view as View) : "inbox",
  }),
  loaderDeps: ({ search }) => ({ view: search.view }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(queueQuery(deps.view)),
  component: Queue,
})

function Queue() {
  const { view } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useSuspenseQuery(queueQuery(view))

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <Tabs value={view} onValueChange={(v) => navigate({ search: { view: v as View } })}>
        <TabsList className="h-auto flex-wrap">
          {data.views.map((v) => (
            <TabsTrigger key={v.view} value={v.view}>
              {v.label}
              <span className="text-muted-foreground tabular-nums">{v.count}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="mt-4 flex flex-col gap-2">
        {data.items.length === 0 && <p className="text-muted-foreground py-10 text-center text-sm">Nothing here.</p>}
        {data.items.map((item) => (
          <Link key={item.id} to="/items/$id" params={{ id: item.id }} className="group">
            <Card className="group-hover:bg-muted/40 gap-2 px-4 py-3 transition-colors">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  <span className="text-muted-foreground">#{item.id}</span>{" "}
                  {item.source === "bluesky"
                    ? `@${item.author}`
                    : item.source === "classifier"
                      ? `${item.author} classifier`
                      : "In-app report"}
                </span>
                <ItemBadges item={item} />
              </div>
              {(item.subject || item.reporter) && (
                <div className="flex flex-col gap-0.5 text-sm">
                  {item.subject && <AccountLink account={item.subject} inCard />}
                  {item.reporter && (
                    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                      reported by <AccountLink account={item.reporter} inCard />
                    </span>
                  )}
                </div>
              )}
              <p className="line-clamp-3 text-sm whitespace-pre-wrap">{item.text}</p>
              <p className="text-muted-foreground text-xs">
                {when(item.receivedAt)}
                {item.routeReason && ` · ${item.routeReason}`}
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </main>
  )
}
