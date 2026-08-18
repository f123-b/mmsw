export const SESSION_STATES = [
  "IDLE",
  "CREATING",
  "CONNECTING",
  "READY",
  "RUNNING",
  "RECONNECTING",
  "ENDING",
  "ENDED",
  "ERROR"
] as const;

export type SessionState = typeof SESSION_STATES[number];

const transitions: Record<SessionState, readonly SessionState[]> = {
  IDLE: ["CREATING"],
  CREATING: ["CONNECTING", "ERROR"],
  CONNECTING: ["READY", "RECONNECTING", "ERROR"],
  READY: ["RUNNING", "ENDING", "ERROR"],
  RUNNING: ["RECONNECTING", "ENDING", "ERROR"],
  RECONNECTING: ["CONNECTING", "ENDING", "ERROR"],
  ENDING: ["ENDED", "ERROR"],
  ENDED: ["CREATING", "IDLE"],
  ERROR: ["CREATING", "IDLE", "ENDING"]
};

export class InvalidSessionTransitionError extends Error {
  constructor(public readonly from: SessionState, public readonly to: SessionState) {
    super(`Invalid session transition: ${from} → ${to}`);
    this.name = "InvalidSessionTransitionError";
  }
}

export class SessionStateMachine {
  private currentState: SessionState;
  private readonly listeners = new Set<(state: SessionState) => void>();

  constructor(initialState: SessionState = "IDLE") {
    this.currentState = initialState;
  }

  get state(): SessionState {
    return this.currentState;
  }

  canTransition(to: SessionState): boolean {
    return transitions[this.currentState].includes(to);
  }

  transition(to: SessionState): SessionState {
    if (!this.canTransition(to)) {
      throw new InvalidSessionTransitionError(this.currentState, to);
    }
    this.currentState = to;
    this.listeners.forEach((listener) => listener(to));
    return to;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function normalizeMeter(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value);
}
