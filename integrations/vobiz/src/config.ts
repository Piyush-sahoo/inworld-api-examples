import "dotenv/config";
import { randomBytes, timingSafeEqual } from "node:crypto";

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const val = Number(raw);
  // setTimeout fires at once for delays above ~24.8 days, so cap at 24 hours.
  if (!Number.isInteger(val) || val <= 0 || val > 86400) {
    throw new Error(`${name} must be a whole number of seconds between 1 and 86400`);
  }
  return val;
}

export const config = {
  inworldApiKey: required("INWORLD_API_KEY"),

  port: parseInt(optional("PORT", "3000"), 10),
  serverUrl: required("SERVER_URL"),

  // Secret path segment in the answer, hangup and media-stream URLs, so only Vobiz
  // (which gets the URLs from your application settings) can start a session.
  // Set it in .env to keep the URLs the same between restarts.
  pathToken: optional("PATH_TOKEN", randomBytes(16).toString("hex")),

  // The agent ends any call that reaches this many seconds.
  maxCallSeconds: positiveInt("MAX_CALL_SECONDS", 600),

  // An Inworld-hosted model ("inworld/models/<model>"), a third-party "provider/model"
  // (e.g. openai/gpt-4.1-mini), or an Inworld Router as "inworld/<routerId>".
  llmModel: optional("LLM_MODEL", "inworld/models/deepseek-v4.1-flash"),

  // Voice and speech models. Browse voices in the Inworld TTS Playground.
  voice: optional("INWORLD_VOICE", "Sarah"),
  ttsModel: optional("TTS_MODEL", "inworld-tts-2"),
  sttModel: optional("STT_MODEL", "inworld/inworld-stt-1"),

  systemPrompt: optional(
    "SYSTEM_PROMPT",
    "You are a friendly voice assistant powered by Inworld, talking with a caller on the phone. Keep every reply to one or two short sentences. Your replies are spoken aloud, so never use bullet points, numbered lists, markdown, emoji, or symbols. When naming several things, say them in one natural sentence, and say numbers and units the way you would read them aloud. If the caller asks for something long, like a story, a list, or an explanation, give a short version in a few sentences and offer to continue. If the caller repeats a question, answer it again politely. If you did not catch what the caller said, briefly ask them to repeat it."
  ),
} as const;

/** Constant-time check of a path segment against PATH_TOKEN. */
export function isPathToken(value: unknown): boolean {
  const expected = Buffer.from(config.pathToken);
  const actual = Buffer.from(typeof value === "string" ? value : "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
