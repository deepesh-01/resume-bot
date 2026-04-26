// Per-user serialization. §8: in-memory Map<chat_id, Promise>.
// Different users run concurrently; same-user requests queue.

const queues = new Map<number, Promise<unknown>>()

export const withUserLock = async <T>(
  chat_id: number,
  fn: () => Promise<T>,
): Promise<T> => {
  const prev = queues.get(chat_id) ?? Promise.resolve()
  // Don't propagate prior failures into the next caller.
  const next = prev.catch(() => undefined).then(fn)
  queues.set(chat_id, next)
  try {
    return await next
  } finally {
    if (queues.get(chat_id) === next) queues.delete(chat_id)
  }
}
