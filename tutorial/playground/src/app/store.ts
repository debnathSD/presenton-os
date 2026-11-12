// A tiny store: one state object, shallow patches, synchronous listeners. No framework.

export type Listener<S> = (state: S, prev: S) => void;
export type Store<S> = {
  get(): S;
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: Listener<S>): () => void;
};

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<Listener<S>>();
  return {
    get: () => state,
    set(patch) {
      const prev = state;
      const p = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...p };
      for (const fn of [...listeners]) fn(state, prev);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

/** True when any of the keys changed by reference between two states. */
export function changed<S>(a: S, b: S, ...keys: (keyof S)[]): boolean {
  return keys.some((k) => a[k] !== b[k]);
}
