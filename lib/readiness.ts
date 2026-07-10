export type ReadinessState = 'disconnected' | 'connecting' | 'connected' | 'conflict' | 'logged_out';

interface Waiter {
  resolve: (connected: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Small connection gate used by IPC commands that require the live WhatsApp
 * socket. A supervised daemon can be alive while Baileys is still connecting,
 * so treating "process exists" as "ready" creates a startup/reconnect race.
 */
export class ConnectionReadinessGate {
  private state: ReadinessState;
  private readonly waiters = new Set<Waiter>();

  constructor(initialState: ReadinessState = 'disconnected') {
    this.state = initialState;
  }

  setState(state: ReadinessState): void {
    this.state = state;
    if (state === 'connected') {
      this.settle(true);
    } else if (state === 'conflict' || state === 'logged_out') {
      // These states require user action; waiting cannot make the command work.
      this.settle(false);
    }
  }

  wait(timeoutMs: number): Promise<boolean> {
    if (this.state === 'connected') return Promise.resolve(true);
    if (this.state === 'conflict' || this.state === 'logged_out') return Promise.resolve(false);
    if (timeoutMs <= 0) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(false);
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  cancel(): void {
    this.settle(false);
  }

  private settle(connected: boolean): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(connected);
    }
    this.waiters.clear();
  }
}
