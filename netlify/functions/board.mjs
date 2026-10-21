// Room Tech Status Board: the server. Accounts, sessions, rooms, devices, and tickets, stored in Netlify Blobs.
//
// Environment variables (Netlify > Site configuration > Environment variables):
//   ADMIN_PIN  (required) used once to create the first admin account, and later to recover an admin password.
//
// All requests go to /api/board. GET ?display=<key> serves the read-only wall display.
// Everything else is POST {action, ...} with "Authorization: Bearer <session token>" once signed in.
import { scryptSync, randomBytes, createHmac, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/board" };

const TYPES = ["Projector", "TV or display", "Interactive board", "Document camera", "Computer", "Laptop", "Chromebook cart", "iPad cart", "Printer", "Speakers or sound", "Microphone", "Phone", "Wi-Fi access point", "Camera", "Other"];
const DEV_STATUS = ["ok", "issue", "down", "repair"];
const TICKET_STATES = ["open", "progress", "waiting", "fixed"];
const ROLES = ["admin", "tech", "teacher"];
const L = { rooms: 400, devices: 60, tickets: 1500, comments: 100, users: 500, name: 60, text: 1000, field: 80, log: 400 };
const DAY = 86400000;

/* ---------- storage ---------- */
function hash32(t) { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; }
let _st;
async function storage() {
  if (_st) return _st;
  if (process.env.BOARD_DIR) { // local testing only: files that behave like Blobs, including conditional writes
    const fs = await import("node:fs"), path = await import("node:path");
    fs.mkdirSync(process.env.BOARD_DIR, { recursive: true });
    const f = k => path.join(process.env.BOARD_DIR, k + ".json");
    const read = k => { try { const t = fs.readFileSync(f(k), "utf8"); return { data: JSON.parse(t), etag: t.length + ":" + hash32(t) }; } catch { return { data: null, etag: null }; } };
    return (_st = { get: async k => read(k), set: async (k, v, etag) => { if ((read(k).etag || null) !== (etag || null)) return false; fs.writeFileSync(f(k), JSON.stringify(v)); return true; } });
  }
  const { getStore } = await import("@netlify/blobs");
  const store = getStore({ name: "room-status", consistency: "strong" });
  return (_st = {
    async get(k) { const r = await store.getWithMetadata(k, { type: "json" }); return { data: r ? r.data : null, etag: r ? r.etag : null }; },
    async set(k, v, etag) { const r = await store.setJSON(k, v, etag ? { onlyIfMatch: etag } : { onlyIfNew: true }); return !r || r.modified !== false; },
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Read-modify-write with retries, so two people saving at once never overwrite each other.
async function mutate(key, init, fn) {
  const st = await storage();
  for (let i = 0; i < 10; i++) {
    const { data, etag } = await st.get(key);
    const v = data || init();
    const out = await fn(v);
    if (out && out.__abort) return { v: out, out };
    if (await st.set(key, v, etag)) return { v, out };
    await sleep(40 + Math.random() * 160);
  }
  throw new HttpError(409, "The board was busy. Try again.");
}
async function read(key, init) { const { data } = await (await storage()).get(key); return data || init(); }

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(s, m, extra) { super(m); this.status = s; this.extra = extra; } }
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, n);
const line = (s, n) => clean(s, n).replace(/\s*\n\s*/g, " ");
const id = () => Date.now().toString(36) + randomBytes(4).toString("hex");
const same = (a, b) => { const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? "")); return x.length === y.length && timingSafeEqual(x, y); };
const normUser = u => String(u ?? "").trim().toLowerCase();
const validUser = u => /^[a-z0-9][a-z0-9._-]{1,31}$/.test(u);
const pwProblem = p => typeof p !== "string" || p.length < 8 ? "Passwords need at least 8 characters." : p.length > 200 ? "That password is too long." : /^(password|12345678|123456789|qwertyui)/i.test(p) ? "Pick a less common password." : "";
function hashPw(pw, salt = randomBytes(16).toString("hex")) { return { salt, hash: scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex") }; }
function checkPw(pw, u) { if (!u || !u.hash) return false; const h = scryptSync(String(pw), u.salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex"); return same(h, u.hash); }
const WORDS = "amber anchor apple arrow aspen badge basin beacon birch bison blaze bloom bluff brave brook cabin canal cedar cliff clover cobalt comet coral crane creek crest daisy delta drift eagle ember fable falcon fern field flint forest fox frost garden glade glow granite harbor hawk hazel heron hill holly iris island ivy jade juniper kettle lake lark laurel lemon lily linen maple marble meadow mesa mint moss north oak ocean olive onyx orbit otter owl pebble pine plume pond prairie quail quartz rain raven reed ridge river robin sage sail shore sky slate spruce stone summit sun swift thistle thunder tide timber trail tulip valley violet willow wren".split(" ");
const tempPw = () => { const w = () => WORDS[randomBytes(2).readUInt16BE() % WORDS.length]; return `${w()}-${w()}-${10 + (randomBytes(1)[0] % 90)}`; };
const publicUser = u => ({ username: u.username, name: u.name, role: u.role, rooms: u.rooms || [], disabled: !!u.disabled, mustChange: !!u.mustChange, created: u.created, lastLogin: u.lastLogin || null });

/* ---------- sessions: signed tokens ---------- */
async function secret() {
  const m = await read("meta", () => null);
  if (m && m.secret) return m.secret;
  const { v } = await mutate("meta", () => ({}), m2 => { if (!m2.secret) m2.secret = randomBytes(32).toString("hex"); if (!m2.displays) m2.displays = []; });
  return v.secret;
}
const b64u = s => Buffer.from(s).toString("base64url");
async function sign(payload) { const p = b64u(JSON.stringify(payload)); return p + "." + createHmac("sha256", await secret()).update(p).digest("base64url"); }
async function verify(tok) {
  const [p, s] = String(tok || "").split("."); if (!p || !s) return null;
  const want = createHmac("sha256", await secret()).update(p).digest("base64url"); if (!same(s, want)) return null;
  try { const o = JSON.parse(Buffer.from(p, "base64url").toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
}
async function currentUser(req) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""); if (!t) return null;
  const s = await verify(t); if (!s) return null;
  const users = await read("users", () => ({ list: [] }));
  const u = users.list.find(x => x.username === s.u);
  if (!u || u.disabled || (u.tv || 0) !== s.v) return null;
  return u;
}
const can = (u, what) => u && (u.role === "admin" || (what === "manage" && u.role === "tech"));

/* ---------- login throttling ---------- */
async function throttle(key) {
  const f = await read("fails", () => ({}));
  const e = f[key];
  if (e && e.until > Date.now()) throw new HttpError(429, `Too many tries. Wait ${Math.ceil((e.until - Date.now()) / 60000)} minutes, or ask your admin to reset your password.`);
}
async function failed(key) {
  await sleep(600);
  await mutate("fails", () => ({}), f => {
    for (const k of Object.keys(f)) if (f[k].until && f[k].until < Date.now() - DAY) delete f[k];
    const e = f[key] = f[key] || { n: 0 }; e.n++;
    if (e.n >= 6) { e.until = Date.now() + 10 * 60000; e.n = 0; }
  });
}
const cleared = key => mutate("fails", () => ({}), f => { delete f[key]; });

/* ---------- board data ---------- */
const blankBoard = () => ({ v: 2, school: "", rooms: [], tickets: [], updated: Date.now() });
function upgrade(b) { // older boards stored "reports"; turn them into tickets
  if (b.reports && !b.tickets) { b.tickets = b.reports.map(r => ({ id: r.id, room: r.room, device: r.device, text: r.text, by: "", byName: r.by || "", severity: r.severity, state: r.state === "fixed" ? "fixed" : r.state === "progress" ? "progress" : "open", opened: r.opened, updated: r.closed || r.opened, closed: r.closed, comments: r.reply ? [{ by: "", byName: "Tech", role: "tech", text: r.reply, ts: r.closed || r.opened }] : [], seen: {} })); delete b.reports; }
  b.tickets = b.tickets || []; b.v = 2; return b;
}
function recompute(b) {
  for (const room of b.rooms) for (const d of room.devices) {
    const open = b.tickets.filter(t => t.room === room.id && t.device === d.id && t.state !== "fixed");
    if (open.length) {
      if (!d.manual) d.status = open.some(t => t.state === "progress" || t.state === "waiting") ? "repair" : open.some(t => t.severity === "down") ? "down" : "issue";
    } else if (!d.manual) d.status = "ok";
  }
}
function boardFor(b, u) {
  const cutoff = Date.now() - 45 * DAY;
  let tickets = b.tickets.filter(t => t.state !== "fixed" || (t.closed || 0) > cutoff), rooms = b.rooms;
  // Everyone except admins only sees the rooms assigned to them (and tickets they wrote). Admins see everything.
  if (u && u.role !== "admin") { const mine = new Set(u.rooms || []); rooms = rooms.filter(r => mine.has(r.id)); tickets = tickets.filter(t => mine.has(t.room) || t.by === u.username); }
  return { ...b, rooms, tickets: tickets.map(t => ({ ...t, unread: u ? (t.comments || []).some(c => c.ts > ((t.seen || {})[u.username] || 0) && c.by !== u.username) : false })) };
}
async function log(by, text) { await mutate("log", () => ({ list: [] }), l => { l.list.unshift({ ts: Date.now(), by, text: clean(text, 300) }); l.list = l.list.slice(0, L.log); }); }

/* ---------- handler ---------- */
export default async (req) => {
  try { return await handle(req); }
  catch (e) { if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status); console.error(e); return json({ error: "Something went wrong on the server." }, 500); }
};

async function handle(req) {
  const ADMIN_PIN = process.env.ADMIN_PIN;
  if (!ADMIN_PIN) return json({ error: "Add an ADMIN_PIN environment variable in Netlify, then redeploy.", setup: "pin" }, 503);
  const url = new URL(req.url);

  // Wall display: read-only, by private key
  if (req.method === "GET") {
    const key = url.searchParams.get("display");
    if (!key) return json({ error: "Not found." }, 404);
    const meta = await read("meta", () => ({}));
    if (!(meta.displays || []).some(d => same(d.key, key))) { await sleep(500); throw new HttpError(403, "This display link isn't valid. Ask your admin for a new one."); }
    const b = upgrade(await read("board", blankBoard));
    return json({ board: boardFor(b, null), display: true });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  let body; try { body = await req.json(); } catch { throw new HttpError(400, "Bad request."); }
  const a = body.action;

  /* ----- signed-out actions ----- */
  if (a === "status") { const users = await read("users", () => ({ list: [] })); return json({ needsSetup: !users.list.some(u => u.role === "admin" && !u.disabled) }); }

  if (a === "setup" || a === "recover") {
    await throttle("pin");
    if (!same(clean(body.pin, 100), ADMIN_PIN)) { await failed("pin"); throw new HttpError(401, "That setup PIN isn't right."); }
    await cleared("pin");
    const username = normUser(body.username), p = pwProblem(body.password);
    if (!validUser(username)) throw new HttpError(400, "Usernames are 2 to 32 letters, numbers, dots, dashes, or underscores.");
    if (p) throw new HttpError(400, p);
    const { v } = await mutate("users", () => ({ list: [] }), users => {
      const hasAdmin = users.list.some(u => u.role === "admin" && !u.disabled);
      if (a === "setup" && hasAdmin) return { __abort: true };
      let u = users.list.find(x => x.username === username);
      if (!u) { u = { username, role: "admin", rooms: [], created: Date.now() }; users.list.push(u); }
      u.role = "admin";
      Object.assign(u, hashPw(body.password), { name: line(body.name, L.name) || u.name || username, disabled: false, mustChange: false, tv: (u.tv || 0) + 1 });
    });
    if (v.__abort) throw new HttpError(409, "Setup is already done. Sign in instead.");
    await log(username, a === "setup" ? "Created the first admin account" : "Reset an admin password with the setup PIN");
    return json({ ok: true });
  }

  if (a === "login") {
    const username = normUser(body.username);
    await throttle("u:" + username);
    const users = await read("users", () => ({ list: [] }));
    const u = users.list.find(x => x.username === username);
    if (!u || u.disabled || !checkPw(body.password, u)) { await failed("u:" + username); throw new HttpError(401, u && u.disabled ? "This account is turned off. Ask your admin." : "That username or password isn't right."); }
    await cleared("u:" + username);
    const days = body.remember ? 30 : 1;
    const token = await sign({ u: u.username, v: u.tv || 0, exp: Date.now() + days * DAY });
    await mutate("users", () => ({ list: [] }), us => { const x = us.list.find(y => y.username === username); if (x) x.lastLogin = Date.now(); });
    return json({ token, user: publicUser(u) });
  }

  /* ----- signed-in actions ----- */
  const me = await currentUser(req);
  if (!me) throw new HttpError(401, "Please sign in again.", { signin: true });

  if (a === "changePassword") {
    if (!checkPw(body.current, me)) { await sleep(500); throw new HttpError(400, "Your current password isn't right."); }
    const p = pwProblem(body.next); if (p) throw new HttpError(400, p);
    if (same(body.current, body.next)) throw new HttpError(400, "Pick a new password that's different from the old one.");
    let token;
    await mutate("users", () => ({ list: [] }), us => { const x = us.list.find(y => y.username === me.username); Object.assign(x, hashPw(body.next), { mustChange: false, tv: (x.tv || 0) + 1 }); });
    const fresh = (await read("users", () => ({ list: [] }))).list.find(y => y.username === me.username);
    token = await sign({ u: fresh.username, v: fresh.tv, exp: Date.now() + (body.remember ? 30 : 1) * DAY });
    await log(me.username, "Changed their password");
    return json({ ok: true, token, user: publicUser(fresh) });
  }
  if (me.mustChange && a !== "me") throw new HttpError(403, "Set a new password first.", { mustChange: true });

  if (a === "me" || a === "load") {
    const b = upgrade(await read("board", blankBoard));
    const users = await read("users", () => ({ list: [] }));
    let people = users.list.filter(u => !u.disabled).map(u => ({ username: u.username, name: u.name, role: u.role, rooms: u.rooms || [] }));
    if (me.role !== "admin") { const mine = new Set(me.rooms || []); people = people.filter(p => p.role === "admin" || p.username === me.username || p.rooms.some(r => mine.has(r))).map(p => ({ ...p, rooms: p.rooms.filter(r => mine.has(r)) })); }
    const out = { me: publicUser(me), board: boardFor(b, me), people, types: TYPES };
    if (can(me, "manage")) out.log = (await read("log", () => ({ list: [] }))).list.slice(0, 60);
    if (me.role === "admin") { out.users = users.list.map(publicUser); out.displays = ((await read("meta", () => ({}))).displays || []).map(d => ({ id: d.id, name: d.name, key: d.key, created: d.created })); }
    return json(out);
  }

  /* ----- account admin ----- */
  if (["createUsers", "updateUser", "resetPassword", "deleteUser"].includes(a)) {
    if (me.role !== "admin") throw new HttpError(403, "Only an admin can manage accounts.");
    const board = await read("board", blankBoard); const roomIds = new Set(board.rooms.map(r => r.id));
    const made = [];
    const { v } = await mutate("users", () => ({ list: [] }), users => {
      made.length = 0;
      if (a === "createUsers") {
        const rows = Array.isArray(body.users) ? body.users.slice(0, 200) : [];
        if (users.list.length + rows.length > L.users) return { __abort: true, msg: "Account limit reached." };
        for (const r of rows) {
          const username = normUser(r.username);
          if (!validUser(username)) return { __abort: true, msg: `“${r.username}” isn't a valid username. Use letters, numbers, dots, dashes, or underscores.` };
          if (users.list.some(x => x.username === username) || made.some(m => m.username === username)) return { __abort: true, msg: `The username “${username}” is already taken.` };
          const role = ROLES.includes(r.role) ? r.role : "teacher";
          const pw = r.password && !pwProblem(r.password) ? r.password : tempPw();
          const u = { username, name: line(r.name, L.name) || username, role, rooms: (r.rooms || []).filter(x => roomIds.has(x)).slice(0, 20), created: Date.now(), mustChange: true, tv: 0, ...hashPw(pw) };
          users.list.push(u); made.push({ username, name: u.name, password: pw, role });
        }
      } else {
        const u = users.list.find(x => x.username === normUser(body.username));
        if (!u) return { __abort: true, msg: "That account no longer exists." };
        const otherAdmins = users.list.filter(x => x !== u && x.role === "admin" && !x.disabled).length;
        if (a === "updateUser") {
          if (body.name != null) u.name = line(body.name, L.name) || u.name;
          if (body.role != null && ROLES.includes(body.role)) { if (u.role === "admin" && body.role !== "admin" && !otherAdmins) return { __abort: true, msg: "Keep at least one admin account." }; u.role = body.role; }
          if (Array.isArray(body.rooms)) u.rooms = body.rooms.filter(x => roomIds.has(x)).slice(0, 20);
          if (body.disabled != null) { if (body.disabled && u.role === "admin" && !otherAdmins) return { __abort: true, msg: "Keep at least one admin account turned on." }; u.disabled = !!body.disabled; u.tv = (u.tv || 0) + 1; }
        }
        if (a === "resetPassword") { const pw = tempPw(); Object.assign(u, hashPw(pw), { mustChange: true, tv: (u.tv || 0) + 1 }); made.push({ username: u.username, name: u.name, password: pw, role: u.role }); }
        if (a === "deleteUser") { if (u.username === me.username) return { __abort: true, msg: "You can't delete your own account." }; if (u.role === "admin" && !otherAdmins) return { __abort: true, msg: "Keep at least one admin account." }; users.list = users.list.filter(x => x !== u); }
      }
    });
    if (v.__abort) throw new HttpError(400, v.msg);
    if (a === "resetPassword") await cleared("u:" + normUser(body.username));
    await log(me.username, a === "createUsers" ? `Created ${made.length} account${made.length === 1 ? "" : "s"}: ${made.map(m => m.username).join(", ")}` : a === "resetPassword" ? `Reset the password for ${normUser(body.username)}` : a === "deleteUser" ? `Deleted the account ${normUser(body.username)}` : `Updated the account ${normUser(body.username)}`);
    return json({ ok: true, created: made });
  }

  if (a === "addDisplay" || a === "deleteDisplay") {
    if (me.role !== "admin") throw new HttpError(403, "Only an admin can manage display links.");
    await mutate("meta", () => ({}), m => { m.displays = m.displays || []; if (a === "addDisplay") m.displays.push({ id: id(), name: line(body.name, L.name) || "Display", key: randomBytes(18).toString("base64url"), created: Date.now() }); else m.displays = m.displays.filter(d => d.id !== body.id); });
    await log(me.username, a === "addDisplay" ? `Made a display link: ${line(body.name, L.name) || "Display"}` : "Removed a display link");
    return json({ ok: true });
  }

  /* ----- board changes ----- */
  const manage = can(me, "manage");
  let note = "", result = {};
  const { v: b } = await mutate("board", blankBoard, b0 => {
    const b = upgrade(b0); note = ""; result = {};
    const room = r => b.rooms.find(x => x.id === r);
    const dev = (r, d) => (room(r)?.devices || []).find(x => x.id === d);
    const tk = t => b.tickets.find(x => x.id === t);
    const need = ok => { if (!ok) throw new HttpError(403, "Your account can't do that."); };
    const mine = rid => me.role === "admin" || (me.rooms || []).includes(rid);
    const needRoom = rid => { if (!mine(rid)) throw new HttpError(403, "That room isn't assigned to your account."); };
    const devFields = (d, src) => { for (const k of ["name", "model", "serial", "asset", "location"]) if (src[k] != null) d[k] = line(src[k], L.field); if (src.notes != null) d.notes = clean(src.notes, L.text); if (src.type != null && TYPES.includes(src.type)) d.type = src.type; };
    switch (a) {
      case "report": {
        const r = room(body.room), d = dev(body.room, body.device);
        if (!r || !d) throw new HttpError(400, "That room or device no longer exists. Refresh and try again.");
        if (!mine(r.id)) throw new HttpError(403, "You can only report problems in rooms assigned to you.");
        const text = clean(body.text, L.text); if (!text) throw new HttpError(400, "Describe the problem.");
        if (b.tickets.length >= L.tickets) b.tickets = b.tickets.filter(t => t.state !== "fixed" || t.closed > Date.now() - 90 * DAY);
        const t = { id: id(), room: r.id, device: d.id, text, by: me.username, byName: me.name, severity: body.severity === "down" ? "down" : "issue", state: "open", opened: Date.now(), updated: Date.now(), comments: [], seen: { [me.username]: Date.now() } };
        d.manual = false; b.tickets.unshift(t); result.ticket = t.id; note = `Reported ${d.name || d.type} in ${r.name}`; break;
      }
      case "comment": {
        const t = tk(body.ticket); if (!t) throw new HttpError(400, "That ticket no longer exists.");
        need(t.by === me.username || mine(t.room));
        const text = clean(body.text, L.text); if (!text) throw new HttpError(400, "Write a message first.");
        t.comments = (t.comments || []).concat({ by: me.username, byName: me.name, role: me.role, text, ts: Date.now() }).slice(-L.comments);
        t.updated = Date.now(); t.seen = { ...(t.seen || {}), [me.username]: Date.now() };
        if (t.state === "fixed" && !manage) { t.state = "open"; t.closed = null; t.comments.push({ by: "", byName: "Board", role: "system", text: "Reopened by a new message.", ts: Date.now() + 1 }); }
        note = `Messaged on a ticket in ${room(t.room)?.name || "a room"}`; break;
      }
      case "seen": { const t = tk(body.ticket); if (t) t.seen = { ...(t.seen || {}), [me.username]: Date.now() }; break; }
      case "ticketState": {
        const t = tk(body.ticket); if (!t) throw new HttpError(400, "That ticket no longer exists.");
        const own = t.by === me.username;
        need((manage && mine(t.room)) || (own && body.state === "fixed"));
        if (!TICKET_STATES.includes(body.state)) throw new HttpError(400, "Unknown status.");
        const label = { open: "Open", progress: "Working on it", waiting: "Waiting on parts", fixed: "Fixed" }[body.state];
        t.state = body.state; t.updated = Date.now(); t.closed = body.state === "fixed" ? Date.now() : null;
        if (body.assignee !== undefined && manage) t.assignee = normUser(body.assignee) || null;
        t.comments = (t.comments || []).concat({ by: "", byName: me.name, role: "system", text: `${me.name} marked this ${label.toLowerCase()}.`, ts: Date.now() });
        if (t.state === "fixed") { const d = dev(t.room, t.device); if (d) d.manual = false; }
        note = `Marked a ticket ${label.toLowerCase()} (${room(t.room)?.name || ""})`; break;
      }
      case "assign": { need(manage); const t = tk(body.ticket); if (!t) break; needRoom(t.room); t.assignee = normUser(body.assignee) || null; t.updated = Date.now(); note = "Changed who's handling a ticket"; break; }
      case "school": need(me.role === "admin"); b.school = line(body.school, L.name); note = "Changed the school name"; break;
      case "addRoom": {
        need(me.role === "admin"); if (b.rooms.length >= L.rooms) throw new HttpError(400, "Room limit reached.");
        const name = line(body.name, L.name); if (!name) throw new HttpError(400, "Name the room.");
        const types = Array.isArray(body.devices) ? body.devices.slice(0, L.devices) : [];
        const r = { id: id(), name, area: line(body.area, L.name), devices: types.map(t => ({ id: id(), type: TYPES.includes(t) ? t : "Other", name: "", status: "ok" })) };
        b.rooms.push(r); result.room = r.id; note = `Added the room ${name}`; break;
      }
      case "editRoom": { need(manage); needRoom(body.room); const r = room(body.room); if (!r) break; if (body.name != null) r.name = line(body.name, L.name) || r.name; if (body.area != null) r.area = line(body.area, L.name); note = `Edited the room ${r.name}`; break; }
      case "delRoom": { need(me.role === "admin"); const r = room(body.room); b.rooms = b.rooms.filter(x => x.id !== body.room); b.tickets = b.tickets.filter(x => x.room !== body.room); note = `Deleted the room ${r ? r.name : ""}`; break; }
      case "addDevice": {
        need(manage); needRoom(body.room); const r = room(body.room); if (!r) throw new HttpError(400, "That room no longer exists.");
        if (r.devices.length >= L.devices) throw new HttpError(400, "That room has the most devices allowed.");
        const d = { id: id(), type: TYPES.includes(body.type) ? body.type : "Other", name: "", status: "ok" }; devFields(d, body); r.devices.push(d); result.device = d.id; note = `Added ${d.name || d.type} to ${r.name}`; break;
      }
      case "editDevice": {
        need(manage); needRoom(body.room); if (body.moveTo) needRoom(body.moveTo); const d = dev(body.room, body.device); if (!d) throw new HttpError(400, "That device no longer exists.");
        devFields(d, body);
        if (body.status != null) { if (!DEV_STATUS.includes(body.status)) throw new HttpError(400, "Unknown status."); d.status = body.status; d.manual = true; d.statusNote = clean(body.statusNote, L.field * 2); }
        if (body.moveTo && body.moveTo !== body.room) { const from = room(body.room), to = room(body.moveTo); if (to) { from.devices = from.devices.filter(x => x !== d); to.devices.push(d); b.tickets.forEach(t => { if (t.device === d.id) t.room = to.id; }); } }
        note = `Updated ${d.name || d.type} in ${room(body.moveTo || body.room)?.name || ""}`; break;
      }
      case "delDevice": { need(manage); needRoom(body.room); const r = room(body.room); if (!r) break; const d = r.devices.find(x => x.id === body.device); r.devices = r.devices.filter(x => x.id !== body.device); b.tickets = b.tickets.filter(x => x.device !== body.device); note = `Removed ${d ? d.name || d.type : "a device"} from ${r.name}`; break; }
      default: throw new HttpError(400, "Unknown action.");
    }
    recompute(b); b.updated = Date.now();
  });
  if (note) await log(me.username, note);
  return json({ ok: true, ...result, board: boardFor(b.__abort ? upgrade(await read("board", blankBoard)) : b, me) });
}
