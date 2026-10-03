import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query"
import type { ItemDetail, Options, QueueResponse, View } from "@workspace/types"

// The dashboard API. Every write returns the item as it now is, which goes
// straight into the cache, so the page updates without a second request.

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  })
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new ApiError(body.error ?? `${res.status} ${res.statusText}`)
  return body
}

export const queueQuery = (view: View) =>
  queryOptions({
    queryKey: ["queue", view],
    queryFn: () => request<QueueResponse>(`/items?view=${view}`),
    refetchInterval: 15_000,
  })

export const itemQuery = (id: number) =>
  queryOptions({
    queryKey: ["item", id],
    queryFn: () => request<ItemDetail>(`/items/${id}`),
    // Quick while an agent works, so its steps show as they happen.
    refetchInterval: (query) => (query.state.data?.busy ? 2500 : 30_000),
  })

export const optionsQuery = queryOptions({
  queryKey: ["options"],
  queryFn: () => request<Options>("/options"),
  staleTime: Infinity,
})

export type ItemAction =
  | { action: "messages"; body: { message: string } }
  | { action: "triage"; body: { kind?: string; area?: string; platform?: string } }
  | { action: "pr"; body: { title: string; body: string } }
  | { action: "investigate" | "done" | "dismiss" | "discard-fix" | "confirm-takedown" | "cancel-moderation"; body?: undefined }

export function useItemAction(id: number) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ action, body }: ItemAction) =>
      request<ItemDetail>(`/items/${id}/${action}`, { method: "POST", body: JSON.stringify(body ?? {}) }),
    onSuccess: (item) => {
      client.setQueryData(["item", id], item)
      client.invalidateQueries({ queryKey: ["queue"] })
    },
  })
}
