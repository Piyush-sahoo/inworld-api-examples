/**
 * Vobiz webhooks.
 *
 * /answer returns VobizXML with a bidirectional <Stream> that sends the caller's
 * audio to our WebSocket as G.711 μ-law 8kHz. keepCallAlive keeps the call up
 * for as long as the stream is open.
 * /hangup receives the end-of-call notification.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { config, isPathToken } from "../config.js";

export const answerRouter = Router();

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Vobiz sends call details as form fields (POST) or query parameters (GET).
function param(req: Request, name: string): string {
  const value = req.body?.[name] ?? req.query[name];
  return typeof value === "string" ? value : "";
}

function checkToken(req: Request, res: Response, next: NextFunction) {
  if (!isPathToken(req.params.token)) {
    res.sendStatus(404);
    return;
  }
  next();
}

export function answerXml(): string {
  const wsUrl = new URL(`/media-stream/${config.pathToken}`, config.serverUrl);
  wsUrl.protocol = wsUrl.protocol === "http:" ? "ws:" : "wss:";

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    '  <Stream bidirectional="true" keepCallAlive="true" audioTrack="inbound" contentType="audio/x-mulaw;rate=8000">' +
      escapeXml(wsUrl.toString()) +
      "</Stream>",
    "</Response>",
  ].join("\n");
}

answerRouter.all("/answer/:token", checkToken, (req, res) => {
  console.log(`[call] ${param(req, "Direction") || "Call"} answered: ${param(req, "From")} → ${param(req, "To")} (call: ${param(req, "CallUUID")})`);
  res.type("application/xml").send(answerXml());
});

answerRouter.all("/hangup/:token", checkToken, (req, res) => {
  const cause = param(req, "HangupCause");
  const duration = param(req, "Duration");
  console.log(`[call] Call ended (call: ${param(req, "CallUUID")}, cause: ${cause || "n/a"}, duration: ${duration || "n/a"}s)`);
  res.sendStatus(200);
});
