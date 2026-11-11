"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import ShareInvite from "@/components/ShareInvite";
import { api, storeToken } from "@/lib/api";
import type { Role } from "@/lib/format";

export default function Home() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [created, setCreated] = useState<{ taskId: string; token: string } | null>(null);

  async function start(starterRoles: Role[], forMum: boolean) {
    setBusy(true); setErr("");
    try {
      const r = await api.createTask({ title: title.trim() || "Something for Mum", starterRoles });
      storeToken(r.taskId, r.token);
      if (forMum) setCreated(r);
      else router.push(`/t/${r.taskId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start.");
    } finally { setBusy(false); }
  }

  return (
    <main className="page">
      <header className="hero">
        <p className="eyebrow">Dad&apos;s Typing...</p>
        <h1>Help Mum buy the right thing, together.</h1>
        <p className="lead">
          Describe what is needed or share a photo. We find options that really match, Mum
          chooses herself, and whoever is paying approves it in PayPal. Everyone sees the same
          thing along the way.
        </p>
      </header>

      <section className="card stack" aria-labelledby="start-h">
        <h2 id="start-h">Start a shopping task</h2>
        {!created && (
          <>
            <label className="field">
              <span>What are you looking for?</span>
              <input name="title" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. a cat carrier that opens from the top" maxLength={120} />
            </label>
            <button className="btn" disabled={busy} onClick={() => start(["helper", "payer"], true)}>
              Start for Mum
            </button>
            <button className="btn secondary" disabled={busy} onClick={() => start(["requester", "chooser"], false)}>
              Start as Mum
            </button>
            <p className="muted">
              &quot;Start for Mum&quot; sets you up to help and pay. Then you send her a link.
              &quot;Start as Mum&quot; is for Mum herself.
            </p>
          </>
        )}
        {created && (
          <div className="stack">
            <p className="ok-note">Task started. Next, send it to Mum.</p>
            <ShareInvite taskId={created.taskId} token={created.token} roles={["requester", "chooser"]}
              label="Mum" buttonText="Send to Mum"
              hint="This makes a private link for Mum. She can describe what she wants and choose." />
            <Link className="btn secondary" href={`/t/${created.taskId}`}>Open the task</Link>
          </div>
        )}
        <p role="alert" className="error">{err}</p>
      </section>

      <p className="muted small">
        This is a demo. The chat is simulated in your browser, not WhatsApp. Payments use PayPal
        Sandbox and the shop is a demo catalogue, so no real money moves.
      </p>
    </main>
  );
}
