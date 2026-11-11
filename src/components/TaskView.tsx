"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import Chat from "./Chat";
import Comparison from "./Comparison";
import PayerPanel from "./PayerPanel";
import ShareInvite from "./ShareInvite";
import {
  api, ApiError, type ChatMessage, type Comparison as Cmp, type Offer, type TaskView as View,
} from "@/lib/api";
import { canDo, formatMoney, nextActionCopy, requirementLabel } from "@/lib/format";
import { useTaskToken } from "@/lib/useToken";

const POLL_MS = 4000;

export default function TaskPage({ taskId }: { taskId: string }) {
  const { ready, token } = useTaskToken(taskId);
  const [view, setView] = useState<View | null>(null);
  const [cmp, setCmp] = useState<Cmp | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [invalid, setInvalid] = useState(false);
  const [offline, setOffline] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [choiceErr, setChoiceErr] = useState<{ msg: string; stale: boolean } | null>(null);
  const [reqErr, setReqErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (!token || inflight.current) return;
    inflight.current = true;
    setUpdating(true);
    try {
      const v = await api.getTask(taskId, token);
      setView(v); setInvalid(false);
      const [c, m] = await Promise.allSettled([api.getComparison(taskId, token), api.getMessages(taskId, token)]);
      if (c.status === "fulfilled") setCmp(c.value);
      if (m.status === "fulfilled") setMessages((old) => mergeMsgs(old, m.value.messages));
      failures.current = 0; setOffline(false);
    } catch (e) {
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) setInvalid(true);
      else { failures.current++; setOffline(true); }
    } finally { inflight.current = false; setUpdating(false); }
  }, [taskId, token]);

  useEffect(() => {
    if (!token) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      if (!document.hidden) await load();
      if (stop) return;
      const wait = Math.min(POLL_MS * 2 ** Math.min(failures.current, 3), 30000);
      timer.current = setTimeout(tick, wait);
    };
    const vis = () => {
      if (!document.hidden) { if (timer.current) clearTimeout(timer.current); void tick(); }
    };
    void tick();
    document.addEventListener("visibilitychange", vis);
    return () => { stop = true; if (timer.current) clearTimeout(timer.current); document.removeEventListener("visibilitychange", vis); };
  }, [token, load]);

  async function choose(o: Offer) {
    if (!token || !cmp) return;
    setChoosing(o.id); setChoiceErr(null);
    try { await api.select(taskId, token, o.id, cmp.version); await load(); }
    catch (e) {
      const stale = e instanceof ApiError && (e.code === "stale" || e.status === 409);
      setChoiceErr({ stale, msg: stale ? "The options changed while you were looking. Refresh and choose again." : e instanceof Error ? e.message : "Could not choose." });
    } finally { setChoosing(null); }
  }

  async function confirmReq(rid: string) {
    if (!token) return;
    setReqErr("");
    try { await api.confirmRequirement(taskId, token, rid); await load(); }
    catch (e) { setReqErr(e instanceof Error ? e.message : "Could not confirm."); }
  }

  if (!ready) return <main className="page"><p role="status">Opening...</p></main>;
  if (!token || invalid) {
    return (
      <main className="page">
        <section className="card stack" role="alert">
          <h1>This link is not working</h1>
          <p>{invalid ? "It may have expired or been turned off, or it may be for a different task."
            : "This page needs the private link that was sent to you."}</p>
          <p>Ask the person who invited you to send a new link.</p>
          <Link className="btn secondary" href="/">Start a new task</Link>
        </section>
      </main>
    );
  }
  if (!view) return <main className="page"><p role="status">Loading your task...</p></main>;

  const roles = view.viewer.roles;
  const copy = nextActionCopy(view.nextAction);
  const sel = view.selection;
  const extOffer = sel?.route === "external"
    ? cmp?.offers.find((o) => o.route === "external" && o.title === sel.title && o.seller === sel.seller) : undefined;
  const showPayer = !!view.order || roles.includes("payer");
  const chooseOn = canDo(roles, "choose") && !view.order && view.nextAction !== "cancelled" && view.nextAction !== "paid";

  return (
    <main className="page">
      <header className="stack">
        <p className="eyebrow">Dad&apos;s Typing...</p>
        <h1>{view.title}</h1>
        <div className="next" role="status" aria-live="polite">
          <strong>{copy.headline}</strong>
          <p>{copy.detail}</p>
        </div>
        <p className="muted small" role="status" aria-live="polite">
          {offline ? "Connection lost. Trying again..." : updating ? "Updating..." : "Up to date"}
          {" · "}You can: {roles.join(", ")}
        </p>
      </header>

      {sel && (
        <section className="card selection" aria-labelledby="sel-h">
          <h2 id="sel-h">Chosen: {sel.title}</h2>
          <p>From {sel.seller}{sel.reason ? ` · Reason: ${sel.reason}` : ""}</p>
          {sel.stale && <p className="error">The requirements changed after this choice. Please choose again.</p>}
          {sel.route === "external" && (
            <>
              <p className="muted">This is an external retailer link. Payment is not taken here.</p>
              {extOffer?.url && (
                <a className="btn" href={extOffer.url} target="_blank" rel="noopener noreferrer">View at retailer</a>
              )}
            </>
          )}
        </section>
      )}

      {view.receipt && (
        <section className="card receipt" aria-labelledby="rc-h">
          <h2 id="rc-h">Receipt</h2>
          <dl className="facts">
            <dt>Seller</dt><dd>{view.receipt.seller}</dd>
            <dt>Item</dt><dd>{view.receipt.title}</dd>
            <dt>SKU</dt><dd>{view.receipt.sku}</dd>
            <dt>Total paid</dt><dd><strong>{formatMoney(view.receipt.totalMinor, view.receipt.currency)}</strong></dd>
          </dl>
          <p className="muted small">Sandbox payment. Demo shop.</p>
        </section>
      )}

      <Chat taskId={taskId} token={token} messages={messages} canSend={canDo(roles, "message")}
        canConfirm={canDo(roles, "confirm_requirement")} onChanged={load}
        onSent={(m) => setMessages((old) => mergeMsgs(old, m))} />

      <section className="card stack" aria-labelledby="req-h">
        <h2 id="req-h">What we need</h2>
        {view.requirements.length === 0 && <p className="muted">Nothing confirmed yet.</p>}
        <ul className="reqs">
          {view.requirements.map((r) => (
            <li key={r.id}>
              <span>{requirementLabel(r)}</span>
              <span className="tag">{r.essential ? "Essential" : "Preference"}</span>
              <span className="tag">{r.status === "confirmed" ? "Confirmed" : "Waiting to be confirmed"}</span>
              {r.status === "proposed" && canDo(roles, "confirm_requirement") && (
                <button className="btn small-btn" onClick={() => confirmReq(r.id)}>Confirm</button>
              )}
            </li>
          ))}
        </ul>
        <p role="alert" className="error">{reqErr}</p>
      </section>

      {choiceErr && (
        <div className="note" role="alert">
          <p>{choiceErr.msg}</p>
          {choiceErr.stale && <button className="btn" onClick={() => { setChoiceErr(null); void load(); }}>Refresh</button>}
        </div>
      )}
      <Comparison offers={cmp?.offers ?? []} canChoose={chooseOn} busyId={choosing}
        disabled={!cmp} onChoose={choose} />

      {canDo(roles, "invite") && (
        <section className="card stack" aria-labelledby="ask-h">
          <h2 id="ask-h">Ask someone</h2>
          <ShareInvite taskId={taskId} token={token} roles={["helper"]} label="Helper"
            buttonText="Make a helper link" hint="A helper can chat and suggest details, but cannot choose or pay." />
          <ShareInvite taskId={taskId} token={token} roles={["payer"]} label="Payer"
            buttonText="Make a payer link" hint="The payer can review the order and pay in PayPal." />
        </section>
      )}

      {showPayer && <PayerPanel taskId={taskId} token={token} view={view} onChanged={load} />}
    </main>
  );
}

function mergeMsgs(old: ChatMessage[], next: ChatMessage[]) {
  const map = new Map(old.map((m) => [m.id, m]));
  next.forEach((m) => map.set(m.id, m));
  return [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
