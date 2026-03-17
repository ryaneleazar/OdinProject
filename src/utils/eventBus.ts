import { EventEmitter } from "events";

export interface OdinEvents {
  "ticket:new": { ticketId: string; identifier: string; title: string; commentId: string };
  "ticket:implementing": { ticketId: string };
  "ticket:selfReviewing": { ticketId: string };
  "ticket:creatingPR": { ticketId: string };
  "ticket:awaitingReview": { ticketId: string; prNumber: number };
  "ticket:addressingFeedback": { ticketId: string; prNumber: number };
  "ticket:completed": { ticketId: string };
  "ticket:failed": { ticketId: string; error: string };
}

class TypedEventBus {
  private emitter = new EventEmitter();

  emit<K extends keyof OdinEvents>(event: K, data: OdinEvents[K]) {
    this.emitter.emit(event, data);
  }

  on<K extends keyof OdinEvents>(
    event: K,
    handler: (data: OdinEvents[K]) => void
  ) {
    this.emitter.on(event, handler);
  }

  off<K extends keyof OdinEvents>(
    event: K,
    handler: (data: OdinEvents[K]) => void
  ) {
    this.emitter.off(event, handler);
  }
}

export const eventBus = new TypedEventBus();
