import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { config, isPathToken } from "./config.js";
import { answerRouter } from "./server/answer.js";
import { handleCallStream } from "./voice/call-handler.js";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(answerRouter);

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Only /media-stream/<PATH_TOKEN> is upgraded to a WebSocket; anything else is refused.
server.on("upgrade", (req, socket, head) => {
  const match = req.url?.match(/^\/media-stream\/([^/?#]+)$/);
  if (!match || !isPathToken(match[1])) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => handleCallStream(ws));
});

server.listen(config.port, () => {
  console.log(`[server] Listening on port ${config.port}`);
  console.log(`[server] Answer URL: ${config.serverUrl}/answer/${config.pathToken}`);
  console.log(`[server] Hangup URL: ${config.serverUrl}/hangup/${config.pathToken}`);
  if (!process.env.PATH_TOKEN) {
    console.log("[server] PATH_TOKEN is not set, so these URLs change on every restart. Set it in .env to keep them.");
  }
  console.log(`[server] LLM: ${config.llmModel} · voice: ${config.voice} · TTS: ${config.ttsModel} · STT: ${config.sttModel}`);
});

process.on("SIGINT", () => { server.close(); process.exit(0); });
process.on("SIGTERM", () => { server.close(); process.exit(0); });
