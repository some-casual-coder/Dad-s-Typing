"use client";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { api, ApiError } from "@/lib/api";
import {
  initialVoice, pickRecorderMime, VOICE_MAX_BYTES, VOICE_MAX_SECONDS, VOICE_MESSAGES, voiceReducer,
} from "@/lib/voice";

interface Props {
  taskId: string;
  token: string;
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

const CLIENT_TIMEOUT_MS = 30_000;
const btn = "btn secondary";

export function VoiceRecorder({ taskId, token, onTranscript, disabled }: Props) {
  const [s, dispatch] = useReducer(voiceReducer, initialVoice);
  const seq = useRef(0);
  const stream = useRef<MediaStream | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const held = useRef<Blob | null>(null);
  const abort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const supported = typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== "undefined" && window.isSecureContext;

  useEffect(() => { seq.current = s.seq; }, [s.seq]);

  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (rec.current && rec.current.state !== "inactive") {
      rec.current.ondataavailable = null;
      rec.current.onstop = null;
      try { rec.current.stop(); } catch { /* already stopped */ }
    }
    rec.current = null;
  }, []);

  const transcribe = useCallback(async (mySeq: number) => {
    const blob = held.current;
    if (!blob) return dispatch({ type: "failed", seq: mySeq, error: "failed" });
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    const timeout = setTimeout(() => ctl.abort(), CLIENT_TIMEOUT_MS);
    try {
      const r = await api.transcribe(taskId, token, blob, ctl.signal);
      if (!ctl.signal.aborted) { held.current = null; dispatch({ type: "result", seq: mySeq, text: r.text }); }
    } catch (e) {
      if (ctl.signal.aborted && abort.current !== ctl) return;
      const error = ctl.signal.aborted || (e instanceof ApiError && e.status === 504) ? "timeout"
        : e instanceof ApiError && e.status === 413 ? "too_long" : "failed";
      dispatch({ type: "failed", seq: mySeq, error });
    } finally { clearTimeout(timeout); }
  }, [taskId, token]);

  const start = async () => {
    if (!supported) return dispatch({ type: "unsupported" });
    dispatch({ type: "press" });
    const mine = seq.current + 1;
    held.current = null;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      // cancelled or superseded while the permission prompt was open
      if (seq.current !== mine) return media.getTracks().forEach((t) => t.stop());
      const mime = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
      if (!mime) { media.getTracks().forEach((t) => t.stop()); return dispatch({ type: "unsupported" }); }
      const mr = new MediaRecorder(media, { mimeType: mime });
      stream.current = media;
      rec.current = mr;
      chunks.current = [];
      mr.ondataavailable = (ev) => { if (ev.data.size) chunks.current.push(ev.data); };
      mr.onstop = () => {
        const blob = new Blob(chunks.current, { type: mr.mimeType || mime });
        chunks.current = [];
        release();
        if (seq.current !== mine) return;
        if (blob.size > VOICE_MAX_BYTES) return dispatch({ type: "failed", seq: mine, error: "too_long" });
        held.current = blob;
        void transcribe(mine);
      };
      mr.start();
      dispatch({ type: "granted", seq: mine });
      timer.current = setInterval(() => dispatch({ type: "tick" }), 1000);
    } catch {
      dispatch({ type: "denied", seq: mine });
    }
  };

  const stop = () => {
    if (s.phase !== "recording") return;
    dispatch({ type: "stop" });
    rec.current?.stop();
  };

  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    held.current = null;
    chunks.current = [];
    release();
    dispatch({ type: "cancel" });
  };

  useEffect(() => {
    if (s.phase === "recording" && s.secondsLeft === 0) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s]);

  useEffect(() => () => { abort.current?.abort(); release(); }, [release]);

  const retry = () => {
    if (s.phase === "error" && (s.error === "timeout" || s.error === "failed") && held.current) {
      dispatch({ type: "retry" });
      void transcribe(s.seq + 1);
    } else void start();
  };

  const use = () => {
    const text = s.phase === "review" ? s.text.trim() : "";
    if (text) onTranscript(text);
    cancel();
  };

  const status =
    s.phase === "recording" ? `Recording, ${s.secondsLeft} seconds left`
    : s.phase === "requesting" ? "Waiting for microphone permission"
    : s.phase === "transcribing" ? "Transcribing"
    : s.phase === "review" ? "Transcript ready to review"
    : s.phase === "error" ? VOICE_MESSAGES[s.error] : "";

  return (
    <div className="stack">
      <p role="status" aria-live="polite" className={s.phase === "idle" ? "sr-only" : "small"}>{status}</p>
      {(s.phase === "idle" || s.phase === "requesting") && (
        <button type="button" className={btn} onClick={start} disabled={disabled || s.phase === "requesting"}>
          Speak ({VOICE_MAX_SECONDS}s max)
        </button>
      )}
      {(s.phase === "recording" || s.phase === "requesting" || s.phase === "transcribing") && (
        <div className="row">
          {s.phase === "recording" && <button type="button" className={btn} onClick={stop} autoFocus>Stop</button>}
          <button type="button" className={btn} onClick={cancel}>Cancel</button>
        </div>
      )}
      {s.phase === "error" && (
        <div className="row">
          {s.error !== "unsupported" && <button type="button" className={btn} onClick={retry}>Try again</button>}
          <button type="button" className={btn} onClick={cancel}>Dismiss</button>
        </div>
      )}
      {s.phase === "review" && (
        <div className="stack">
          <label className="small" htmlFor="voice-transcript">Check what we heard, edit if needed</label>
          <textarea
            id="voice-transcript" rows={2} maxLength={2000}
            value={s.text} onChange={(e) => dispatch({ type: "edit", text: e.target.value })}
          />
          <div className="row">
            <button type="button" className={btn} onClick={use} disabled={!s.text.trim()}>Use this text</button>
            <button type="button" className={btn} onClick={start}>Record again</button>
            <button type="button" className={btn} onClick={cancel}>Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}
