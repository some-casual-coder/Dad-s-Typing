import { channel3FromEnv } from "./channel3";
import { fxFromEnv } from "./fx";
import { geminiFromEnv } from "./gemini";
import { extractorFromEnv, openRouterFromEnv } from "./openrouter";
import { paypalFromEnv } from "./paypal";
import { transcriberFromEnv } from "./stt";
import type { Discovery, Extractor, FxSource, Interpreter, Payments, Transcriber } from "./types";

const g = globalThis as unknown as { __dtAdapters?: { i?: Interpreter; d?: Discovery; p?: Payments; t?: Transcriber; f?: FxSource; x?: Extractor } };
const cache = () => (g.__dtAdapters ??= {});

export const getInterpreter = () =>
  (cache().i ??= process.env.INTERPRETER_PROVIDER === "openrouter" ? openRouterFromEnv() : geminiFromEnv());
export const getDiscovery = () => (cache().d ??= channel3FromEnv());
export const getPayments = () => (cache().p ??= paypalFromEnv());
export const getTranscriber = () => (cache().t ??= transcriberFromEnv());
export const getFx = () => (cache().f ??= fxFromEnv());
export const getExtractor = () => (cache().x ??= extractorFromEnv());
