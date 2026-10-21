// Room Tech Status Board: checks UniFi every 5 minutes (needs UNIFI_API_KEY).
// Access points and switches linked to devices on the board get a ticket when they've been offline for two checks
// in a row, and the ticket closes itself when they come back online.
import { runUnifi } from "./board.mjs";

export const config = { schedule: "*/5 * * * *" };

export default async () => {
  try { return new Response(JSON.stringify(await runUnifi()), { headers: { "content-type": "application/json" } }); }
  catch (e) { console.error("UniFi check failed:", e.message); return new Response("UniFi check failed: " + e.message, { status: 500 }); }
};
