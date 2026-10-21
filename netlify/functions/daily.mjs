// Room Tech Status Board: daily check, run by Netlify on a schedule (7 AM Eastern).
// Emails admins about warranties ending soon and projector lamps near the end of their life,
// and on Mondays lists tickets that have been open more than a week. Needs email set up (see board.mjs).
import { runDaily, mailReady } from "./board.mjs";

export const config = { schedule: "0 11 * * *" };

export default async () => {
  if (!mailReady()) return new Response("Email isn't set up, so there's nothing to send.");
  const r = await runDaily();
  return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
};
