// Actor kinds the control-plane services gate on (DESIGN §7.1, §7.3, §12).
//
// One vocabulary for the whole application layer: a service that refuses Builder
// must refuse it for the same reason as every other service, otherwise "Builder
// reads blueprints only" becomes a per-module claim instead of one rule.

// `evaluator` is the trusted comparison role of DESIGN 10. It is not a control-plane
// kind and it is not a decision kind: it may only hand a completion in, never approve
// a plan, a contract or a sample.
export type ActorKind = "inspector" | "reviewer" | "builder" | "system" | "evaluator";

export type Actor = {
  actorId: string;
  actorKind: ActorKind;
};

// A recorded decision is attribution: only a human-side role may approve or
// reject, and `system` (a worker or the generation path) never may.
export const DECISION_KINDS: ActorKind[] = ["inspector", "reviewer"];

export const CONTROL_PLANE_KINDS: ActorKind[] = ["inspector", "reviewer", "system"];

export function isBuilder(actor: Actor): boolean {
  return actor.actorKind === "builder";
}

export function mayRecordDecision(actor: Actor): boolean {
  return DECISION_KINDS.includes(actor.actorKind);
}

export function isControlPlane(actor: Actor): boolean {
  return CONTROL_PLANE_KINDS.includes(actor.actorKind);
}
