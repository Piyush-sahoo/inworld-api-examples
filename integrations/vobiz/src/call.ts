/**
 * Places an outbound call with the Vobiz Make Call API. When the person answers,
 * Vobiz fetches the same answer URL as for inbound calls, so the agent takes the call.
 *
 * Usage (with the server running): npm run call -- +919876543210
 */
import "dotenv/config";

// Not imported from config.ts, which also requires INWORLD_API_KEY: placing a call only needs Vobiz settings.
function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

const to = process.argv[2];
if (!to || !/^\+[1-9]\d{6,14}$/.test(to)) {
  console.error("Usage: npm run call -- +<country code><number>, for example +919876543210");
  process.exit(1);
}

const authId = required("VOBIZ_AUTH_ID");
const authToken = required("VOBIZ_AUTH_TOKEN");
const from = required("VOBIZ_FROM_NUMBER");
const serverUrl = required("SERVER_URL");
// The server must use the same PATH_TOKEN, so it has to be set in .env.
const pathToken = required("PATH_TOKEN");
const maxCallSeconds = parseInt(process.env.MAX_CALL_SECONDS || "600", 10) || 600;

const response = await fetch(`https://api.vobiz.ai/api/v1/Account/${encodeURIComponent(authId)}/Call/`, {
  method: "POST",
  headers: {
    "X-Auth-ID": authId,
    "X-Auth-Token": authToken,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({
    from,
    to,
    answer_url: new URL(`/answer/${pathToken}`, serverUrl).toString(),
    answer_method: "POST",
    hangup_url: new URL(`/hangup/${pathToken}`, serverUrl).toString(),
    hangup_method: "POST",
    time_limit: maxCallSeconds,
  }),
});

const body = await response.text();
if (!response.ok) {
  console.error(`Vobiz returned ${response.status}: ${body.slice(0, 300)}`);
  process.exit(1);
}

// Accepted means queued, not answered: the server logs the call when it connects.
console.log(`Calling ${to} from ${from} (request_uuid: ${JSON.parse(body).request_uuid})`);
