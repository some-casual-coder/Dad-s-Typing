"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Candidate, type SharedSource } from "@/lib/api";
import { newId } from "@/lib/format";

// What each state means to the shopper; never claims a video was watched
const STATUS: Record<string, string> = {
  checking: "Checking what I can see in this post...",
  preview_only: "I can't read the video from a link. Add a screenshot of the item or describe it.",
  resolved: "Here's what the video check found. Pick the item you mean.",
  needs_input: "I couldn't tell the item from this post. Add a screenshot or describe it.",
  retryable_error: "I couldn't check the post just now. Try again, or add a screenshot.",
  unavailable: "I can't open that post here. Add a screenshot of the item or describe it.",
  unsupported: "That link doesn't point to a post I can use. Add a screenshot or describe the item.",
};
const REASON: Record<string, string> = {
  secondary_source: "Links from this site are opened, not analysed.", story: "Stories can't be read.", not_a_post: "It looks like a profile, not a post.",
  check_unconfirmed: "The check may not have started.", timed_out: "The check took too long.", no_product: "No product was found in it.",
  not_the_item: "You said it's something else.", restricted: "The post is restricted.", not_found_or_private: "It may be private or deleted.",
};
const BADGE: Record<string, string> = {
  user_text: "Your words", user_image: "Screenshot you added", provider_visual: "Video check (seen)", provider_spoken: "Video check (heard)",
  authorized_frame: "Frames from your clip", permitted_caption: "Caption",
};
const ORIGIN: Record<string, string> = { provider_generated_observation: "From a video check of the link, not verified", shopper_upload_frames: "From frames of the clip you uploaded" };

const readFile = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1] ?? "");
  r.onerror = () => rej(new Error("Could not read the file."));
  r.readAsDataURL(f);
});

function Candidates({ list, busy, onChoose }: { list: Candidate[]; busy: boolean; onChoose: (id: string) => void }) {
  const live = list.filter((c) => c.status !== "late");
  const late = list.filter((c) => c.status === "late");
  const card = (c: Candidate) => (
    <li key={c.id} className="cand">
      <p><strong>{[c.brand, c.model, c.label].filter(Boolean).join(" ")}</strong>{c.status === "chosen" && <span className="badge eligible"> Chosen</span>}</p>
      {c.attributes.length > 0 && <p className="small">{c.attributes.join(", ")}</p>}
      <p className="small muted">Why I think this is it: {c.basis.map((b) => `${b.observation}${b.at !== null ? ` (around ${b.at}s)` : ""}`).join(" ")} {ORIGIN[c.provenance]}.</p>
      {c.uncertain.length > 0 && <p className="small">Not sure about: {c.uncertain.join("; ")}</p>}
      {c.status !== "chosen" && <button className="btn small-btn" disabled={busy} onClick={() => onChoose(c.id)}>Find this item</button>}
    </li>
  );
  return (
    <>
      {live.length > 0 && <ul className="cands">{live.map(card)}</ul>}
      {late.length > 0 && <details className="more"><summary>Found later ({late.length})</summary><ul className="cands">{late.map(card)}</ul></details>}
    </>
  );
}

export default function SharedSources({ taskId, token, canEdit, refreshKey, onChanged, compact = false }: { taskId: string; token: string; canEdit: boolean; refreshKey: number; onChanged: () => void; compact?: boolean }) {
  const [data, setData] = useState<{ sources: SharedSource[]; uploads: Candidate[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [desc, setDesc] = useState("");
  const load = useCallback(async () => { try { setData(await api.getSources(taskId, token)); } catch { /* the task view still works */ } }, [taskId, token]);
  useEffect(() => { void (async () => { await load(); })(); }, [load, refreshKey]);
  useEffect(() => {
    if (!data?.sources.some((s) => s.status === "checking")) return;
    const t = setTimeout(() => { void load(); }, 4000);
    return () => clearTimeout(t);
  }, [data, load]);

  const act = async (fn: () => Promise<unknown>, done = "") => {
    setBusy(true); setMsg("");
    try { await fn(); setMsg(done); await load(); onChanged(); } catch (e) { setMsg(e instanceof ApiError || e instanceof Error ? e.message : "That didn't work."); } finally { setBusy(false); }
  };
  if (!data || (!data.sources.length && !data.uploads.length)) return canEdit && !compact ? <ClipOnly taskId={taskId} token={token} onDone={() => { void load(); onChanged(); }} /> : null;

  const screenshot = (f: File) => act(async () => api.sendMessage(taskId, token, { clientMessageId: newId(), imageBase64: await readFile(f), mime: f.type }),
    "Screenshot added to this task.");
  const describe = () => desc.trim() && act(async () => { await api.sendMessage(taskId, token, { clientMessageId: newId(), text: desc.trim() }); setDesc(""); }, "Added to this task.");
  const clip = (f: File) => act(async () => {
    const r = await api.uploadClip(taskId, token, { videoBase64: await readFile(f), mime: f.type });
    if (!r.products) throw new Error(r.noProductReason ?? "No product found in the clip; add a screenshot or describe it.");
  }, "Clip checked.");

  const body = (
    <>
      {data.sources.map((s) => (
        <div key={s.id} className="stack source">
          <p><span className="tag">{s.label}</span> <a href={s.openUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open original</a></p>
          <p role="status">{STATUS[s.status] ?? s.status}{s.reason && REASON[s.reason] ? ` ${REASON[s.reason]}` : ""}</p>
          {s.evidence.length > 0 && <p className="small">{s.evidence.map((e) => <span key={e} className="tag">{BADGE[e] ?? e}</span>)}</p>}
          <Candidates list={s.candidates} busy={busy || !canEdit} onChoose={(id) => act(() => api.chooseCandidate(taskId, token, id), "Searching for that item.")} />
          {canEdit && s.candidates.some((c) => c.status === "proposed") && (
            <button className="btn secondary small-btn" disabled={busy} onClick={() => act(() => api.sourceAction(taskId, token, s.id, "something_else"))}>Something else</button>)}
          {canEdit && s.status === "retryable_error" && <button className="btn secondary small-btn" disabled={busy} onClick={() => act(() => api.sourceAction(taskId, token, s.id, "retry"))}>Try again</button>}
        </div>
      ))}
      {data.uploads.length > 0 && <Candidates list={data.uploads} busy={busy || !canEdit} onChoose={(id) => act(() => api.chooseCandidate(taskId, token, id), "Searching for that item.")} />}
      {canEdit && (
        <div className="stack">
          <div className="row">
            <label className="btn small-btn">Add screenshot<input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void screenshot(f); }} /></label>
            <label className="btn secondary small-btn">Add a short clip<input type="file" accept="video/mp4,video/quicktime,video/webm" hidden disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void clip(f); }} /></label>
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void describe(); }}>
            <label className="field"><span>Describe the item</span><input value={desc} maxLength={300} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. the folding table at 0:16, not the chair" /></label>
            <button className="btn secondary" type="submit" disabled={busy || !desc.trim()}>Add</button>
          </form>
        </div>
      )}
      {msg && <p role="status" className="small">{msg}</p>}
    </>
  );
  // Once the item is known the source shrinks to one line
  if (compact) {
    const first = data.sources[0];
    return (
      <details className="card more">
        <summary>{first ? `From your ${first.label} post` : "From your clip"} · Change item</summary>
        <div className="stack" aria-live="polite">{body}</div>
      </details>
    );
  }
  return (
    <section className="card stack" aria-labelledby="src-h" aria-live="polite">
      <h2 id="src-h">Which item?</h2>
      {body}
    </section>
  );
}

// No link on the task: the clip upload is still offered on its own
function ClipOnly({ taskId, token, onDone }: { taskId: string; token: string; onDone: () => void }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack small">
      <label className="btn secondary small-btn">{busy ? "Checking the clip..." : "Have a short video of it? Add a clip"}
        <input type="file" accept="video/mp4,video/quicktime,video/webm" hidden disabled={busy} onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
          setBusy(true); setMsg("");
          try {
            const r = await api.uploadClip(taskId, token, { videoBase64: await readFile(f), mime: f.type });
            setMsg(r.products ? "Clip checked. Pick the item below." : r.noProductReason ?? "No product found."); onDone();
          } catch (err) { setMsg(err instanceof Error ? err.message : "That didn't work."); } finally { setBusy(false); }
        }} /></label>
      {msg && <p role="status">{msg}</p>}
    </div>
  );
}
