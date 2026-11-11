import { channel3FromEnv } from "./channel3";
import { geminiFromEnv } from "./gemini";
import { openRouterFromEnv } from "./openrouter";
import { paypalFromEnv } from "./paypal";
import { transcriberFromEnv } from "./stt";
import type { Discovery, Interpreter, Payments, Transcriber } from "./types";

const g = globalThis as unknown as { __dtAdapters?: { i?: Interpreter; d?: Discovery; p?: Payments; t?: Transcriber } };
const cache = () => (g.__dtAdapters ??= {});

export const getInterpreter = () =>
  (cache().i ??= process.env.INTERPRETER_PROVIDER === "openrouter" ? openRouterFromEnv() : geminiFromEnv());
export const getDiscovery = () => (cache().d ??= channel3FromEnv());
export const getPayments = () => (cache().p ??= paypalFromEnv());
export const getTranscriber = () => (cache().t ??= transcriberFromEnv());
