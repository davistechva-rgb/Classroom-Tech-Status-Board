// Room Tech Status Board: the shared data behind the board, stored in Netlify Blobs.
//   GET  /api/board                      -> the board (rooms, devices, open and recent reports)
//   POST /api/board {action:"report",...} -> anyone with the staff code (if one is set) can report a problem
//   POST /api/board {action:..., pin}     -> admin actions need ADMIN_PIN
// Set these in Netlify under Site configuration > Environment variables:
//   ADMIN_PIN   (required) the PIN you use to manage rooms and fix reports
//   STAFF_CODE  (optional) a code teachers enter to view and report; leave unset to let anyone with the link use it
import { timingSafeEqual } from "node:crypto";

export const config = { path: "/api/board" };
const KEY = "board";
const LIMITS = { rooms: 300, devices: 40, reports: 600, name: 60, text: 400 };
const TYPES = ["Projector", "TV or display", "Interactive board", "Document camera", "Computer", "Chromebook cart", "Printer", "Speakers or sound", "Phone", "Wi-Fi", "Other"];
const STATUS = ["ok", "issue", "down", "repair"];

function hash(t) { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; }
async function storage() {
  if (process.env.BOARD_FILE) { // local testing only: behaves like Blobs, including conditional writes
    const fs = await import("node:fs");
    const read = () => { try { const t = fs.readFileSync(process.env.BOARD_FILE, "utf8"); return { data: JSON.parse(t), etag: String(t.length) + ":" + hash(t) }; } catch { return { data: null, etag: null }; } };
    return {
      async get() { return read(); },
      async set(v, etag) { const cur = read(); if ((cur.etag || null) !== (etag || null)) return false; fs.writeFileSync(process.env.BOARD_FILE, JSON.stringify(v)); return true; },
    };
  }
  const { getStore } = await import("@netlify/blobs");
  const store = getStore({ name: "room-status", consistency: "strong" });
  return {
    async get() { const r = await store.getWithMetadata(KEY, { type: "json" }); return { data: r ? r.data : null, etag: r ? r.etag : null }; },
    async set(v, etag) {
      try { const r = await store.setJSON(KEY, v, etag ? { onlyIfMatch: etag } : { onlyIfNew: true }); return !r || r.modified !== false; }
      catch { await store.setJSON(KEY, v); return true; }
    },
  };
}
const blank = () => ({ v: 1, school: "", rooms: [], reports: [], updated: Date.now() });
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function same(a, b) { const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? "")); return x.length === y.length && timingSafeEqual(x, y); }
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function view(b) {
  const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 30;
  return { ...b, reports: b.reports.filter(r => r.state !== "fixed" || r.closed > cutoff) };
}
function recompute(b) { // a device's status follows its worst open report, unless an admin set it by hand
  for (const room of b.rooms) for (const d of room.devices) {
    const open = b.reports.filter(r => r.room === room.id && r.device === d.id && r.state !== "fixed");
    if (open.length) { if (d.status === "ok") d.status = open.some(r => r.severity === "down") ? "down" : "issue"; }
    else if (d.auto && d.status !== "ok") d.status = "ok";
  }
}

export default async (req) => {
  const ADMIN = process.env.ADMIN_PIN, STAFF = process.env.STAFF_CODE || "";
  if (!ADMIN) return json({ error: "setup", message: "Set ADMIN_PIN in Netlify's environment variables, then redeploy." }, 503);
  const code = req.headers.get("x-staff-code") || "";
  const st = await storage();

  if (req.method === "GET") {
    if (STAFF && !same(code, STAFF) && !same(req.headers.get("x-admin-pin"), ADMIN)) { await sleep(400); return json({ error: "code", needCode: true }, 401); }
    const { data } = await st.get();
    return json({ board: view(data || blank()), types: TYPES, needCode: !!STAFF });
  }
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body; try { body = await req.json(); } catch { return json({ error: "bad-json" }, 400); }
  const isAdmin = same(body.pin, ADMIN);
  if (body.action === "login") { if (!isAdmin) { await sleep(700); return json({ error: "pin", message: "That PIN isn't right." }, 401); } return json({ ok: true }); }
  if (body.action === "report") { if (STAFF && !isAdmin && !same(code, STAFF)) { await sleep(400); return json({ error: "code", needCode: true }, 401); } }
  else if (!isAdmin) { await sleep(700); return json({ error: "pin", message: "Admin PIN needed." }, 401); }

  for (let attempt = 0; attempt < 8; attempt++) {
    const { data, etag } = await st.get();
    const b = data || blank();
    const room = r => b.rooms.find(x => x.id === r);
    const dev = (r, d) => (room(r)?.devices || []).find(x => x.id === d);
    let result = { ok: true };
    switch (body.action) {
      case "report": {
        const r = room(body.room), d = dev(body.room, body.device);
        if (!r || !d) return json({ error: "That room or device no longer exists. Refresh and try again." }, 400);
        const text = clean(body.text, LIMITS.text); if (!text) return json({ error: "Describe the problem." }, 400);
        const rep = { id: id(), room: r.id, device: d.id, text, by: clean(body.by, LIMITS.name), severity: body.severity === "down" ? "down" : "issue", state: "open", opened: Date.now() };
        b.reports.unshift(rep); if (d.status === "ok" || (rep.severity === "down" && d.status === "issue")) { d.status = rep.severity; d.auto = true; }
        result = { ok: true, report: rep.id }; break;
      }
      case "school": b.school = clean(body.school, LIMITS.name); break;
      case "addRoom": {
        if (b.rooms.length >= LIMITS.rooms) return json({ error: "Room limit reached." }, 400);
        const name = clean(body.name, LIMITS.name); if (!name) return json({ error: "Name the room." }, 400);
        const types = Array.isArray(body.devices) ? body.devices.slice(0, LIMITS.devices) : [];
        b.rooms.push({ id: id(), name, area: clean(body.area, LIMITS.name), devices: types.map(t => ({ id: id(), type: TYPES.includes(t) ? t : "Other", name: "", status: "ok", auto: true })) });
        b.rooms.sort((x, y) => (x.area || "").localeCompare(y.area || "", undefined, { numeric: true }) || x.name.localeCompare(y.name, undefined, { numeric: true }));
        break;
      }
      case "editRoom": { const r = room(body.room); if (!r) break; if (body.name != null) r.name = clean(body.name, LIMITS.name) || r.name; if (body.area != null) r.area = clean(body.area, LIMITS.name); break; }
      case "delRoom": b.rooms = b.rooms.filter(x => x.id !== body.room); b.reports = b.reports.filter(x => x.room !== body.room); break;
      case "addDevice": { const r = room(body.room); if (!r || r.devices.length >= LIMITS.devices) break; r.devices.push({ id: id(), type: TYPES.includes(body.type) ? body.type : "Other", name: clean(body.name, LIMITS.name), status: "ok", auto: true }); break; }
      case "delDevice": { const r = room(body.room); if (!r) break; r.devices = r.devices.filter(x => x.id !== body.device); b.reports = b.reports.filter(x => !(x.room === body.room && x.device === body.device)); break; }
      case "setStatus": { const d = dev(body.room, body.device); if (!d || !STATUS.includes(body.status)) break; d.status = body.status; d.auto = false; d.note = clean(body.note, LIMITS.text); d.changed = Date.now(); break; }
      case "report-state": {
        const rep = b.reports.find(x => x.id === body.report); if (!rep) break;
        if (!["open", "progress", "fixed"].includes(body.state)) break;
        rep.state = body.state; if (body.reply != null) rep.reply = clean(body.reply, LIMITS.text);
        if (rep.state === "fixed") { rep.closed = Date.now(); const d = dev(rep.room, rep.device); if (d) d.auto = true; }
        else if (rep.state === "progress") { const d = dev(rep.room, rep.device); if (d && d.auto) d.status = "repair"; }
        break;
      }
      default: return json({ error: "Unknown action." }, 400);
    }
    b.reports = b.reports.slice(0, LIMITS.reports);
    recompute(b); b.updated = Date.now();
    if (await st.set(b, etag)) return json({ ...result, board: view(b) });
    await sleep(80 + Math.random() * 120); // someone else saved at the same moment; try again with their changes
  }
  return json({ error: "The board was busy. Try again." }, 409);
};
