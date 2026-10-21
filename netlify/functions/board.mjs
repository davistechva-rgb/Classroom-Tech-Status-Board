// Room Tech Status Board: the server. Accounts, sessions, rooms, devices, and tickets, stored in Netlify Blobs.
//
// Environment variables (Netlify > Site configuration > Environment variables):
//   ADMIN_PIN  (required) used once to create the first admin account, and later to recover an admin password.
//   Email alerts (optional, pick one):
//     Microsoft 365: MS_TENANT_ID + MS_CLIENT_ID + MS_CLIENT_SECRET + MAIL_FROM (the mailbox alerts are sent from).
//       Sends through Microsoft Graph with an Entra app that has the Mail.Send application permission.
//     SMTP_USER + SMTP_PASS  for example a Gmail address and a Google app password (SMTP_HOST / SMTP_PORT for other providers)
//     RESEND_API_KEY + MAIL_FROM  a Resend.com key and a verified sender address
//   MAIL_NAME (optional) the sender name on alerts. Default: Room Tech Status
//   Sign in with Google (optional): GOOGLE_CLIENT_ID (a Web client ID from Google Cloud), and GOOGLE_DOMAIN to only allow one
//     Google Workspace domain (for example fuquaschool.org).
//
// All requests go to /api/board. GET ?display=<key> serves the read-only wall display, GET ?photo=<id>&s=<sig> serves a photo.
// Everything else is POST {action, ...} with "Authorization: Bearer <session token>" once signed in.
import { scryptSync, randomBytes, createHmac, timingSafeEqual, createPublicKey, verify as rsaVerify } from "node:crypto";

export const config = { path: "/api/board" };

const TYPES = ["Projector", "TV or display", "Interactive board", "Document camera", "Computer", "Laptop", "Chromebook cart", "iPad cart", "Printer", "Speakers or sound", "Microphone", "Phone", "Wi-Fi access point", "Camera", "Other"];
const DEV_STATUS = ["ok", "issue", "down", "repair"];
const TICKET_STATES = ["open", "progress", "waiting", "fixed"];
const ROLES = ["admin", "tech", "teacher"];
const L = { rooms: 400, devices: 60, tickets: 1500, comments: 100, users: 500, name: 60, text: 1000, field: 80, log: 400 };
const DAY = 86400000;
const LOAN_TYPES = ["Chromebook", "Laptop", "iPad", "Charger", "Hotspot", "Calculator", "Headphones", "Camera", "Projector", "Speaker", "Cable or adapter", "Other"];
const DEFAULT_FIXES = {
  "Projector": ["Press Source (or Input) on the remote and pick the input your laptop or computer is on.", "Check the HDMI cable is pushed in tight at both ends.", "Turn the projector off, wait 30 seconds, and turn it back on."],
  "TV or display": ["Press Input or Source on the remote and pick the right HDMI.", "Check the cable is pushed in at both ends.", "Unplug the TV for 30 seconds, then plug it back in."],
  "Interactive board": ["Check the board's input is set to the computer.", "Unplug and replug the USB touch cable from the computer.", "Restart the computer."],
  "Document camera": ["Check the camera's light is on. If not, press its power button.", "Pick the document camera input on the projector or TV.", "Unplug the USB cable and plug it back in."],
  "Computer": ["Restart the computer (Start > Power > Restart).", "Check the monitor's power light and cable.", "Try a different outlet or power strip."],
  "Laptop": ["Plug in the charger and wait a few minutes.", "Hold the power button for 10 seconds, then turn it back on.", "Restart it."],
  "Chromebook cart": ["Check the cart is plugged into the wall and its power switch is on.", "Make sure each Chromebook's charger is clicked in all the way.", "Try a different outlet."],
  "iPad cart": ["Check the cart is plugged into the wall and switched on.", "Make sure each iPad's cable is pushed in all the way.", "Try a different outlet."],
  "Printer": ["Check it has paper and no blinking lights.", "Turn the printer off and on.", "Cancel stuck jobs and print again."],
  "Speakers or sound": ["Check the volume on the computer and on the speakers.", "Make sure the right speaker is picked in the computer's sound settings.", "Unplug the audio cable and plug it back in."],
  "Microphone": ["Check the mic is on and its battery is charged.", "Check it isn't muted on the receiver or computer."],
  "Phone": ["Check the cord from the phone to the wall is pushed in.", "Unplug the phone's network cable for 10 seconds, then plug it back in."],
  "Wi-Fi access point": ["Turn your device's Wi-Fi off and on.", "Try moving closer to the hallway or another room.", "Check whether others nearby have the same problem."],
  "Camera": ["Check the camera is plugged in and its light is on.", "Restart the app or computer that uses it."],
  "Other": [] };
const PHOTO_MAX = 2500000;

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

/* ---------- photos (kept in their own store so the board stays small) ---------- */
let _ph;
async function photoStore() {
  if (_ph) return _ph;
  if (process.env.BOARD_DIR) {
    const fs = await import("node:fs"), path = await import("node:path"); const dir = path.join(process.env.BOARD_DIR, "photos"); fs.mkdirSync(dir, { recursive: true });
    return (_ph = { get: async k => { try { return fs.readFileSync(path.join(dir, k)); } catch { return null; } }, set: async (k, buf) => fs.writeFileSync(path.join(dir, k), buf) });
  }
  const { getStore } = await import("@netlify/blobs");
  const store = getStore({ name: "room-photos" });
  return (_ph = { get: async k => { const a = await store.get(k, { type: "arrayBuffer" }); return a ? Buffer.from(a) : null; }, set: (k, buf) => store.set(k, buf) });
}
async function savePhoto(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw new HttpError(400, "That photo couldn't be read. Try a different picture.");
  const buf = Buffer.from(m[2], "base64"); if (buf.length > PHOTO_MAX) throw new HttpError(400, "That photo is too big.");
  const key = id() + randomBytes(6).toString("hex") + "." + (m[1] === "jpeg" ? "jpg" : m[1]);
  await (await photoStore()).set(key, buf); return key;
}
const photoSig = (sec, k) => createHmac("sha256", sec).update("p:" + k).digest("base64url").slice(0, 22);
const photoUrl = (sec, k) => `api/board?photo=${encodeURIComponent(k)}&s=${photoSig(sec, k)}`;

/* ---------- email alerts ---------- */
const SITE = () => (process.env.URL || "").replace(/\/$/, "");
const msReady = () => !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.MAIL_FROM);
export const mailReady = () => !!(msReady() || process.env.RESEND_API_KEY || (process.env.SMTP_USER && process.env.SMTP_PASS) || process.env.MAIL_TEST_DIR);
const escH = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function emailBody(title, lines, link, linkText) {
  const text = [title, "", ...lines, "", link ? `${linkText || "Open the board"}: ${link}` : "", "", "Room Tech Status by Davis Tech Support. Change which emails you get under My settings on the board."].join("\n");
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;background:#F3F5F9;padding:24px"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;border:1px solid #E1E6EE;overflow:hidden">
<div style="background:#14213D;color:#fff;padding:14px 20px;font-weight:700;font-size:16px">Room Tech Status</div><div style="padding:20px;color:#132033;font-size:15px;line-height:1.5">
<h2 style="margin:0 0 12px;font-size:19px">${escH(title)}</h2>${lines.map(l => `<p style="margin:0 0 8px">${escH(l)}</p>`).join("")}
${link ? `<p style="margin:18px 0 4px"><a href="${escH(link)}" style="background:#E8453C;color:#fff;text-decoration:none;padding:11px 18px;border-radius:9px;font-weight:700;display:inline-block">${escH(linkText || "Open the board")}</a></p>` : ""}</div>
<div style="padding:12px 20px;color:#5D6B7E;font-size:12px;border-top:1px solid #E1E6EE">Room Tech Status by Davis Tech Support. Change which emails you get under <b>My settings</b> on the board.</div></div></div>`;
  return { text, html };
}
async function sendMail(to, subject, body) {
  if (!to || !mailReady()) return false;
  const name = process.env.MAIL_NAME || "Room Tech Status";
  if (process.env.MAIL_TEST_DIR) { const fs = await import("node:fs"); fs.mkdirSync(process.env.MAIL_TEST_DIR, { recursive: true }); fs.appendFileSync(process.env.MAIL_TEST_DIR + "/mail.jsonl", JSON.stringify({ to, subject, text: body.text }) + "\n"); return true; }
  if (msReady()) {
    const graph = process.env.MS_GRAPH_HOST || "https://graph.microsoft.com";
    const send = async () => fetch(`${graph}/v1.0/users/${encodeURIComponent(process.env.MAIL_FROM)}/sendMail`, { method: "POST", headers: { authorization: "Bearer " + await msToken(), "content-type": "application/json" },
      body: JSON.stringify({ message: { subject, body: { contentType: "HTML", content: body.html }, toRecipients: [{ emailAddress: { address: to } }], from: { emailAddress: { address: process.env.MAIL_FROM, name } } }, saveToSentItems: false }) });
    let r = await send(); if (r.status === 401 || r.status === 403) { _ms = null; r = await send(); }
    if (!r.ok) { const t = await r.text(); let m = t; try { m = JSON.parse(t).error.message; } catch {} throw new Error(`Microsoft 365 said ${r.status}: ${String(m).slice(0, 220)}${r.status === 403 ? " " + msHint() : ""}`); }
    return true;
  }
  if (process.env.RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + process.env.RESEND_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ from: `${name} <${process.env.MAIL_FROM || "onboarding@resend.dev"}>`, to: [to], subject, text: body.text, html: body.html }) });
    if (!r.ok) throw new Error("Resend " + r.status + " " + (await r.text()).slice(0, 200)); return true;
  }
  const nodemailer = (await import("nodemailer")).default; const port = +(process.env.SMTP_PORT || 465);
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST || "smtp.gmail.com", port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS).replace(/\s+/g, "") } });
  await t.sendMail({ from: `"${name}" <${process.env.MAIL_FROM || process.env.SMTP_USER}>`, to, subject, text: body.text, html: body.html }); return true;
}
let _ms = null; // cached Microsoft Graph app token
// Explains a 403 by reading which permissions are inside the app's token (the "roles" claim).
function msHint() {
  let roles = [];
  try { roles = JSON.parse(Buffer.from(String(_lastTok || "").split(".")[1], "base64url")).roles || []; } catch {}
  if (!roles.includes("Mail.Send")) return `(The app's sign-in has no Mail.Send application permission. It has: ${roles.join(", ") || "none"}. In Entra, add Mail.Send under "Application permissions", not "Delegated", then grant admin consent.)`;
  return `(The app does have Mail.Send, so Exchange is blocking it from sending as ${process.env.MAIL_FROM}. Your tenant likely has an application access policy or an RBAC for Applications rule. Allow this app for that mailbox, or use a mailbox the policy allows.)`;
}
let _lastTok = "";
async function msToken() {
  if (_ms && _ms.exp > Date.now() + 60000) return _ms.tok;
  const login = process.env.MS_LOGIN_HOST || "https://login.microsoftonline.com";
  const r = await fetch(`${login}/${encodeURIComponent(process.env.MS_TENANT_ID)}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Microsoft 365 sign-in failed: " + String(j.error_description || j.error || r.status).split("\r\n")[0].slice(0, 220));
  _ms = { tok: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; _lastTok = j.access_token; return _ms.tok;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
async function mailMany(list) { const r = await Promise.allSettled(list.map(([to, sub, body]) => withTimeout(sendMail(to, sub, body), 9000))); r.forEach(x => { if (x.status === "rejected") console.error("email failed:", x.reason && x.reason.message); }); }
const prefs = u => ({ reports: u.role === "teacher" ? "none" : "down", replies: true, digest: u.role === "admin", ...(u.notify || {}) });
async function notify(kind, t, b, me) {
  if (!mailReady() || !t) return;
  const users = (await read("users", () => ({ list: [] }))).list.filter(u => !u.disabled && u.email && u.username !== me.username);
  const r = b.rooms.find(x => x.id === t.room), d = r && r.devices.find(x => x.id === t.device);
  const where = `${r ? r.name : "A room"}: ${d ? d.name || d.type : "a device"}`, link = SITE() ? `${SITE()}/#/t/${t.id}` : "";
  const staff = u => u.role !== "teacher", last = (t.comments || []).filter(c => c.role !== "system").slice(-1)[0];
  const STATE = { open: "Open", progress: "Working on it", waiting: "Waiting on parts", fixed: "Fixed" };
  let to = [], subject = "", body;
  if (kind === "report") {
    to = users.filter(u => staff(u) && (prefs(u).reports === "all" || (prefs(u).reports === "down" && t.severity === "down")));
    subject = `${t.severity === "down" ? "🔴 Not working" : "🟠 Problem"}: ${where}`;
    body = emailBody(subject, [`${t.byName || "Someone"} reported: “${t.text}”`, t.photos && t.photos.length ? "A photo is attached on the board." : ""].filter(Boolean), link, "Open the ticket");
  } else if (kind === "staffReply" || kind === "state") {
    to = users.filter(u => u.username === t.by && prefs(u).replies);
    subject = kind === "state" ? `${STATE[t.state]}: ${where}` : `New reply: ${where}`;
    body = emailBody(subject, kind === "state" ? [`${me.name} marked your ticket “${STATE[t.state].toLowerCase()}.”`, `Your report: “${t.text}”`] : [`${me.name} wrote: “${last ? last.text : ""}”`], link, "Open the ticket");
  } else if (kind === "teacherReply") {
    to = users.filter(u => staff(u) && prefs(u).replies && (t.assignee ? u.username === t.assignee : prefs(u).reports === "all" || u.role === "admin"));
    subject = `New reply: ${where}`; body = emailBody(subject, [`${me.name} wrote: “${last ? last.text : ""}”`], link, "Open the ticket");
  }
  await mailMany(to.map(u => [u.email, subject, body]));
}

/* ---------- daily check: warranties, projector lamps, and old tickets (run by daily.mjs) ---------- */
export async function runDaily(now = Date.now()) {
  const b0 = upgrade(await read("board", blankBoard)); const items = [];
  for (const r of b0.rooms) for (const d of r.devices) {
    if (d.warranty && d.warnW !== d.warranty) { const days = Math.ceil((Date.parse(d.warranty) - now) / DAY); if (days <= 30 && days >= -1) items.push({ r: r.id, d: d.id, k: "W", text: `${r.name}: ${d.name || d.type}${d.model ? " (" + d.model + ")" : ""} warranty ${days < 0 ? "ended" : days === 0 ? "ends today" : `ends in ${days} day${days === 1 ? "" : "s"}`} (${d.warranty})` }); }
    if (d.lampLife > 0 && d.lampHours >= d.lampLife * 0.9 && !d.warnL) items.push({ r: r.id, d: d.id, k: "L", text: `${r.name}: ${d.name || d.type} lamp is at ${d.lampHours} of ${d.lampLife} hours` });
  }
  const monday = new Date(now).getUTCDay() === 1;
  const stale = monday ? b0.tickets.filter(t => t.state !== "fixed" && now - t.opened > 7 * DAY) : [];
  const L0 = await read("loans", () => ({ items: [], loans: [] }));
  const overdue = (L0.loans || []).filter(l => !l.back && l.due && l.due < now);
  const newOver = overdue.filter(l => !l.warned), showOver = monday ? overdue : newOver;
  if (!items.length && !stale.length && !showOver.length) return { sent: 0, items: 0 };
  const users = (await read("users", () => ({ list: [] }))).list.filter(u => !u.disabled && u.email && prefs(u).digest);
  const nm = id => { const r = b0.rooms.find(x => x.id === id.room), d = r && r.devices.find(x => x.id === id.device); return `${r ? r.name : "?"}: ${d ? d.name || d.type : "?"}`; };
  const itemName = id => { const it = (L0.items || []).find(x => x.id === id); return it ? it.name + (it.asset ? ` (${it.asset})` : "") : "a loaner"; };
  const lines = [...items.map(i => i.text), ...(showOver.length ? [`${showOver.length} loaner${showOver.length === 1 ? " is" : "s are"} overdue:`, ...showOver.slice(0, 20).map(l => `• ${itemName(l.item)} with ${l.to}, due ${new Date(l.due).toDateString()}`)] : []), ...(stale.length ? [`${stale.length} ticket${stale.length === 1 ? " has" : "s have"} been open more than a week:`, ...stale.slice(0, 15).map(t => `• ${nm(t)}, opened ${new Date(t.opened).toDateString()}`)] : [])];
  const subject = !items.length && !stale.length ? `${showOver.length} overdue loaner${showOver.length === 1 ? "" : "s"}` : items.length ? `Heads up: ${items.length} warranty or lamp reminder${items.length === 1 ? "" : "s"}` : `${stale.length} ticket${stale.length === 1 ? "" : "s"} open more than a week`;
  await mailMany(users.map(u => [u.email, subject, emailBody(subject, lines, SITE() ? SITE() + "/#/reports" : "", "Open reports")]));
  if (users.length && items.length) await mutate("board", blankBoard, b => { for (const i of items) { const r = b.rooms.find(x => x.id === i.r), d = r && r.devices.find(x => x.id === i.d); if (!d) continue; if (i.k === "W") d.warnW = d.warranty; else d.warnL = true; } });
  if (users.length && newOver.length) await mutate("loans", () => ({ items: [], loans: [] }), x => { for (const l of x.loans) if (newOver.some(o => o.id === l.id)) l.warned = true; });
  return { sent: users.length, items: items.length, stale: stale.length, overdue: showOver.length };
}

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
const publicUser = u => ({ hasPw: !!u.hash, google: u.google ? { email: u.google.email || u.email || "", since: u.google.first || null, last: u.google.last || null } : null, username: u.username, name: u.name, role: u.role, rooms: u.rooms || [], disabled: !!u.disabled, mustChange: !!u.mustChange, created: u.created, lastLogin: u.lastLogin || null, email: u.email || "", notify: prefs(u) });
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const cleanEmail = e => { const x = line(e, 120).toLowerCase(); if (x && !validEmail(x)) throw new HttpError(400, `“${x}” doesn't look like an email address.`); return x; };

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
/* ---------- Sign in with Google: verify the ID token Google gives the browser ---------- */
const GOOGLE_ID = () => (process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_DOMAIN = () => (process.env.GOOGLE_DOMAIN || "").trim().toLowerCase().replace(/^@/, "");
let _gk = { keys: null, exp: 0 };
async function googleKeys(force) {
  if (!force && _gk.keys && _gk.exp > Date.now()) return _gk.keys;
  const r = await fetch(process.env.GOOGLE_CERTS_URL || "https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw new HttpError(502, "Couldn't reach Google to check the sign-in. Try again.");
  const j = await r.json(), ma = +((/max-age=(\d+)/.exec(r.headers.get("cache-control") || "") || [0, 3600])[1]);
  _gk = { keys: j.keys || [], exp: Date.now() + Math.min(ma, 86400) * 1000 }; return _gk.keys;
}
async function verifyGoogle(cred) {
  const bad = m => new HttpError(401, m || "Google sign-in didn't work. Try again.");
  const [h, p, sig] = String(cred || "").split("."); if (!h || !p || !sig) throw bad();
  let head, pay; try { head = JSON.parse(Buffer.from(h, "base64url")); pay = JSON.parse(Buffer.from(p, "base64url")); } catch { throw bad(); }
  if (head.alg !== "RS256" || !head.kid) throw bad();
  let k = (await googleKeys()).find(x => x.kid === head.kid); if (!k) k = (await googleKeys(true)).find(x => x.kid === head.kid); if (!k) throw bad();
  if (!rsaVerify("RSA-SHA256", Buffer.from(h + "." + p), createPublicKey({ key: k, format: "jwk" }), Buffer.from(sig, "base64url"))) throw bad();
  const now = Date.now() / 1000;
  if (pay.aud !== GOOGLE_ID() || !["accounts.google.com", "https://accounts.google.com"].includes(pay.iss) || !(pay.exp > now - 60) || (pay.iat && pay.iat > now + 300)) throw bad();
  if (!pay.email || pay.email_verified === false || pay.email_verified === "false") throw bad("Your Google account's email isn't verified.");
  const dom = GOOGLE_DOMAIN(); if (dom && String(pay.hd || "").toLowerCase() !== dom) throw bad(`Use your ${dom} Google account to sign in.`);
  return { email: String(pay.email).toLowerCase(), name: pay.name || "", hd: pay.hd || "", sub: String(pay.sub || "") };
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
function boardFor(b, u, sec) {
  const cutoff = Date.now() - 45 * DAY, now = Date.now();
  let tickets = b.tickets.filter(t => t.state !== "fixed" || (t.closed || 0) > cutoff), rooms = b.rooms;
  // Teachers only see the rooms assigned to them (and tickets they wrote). Admins and techs see everything.
  if (u && u.role === "teacher") { const mine = new Set(u.rooms || []); rooms = rooms.filter(r => mine.has(r.id)); tickets = tickets.filter(t => mine.has(t.room) || t.by === u.username); }
  const pu = k => sec ? photoUrl(sec, k) : "";
  return { ...b, rooms, notices: (b.notices || []).filter(n => !n.until || n.until > now),
    tickets: tickets.map(t => ({ ...t, photos: (t.photos || []).map(pu), comments: (t.comments || []).map(c => c.photo ? { ...c, photo: pu(c.photo) } : c),
      unread: u ? (t.comments || []).some(c => c.ts > ((t.seen || {})[u.username] || 0) && c.by !== u.username) : false })) };
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
  if (req.method === "GET" && url.searchParams.get("photo")) {
    const k = url.searchParams.get("photo");
    if (!/^[a-z0-9]+\.(jpg|png|webp)$/.test(k) || !same(url.searchParams.get("s"), photoSig(await secret(), k))) throw new HttpError(404, "Not found.");
    const buf = await (await photoStore()).get(k); if (!buf) throw new HttpError(404, "Not found.");
    return new Response(buf, { headers: { "content-type": k.endsWith("png") ? "image/png" : k.endsWith("webp") ? "image/webp" : "image/jpeg", "cache-control": "private, max-age=604800" } });
  }
  if (req.method === "GET") {
    const key = url.searchParams.get("display");
    if (!key) return json({ error: "Not found." }, 404);
    const meta = await read("meta", () => ({}));
    if (!(meta.displays || []).some(d => same(d.key, key))) { await sleep(500); throw new HttpError(403, "This display link isn't valid. Ask your admin for a new one."); }
    const b = upgrade(await read("board", blankBoard));
    return json({ board: boardFor(b, null, null), display: true });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  let body; try { body = await req.json(); } catch { throw new HttpError(400, "Bad request."); }
  const a = body.action;

  /* ----- signed-out actions ----- */
  if (a === "status") { const users = await read("users", () => ({ list: [] })); return json({ needsSetup: !users.list.some(u => u.role === "admin" && !u.disabled), googleClientId: GOOGLE_ID() || null, googleDomain: GOOGLE_DOMAIN() || null }); }

  if (a === "google") {
    if (!GOOGLE_ID()) throw new HttpError(400, "Google sign-in isn't turned on for this board.");
    const g = await verifyGoogle(body.credential);
    const meta = await read("meta", () => ({}));
    let u = (await read("users", () => ({ list: [] }))).list.find(x => x.email && x.email.toLowerCase() === g.email);
    if (!u) {
      if (!meta.googleAutoCreate) throw new HttpError(403, `No board account uses ${g.email}. Ask your admin to add that email to your account on the People page.`);
      const { v } = await mutate("users", () => ({ list: [] }), us => {
        if (us.list.some(x => x.email && x.email.toLowerCase() === g.email)) return;
        if (us.list.length >= L.users) return { __abort: true, msg: "Account limit reached." };
        const base = g.email.split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 28) || "user"; let un = validUser(base) ? base : "u" + base, n = 2;
        while (us.list.some(x => x.username === un)) un = base + n++;
        us.list.push({ username: un, name: line(g.name, L.name) || un, email: g.email, role: "teacher", rooms: [], created: Date.now(), mustChange: false, tv: 0, viaGoogle: true, google: { sub: g.sub, email: g.email, first: Date.now(), last: Date.now() } });
      });
      if (v.__abort) throw new HttpError(400, v.msg);
      u = (await read("users", () => ({ list: [] }))).list.find(x => x.email && x.email.toLowerCase() === g.email);
      await log(u.username, `Joined with Google (${g.email})`);
    }
    if (u.disabled) throw new HttpError(401, "This account is turned off. Ask your admin.");
    const token = await sign({ u: u.username, v: u.tv || 0, exp: Date.now() + (body.remember === false ? 1 : 30) * DAY });
    let fresh = u;
    await mutate("users", () => ({ list: [] }), us => { const x = us.list.find(y => y.username === u.username); if (x) { const now = Date.now(); x.lastLogin = now; x.mustChange = false; x.google = { sub: g.sub, email: g.email, first: (x.google && x.google.first) || now, last: now }; fresh = x; } });
    return json({ token, user: publicUser(fresh) });
  }

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
    if (me.hash && !checkPw(body.current, me)) { await sleep(500); throw new HttpError(400, "Your current password isn't right."); }
    const p = pwProblem(body.next); if (p) throw new HttpError(400, p);
    if (me.hash && same(body.current, body.next)) throw new HttpError(400, "Pick a new password that's different from the old one.");
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
    if (me.role === "teacher") { const mine = new Set(me.rooms || []); people = people.filter(p => p.role !== "teacher" || p.username === me.username || p.rooms.some(r => mine.has(r))).map(p => ({ ...p, rooms: p.rooms.filter(r => mine.has(r)) })); }
    const out = { me: publicUser(me), board: boardFor(b, me, await secret()), people, types: TYPES, mail: mailReady(), site: SITE(), google: !!GOOGLE_ID() };
    if (can(me, "manage")) out.log = (await read("log", () => ({ list: [] }))).list.slice(0, 60);
    out.fixes = { ...DEFAULT_FIXES, ...(b.fixes || {}) }; out.loanTypes = LOAN_TYPES;
    const LN = await read("loans", () => ({ items: [], loans: [] }));
    if (can(me, "manage")) { out.loans = LN; out.walks = (await read("walks", () => ({ list: [] }))).list.slice(0, 30); }
    else { const mine = (LN.loans || []).filter(l => l.toUser === me.username && !l.back); out.loans = { items: (LN.items || []).filter(i => mine.some(l => l.item === i.id)), loans: mine }; }
    if (me.role === "admin") { const meta = await read("meta", () => ({})); out.signin = { google: !!GOOGLE_ID(), domain: GOOGLE_DOMAIN(), autoCreate: !!meta.googleAutoCreate }; out.users = users.list.map(publicUser); out.displays = ((await read("meta", () => ({}))).displays || []).map(d => ({ id: d.id, name: d.name, key: d.key, created: d.created })); }
    return json(out);
  }

  if (a === "updateMe") {
    const email = body.email != null ? cleanEmail(body.email) : undefined, n = body.notify || {};
    await mutate("users", () => ({ list: [] }), us => { const x = us.list.find(y => y.username === me.username); if (!x) return;
      if (email !== undefined) x.email = email;
      x.notify = { ...prefs(x), ...(["all", "down", "none"].includes(n.reports) && x.role !== "teacher" ? { reports: n.reports } : {}), ...(n.replies != null ? { replies: !!n.replies } : {}), ...(n.digest != null && x.role !== "teacher" ? { digest: !!n.digest } : {}) }; });
    const fresh = (await read("users", () => ({ list: [] }))).list.find(y => y.username === me.username);
    return json({ ok: true, user: publicUser(fresh) });
  }
  if (a === "testEmail") {
    if (!mailReady()) throw new HttpError(400, "Email isn't set up yet. Add the Microsoft 365 settings in Netlify (see the README), then redeploy.");
    if (!me.email) throw new HttpError(400, "Add your email address first.");
    try { await withTimeout(sendMail(me.email, "Test email from Room Tech Status", emailBody("Email alerts are working ✅", [`This is a test sent to ${me.email}.`], SITE(), "Open the board")), 12000); }
    catch (e) { throw new HttpError(502, "The email didn't send: " + String(e.message || e).slice(0, 200)); }
    return json({ ok: true });
  }
  if (a === "stats") {
    if (!can(me, "manage")) throw new HttpError(403, "Only techs and admins can see reports.");
    const b = upgrade(await read("board", blankBoard));
    return json({ tickets: b.tickets.map(t => ({ id: t.id, room: t.room, device: t.device, severity: t.severity, state: t.state, opened: t.opened, closed: t.closed || null, by: t.byName || t.by, assignee: t.assignee || null, text: t.text })), selfFixed: (await read("selffix", () => ({ list: [] }))).list });
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
          let email = ""; try { email = r.email ? cleanEmail(r.email) : ""; } catch (e) { return { __abort: true, msg: e.message }; }
          const u = { username, email, name: line(r.name, L.name) || username, role, rooms: (r.rooms || []).filter(x => roomIds.has(x)).slice(0, 20), created: Date.now(), mustChange: true, tv: 0, ...hashPw(pw) };
          users.list.push(u); made.push({ username, name: u.name, password: pw, role });
        }
      } else {
        const u = users.list.find(x => x.username === normUser(body.username));
        if (!u) return { __abort: true, msg: "That account no longer exists." };
        const otherAdmins = users.list.filter(x => x !== u && x.role === "admin" && !x.disabled).length;
        if (a === "updateUser") {
          if (body.name != null) u.name = line(body.name, L.name) || u.name;
          if (body.email != null) { try { u.email = cleanEmail(body.email); } catch (e) { return { __abort: true, msg: e.message }; } }
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

  if (a === "signinSettings") {
    if (me.role !== "admin") throw new HttpError(403, "Only an admin can change sign-in settings.");
    await mutate("meta", () => ({}), m => { m.googleAutoCreate = !!body.googleAutoCreate; });
    await log(me.username, body.googleAutoCreate ? "Let new staff join with Google" : "Turned off joining with Google");
    return json({ ok: true });
  }
  /* ----- quick fixes ----- */
  if (a === "selfFixed") {
    const b = await read("board", blankBoard); const r = b.rooms.find(x => x.id === body.room), d = r && r.devices.find(x => x.id === body.device);
    if (!d) throw new HttpError(400, "That device no longer exists.");
    await mutate("selffix", () => ({ list: [] }), x => { x.list.unshift({ ts: Date.now(), room: r.id, device: d.id, type: d.type, by: me.username }); x.list = x.list.slice(0, 3000); });
    await log(me.username, `Fixed ${d.name || d.type} in ${r.name} with a quick fix`);
    return json({ ok: true });
  }
  if (a === "setFixes") {
    if (!can(me, "manage")) throw new HttpError(403, "Only techs and admins can edit quick fixes.");
    if (!TYPES.includes(body.type)) throw new HttpError(400, "Unknown device type.");
    const steps = (Array.isArray(body.steps) ? body.steps : []).map(x => line(x, 240)).filter(Boolean).slice(0, 8);
    const { v } = await mutate("board", blankBoard, b => { b.fixes = b.fixes || {}; if (body.reset) delete b.fixes[body.type]; else b.fixes[body.type] = steps; });
    await log(me.username, `Updated the quick fixes for ${body.type}`);
    return json({ ok: true, fixes: { ...DEFAULT_FIXES, ...(v.fixes || {}) } });
  }

  /* ----- loaners ----- */
  if (["loanItemAdd", "loanItemEdit", "loanItemDel", "checkout", "checkin", "loanDel"].includes(a)) {
    if (!can(me, "manage")) throw new HttpError(403, "Only techs and admins can manage loaners.");
    const users = (await read("users", () => ({ list: [] }))).list;
    let note = "";
    const { v } = await mutate("loans", () => ({ items: [], loans: [] }), x => {
      x.items = x.items || []; x.loans = x.loans || []; note = "";
      const item = id => x.items.find(i => i.id === id);
      const fields = (it, src) => { for (const k of ["name", "asset", "serial"]) if (src[k] != null) it[k] = line(src[k], L.field); if (src.notes != null) it.notes = clean(src.notes, L.text); if (src.type != null) it.type = LOAN_TYPES.includes(src.type) ? src.type : "Other"; };
      if (a === "loanItemAdd") {
        const rows = (Array.isArray(body.items) ? body.items : []).slice(0, 300); if (x.items.length + rows.length > 2000) return { __abort: true, msg: "Loaner limit reached." };
        for (const r of rows) { const it = { id: id(), type: "Other", name: "", status: "in", created: Date.now() }; fields(it, r); if (!it.name) continue; if (it.asset && x.items.some(o => o.asset && o.asset.toLowerCase() === it.asset.toLowerCase())) return { __abort: true, msg: `Asset tag ${it.asset} is already on the list.` }; x.items.push(it); }
        note = `Added ${rows.length} loaner${rows.length === 1 ? "" : "s"}`;
      } else if (a === "loanItemEdit") {
        const it = item(body.id); if (!it) return { __abort: true, msg: "That loaner no longer exists." }; fields(it, body);
        if (body.status && ["in", "repair", "retired"].includes(body.status) && it.status !== "out") it.status = body.status; note = `Updated the loaner ${it.name}`;
      } else if (a === "loanItemDel") {
        const it = item(body.id); if (!it) return; if (it.status === "out") return { __abort: true, msg: "Check it in before removing it." };
        x.items = x.items.filter(i => i !== it); note = `Removed the loaner ${it.name}`;
      } else if (a === "checkout") {
        const it = item(body.item); if (!it) return { __abort: true, msg: "That loaner no longer exists." };
        if (it.status === "out") return { __abort: true, msg: `${it.name} is already checked out.` };
        if (it.status === "retired") return { __abort: true, msg: `${it.name} is retired.` };
        const to = line(body.to, L.name); if (!to) return { __abort: true, msg: "Who is borrowing it?" };
        const toUser = users.some(u => u.username === body.toUser) ? body.toUser : null;
        const due = +body.due || null;
        x.loans.unshift({ id: id(), item: it.id, to, toUser, by: me.username, byName: me.name, out: Date.now(), due, notes: clean(body.notes, 300), back: null });
        x.loans = x.loans.filter((l, i) => !l.back || i < 6000);
        it.status = "out"; note = `Checked out ${it.name} to ${to}`;
      } else if (a === "checkin") {
        const l = x.loans.find(o => o.id === body.loan && !o.back); if (!l) return { __abort: true, msg: "That loan is already checked in." };
        const it = item(l.item); l.back = Date.now(); l.backBy = me.name; l.condition = ["good", "damaged", "missing"].includes(body.condition) ? body.condition : "good"; l.backNotes = clean(body.notes, 300);
        if (it) { it.status = l.condition === "good" ? "in" : "repair"; note = `Checked in ${it.name} from ${l.to}${l.condition !== "good" ? ` (${l.condition === "damaged" ? "damaged" : "missing parts"})` : ""}`; }
      } else if (a === "loanDel") { x.loans = x.loans.filter(l => !(l.id === body.loan && l.back)); }
    });
    if (v.__abort) throw new HttpError(400, v.msg);
    if (note) await log(me.username, note);
    return json({ ok: true, loans: v });
  }

  /* ----- walkthroughs ----- */
  if (["walkStart", "walkMark", "walkFinish", "walkDel"].includes(a)) {
    if (!can(me, "manage")) throw new HttpError(403, "Only techs and admins can run walkthroughs.");
    let ticketId = null, note = "";
    if (a === "walkMark" && body.ok === false) {
      const text = clean(body.note, L.text) || "Problem found during a room walkthrough.";
      const walks0 = await read("walks", () => ({ list: [] })); const w0 = walks0.list.find(w => w.id === body.walk);
      const prev = w0 && w0.results && w0.results[body.device];
      if (prev && prev.ticket && prev.ok === false) ticketId = prev.ticket; // already reported in this walkthrough
      else {
        const { v: b } = await mutate("board", blankBoard, b0 => { const b = upgrade(b0); const r = b.rooms.find(x => x.id === body.room), d = r && r.devices.find(x => x.id === body.device);
          if (!d) throw new HttpError(400, "That device no longer exists.");
          const t = { id: id(), room: r.id, device: d.id, text: `${text} (Found during the walkthrough “${w0 ? w0.name : ""}”.)`, by: me.username, byName: me.name, severity: body.severity === "down" ? "down" : "issue", state: "open", opened: Date.now(), updated: Date.now(), comments: [], photos: [], seen: { [me.username]: Date.now() }, fromWalk: body.walk };
          d.manual = false; b.tickets.unshift(t); ticketId = t.id; recompute(b); b.updated = Date.now(); });
        const t = b.tickets.find(x => x.id === ticketId); try { await notify("report", t, b, me); } catch {}
      }
    }
    const { v } = await mutate("walks", () => ({ list: [] }), x => {
      x.list = x.list || []; note = "";
      if (a === "walkStart") { const name = line(body.name, L.name) || "Room walkthrough"; const rooms = Array.isArray(body.rooms) ? body.rooms.slice(0, L.rooms) : [];
        if (!rooms.length) return { __abort: true, msg: "Pick at least one room." };
        const w = { id: id(), name, rooms, results: {}, started: Date.now(), by: me.username, byName: me.name, done: null }; x.list.unshift(w); x.list = x.list.slice(0, 60); note = `Started the walkthrough “${name}”`; return { id: w.id }; }
      const w = x.list.find(o => o.id === body.walk); if (!w) return { __abort: true, msg: "That walkthrough no longer exists." };
      if (a === "walkMark") { if (body.clear) delete w.results[body.device]; else w.results[body.device] = { ok: !!body.ok, note: clean(body.note, 300), by: me.name, ts: Date.now(), ...(ticketId ? { ticket: ticketId } : {}) }; }
      if (a === "walkFinish") { w.done = body.reopen ? null : Date.now(); note = `${body.reopen ? "Reopened" : "Finished"} the walkthrough “${w.name}”`; }
      if (a === "walkDel") { x.list = x.list.filter(o => o !== w); note = `Deleted the walkthrough “${w.name}”`; }
    });
    if (v.__abort) throw new HttpError(400, v.msg);
    if (note) await log(me.username, note);
    const b = upgrade(await read("board", blankBoard));
    return json({ ok: true, walks: v.list.slice(0, 30), id: v.list[0] && a === "walkStart" ? v.list[0].id : undefined, ticket: ticketId, board: boardFor(b, me, await secret()) });
  }

  if (a === "addDisplay" || a === "deleteDisplay") {
    if (me.role !== "admin") throw new HttpError(403, "Only an admin can manage display links.");
    await mutate("meta", () => ({}), m => { m.displays = m.displays || []; if (a === "addDisplay") m.displays.push({ id: id(), name: line(body.name, L.name) || "Display", key: randomBytes(18).toString("base64url"), created: Date.now() }); else m.displays = m.displays.filter(d => d.id !== body.id); });
    await log(me.username, a === "addDisplay" ? `Made a display link: ${line(body.name, L.name) || "Display"}` : "Removed a display link");
    return json({ ok: true });
  }

  /* ----- board changes ----- */
  const manage = can(me, "manage");
  let note = "", result = {}, job = null;
  const photo = (a === "report" || a === "comment") && body.photo ? await savePhoto(body.photo) : null;
  const { v: b } = await mutate("board", blankBoard, b0 => {
    const b = upgrade(b0); note = ""; result = {}; job = null;
    const room = r => b.rooms.find(x => x.id === r);
    const dev = (r, d) => (room(r)?.devices || []).find(x => x.id === d);
    const tk = t => b.tickets.find(x => x.id === t);
    const need = ok => { if (!ok) throw new HttpError(403, "Your account can't do that."); };
    const mine = rid => me.role !== "teacher" || (me.rooms || []).includes(rid);
    const needRoom = rid => { if (!mine(rid)) throw new HttpError(403, "That room isn't assigned to your account."); };
    const devFields = (d, src) => {
      for (const k of ["name", "model", "serial", "asset", "location"]) if (src[k] != null) d[k] = line(src[k], L.field);
      if (src.notes != null) d.notes = clean(src.notes, L.text); if (src.type != null && TYPES.includes(src.type)) d.type = src.type;
      for (const k of ["purchased", "warranty"]) if (src[k] != null) { const v = String(src[k]).trim(); d[k] = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ""; if (k === "warranty" && d.warnW && d.warnW !== d.warranty) delete d.warnW; }
      for (const k of ["lampHours", "lampLife"]) if (src[k] != null) { const v = Math.round(+src[k]); d[k] = src[k] === "" || !(v >= 0) ? 0 : Math.min(v, 200000); }
      if (!(d.lampLife > 0 && d.lampHours >= d.lampLife * 0.9)) delete d.warnL;
    };
    switch (a) {
      case "report": {
        const r = room(body.room), d = dev(body.room, body.device);
        if (!r || !d) throw new HttpError(400, "That room or device no longer exists. Refresh and try again.");
        if (!mine(r.id)) throw new HttpError(403, "You can only report problems in rooms assigned to you.");
        const text = clean(body.text, L.text); if (!text) throw new HttpError(400, "Describe the problem.");
        if (b.tickets.length >= L.tickets) b.tickets = b.tickets.filter(t => t.state !== "fixed" || t.closed > Date.now() - 90 * DAY);
        const t = { id: id(), room: r.id, device: d.id, text, by: me.username, byName: me.name, severity: body.severity === "down" ? "down" : "issue", state: "open", opened: Date.now(), updated: Date.now(), comments: [], photos: photo ? [photo] : [], seen: { [me.username]: Date.now() } };
        d.manual = false; b.tickets.unshift(t); result.ticket = t.id; job = ["report", t.id]; note = `Reported ${d.name || d.type} in ${r.name}`; break;
      }
      case "comment": {
        const t = tk(body.ticket); if (!t) throw new HttpError(400, "That ticket no longer exists.");
        need(t.by === me.username || mine(t.room));
        const text = clean(body.text, L.text); if (!text && !photo) throw new HttpError(400, "Write a message first.");
        t.comments = (t.comments || []).concat({ by: me.username, byName: me.name, role: me.role, text, ts: Date.now(), ...(photo ? { photo } : {}) }).slice(-L.comments);
        job = [me.role === "teacher" ? "teacherReply" : t.by === me.username ? null : "staffReply", t.id];
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
        if (!own || manage) job = ["state", t.id];
        note = `Marked a ticket ${label.toLowerCase()} (${room(t.room)?.name || ""})`; break;
      }
      case "assign": { need(manage); const t = tk(body.ticket); if (!t) break; needRoom(t.room); t.assignee = normUser(body.assignee) || null; t.updated = Date.now(); note = "Changed who's handling a ticket"; break; }
      case "addNotice": {
        need(manage); const text = line(body.text, 200); if (!text) throw new HttpError(400, "Write what's happening.");
        const until = +body.until; if (!(until > Date.now())) throw new HttpError(400, "Pick when it ends. It has to be in the future.");
        b.notices = (b.notices || []).filter(n => !n.until || n.until > Date.now()).slice(-30);
        b.notices.push({ id: id(), text, area: line(body.area, L.name), until: Math.min(until, Date.now() + 60 * DAY), by: me.username, byName: me.name, ts: Date.now() });
        note = `Posted a notice: ${text}`; break;
      }
      case "delNotice": { need(manage); b.notices = (b.notices || []).filter(n => n.id !== body.id); note = "Removed a notice"; break; }
      case "school": need(me.role === "admin"); b.school = line(body.school, L.name); note = "Changed the school name"; break;
      case "addRoom": {
        need(manage); if (b.rooms.length >= L.rooms) throw new HttpError(400, "Room limit reached.");
        const name = line(body.name, L.name); if (!name) throw new HttpError(400, "Name the room.");
        const types = Array.isArray(body.devices) ? body.devices.slice(0, L.devices) : [];
        const r = { id: id(), name, area: line(body.area, L.name), devices: types.map(t => ({ id: id(), type: TYPES.includes(t) ? t : "Other", name: "", status: "ok" })) };
        b.rooms.push(r); result.room = r.id; note = `Added the room ${name}`; break;
      }
      case "editRoom": { need(manage); needRoom(body.room); const r = room(body.room); if (!r) break; if (body.name != null) r.name = line(body.name, L.name) || r.name; if (body.area != null) r.area = line(body.area, L.name); note = `Edited the room ${r.name}`; break; }
      case "delRoom": { need(manage); const r = room(body.room); b.rooms = b.rooms.filter(x => x.id !== body.room); b.tickets = b.tickets.filter(x => x.room !== body.room); note = `Deleted the room ${r ? r.name : ""}`; break; }
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
  if (job && job[0]) { try { await notify(job[0], b.tickets.find(t => t.id === job[1]), b, me); } catch (e) { console.error("notify failed", e); } }
  return json({ ok: true, ...result, board: boardFor(b.__abort ? upgrade(await read("board", blankBoard)) : b, me, await secret()) });
}
