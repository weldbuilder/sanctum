// Test helper: records where every timer created while it is installed came from, so a timer left alive prints its creation stack.
// Install AFTER vi.useFakeTimers() (it wraps whatever setTimeout/setInterval the globals are then); the returned object restores them.
type Handle = unknown;
export interface TimerTracker { live(): string[]; created(): string[]; restore(): void }

export function trackTimers(): TimerTracker {
  const g = globalThis as unknown as Record<string, (...a: unknown[]) => Handle>;
  const original = { setTimeout: g.setTimeout, setInterval: g.setInterval, clearTimeout: g.clearTimeout, clearInterval: g.clearInterval };
  const stacks = new Map<Handle, string>();
  const everCreated: string[] = [];
  const stack = () => (new Error().stack ?? '').split('\n').slice(3, 12).join('\n');
  g.setTimeout = (fn: unknown, ...rest: unknown[]) => {
    const h: Handle = original.setTimeout((...a: unknown[]) => { stacks.delete(h); return (fn as (...x: unknown[]) => unknown)(...a); }, ...rest);
    stacks.set(h, `setTimeout${stack()}`);
    everCreated.push(stacks.get(h)!);
    return h;
  };
  g.setInterval = (fn: unknown, ...rest: unknown[]) => {
    const h = original.setInterval(fn, ...rest);
    stacks.set(h, `setInterval${stack()}`);
    everCreated.push(stacks.get(h)!);
    return h;
  };
  g.clearTimeout = (h: unknown) => { stacks.delete(h); return original.clearTimeout(h); };
  g.clearInterval = (h: unknown) => { stacks.delete(h); return original.clearInterval(h); };
  return {
    live: () => [...stacks.values()],
    created: () => [...everCreated],
    restore: () => { Object.assign(g, original); },
  };
}
