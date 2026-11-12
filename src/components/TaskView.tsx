"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import Chat from "./Chat";
import DeliveredCards from "./DeliveredCards";
import PayerPanel, { TopupPay } from "./PayerPanel";
import { MustHave, ShareMenu, Stepper, stageOf } from "./TaskParts";
import SharedSources from "./SharedSources";
import StatusTimeline from "./StatusTimeline";
import {
  api, ApiError, type ChatMessage, type Comparison as Cmp, type Offer, type Proposal, type TaskView as View,
} from "@/lib/api";
import { canDo, formatMoney, stageCopy } from "@/lib/format";
import { useTaskToken } from "@/lib/useToken";

const POLL_MS = 4000;

export default function TaskPage({ taskId }: { taskId: string }) {
  const { ready, token } = useTaskToken(taskId);
  const [view, setView] = useState<View | null>(null);
  const [cmp, setCmp] = useState<Cmp | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [serverProposals, setServerProposals] = useState<Proposal[]>([]);
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
      if (m.status === "fulfilled") {
        setMessages((old) => mergeMsgs(old, m.value.messages));
        setServerProposals(m.value.proposals ?? []);
      }
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
    const vis = () => { if (!document.hidden) void load(); };
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
  const stage = stageOf(view);
  const canPay = canDo(roles, "pay");
  const copy = stageCopy(stage, view.nextAction, { canPay, canChoose: canDo(roles, "choose"), tracked: !!view.fulfilment });
  const sel = view.selection;
  const extOffer = sel?.route === "external"
    ? cmp?.offers.find((o) => o.route === "external" && o.title === sel.title && o.seller === sel.seller) : undefined;
  const chooseOn = canDo(roles, "choose") && !view.order && view.nextAction !== "cancelled" && view.nextAction !== "paid";
  const lastSaid = [...messages].reverse().find((m) => m.role === "assistant")?.body ?? "";

  const chat = (bare: boolean) => (
    <Chat taskId={taskId} token={token} messages={messages} serverProposals={serverProposals} canSend={canDo(roles, "message")}
      canConfirm={canDo(roles, "confirm_requirement")} onChanged={load} bare={bare}
      onSent={(m) => setMessages((old) => mergeMsgs(old, m))} />
  );
  // After Find the conversation steps back to one bar; a pending question opens it
  const chatBar = (
    <details className="card chatbar" open={serverProposals.length > 0}>
      <summary>{canDo(roles, "message") ? "Ask or change something" : `Conversation (${messages.length})`}
        {lastSaid && <span className="last">{lastSaid}</span>}</summary>
      {chat(true)}
    </details>
  );
  const must = <MustHave reqs={view.requirements} canConfirm={canDo(roles, "confirm_requirement")} onConfirm={confirmReq} />;
  const cards = cmp && (
    <DeliveredCards taskId={taskId} token={token} refreshKey={cmp.version * 1000 + cmp.offers.length} canEdit={canDo(roles, "message")} canChoose={chooseOn}
      busy={choosing} excluded={cmp.offers.filter((o) => o.status === "ineligible")}
      onChoose={(id) => { const o = cmp.offers.find((x) => x.id === id); if (o) void choose(o); }} />
  );
  const sources = (compact: boolean) => (
    <SharedSources taskId={taskId} token={token} canEdit={canDo(roles, "message")} refreshKey={messages.length} onChanged={load} compact={compact} />
  );

  return (
    <main className="page">
      <header className="stack">
        <h1>{view.title}</h1>
        <Stepper stage={stage} />
        <div className="next" role="status" aria-live="polite">
          <strong>{copy.headline}</strong>
          <p>{copy.detail}</p>
        </div>
        {offline && <p className="muted small" role="status">Connection lost. Trying again...</p>}
        {!offline && updating && <span className="sr-only" role="status">Updating</span>}
      </header>

      {choiceErr && (
        <div className="note" role="alert">
          <p>{choiceErr.msg}</p>
          {choiceErr.stale && <button className="btn" onClick={() => { setChoiceErr(null); void load(); }}>Refresh</button>}
        </div>
      )}
      <p role="alert" className="error">{reqErr}</p>

      {stage === "find" && (
        <>
          {sources(false)}
          {chat(false)}
          {must}
          <ShareMenu taskId={taskId} token={token} roles={roles} stage={stage} />
        </>
      )}

      {stage === "choose" && (
        <>
          {must}
          {canDo(roles, "choose") ? cards : cards && <details className="card more"><summary>See the options</summary>{cards}</details>}
          {sources(true)}
          {chatBar}
          <ShareMenu taskId={taskId} token={token} roles={roles} stage={stage} />
        </>
      )}

      {stage === "pay" && sel && (
        <>
          {canPay ? <PayerPanel taskId={taskId} token={token} view={view} onChanged={load} /> : (
            <section className="card stack"><h2>Chosen: {sel.title}</h2><p className="small">From {sel.seller}</p></section>
          )}
          {sel.route === "external" && extOffer?.url && (
            <a className="small" href={extOffer.url} target="_blank" rel="noopener noreferrer">See the listing at the store</a>
          )}
          <ShareMenu taskId={taskId} token={token} roles={roles} stage={stage} />
          {chooseOn && cards && <details className="card more"><summary>Change my choice</summary>{cards}</details>}
          {chatBar}
        </>
      )}

      {stage === "track" && (
        <>
          {view.fulfilment ? (
            <StatusTimeline taskId={taskId} token={token} f={view.fulfilment} onChanged={load}
              extra={canPay ? <TopupPay taskId={taskId} token={token} view={view} /> : null} />
          ) : null}
          {view.receipt && (
            <details className="card more receipt" open={!view.fulfilment}>
              <summary>Receipt · {formatMoney(view.receipt.totalMinor, view.receipt.currency)} paid</summary>
              <dl className="facts">
                <dt>Seller</dt><dd>{view.receipt.seller}</dd>
                <dt>Item</dt><dd>{view.receipt.title}</dd>
                <dt>Total paid</dt><dd><strong>{formatMoney(view.receipt.totalMinor, view.receipt.currency)}</strong></dd>
                {!!view.receipt.refundedMinor && (<><dt>Refunded</dt><dd>{formatMoney(view.receipt.refundedMinor, view.receipt.currency)}</dd></>)}
                {!!view.receipt.refundPendingMinor && (<><dt>Refund pending</dt><dd>{formatMoney(view.receipt.refundPendingMinor, view.receipt.currency)}</dd></>)}
              </dl>
              <p className="muted small">PayPal Sandbox payment.</p>
            </details>
          )}
          {chatBar}
        </>
      )}

      <p className="muted small">Demo: this chat runs in your browser. Payments use PayPal Sandbox.</p>
    </main>
  );
}

function mergeMsgs(old: ChatMessage[], next: ChatMessage[]) {
  const map = new Map(old.map((m) => [m.id, m]));
  next.forEach((m) => map.set(m.id, m));
  return [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
