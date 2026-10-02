import type { ItemSummary } from "@workspace/types"
import { Badge } from "@workspace/ui/components/badge"
import { FIX_LABEL, STATUS_LABEL, words } from "@/lib/format"

/** The badges an item shows in the queue and at the top of its page. */
export function ItemBadges({ item }: { item: ItemSummary }) {
  const t = item.triage
  return (
    <div className="flex flex-wrap items-center gap-1">
      {t && <Badge variant={t.kind === "bug" ? "destructive" : "secondary"}>{words(t.kind)}</Badge>}
      {t && t.area !== "other" && <Badge variant="outline">{t.area}</Badge>}
      {t && t.platform !== "unknown" && <Badge variant="outline">{t.platform}</Badge>}
      <Badge variant={item.status === "failed" ? "destructive" : item.status === "needs_review" ? "default" : "outline"}>
        {STATUS_LABEL[item.status]}
      </Badge>
      {item.fixStatus && (
        <Badge variant={item.fixStatus === "failed" ? "destructive" : item.fixStatus === "ready" ? "default" : "secondary"}>
          {FIX_LABEL[item.fixStatus]}
        </Badge>
      )}
      {item.working && (
        <Badge variant="secondary" className="gap-1.5">
          <span className="bg-primary size-1.5 animate-pulse rounded-full motion-reduce:animate-none" />
          working
        </Badge>
      )}
    </div>
  )
}
