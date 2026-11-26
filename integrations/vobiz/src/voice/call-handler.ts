/**
 * Bridges a Vobiz <Stream> WebSocket to an Inworld Realtime WebSocket.
 *
 * Both Vobiz (with contentType="audio/x-mulaw;rate=8000") and Inworld use
 * G.711 μ-law at 8kHz, so audio passes through as-is with no format
 * conversion. We only buffer to ≥50ms chunks.
 */
import WebSocket from "ws";
import { InworldRealtimeClient } from "./inworld-realtime.js";
import { config } from "../config.js";

interface VobizStreamMessage {
  event: "start" | "media" | "playedStream" | "clearedAudio" | "dtmf";
  start?: { streamId: string; callId: string };
  media?: { payload: string };
}

// 50ms of mulaw 8kHz = 400 bytes (8000 samples/sec × 0.05s × 1 byte/sample)
const MIN_CHUNK_BYTES = 400;

// Caller audio held while the Inworld session is being set up: 5 s of mulaw 8kHz.
// Older audio is dropped first if setup takes longer than that.
const MAX_PENDING_BYTES = 8000 * 5;

// Peak level (16-bit PCM) above which an inbound chunk counts as caller voice.
// Only used to time latency from the caller's real end of speech.
const VOICE_PEAK_THRESHOLD = 1000;

function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const magnitude = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - magnitude : magnitude - 0x84;
}

function hasVoice(chunk: Buffer): boolean {
  for (const byte of chunk) {
    if (Math.abs(mulawToLinear(byte)) > VOICE_PEAK_THRESHOLD) return true;
  }
  return false;
}

export function handleCallStream(vobizWs: WebSocket): void {
  let streamId: string | null = null;
  let inworld: InworldRealtimeClient | null = null;
  let outBuffer = Buffer.alloc(0);
  let inBuffer = Buffer.alloc(0);
  // Inworld only understands caller audio once the session config is applied,
  // so audio that arrives earlier (often the callee's "hello") is held here.
  let inworldReady = false;
  let pendingAudio = Buffer.alloc(0);
  let callTimer: NodeJS.Timeout | null = null;
  let agentHasSpoken = false;

  // Latency tracking, relative to the last inbound chunk that contained voice.
  // Inworld's speech_stopped fires only once turn detection commits the turn,
  // so it cannot measure how long turn detection itself took.
  let lastVoiceAt: number | null = null;
  // lastVoiceAt as of the committed turn. The caller may keep talking before the
  // reply starts, so response timings are measured from this snapshot instead.
  let turnVoiceEndAt: number | null = null;
  // Inworld sends audio faster than real time, so a response is often "done"
  // while Vobiz is still playing it. Estimate when playback actually ends.
  let playbackEndsAt = 0;
  let firstAudioLogged = false;
  let responseAudioBytes = 0;

  function elapsedSince(start: number | null): string {
    return start === null ? "n/a" : `+${Date.now() - start}ms`;
  }

  function sendToVobiz(payload: Buffer) {
    if (vobizWs.readyState === WebSocket.OPEN && streamId) {
      // mulaw 8kHz is 1 byte per sample, so bytes / 8 = milliseconds of audio.
      playbackEndsAt = Math.max(playbackEndsAt, Date.now()) + payload.length / 8;
      // playAudio carries only event and media; Vobiz plays it on this stream.
      vobizWs.send(
        JSON.stringify({
          event: "playAudio",
          media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: payload.toString("base64") },
        })
      );
    }
  }

  function flushOutBuffer() {
    while (outBuffer.length >= MIN_CHUNK_BYTES) {
      sendToVobiz(outBuffer.subarray(0, MIN_CHUNK_BYTES));
      outBuffer = outBuffer.subarray(MIN_CHUNK_BYTES);
    }
  }

  // Sends caller audio to Inworld in ≥50ms chunks.
  function forwardCallerAudio(audio: Buffer) {
    if (!inworld) return;
    inBuffer = Buffer.concat([inBuffer, audio]);
    while (inBuffer.length >= MIN_CHUNK_BYTES) {
      const chunk = inBuffer.subarray(0, MIN_CHUNK_BYTES);
      inworld.sendAudio(chunk.toString("base64"));
      inBuffer = inBuffer.subarray(MIN_CHUNK_BYTES);
    }
  }

  // Stopping the stream ends the call, because there is no XML after <Stream>.
  function endCall(reason: string) {
    if (vobizWs.readyState === WebSocket.OPEN && streamId) {
      console.log(`[call] ${reason}, ending the call`);
      vobizWs.send(JSON.stringify({ event: "stop", streamId }));
    }
  }

  vobizWs.on("message", async (data: Buffer) => {
    let msg: VobizStreamMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    switch (msg.event) {
      case "start":
        // One Inworld session per stream, even if Vobiz repeats the start event.
        if (inworld || typeof msg.start?.streamId !== "string") break;
        streamId = msg.start.streamId;
        console.log(`[call] Stream started (call: ${msg.start.callId})`);

        callTimer = setTimeout(
          () => endCall(`Reached MAX_CALL_SECONDS (${config.maxCallSeconds}s)`),
          config.maxCallSeconds * 1000
        );

        inworld = new InworldRealtimeClient();

        inworld.on("ready", () => {
          inworldReady = true;
          if (pendingAudio.length > 0) {
            console.log(`[call] Sending ${pendingAudio.length / 8}ms of caller audio received during setup`);
            forwardCallerAudio(pendingAudio);
            pendingAudio = Buffer.alloc(0);
          }
        });

        inworld.on("audio", (base64Audio) => {
          const audio = Buffer.from(base64Audio, "base64");
          agentHasSpoken = true;
          if (!firstAudioLogged) {
            firstAudioLogged = true;
            console.log(`[latency] First bot audio: ${elapsedSince(turnVoiceEndAt)} after caller stopped talking`);
          }
          responseAudioBytes += audio.length;
          outBuffer = Buffer.concat([outBuffer, audio]);
          flushOutBuffer();
        });

        inworld.on("audioDone", () => {
          if (outBuffer.length > 0) {
            sendToVobiz(outBuffer);
            outBuffer = Buffer.alloc(0);
          }
        });

        // Barge-in: stop local playback. Inworld cancels the in-flight response
        // itself because the session sets turn_detection.interrupt_response.
        inworld.on("speechStarted", () => {
          const unplayedMs = Math.round(playbackEndsAt - Date.now());
          if (unplayedMs > 0) {
            console.log(`[call] Caller interrupted the bot, clearing ~${unplayedMs}ms of unplayed audio`);
          }
          playbackEndsAt = 0;
          outBuffer = Buffer.alloc(0);
          if (vobizWs.readyState === WebSocket.OPEN && streamId) {
            vobizWs.send(JSON.stringify({ event: "clearAudio", streamId }));
          }
        });

        inworld.on("speechStopped", () => {
          turnVoiceEndAt = lastVoiceAt;
          console.log(`[latency] Turn end detected: ${elapsedSince(turnVoiceEndAt)} after caller stopped talking`);
        });

        inworld.on("transcript", (text) => console.log(`[call] User: ${text}`));

        inworld.on("responseCreated", (responseId) => {
          firstAudioLogged = false;
          responseAudioBytes = 0;
          console.log(`[latency] Response ${responseId} created: ${elapsedSince(turnVoiceEndAt)} after caller stopped talking`);
        });

        inworld.on("responseDone", (responseId, status, transcript) => {
          const audioMs = Math.round(responseAudioBytes / 8);
          console.log(`[call] Bot (${status}, ${audioMs}ms audio, response ${responseId}): ${transcript}`);
        });

        inworld.on("error", (err) => {
          console.error(`[call] Inworld error: ${err.message}`);
          // An error before the agent has said anything means the session could not be set up
          // (for example a model not on your plan or an unknown voice), so end the call.
          if (!agentHasSpoken) endCall("Inworld session failed");
        });
        // Without Inworld the caller would hear silence, so end the call.
        inworld.on("closed", () => {
          console.log("[call] Inworld closed");
          endCall("Inworld session closed");
        });

        try {
          await inworld.connect(config.systemPrompt);
        } catch (err) {
          console.error("[call] Failed to connect to Inworld:", err);
          endCall("Could not connect to Inworld");
        }
        break;

      case "media":
        if (inworld && typeof msg.media?.payload === "string") {
          const audio = Buffer.from(msg.media.payload, "base64");
          if (hasVoice(audio)) lastVoiceAt = Date.now();
          if (inworldReady) {
            forwardCallerAudio(audio);
          } else {
            pendingAudio = Buffer.concat([pendingAudio, audio]);
            if (pendingAudio.length > MAX_PENDING_BYTES) {
              pendingAudio = pendingAudio.subarray(pendingAudio.length - MAX_PENDING_BYTES);
            }
          }
        }
        break;
    }
  });

  function cleanup() {
    if (callTimer) clearTimeout(callTimer);
    callTimer = null;
    inworld?.close();
    inworld = null;
    pendingAudio = Buffer.alloc(0);
  }

  // Without a listener, a socket error would be thrown and crash the process,
  // ending every other call on this server. ws emits close after error.
  vobizWs.on("error", (err) => {
    console.error(`[call] Stream error: ${err.message}`);
    cleanup();
  });

  // Vobiz sends no stop event: the WebSocket closing is the end of the call.
  vobizWs.on("close", () => {
    console.log("[call] Stream closed");
    cleanup();
  });
}
