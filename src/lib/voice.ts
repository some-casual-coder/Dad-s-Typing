import type { AudioFormat } from "@/adapters/types";

// Single source of truth for client and route limits
export const VOICE_MAX_SECONDS = 20;
export const VOICE_MAX_BYTES = 2.5 * 1024 * 1024;
export const VOICE_MULTIPART_OVERHEAD = 16 * 1024;

export const CONTAINERS: Record<string, AudioFormat> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
};

// Chrome/Edge/Android: webm/opus; Firefox: ogg/opus; Safari/iOS: mp4/aac
export const RECORDER_PREFERENCE = [
  "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm",
];

export const baseMime = (mime: string) => mime.split(";")[0].trim().toLowerCase();

export function pickRecorderMime(isSupported: (m: string) => boolean): string | null {
  return RECORDER_PREFERENCE.find((m) => {
    try { return isSupported(m); } catch { return false; }
  }) ?? null;
}

const at = (b: Uint8Array, o: number, s: string) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));

// Container sniffing: the declared type alone is not trusted
export function sniffFormat(b: Uint8Array): AudioFormat | null {
  if (b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (b.length > 4 && at(b, 0, "OggS")) return "ogg";
  if (b.length > 12 && at(b, 4, "ftyp")) return "m4a";
  return null;
}

export type VoiceError = "permission" | "unsupported" | "no_speech" | "timeout" | "failed" | "too_long";

export type VoiceState =
  | { phase: "idle"; seq: number }
  | { phase: "requesting"; seq: number }
  | { phase: "recording"; seq: number; secondsLeft: number }
  | { phase: "transcribing"; seq: number }
  | { phase: "review"; seq: number; text: string }
  | { phase: "error"; seq: number; error: VoiceError };

export type VoiceEvent =
  | { type: "press" }
  | { type: "granted"; seq: number }
  | { type: "denied"; seq: number }
  | { type: "unsupported" }
  | { type: "tick" }
  | { type: "stop" }
  | { type: "cancel" }
  | { type: "retry" }
  | { type: "result"; seq: number; text: string }
  | { type: "failed"; seq: number; error: "timeout" | "failed" | "too_long" }
  | { type: "edit"; text: string };

export const initialVoice: VoiceState = { phase: "idle", seq: 0 };

// Every async outcome carries the seq it was started with; stale ones are dropped
export function voiceReducer(s: VoiceState, e: VoiceEvent): VoiceState {
  switch (e.type) {
    case "press":
      return s.phase === "idle" || s.phase === "error" || s.phase === "review"
        ? { phase: "requesting", seq: s.seq + 1 } : s;
    case "unsupported":
      return s.phase === "idle" ? { phase: "error", seq: s.seq, error: "unsupported" } : s;
    case "granted":
      return s.phase === "requesting" && e.seq === s.seq
        ? { phase: "recording", seq: s.seq, secondsLeft: VOICE_MAX_SECONDS } : s;
    case "denied":
      return s.phase === "requesting" && e.seq === s.seq ? { phase: "error", seq: s.seq, error: "permission" } : s;
    case "tick":
      return s.phase === "recording" ? { ...s, secondsLeft: Math.max(s.secondsLeft - 1, 0) } : s;
    case "stop":
      return s.phase === "recording" ? { phase: "transcribing", seq: s.seq } : s;
    case "cancel":
      return s.phase === "idle" ? s : { phase: "idle", seq: s.seq + 1 };
    case "retry":
      // only failures that kept the recording can be resent
      return s.phase === "error" && (s.error === "timeout" || s.error === "failed")
        ? { phase: "transcribing", seq: s.seq + 1 }
        : s.phase === "error" ? { phase: "requesting", seq: s.seq + 1 } : s;
    case "result":
      if (s.phase !== "transcribing" || e.seq !== s.seq) return s;
      return e.text.trim() ? { phase: "review", seq: s.seq, text: e.text }
        : { phase: "error", seq: s.seq, error: "no_speech" };
    case "failed":
      return s.phase === "transcribing" && e.seq === s.seq ? { phase: "error", seq: s.seq, error: e.error } : s;
    case "edit":
      return s.phase === "review" ? { ...s, text: e.text } : s;
  }
}

export const VOICE_MESSAGES: Record<VoiceError, string> = {
  permission: "Microphone access was blocked. Allow it in your browser settings, or type instead.",
  unsupported: "Voice recording isn't available on this device or connection. Please type instead.",
  no_speech: "We didn't catch any speech. Try again, or type instead.",
  timeout: "Transcribing took too long. Retry, or type instead.",
  failed: "Voice isn't working right now. Retry, or type instead.",
  too_long: "That recording was too long. Keep it under 20 seconds.",
};
