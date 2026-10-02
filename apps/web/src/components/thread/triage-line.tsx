import { useState } from "react"
import { toast } from "sonner"
import { useQuery } from "@tanstack/react-query"
import type { ItemDetail } from "@workspace/types"
import { Button } from "@workspace/ui/components/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select"
import { optionsQuery, useItemAction } from "@/lib/api"
import { words } from "@/lib/format"

function Choice({ label, value, options, onChange }: { label: string; value: string; options: Record<string, string>; onChange: (v: string) => void }) {
  const items = Object.keys(options).map((k) => ({ value: k, label: words(k) }))
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as string)} items={items}>
      <SelectTrigger size="sm" aria-label={label} className="min-w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** "Triaged: bug · upload · ios · severity 2.0", with a way to correct it. */
export function TriageLine({ item }: { item: ItemDetail }) {
  const t = item.triage
  const options = useQuery(optionsQuery)
  const act = useItemAction(item.id)
  const [draft, setDraft] = useState({ kind: t?.kind ?? "", area: t?.area ?? "", platform: t?.platform ?? "" })

  if (!t) {
    return item.status === "new" ? <p className="text-muted-foreground text-center text-xs">Waiting for triage</p> : null
  }
  const reason = item.routeReason && !item.routeReason.startsWith(t.kind) ? ` · ${item.routeReason}` : ""
  const summary = [words(t.kind), t.area, t.platform !== "unknown" ? t.platform : "", `severity ${t.severity.toFixed(1)}`]
    .filter(Boolean)
    .join(" · ")

  return (
    <Collapsible className="text-muted-foreground flex flex-col items-center text-center text-xs">
      <p>
        Triaged: {summary}
        {reason}
        {" · "}
        <CollapsibleTrigger className="hover:text-foreground underline underline-offset-2">correct</CollapsibleTrigger>
      </p>
      <CollapsibleContent>
        {options.data && (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            <Choice label="Kind" value={draft.kind} options={options.data.kinds} onChange={(kind) => setDraft({ ...draft, kind })} />
            <Choice label="Area" value={draft.area} options={options.data.areas} onChange={(area) => setDraft({ ...draft, area })} />
            <Choice label="Platform" value={draft.platform} options={options.data.platforms} onChange={(platform) => setDraft({ ...draft, platform })} />
            <Button
              size="sm"
              variant="outline"
              disabled={act.isPending}
              onClick={() => act.mutate({ action: "triage", body: draft }, { onSuccess: () => toast.success("Triage corrected"), onError: (e) => toast.error(e.message) })}
            >
              Save
            </Button>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
