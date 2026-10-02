import { useEffect, useState } from "react"
import { CheckIcon, ChevronRightIcon, LoaderIcon, XIcon } from "lucide-react"
import type { Step, ThreadEntry } from "@workspace/types"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible"
import { Markdown } from "@/components/markdown"
import { cost, elapsed } from "@/lib/format"

type AgentEntry = Extract<ThreadEntry, { kind: "agent" }>

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ul className="mt-2 flex flex-col gap-0.5 text-xs">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-2">
          <span className="mt-0.5 shrink-0">
            {step.state === "done" ? (
              <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-400" />
            ) : step.state === "failed" ? (
              <XIcon className="text-destructive size-3" />
            ) : (
              <LoaderIcon className="text-primary size-3 animate-spin motion-reduce:animate-none" />
            )}
          </span>
          <span className="text-muted-foreground min-w-0">
            {step.label}
            {step.detail && <code className="text-foreground/80 ml-1 font-mono break-all">{step.detail.slice(0, 200)}</code>}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** One agent turn: its work folded into one line, then what it said. Live while it runs. */
export function AgentMessage({ entry }: { entry: AgentEntry }) {
  const now = useNow(entry.live)
  const shown = entry.steps.slice(-25)

  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{entry.who}</span>
      <div className="bg-card rounded-xl border px-4 py-3">
        {entry.live ? (
          <div className="text-muted-foreground text-xs">
            <span className="flex items-center gap-2">
              <span className="bg-primary size-2 animate-pulse rounded-full motion-reduce:animate-none" />
              Working · {elapsed(now - entry.startedAt)}
              {entry.steps.length > 0 && ` · ${entry.steps.length} steps`}
              {entry.cost > 0 && ` · ${cost(entry.cost)}`}
            </span>
            {entry.steps.length > shown.length && <p className="mt-2">{entry.steps.length - shown.length} earlier steps not shown</p>}
            {shown.length > 0 ? <StepList steps={shown} /> : <p className="mt-2">Waiting for the model's first step.</p>}
          </div>
        ) : (
          entry.steps.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex items-center gap-1 text-xs">
                <ChevronRightIcon className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
                {entry.summary}
                {entry.cost > 0 && ` · ${cost(entry.cost)}`}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <StepList steps={entry.steps} />
              </CollapsibleContent>
            </Collapsible>
          )
        )}
        {entry.text &&
          (entry.live ? (
            <p className="text-muted-foreground mt-3 line-clamp-6 text-sm whitespace-pre-wrap">{entry.text.slice(-800)}</p>
          ) : (
            <div className={entry.steps.length ? "mt-3" : ""}>
              <Markdown>{entry.text}</Markdown>
            </div>
          ))}
      </div>
    </div>
  )
}
