import type { StorageTransaction, StorageWriterPort } from "../../packages/application/ports.ts";

// A storage port that lets something else land between the service's pre-read and its
// write transaction. Two guards exist only for that window — the attempt budget
// re-checked inside the transaction, and the blueprint re-read inside the transaction —
// and a sequential test would never reach them, so they are raced rather than assumed.
export function racingStorage(
  base: StorageWriterPort,
  race: { method: keyof StorageTransaction; beforeCall: number; inject: (tx: StorageTransaction) => void },
): StorageWriterPort {
  const calls = new Map<string, number>();
  return {
    transact<T>(work: (tx: StorageTransaction) => T) {
      return base.transact((tx) =>
        work(
          new Proxy(tx, {
            get(receiver, property, holder) {
              if (property === race.method) {
                const key = String(property);
                const seen = (calls.get(key) ?? 0) + 1;
                calls.set(key, seen);
                if (seen === race.beforeCall) race.inject(tx);
              }
              const value = Reflect.get(receiver, property, holder);
              return typeof value === "function" ? value.bind(tx) : value;
            },
          }),
        ),
      );
    },
  };
}

