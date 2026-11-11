"use client";
import { useEffect, useRef, useState } from "react";
import { api, type ChatMessage, type Proposal } from "@/lib/api";
import { newId, requirementLabel } from "@/lib/format";
import PhotoPicker from "./PhotoPicker";
import { ReadAloud } from "./ReadAloud";
import { VoiceRecorder } from "./VoiceRecorder";

interface Props {
  taskId: string;
  token: string;
  messages: ChatMessage[];
  canSend: boolean;
  canConfirm: boolean;
  onChanged: () => void;
  onSent: (m: ChatMessage[]) => void;
}

const readBase64 = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1] ?? "");
  r.onerror = () => rej(new Error("Could not read the photo."));
  r.readAsDataURL(f);
});

export default function Chat({ taskId, token, messages, canSend, canConfirm, onChanged, onSent }: Props) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [clarification, setClarification] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [info, setInfo] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState({ value: "", essential: true });
  const clientId = useRef(newId());
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = [text.trim(), file && alt.trim() ? `(Photo: ${alt.trim()})` : ""].filter(Boolean).join(" ");
    if (!body && !file) return;
    setBusy(true); setErr(""); setInfo("");
    try {
      const r = await api.sendMessage(taskId, token, {
        clientMessageId: clientId.current,
        text: body || undefined,
        ...(file ? { imageBase64: await readBase64(file), mime: file.type } : {}),
      });
      clientId.current = newId();
      setText(""); setFile(null); setAlt("");
      onSent(r.messages ?? []);
      setClarification(r.clarification ?? null);
      setProposals(r.proposals ?? []);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send. Your message is still here; try again.");
    } finally { setBusy(false); }
  }

  async function confirm(i: number, p: Proposal, override?: { value: string; essential: boolean }) {
    setBusy(true); setErr(""); setInfo("");
    try {
      const value = override ? (p.op === "eq" || p.op === "neq" || Number.isNaN(Number(override.value)) ? override.value : Number(override.value)) : p.value;
      const r = await api.setRequirement(taskId, token, {
        key: p.key, op: p.op, value, unit: p.unit, essential: override?.essential ?? p.essential,
      });
      if (r.status !== "confirmed" && canConfirm) await api.confirmRequirement(taskId, token, r.requirementId);
      setInfo(r.status === "confirmed" || canConfirm ? "Saved. Options were rechecked." : "Sent. Mum needs to confirm it.");
      setProposals((x) => x.filter((_, j) => j !== i));
      setEditing(null);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save that.");
    } finally { setBusy(false); }
  }

  return (
    <section className="card stack" aria-labelledby="chat-h">
      <h2 id="chat-h">Chat</h2>
      <p className="muted small">Chat simulated in your browser. This is not WhatsApp.</p>

      <ol className="messages" ref={listRef} aria-label="Messages">
        {messages.length === 0 && <li className="muted">No messages yet. Say what you are looking for.</li>}
        {messages.map((m) => (
          <li key={m.id} className={`msg ${m.role}`}>
            <span className="who">{m.role === "assistant" ? "Assistant" : m.author}</span>
            <p>{m.body}{m.hasImage && <span className="muted"> (photo attached)</span>}</p>
            {m.role === "assistant" && <ReadAloud text={m.body} />}
          </li>
        ))}
      </ol>

      {clarification && <div className="note" role="status"><strong>A question</strong><p>{clarification}</p></div>}

      {proposals.map((p, i) => (
        <div key={`${p.key}-${i}`} className="proposal" role="group" aria-label="Proposed requirement">
          <p>I understood: <strong>{requirementLabel(p)}</strong> ({p.essential ? "essential" : "preference"})</p>
          {p.quote && <p className="muted small">From: &quot;{p.quote}&quot;</p>}
          {editing === i ? (
            <div className="stack">
              <label className="field"><span>Value</span>
                <input name="value" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} /></label>
              <label className="check"><input type="checkbox" checked={draft.essential}
                onChange={(e) => setDraft({ ...draft, essential: e.target.checked })} /> Essential (must have)</label>
              <div className="row">
                <button className="btn" disabled={busy || !draft.value.trim()} onClick={() => confirm(i, p, draft)}>Save change</button>
                <button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => confirm(i, p)}>Confirm</button>
              <button className="btn secondary" disabled={busy}
                onClick={() => { setEditing(i); setDraft({ value: String(p.value), essential: p.essential }); }}>Change</button>
            </div>
          )}
        </div>
      ))}

      {canSend ? (
        <form onSubmit={send} className="stack">
          <label className="field"><span>Your message</span>
            <textarea name="message" value={text} onChange={(e) => setText(e.target.value)} rows={3}
              placeholder="e.g. It must open from the top. Delivery to Nairobi." /></label>
          <div className="stack">
            <PhotoPicker file={file} alt={alt} disabled={busy} onFile={setFile} onAlt={setAlt} onError={setErr} />
            <VoiceRecorder taskId={taskId} token={token} disabled={busy}
              onTranscript={(t) => setText((old) => (old.trim() ? `${old.trim()} ${t}` : t))} />
            <div className="row actions-row">
              <button className="btn" type="submit" disabled={busy || (!text.trim() && !file)}>
                {busy ? "Sending..." : "Send"}
              </button>
            </div>
          </div>
        </form>
      ) : <p className="muted">Your link does not allow sending messages.</p>}
      <p role="status" aria-live="polite" className="muted">{info}</p>
      <p role="alert" className="error">{err}</p>
    </section>
  );
}
