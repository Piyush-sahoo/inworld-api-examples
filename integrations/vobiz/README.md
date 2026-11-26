# Vobiz + Inworld Realtime Voice Agent

A voice agent that answers and places phone calls on a [Vobiz](https://vobiz.ai/) number, powered by the [Inworld Realtime API](https://docs.inworld.ai/realtime/overview) for speech-to-speech conversations. One WebSocket to Inworld handles STT + LLM + TTS.

```
Caller ↔ Vobiz ↔ WebSocket ↔ Inworld Realtime
             mulaw 8kHz (passthrough)
```

[Vobiz](https://vobiz.ai/) is a cloud telephony platform with phone numbers in India, the US and other regions, controlled through a REST API and VobizXML. Its `<Stream>` element sends live call audio to a WebSocket server and plays audio from that server back into the call, which is how this example connects a phone call to Inworld.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [ngrok](https://ngrok.com/) account (free tier works; it includes one static dev domain)
- [Vobiz](https://vobiz.ai/) account with a phone number
- [Inworld](https://www.inworld.ai/) account

## Setup

1. **Get your Inworld API key** — in the [Inworld Portal](https://portal.inworld.ai/), open your workspace and create an API key. Choose type **Realtime-only** (this example only calls the Realtime API), then copy the **Base64** credential; it is sent as `Authorization: Basic <key>`.

2. **Get a Vobiz phone number** — sign up at [vobiz.ai](https://vobiz.ai/) and buy a phone number with Voice capability in the [Vobiz console](https://console.vobiz.ai/). For outbound calls, also copy your **Auth ID** and **Auth Token** from the console.

3. **Set up ngrok** — [install ngrok](https://ngrok.com/download) (for example `brew install ngrok`), then add your [authtoken](https://dashboard.ngrok.com/get-started/your-authtoken):
   ```bash
   ngrok config add-authtoken <your-authtoken>
   ```
   Free accounts get one static **dev domain**, listed under [Domains](https://dashboard.ngrok.com/domains) (for example `your-name.ngrok-free.dev`). Use it so the Vobiz answer URL stays the same between restarts.

4. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   Fill in `INWORLD_API_KEY`, `SERVER_URL=https://<your-ngrok-domain>` and `PATH_TOKEN` (generate one with `openssl rand -hex 16`). For outbound calls, also fill in `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN` and `VOBIZ_FROM_NUMBER`.

   `PATH_TOKEN` is a secret path segment in the answer, hangup and media-stream URLs, so only Vobiz, which gets the URLs from your settings, can start a session on your Inworld account. If it is empty, the server generates a new one on every start and the URLs change.

5. **(Optional) Choose the models and voice** — every model and the voice are set in `.env`, so you can switch them without touching the code:

   | Variable | Default | What it sets |
   |---|---|---|
   | `LLM_MODEL` | `inworld/models/deepseek-v4.1-flash` | The LLM. Any model from the [Inworld models list](https://inworld.ai/models): Inworld-hosted models use `inworld/models/<model>`; third-party models use `provider/model`, for example `openai/gpt-4.1-mini` |
   | `INWORLD_VOICE` | `Sarah` | The TTS voice. Browse voices in the [TTS Playground](https://docs.inworld.ai/tts/tts-playground) or list them with the [List Voices API](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/list-voices); for Hindi callers, try `Aanya`, `Riya` or `Aarav` |
   | `TTS_MODEL` | `inworld-tts-2` | The TTS model. `inworld-tts-2-flash` is the fastest and lowest-cost option |
   | `STT_MODEL` | `inworld/inworld-stt-1` | The speech-to-text model |

   For fallbacks or A/B tests across LLMs, create a [router](https://docs.inworld.ai/router/introduction) in the [Inworld Portal](https://portal.inworld.ai) and set `LLM_MODEL=inworld/<your-router-id>`; leave the router's prompt template and model settings empty, since the system prompt comes from `SYSTEM_PROMPT`. The server prints the models and voice it uses when it starts.

6. **Install dependencies:**
   ```bash
   npm install
   ```

7. **Configure the Vobiz application** (for inbound calls) — in the [Vobiz console](https://console.vobiz.ai/), create an application with:
   - **Answer URL:** `https://<your-ngrok-domain>/answer/<PATH_TOKEN>`, method **POST**
   - **Hangup URL:** `https://<your-ngrok-domain>/hangup/<PATH_TOKEN>`, method **POST**

   Then attach your phone number to the application. The server prints both URLs when it starts.

## Run

In two terminals:

```bash
ngrok http 3000 --url=<your-ngrok-domain>
```

```bash
npm run dev
```

**Inbound:** call your Vobiz number — the bot will greet you and you can have a conversation.

**Outbound:** with the server running, have the agent call a phone:

```bash
npm run call -- +919876543210
```

Vobiz rings the number from `VOBIZ_FROM_NUMBER`. When the person answers, Vobiz fetches the same answer URL as for an inbound call, so the agent takes the call. Outbound calls do not need the console application from step 7.

Watch the server output to follow each turn (see [Logs](#logs)).

## How it works

1. When a call connects, Vobiz fetches `/answer/<PATH_TOKEN>`, which returns VobizXML with a bidirectional `<Stream>`:
   ```xml
   <Response>
     <Stream bidirectional="true" keepCallAlive="true" audioTrack="inbound"
             contentType="audio/x-mulaw;rate=8000">wss://<your-ngrok-domain>/media-stream/<PATH_TOKEN></Stream>
   </Response>
   ```
2. Vobiz opens a WebSocket to `/media-stream/<PATH_TOKEN>`, sends a `start` event, then the caller's audio as `media` events. `keepCallAlive` keeps the call up for as long as the stream is open
3. Server passes mulaw audio between Vobiz and Inworld (no format conversion needed). Bot audio goes back to Vobiz as `playAudio` events
4. Inworld transcribes the caller with the STT model set by `STT_MODEL`, detects end of turn with semantic VAD (`eagerness: "medium"`), and responds using the LLM set by `LLM_MODEL` and the voice and TTS model set by `INWORLD_VOICE` and `TTS_MODEL`
5. Barge-in: on speech detection, the server sends `clearAudio`, which flushes the audio Vobiz has queued but not yet played. Inworld cancels the in-flight response itself because the session sets `interrupt_response: true`
6. When the caller hangs up, Vobiz closes the WebSocket (there is no stop event) and calls the hangup URL; the server closes the Inworld session. A call that reaches `MAX_CALL_SECONDS` (default 600) is ended by the server sending `stop`, after which Vobiz hangs up

## Logs

Each turn is logged so you can follow the conversation and see where latency comes from:

```
[call] Stream started (call: <call-uuid>)
[latency] Turn end detected: +1764ms after caller stopped talking
[call] User: Ah, this is good. What's your name?
[latency] Response <id> created: +1765ms after caller stopped talking
[latency] First bot audio: +2638ms after caller stopped talking
[call] Bot (completed, 4830ms audio, response <id>): I'm your friendly voice assistant, but I don't have a name of my own. What would you like to call me?
[call] Caller interrupted the bot, clearing ~2667ms of unplayed audio
[latency] Turn end detected: +1721ms after caller stopped talking
[call] User: क्या आप मेरे को हिंदी से बात बात कर सकते हैं।
[latency] First bot audio: +2331ms after caller stopped talking
[call] Bot (completed, 4800ms audio, response <id>): Yes, I can talk with you in Hindi! बताइए, मैं आपकी क्या मदद कर सकता हूँ?
[call] Stream closed
[call] Call ended (call: <call-uuid>, cause: NORMAL_CLEARING, duration: 31s)
```

- Times are measured from the last inbound audio chunk that contained caller voice, not from Inworld's `speech_stopped` event, which fires only once turn detection commits the turn.
- `Turn end detected` is the time turn detection took. The gap between that and `First bot audio` is LLM + TTS time.
- `Bot (cancelled, ...)` means the response was interrupted, usually because the caller kept talking after a mid-sentence pause. On outbound calls the greeting is often cancelled this way, because the person says "hello" as they answer; the agent then replies to them.
- Latency is measured at the server and does not include the phone network in either direction.

## Troubleshooting

- **The call drops right after it connects** — Vobiz could not fetch the answer URL. Check that ngrok forwards to port 3000 and that the answer URL matches the one the server printed, including `PATH_TOKEN`.
- **The call connects, then ends before the agent speaks** — the server output shows why:
  - `Failed to connect to Inworld: ... Inworld HTTP 401` means `INWORLD_API_KEY` is wrong or is not a Realtime key.
  - `Inworld error: This model is currently not available on your plan` means `LLM_MODEL` needs a paid Inworld plan; use an Inworld-hosted model or add billing in the Inworld Portal.
  - `Inworld error: Unknown voice` means `INWORLD_VOICE` does not match a voice ID.
- **`npm run call` prints `Vobiz returned 401`** — check `VOBIZ_AUTH_ID` and `VOBIZ_AUTH_TOKEN`. A `400` means a field is missing or malformed, such as a number not in E.164 format. `VOBIZ_FROM_NUMBER` must be a number on your Vobiz account.
