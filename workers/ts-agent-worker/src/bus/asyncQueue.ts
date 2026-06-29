export class AsyncQueueClosedError extends Error {
  constructor() {
    super("AsyncQueue is closed");
    this.name = "AsyncQueueClosedError";
  }
}

export class AsyncQueueConsumeCancelledError extends Error {
  constructor() {
    super("AsyncQueue consume cancelled");
    this.name = "AsyncQueueConsumeCancelledError";
  }
}

type PendingConsumer<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly consumers: PendingConsumer<T>[] = [];
  private closed = false;

  get size(): number {
    return this.items.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  push(item: T): void {
    if (this.closed) {
      throw new AsyncQueueClosedError();
    }
    const consumer = this.consumers.shift();
    if (consumer) {
      consumer.resolve(item);
      return;
    }
    this.items.push(item);
  }

  shiftNow(): T | undefined {
    return this.items.shift();
  }

  async shift(): Promise<T> {
    const item = this.shiftNow();
    if (item !== undefined) {
      return item;
    }
    if (this.closed) {
      throw new AsyncQueueClosedError();
    }
    return new Promise<T>((resolve, reject) => {
      this.consumers.push({ resolve, reject });
    });
  }

  async shiftWithTimeout(timeoutMs: number, signal?: AbortSignal): Promise<T | undefined> {
    const item = this.shiftNow();
    if (item !== undefined) {
      return item;
    }
    if (this.closed) {
      throw new AsyncQueueClosedError();
    }
    if (signal?.aborted) {
      throw new AsyncQueueConsumeCancelledError();
    }
    const timeout = Math.max(0, timeoutMs);
    return new Promise<T | undefined>((resolve, reject) => {
      const consumer: PendingConsumer<T> = { resolve, reject };
      const cleanup = () => {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        const index = this.consumers.indexOf(consumer);
        if (index >= 0) {
          this.consumers.splice(index, 1);
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new AsyncQueueConsumeCancelledError());
      };
      const timeoutId = setTimeout(() => {
        cleanup();
        resolve(undefined);
      }, timeout);
      consumer.resolve = (value) => {
        cleanup();
        resolve(value);
      };
      consumer.reject = (error) => {
        cleanup();
        reject(error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.consumers.push(consumer);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const consumers = this.consumers.splice(0);
    for (const consumer of consumers) {
      consumer.reject(new AsyncQueueClosedError());
    }
  }
}
