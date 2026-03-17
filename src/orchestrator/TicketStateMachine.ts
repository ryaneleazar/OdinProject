export type TicketState =
  | "Queued"
  | "Implementing"
  | "WritingTests"
  | "SelfReviewing"
  | "CreatingPR"
  | "AwaitingReview"
  | "AddressingFeedback"
  | "Completed"
  | "Failed";

const VALID_TRANSITIONS: Record<TicketState, TicketState[]> = {
  Queued: ["Implementing"],
  Implementing: ["WritingTests", "Failed"],
  WritingTests: ["SelfReviewing", "Failed"],
  SelfReviewing: ["CreatingPR", "Failed"],
  CreatingPR: ["AwaitingReview", "Failed"],
  AwaitingReview: ["AddressingFeedback", "Completed"],
  AddressingFeedback: ["SelfReviewing", "AwaitingReview", "Failed"],
  Completed: [],
  Failed: [],
};

export interface TicketContext {
  ticketId: string;
  identifier: string;
  title: string;
  description: string;
  commentId: string;
  branchName: string;
  worktreePath: string;
  prNumber?: number;
  state: TicketState;
  feedbackRounds: number;
}

export function canTransition(
  from: TicketState,
  to: TicketState
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transition(
  ctx: TicketContext,
  to: TicketState
): TicketContext {
  if (!canTransition(ctx.state, to)) {
    throw new Error(
      `Invalid state transition: ${ctx.state} -> ${to} (ticket: ${ctx.ticketId})`
    );
  }
  return { ...ctx, state: to };
}
