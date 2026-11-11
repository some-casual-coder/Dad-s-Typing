import { DomainError } from "@/domain/errors";

export interface ChannelDef {
  id: string;
  label: string;
  // shape of the stable sender id the connector reports
  sender: RegExp;
  maxReplyChars: number;
  images: boolean;
}

const PHONE = /^\d{6,15}$/;

// Adding a channel is one entry here plus its secret and allowlist in the env
const CHANNELS: Record<string, Omit<ChannelDef, "id">> = {
  whatsapp: { label: "WhatsApp", sender: PHONE, maxReplyChars: 3000, images: true },
  sms: { label: "SMS", sender: PHONE, maxReplyChars: 480, images: false },
  telegram: { label: "Telegram", sender: /^\d{1,20}$/, maxReplyChars: 3500, images: true },
  messenger: { label: "Messenger", sender: /^\d{5,30}$/, maxReplyChars: 1800, images: true },
  instagram: { label: "Instagram", sender: /^\d{5,30}$/, maxReplyChars: 900, images: true },
  email: { label: "Email", sender: /^[^\s@]{1,64}@[^\s@]{1,255}$/, maxReplyChars: 5000, images: true },
  webchat: { label: "Web chat", sender: /^[A-Za-z0-9_-]{8,64}$/, maxReplyChars: 3000, images: true },
};

export function getChannel(id: string): ChannelDef {
  const def = Object.hasOwn(CHANNELS, id) ? CHANNELS[id] : undefined;
  if (!def) throw new DomainError("not_found", "Unknown channel");
  return { id, ...def };
}

export const channelIds = () => Object.keys(CHANNELS);

const envName = (id: string, what: "SECRET" | "ALLOWED") => `CHANNEL_${id.toUpperCase()}_${what}`;

// WhatsApp keeps its original variable names as a fallback
const LEGACY: Record<string, { SECRET: string; ALLOWED: string }> = {
  whatsapp: { SECRET: "WHATSAPP_BRIDGE_SECRET", ALLOWED: "WHATSAPP_ALLOWED_SENDERS" },
};

const read = (id: string, what: "SECRET" | "ALLOWED", env: NodeJS.ProcessEnv) =>
  env[envName(id, what)] ?? env[LEGACY[id]?.[what] ?? ""] ?? "";

export function channelSecret(id: string, env = process.env): string {
  const s = read(id, "SECRET", env);
  if (s.length < 32) throw new DomainError("forbidden", "Channel is not configured");
  return s;
}

export const isConfigured = (id: string, env = process.env) => read(id, "SECRET", env).length >= 32;

// Empty means nobody is allowed: unknown senders are ignored, never answered
export function allowedSenders(id: string, env = process.env): Set<string> {
  const { sender } = getChannel(id);
  return new Set(read(id, "ALLOWED", env).split(",").map((s) => s.trim()).filter((s) => sender.test(s)));
}
