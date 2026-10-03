import { toast } from "sonner"
import type { ItemDetail } from "@workspace/types"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card"
import { AccountLink } from "@/components/account-link"
import { useItemAction } from "@/lib/api"

/** A takedown the agent proposed, which happens only when the maintainer confirms it here. */
export function TakedownCard({ item }: { item: ItemDetail }) {
  const act = useItemAction(item.id)
  const pending = item.moderationPending
  if (pending?.action !== "takedown") return null
  const run = (action: "confirm-takedown" | "cancel-moderation", done: string) =>
    act.mutate({ action }, { onSuccess: () => toast.success(done), onError: (e) => toast.error(e.message) })
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-1.5 text-sm">
          Take down {item.subject ? <AccountLink account={item.subject} /> : "this account"}?
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {pending.reason && <p className="text-muted-foreground">{pending.reason}</p>}
        <p className="text-muted-foreground text-xs">
          The account and everything it posted disappear from grain, and every open report on it is closed. It can be
          reversed from grain&rsquo;s /admin.
        </p>
        <div className="flex gap-2">
          <Button variant="destructive" size="sm" disabled={act.isPending} onClick={() => run("confirm-takedown", "Taken down")}>
            Take down
          </Button>
          <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => run("cancel-moderation", "Cancelled")}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
