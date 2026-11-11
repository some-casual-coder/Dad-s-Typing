"use client";
import { useEffect, useState, useSyncExternalStore } from "react";

const btn = "btn secondary";

const canSpeak = () => "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

export function ReadAloud({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);
  const ok = useSyncExternalStore(() => () => {}, canSpeak, () => false);

  useEffect(() => {
    return () => { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); };
  }, []);

  if (!ok || !text.trim()) return null;

  const speak = () => {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.onend = u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(u);
  };
  const stop = () => { window.speechSynthesis.cancel(); setSpeaking(false); };

  return (
    <span className="row">
      <button type="button" className={btn} onClick={speak}>{speaking ? "Repeat" : "Read aloud"}</button>
      {speaking && <button type="button" className={btn} onClick={stop}>Stop</button>}
    </span>
  );
}
