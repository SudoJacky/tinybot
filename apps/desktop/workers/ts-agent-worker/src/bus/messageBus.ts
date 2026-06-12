import { AsyncQueue, AsyncQueueClosedError } from "./asyncQueue.ts";
import type { InboundMessage, OutboundMessage } from "./messageTypes.ts";

export const DEFAULT_QUEUE_WARNING_THRESHOLD = 100;

export type MessageBusOptions = {
  warningThreshold?: number;
  now?: () => string;
};

export type MessageBusBatchOptions = {
  maxBatch?: number;
  timeoutMs?: number;
};

export type MessageBusWarning = {
  queue: "inbound" | "outbound";
  size: number;
  threshold: number;
  timestamp: string;
};

export type MessageBusStats = {
  inboundSize: number;
  outboundSize: number;
  warningThreshold: number;
  warnings: MessageBusWarning[];
  lastWarningAt: string | null;
  closed: boolean;
};

export class MessageBus {
  private readonly inbound = new AsyncQueue<InboundMessage>();
  private readonly outbound = new AsyncQueue<OutboundMessage>();
  private readonly warningThreshold: number;
  private readonly now: () => string;
  private readonly warnings: MessageBusWarning[] = [];
  private closed = false;

  constructor(options: MessageBusOptions = {}) {
    this.warningThreshold = Math.max(0, Math.trunc(options.warningThreshold ?? DEFAULT_QUEUE_WARNING_THRESHOLD));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async publishInbound(message: InboundMessage): Promise<void> {
    if (this.closed) {
      return;
    }
    this.inbound.push(message);
    this.recordWarning("inbound", this.inbound.size);
  }

  async consumeInbound(): Promise<InboundMessage | null> {
    return this.consume(this.inbound);
  }

  async consumeInboundWithTimeout(timeoutMs: number): Promise<InboundMessage | null> {
    return this.consumeWithTimeout(this.inbound, timeoutMs);
  }

  async consumeInboundBatch(options: MessageBusBatchOptions = {}): Promise<InboundMessage[]> {
    return this.consumeBatch(this.inbound, options);
  }

  async publishOutbound(message: OutboundMessage): Promise<void> {
    if (this.closed) {
      return;
    }
    this.outbound.push(message);
    this.recordWarning("outbound", this.outbound.size);
  }

  async consumeOutbound(): Promise<OutboundMessage | null> {
    return this.consume(this.outbound);
  }

  async consumeOutboundWithTimeout(timeoutMs: number): Promise<OutboundMessage | null> {
    return this.consumeWithTimeout(this.outbound, timeoutMs);
  }

  async consumeOutboundBatch(options: MessageBusBatchOptions = {}): Promise<OutboundMessage[]> {
    return this.consumeBatch(this.outbound, options);
  }

  drainOutboundForTest(): OutboundMessage[] {
    const messages: OutboundMessage[] = [];
    let message = this.outbound.shiftNow();
    while (message !== undefined) {
      messages.push(message);
      message = this.outbound.shiftNow();
    }
    return messages;
  }

  stats(): MessageBusStats {
    return {
      inboundSize: this.inbound.size,
      outboundSize: this.outbound.size,
      warningThreshold: this.warningThreshold,
      warnings: this.warnings.map((warning) => ({ ...warning })),
      lastWarningAt: this.warnings.at(-1)?.timestamp ?? null,
      closed: this.closed,
    };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.inbound.close();
    this.outbound.close();
  }

  private async consume<T>(queue: AsyncQueue<T>): Promise<T | null> {
    try {
      return await queue.shift();
    } catch (error) {
      if (error instanceof AsyncQueueClosedError) {
        return null;
      }
      throw error;
    }
  }

  private async consumeWithTimeout<T>(queue: AsyncQueue<T>, timeoutMs: number): Promise<T | null> {
    if (this.closed || queue.isClosed) {
      return null;
    }
    try {
      return await queue.shiftWithTimeout(timeoutMs) ?? null;
    } catch (error) {
      if (error instanceof AsyncQueueClosedError) {
        return null;
      }
      throw error;
    }
  }

  private async consumeBatch<T>(queue: AsyncQueue<T>, options: MessageBusBatchOptions): Promise<T[]> {
    const maxBatch = Math.max(1, Math.trunc(options.maxBatch ?? 10));
    const first = await this.consumeWithTimeout(queue, options.timeoutMs ?? 100);
    if (first === null) {
      return [];
    }
    const messages = [first];
    while (messages.length < maxBatch) {
      const next = queue.shiftNow();
      if (next === undefined) {
        break;
      }
      messages.push(next);
    }
    return messages;
  }

  private recordWarning(queue: MessageBusWarning["queue"], size: number): void {
    if (size <= this.warningThreshold) {
      return;
    }
    this.warnings.push({
      queue,
      size,
      threshold: this.warningThreshold,
      timestamp: this.now(),
    });
  }
}
