"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import ShareInvite from "@/components/ShareInvite";
import PhotoPicker from "@/components/PhotoPicker";
import { api, storeToken } from "@/lib/api";
import { newId, type Role } from "@/lib/format";

export default function Home() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [created, setCreated] = useState<{ taskId: string; token: string } | null>(null);

  const [photo, setPhoto] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  const [note, setNote] = useState("");
  const task = useRef<{ taskId: string; token: string } | null>(null);
  const msgId = useRef("");

  // Task is created once; a failed send retries into it with the same id
  async function startWithPhoto() {
    if (!photo) return;
    setBusy(true); setErr("");
    try {
      if (!task.current) {
        const r = await api.createTask({ title: title.trim() || "Something for Mum", starterRoles: ["helper", "payer"] });
        storeToken(r.taskId, r.token);
        task.current = r;
      }
      const b64 = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(",")[1] ?? "");
        fr.onerror = () => rej(new Error("Could not read the photo."));
        fr.readAsDataURL(photo);
      });
      const body = [note.trim(), alt.trim() ? `(Photo: ${alt.trim()})` : ""].filter(Boolean).join(" ");
      await api.sendMessage(task.current.taskId, task.current.token, {
        clientMessageId: msgId.current || (msgId.current = newId()), text: body || undefined, imageBase64: b64, mime: photo.type,
      });
      router.push(`/t/${task.current.taskId}`);
    } catch (e) {
      setErr((e instanceof Error ? e.message : "Could not send the photo.") + " You can try again, or type instead.");
      setBusy(false);
    }
  }

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
            <div className="stack photo-start" role="group" aria-label="Start from a photo">
              <PhotoPicker file={photo} alt={alt} disabled={busy} label="Upload photo"
                onFile={(f) => { setPhoto(f); msgId.current = ""; }} onAlt={setAlt} onError={setErr} />
              {photo && (
                <>
                  <label className="field"><span>Add a note (optional)</span>
                    <input name="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
                      placeholder="e.g. Mum wants one like this" /></label>
                  <button className="btn" disabled={busy} onClick={startWithPhoto}>
                    {busy ? "Sending photo..." : "Start with this photo"}
                  </button>
                </>
              )}
            </div>
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
