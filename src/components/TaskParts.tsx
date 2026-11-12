"use client";
import { useState } from "react";
import type { Requirement, TaskView } from "@/lib/api";
import { canDo, requirementLabel, type Role } from "@/lib/format";
import ShareInvite from "./ShareInvite";

export type Stage = "find" | "choose" | "pay" | "track";
const STEPS: [Stage, string][] = [["find", "Find"], ["choose", "Choose"], ["pay", "Pay"], ["track", "Track"]];

export function stageOf(v: TaskView): Stage {
  if (v.nextAction === "paid" || v.nextAction === "cancelled" || v.fulfilment || v.receipt) return "track";
  if (v.selection && !v.selection.stale) return "pay";
  return v.identified ? "choose" : "find";
}

export function Stepper({ stage }: { stage: Stage }) {
  const at = STEPS.findIndex(([s]) => s === stage);
  return (
    <ol className="stepper" aria-label="Progress">
      {STEPS.map(([s, label], i) => (
        <li key={s} className={i < at ? "done" : i === at ? "now" : ""} aria-current={i === at ? "step" : undefined}>{label}</li>
      ))}
    </ol>
  );
}

// What matters, as one line; pending items confirm in place
export function MustHave({ reqs, canConfirm, onConfirm }: { reqs: Requirement[]; canConfirm: boolean; onConfirm: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!reqs.length) return null;
  const confirmed = reqs.filter((r) => r.status === "confirmed");
  const pending = reqs.filter((r) => r.status === "proposed");
  return (
    <div className="musthave stack">
      <p className="small">
        <strong>Must have:</strong> {confirmed.length ? confirmed.map(requirementLabel).join(" · ") : "nothing confirmed yet"}
        {" · "}<button type="button" className="linkish" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Done" : "Edit"}</button>
      </p>
      {pending.map((r) => (
        <p key={r.id} className="small">Did you mean <strong>{requirementLabel(r)}</strong>?
          {canConfirm && <> <button type="button" className="btn small-btn" onClick={() => onConfirm(r.id)}>Confirm</button></>}</p>
      ))}
      {open && (
        <ul className="reqs small">
          {reqs.map((r) => (
            <li key={r.id}><span>{requirementLabel(r)}</span> <span className="tag">{r.essential ? "Must have" : "Nice to have"}</span>
              <span className="tag">{r.status === "confirmed" ? "Confirmed" : "Not confirmed yet"}</span></li>
          ))}
          <li className="muted">To change one, say it in the chat, e.g. &quot;it doesn&apos;t need to open from the top&quot;.</li>
        </ul>
      )}
    </div>
  );
}

// One quiet Share control instead of three buttons; offers only what fits the stage
export function ShareMenu({ taskId, token, roles, stage }: { taskId: string; token: string; roles: Role[]; stage: Stage }) {
  if (!canDo(roles, "invite") || stage === "track") return null;
  const mum = stage !== "pay" && roles.includes("payer");
  // Someone shopping for Mum can't choose: sending her the link is their next step
  const lead = mum && !canDo(roles, "choose");
  return (
    <details className={lead ? "card more share" : "more share"} open={lead}>
      <summary>{stage === "pay" ? "Someone else paying? Send them a link" : lead ? "Send it to Mum to choose" : "Share"}</summary>
      <div className="stack">
        {mum && <ShareInvite taskId={taskId} token={token} roles={["requester", "chooser"]} label="Mum" buttonText="Send to Mum to choose"
          hint="She can ask questions, correct details and choose herself. She won't see payment details." />}
        <ShareInvite taskId={taskId} token={token} roles={["payer"]} label="Payer" buttonText="Send to someone to pay"
          hint="They see the exact total and pay in PayPal. They can't change the choice." />
        {stage !== "pay" && (
          <details className="more"><summary>More ways</summary>
            <ShareInvite taskId={taskId} token={token} roles={["helper"]} label="Family" buttonText="Send a link to chat and suggest"
              hint="They can chat and suggest details, but can't choose or pay." />
          </details>
        )}
      </div>
    </details>
  );
}
