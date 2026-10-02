import { useEffect, useState } from "react"
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react"
import { toast } from "sonner"
import type { Fix } from "@workspace/types"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@workspace/ui/components/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible"
import { Input } from "@workspace/ui/components/input"
import { Separator } from "@workspace/ui/components/separator"
import { Textarea } from "@workspace/ui/components/textarea"
import { useItemAction } from "@/lib/api"
import { AgentMessage } from "./agent-message"
import { DiffView } from "./diff-view"
import { Screenshots } from "./screenshots"

/** The fix, as the latest thing in the thread: live while it runs, then the diff and the approval. */
export function FixPanel({ itemId, fix }: { itemId: number; fix: Fix }) {
  const act = useItemAction(itemId)
  const [title, setTitle] = useState(fix.title)
  const [body, setBody] = useState(fix.body)
  // The agent proposes the text; take its latest proposal unless it was edited here.
  useEffect(() => setTitle(fix.title), [fix.title])
  useEffect(() => setBody(fix.body), [fix.body])

  if (fix.status === "working") {
    return fix.live ? (
      <AgentMessage entry={fix.live} />
    ) : (
      <p className="text-muted-foreground flex items-center justify-center gap-2 text-xs">
        <span className="bg-primary size-2 animate-pulse rounded-full motion-reduce:animate-none" />
        Preparing checkouts of {fix.repos.join(", ")} for the fix
      </p>
    )
  }

  const discard = (
    <Button
      variant="ghost"
      size="sm"
      disabled={act.isPending}
      onClick={() => act.mutate({ action: "discard-fix" }, { onError: (e) => toast.error(e.message) })}
    >
      Discard fix
    </Button>
  )

  if (fix.status === "failed") {
    return (
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">The fix in {fix.repos.join(", ")} failed</CardTitle>
          <CardAction>{discard}</CardAction>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">{fix.error}</p>
        </CardContent>
      </Card>
    )
  }

  const prRepos = fix.diffs.filter((d) => d.canOpenPr).map((d) => d.repo)
  const patchRepos = fix.diffs.filter((d) => !d.canOpenPr).map((d) => d.repo)
  const allOpen = prRepos.length > 0 && prRepos.every((r) => fix.prUrls[r])

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle>Fix in {fix.repos.join(", ")}</CardTitle>
        <CardAction>
          <code className="text-muted-foreground font-mono text-xs">{fix.branch}</code>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {Object.entries(fix.prUrls).map(([repo, url]) => (
          <a key={repo} href={url} target="_blank" rel="noreferrer" className="text-primary flex items-center gap-1 text-sm hover:underline">
            Draft pull request in {repo}
            <ExternalLinkIcon className="size-3" />
          </a>
        ))}
        {fix.error && (
          <Alert variant="destructive">
            <AlertDescription>{fix.error}</AlertDescription>
          </Alert>
        )}

        {fix.diffs.length === 0 ? (
          <p className="text-muted-foreground text-sm">The fix agent made no changes.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {fix.diffs.map((d) => (
              <Collapsible key={d.repo}>
                <CollapsibleTrigger className="group flex items-center gap-1.5 text-sm">
                  <ChevronRightIcon className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
                  <span className="font-medium">{d.repo}</span>
                  <span className="text-xs text-emerald-600 tabular-nums dark:text-emerald-400">+{d.added}</span>
                  <span className="text-destructive text-xs tabular-nums">−{d.removed}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="text-muted-foreground mt-2 text-xs whitespace-pre-wrap">{d.stat.trim()}</pre>
                  <DiffView diff={d.diff} />
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        )}

        {fix.screenshots && <Screenshots shots={fix.screenshots} />}

        {fix.diffs.length > 0 && <Separator />}

        {prRepos.length > 0 && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              act.mutate(
                { action: "pr", body: { title, body } },
                {
                  onSuccess: () => toast.success(allOpen ? "Pushed to the pull request" : "Draft pull request opened"),
                  onError: (err) => toast.error(err.message),
                }
              )
            }}
          >
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pull request title" aria-label="Pull request title" required />
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-32"
              placeholder="Description"
              aria-label="Pull request description"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={act.isPending}>
                {act.isPending ? "Working" : allOpen ? "Push update" : `Open draft pull request${prRepos.length > 1 ? "s" : ""}`}
                {prRepos.length > 1 && ` in ${prRepos.join(" and ")}`}
              </Button>
              {discard}
            </div>
          </form>
        )}
        {patchRepos.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {patchRepos.map((repo) => (
              <Button key={repo} variant="outline" size="sm" render={<a href={`/api/items/${itemId}/patch?repo=${encodeURIComponent(repo)}`} />}>
                Download {repo} patch
              </Button>
            ))}
            {prRepos.length === 0 && discard}
          </div>
        )}
        {fix.diffs.length === 0 && discard}
      </CardContent>
    </Card>
  )
}
