// Who started the turn an item's agent is on right now. The support tools use
// this to tell a maintainer's request from the agent acting on its own.

export type TurnSource = "person" | "event" | "investigation";

const active = new Map<number, TurnSource>();

export function activeTurn(itemId: number): TurnSource | undefined {
  return active.get(itemId);
}

export async function during<T>(itemId: number, source: TurnSource, run: () => Promise<T>): Promise<T> {
  active.set(itemId, source);
  try {
    return await run();
  } finally {
    active.delete(itemId);
  }
}
