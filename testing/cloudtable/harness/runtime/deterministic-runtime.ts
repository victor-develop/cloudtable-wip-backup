export type DeterministicRuntime = {
  now(): string;
  nextId(prefix: string): string;
  random(): number;
};

export function createDeterministicRuntime(seed = 1): DeterministicRuntime {
  let counter = 0;
  let state = seed;

  return {
    now() {
      return "2026-06-06T00:00:00.000Z";
    },
    nextId(prefix: string) {
      counter += 1;
      return `${prefix}_${counter.toString().padStart(4, "0")}`;
    },
    random() {
      state = (state * 48271) % 0x7fffffff;
      return state / 0x7fffffff;
    }
  };
}

