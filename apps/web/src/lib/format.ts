import type { FixStatus, Status } from "@workspace/types"

export const cost = (n: number) => (n ? `$${n.toFixed(n < 0.01 ? 4 : 2)}` : "")

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

export const words = (s: string) => s.replace(/_/g, " ")

export const STATUS_LABEL: Record<Status, string> = {
  new: "new",
  needs_review: "needs review",
  triaged: "triaged",
  investigate: "queued",
  investigating: "investigating",
  reported: "reported",
  failed: "failed",
  done: "done",
  dismissed: "dismissed",
}

export const FIX_LABEL: Record<Exclude<FixStatus, "">, string> = {
  working: "fixing",
  ready: "fix ready",
  failed: "fix failed",
  pr_open: "PR open",
}
