"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { inviteLink, type Role } from "@/lib/format";

interface Props {
  taskId: string;
  token: string;
  roles: Role[];
  label: string;
  buttonText: string;
  hint?: string;
}

// Creates an invite only when the user taps; shows a copyable link
export default function ShareInvite({ taskId, token, roles, label, buttonText, hint }: Props) {
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function create() {
    setBusy(true); setMsg("");
    try {
      const r = await api.createInvite(taskId, token, roles, label);
      setLink(inviteLink(window.location.origin, taskId, r.token));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not create the link.");
    } finally { setBusy(false); }
  }

  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setMsg("Link copied."); }
    catch { setMsg("Press and hold the link to copy it."); }
  }

  async function share() {
    if (!link) return;
    try { await navigator.share({ title: label, url: link }); }
    catch { /* cancelled */ }
  }

  return (
    <div className="stack">
      {hint && <p className="muted">{hint}</p>}
      {!link && (
        <button className="btn secondary small-btn" onClick={create} disabled={busy}>
          {busy ? "Making link..." : buttonText}
        </button>
      )}
      {link && (
        <div className="stack">
          <label className="field">
            <span>Link to send</span>
            <input name="link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <div className="row">
            <button className="btn" onClick={copy}>Copy link</button>
            {typeof navigator !== "undefined" && "share" in navigator && (
              <button className="btn secondary" onClick={share}>Share</button>
            )}
          </div>
          <p className="muted">Anyone with this link gets these permissions. Send it only to them.</p>
        </div>
      )}
      <p role="status" aria-live="polite" className="muted">{msg}</p>
    </div>
  );
}
