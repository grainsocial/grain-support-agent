import { ChevronRightIcon } from "lucide-react"
import type { Screenshots as Shots } from "@workspace/types"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible"

export function Screenshots({ shots }: { shots: Shots }) {
  if (shots.status === "running") {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <span className="bg-primary size-2 animate-pulse rounded-full motion-reduce:animate-none" />
        Taking before and after screenshots of {shots.pages.length} page{shots.pages.length === 1 ? "" : "s"}
      </p>
    )
  }
  if (shots.status === "failed") {
    return (
      <Collapsible>
        <CollapsibleTrigger className="text-destructive group flex items-center gap-1 text-xs">
          <ChevronRightIcon className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
          Screenshots failed: {shots.error}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="bg-muted/50 mt-2 max-h-72 overflow-auto rounded-lg p-3 text-xs whitespace-pre-wrap">{shots.log}</pre>
        </CollapsibleContent>
      </Collapsible>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm font-medium">
        Screenshots <span className="text-muted-foreground font-normal">before and after, on seed data</span>
      </p>
      {shots.pages.map((page) => (
        <div key={page.name} className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs">
            <code className="text-foreground font-mono">{page.path}</code> {page.viewport}
            {page.device !== "default" && `, ${page.device}`}
          </p>
          <div className={`grid grid-cols-2 gap-2 ${page.viewport === "mobile" ? "max-w-md" : ""}`}>
            {(["before", "after"] as const).map((side) => (
              <figure key={side} className="flex flex-col gap-1">
                <figcaption className="text-muted-foreground text-xs capitalize">{side}</figcaption>
                {page[side] ? (
                  <a href={page[side]} target="_blank" rel="noreferrer">
                    <img src={page[side]} alt={`${page.path} ${side} the fix`} className="w-full rounded-md border" loading="lazy" />
                  </a>
                ) : (
                  <p className="text-muted-foreground text-xs">not taken</p>
                )}
              </figure>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
