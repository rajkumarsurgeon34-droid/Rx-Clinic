// Rx Clinic server — Cloudflare Worker + D1 database.
// Appointments, staff PIN sign-in, and in-app video teleconsults on LiveKit
// (the same video engine and host/waiting-room logic as SRK Meet).
//
// Bindings and settings (Cloudflare → Worker → Settings):
//   DB                  D1 database binding (tables are created automatically)
//   LIVEKIT_URL         e.g. wss://your-project.livekit.cloud            (variable)
//   LIVEKIT_API_KEY     from LiveKit Cloud → Settings → Keys              (variable)
//   LIVEKIT_API_SECRET  from the same page                               (secret)
//   ANTHROPIC_API_KEY   Claude for the AI features (used first if set)   (secret)
//   CLAUDE_MODEL        optional, defaults to claude-sonnet-5-5           (variable)
//   OPENAI_API_KEY      OpenAI for the AI features, if no Claude key     (secret)
//   OPENAI_MODEL        optional, defaults to gpt-4o-mini                (variable)
//   CLINIC_TZ_MINUTES   optional, clinic time zone offset, default 330 (India)

const enc = new TextEncoder();
const DEFAULT_PINS = { doctor: "1001", staff: "2002", pharmacy: "3003", lab: "4004", diagnostics: "5005", billing: "6006", admin: "9009" };
const STAFF_ROLES = Object.keys(DEFAULT_PINS);
const DEFAULT_CLINIC = { name: "Rx Clinic", doctor: "Dr. M. Rajkumar", qual: "MBBS, DNB General Surgery" };
const SESSIONS = [["09:00", "13:00"], ["17:00", "20:00"]];
const SLOT_MIN = 15;
const STATUSES = ["booked", "arrived", "in-call", "completed", "cancelled", "no-show"];
const ID_RE = /^[a-z0-9-]{3,64}$/;
const ROOM_RE = /^rx-[a-z0-9]{16}$/;

// ---------- small helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

async function signJwt(env, claims) {
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = b64url(await hmac(env.LIVEKIT_API_SECRET, `${header}.${body}`));
  return `${header}.${body}.${sig}`;
}

function now() { return Math.floor(Date.now() / 1000); }

function randomFrom(alphabet, n) {
  const r = crypto.getRandomValues(new Uint32Array(n));
  return Array.from(r, (x) => alphabet[x % alphabet.length]).join("");
}

function digits(s, max = 10) { return String(s || "").replace(/\D/g, "").slice(-max); }
function clean(s, max) { return String(s || "").trim().slice(0, max); }
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function secret(env) {
  const s = env.APP_SECRET || env.LIVEKIT_API_SECRET;
  if (!s) throw new HttpError(500, "Server is missing LIVEKIT_API_SECRET");
  return s;
}

// Clinic-local date and minutes (the worker runs in UTC).
function clinicNow(env) {
  const off = Number(env.CLINIC_TZ_MINUTES ?? 330);
  const d = new Date(Date.now() + off * 60000);
  const iso = d.toISOString().slice(0, 10);
  return { date: iso, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function allSlots() {
  const out = [];
  for (const [a, b] of SESSIONS) {
    let [h, m] = a.split(":").map(Number);
    const [eh, em] = b.split(":").map(Number);
    while (h * 60 + m < eh * 60 + em) {
      out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
      m += SLOT_MIN;
      if (m >= 60) { h++; m -= 60; }
    }
  }
  return out;
}

// ---------- database ----------

let schemaReady = false;
async function db(env) {
  if (!env.DB) throw new HttpError(500, "Database not connected: add a D1 binding named DB");
  if (!schemaReady) {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)"),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL,
        mode TEXT NOT NULL, status TEXT NOT NULL, name TEXT NOT NULL, age TEXT, sex TEXT,
        phone TEXT NOT NULL, reason TEXT, lang TEXT, code TEXT NOT NULL, room TEXT, source TEXT)`),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS appt_date ON appointments(date)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS appt_code ON appointments(code)"),
      // General record store for the next stages (visits, ward, lab, pharmacy).
      env.DB.prepare("CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (coll, id))"),
    ]);
    // Older databases: add the patient link to appointments (fails harmlessly once it exists).
    try { await env.DB.prepare("ALTER TABLE appointments ADD COLUMN patient_id TEXT").run(); } catch { /* already there */ }
    schemaReady = true;
  }
  return env.DB;
}

async function getSetting(env, k, fallback) {
  const row = await (await db(env)).prepare("SELECT v FROM settings WHERE k = ?").bind(k).first();
  if (!row) return fallback;
  try { return JSON.parse(row.v); } catch { return fallback; }
}

async function setSetting(env, k, v) {
  await (await db(env)).prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(k, JSON.stringify(v)).run();
}

function publicAppt(r) {
  return {
    patientId: r.patient_id || "", id: r.id, date: r.date, time: r.time, mode: r.mode, status: r.status, name: r.name, age: r.age || "",
    sex: r.sex || "", phone: r.phone, reason: r.reason || "", lang: r.lang || "en", code: r.code,
  };
}

// ---------- accounts and sessions ----------
// Staff: user accounts (username + password) created by the admin, many per role.
// Patients: registered with a Patient ID (RX100001…), linked to a mobile number and/or Aadhaar.
// Session token: role.uid.ver.exp.sig  (ver changes when the password is reset or the account is disabled).

const USER_RE = /^[a-z0-9._-]{3,32}$/;
const PBKDF2_ITER = 20000; // kept modest for the Workers CPU limit; the count is stored with each hash

async function hashPassword(pw, iter = PBKDF2_ITER, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
  return `pbkdf2$${iter}$${btoa(String.fromCharCode(...salt))}$${btoa(String.fromCharCode(...bits))}`;
}
async function checkPassword(pw, stored) {
  const [kind, iter, salt] = String(stored || "").split("$");
  if (kind !== "pbkdf2" || !salt) return false;
  return safeEqual(await hashPassword(String(pw || ""), Number(iter), salt), stored);
}
function validPassword(pw) {
  pw = String(pw || "");
  if (pw.length < 6) throw new HttpError(400, "Password must be at least 6 characters");
  if (pw.length > 72) throw new HttpError(400, "Password is too long");
  return pw;
}

// Lock an account for 15 minutes after 5 wrong passwords.
async function checkLock(env, key) {
  const f = await getDoc(env, "loginfail", key);
  if (f && f.until > Date.now()) throw new HttpError(429, "Too many wrong attempts. Try again in 15 minutes.");
}
async function noteFail(env, key) {
  const f = (await getDoc(env, "loginfail", key)) || { n: 0, until: 0 };
  f.n = f.until && f.until < Date.now() ? 1 : f.n + 1;
  f.until = f.n >= 5 ? Date.now() + 15 * 60000 : 0;
  if (f.n >= 5) f.n = 0;
  await putDoc(env, "loginfail", key, f);
}
async function clearFail(env, key) { await (await db(env)).prepare("DELETE FROM docs WHERE coll = 'loginfail' AND id = ?").bind(key).run(); }

async function makeSession(env, role, uid = "pin", ver = 0, hours = 12) {
  const exp = now() + hours * 3600;
  const sig = b64url(await hmac(secret(env), `session:${role}.${uid}.${ver}.${exp}`)).slice(0, 32);
  return `${role}.${uid}.${ver}.${exp}.${sig}`;
}

/** Checks a session token; returns { role, uid, user }. */
async function readSession(env, session) {
  const [role, uid, ver, exp, sig] = String(session || "").split(".");
  if (!role || !uid || !exp || !sig) throw new HttpError(401, "Sign in again");
  if (Number(exp) < now()) throw new HttpError(401, "Sign in again: your session expired");
  const expected = b64url(await hmac(secret(env), `session:${role}.${uid}.${ver}.${exp}`)).slice(0, 32);
  if (!safeEqual(expected, sig)) throw new HttpError(401, "Sign in again");
  if (uid === "pin") { // old PIN sign-in (app 0.5), allowed only until the admin sets up accounts
    if (await accountsReady(env)) throw new HttpError(401, "Sign in again with your username and password");
    return { role, uid, user: { name: role === "doctor" || role === "admin" ? (await clinicInfo(env)).doctor : role, role } };
  }
  const user = await getDoc(env, role === "patient" ? "patients" : "users", uid);
  if (!user || user.active === false || String(user.ver || 0) !== String(ver)) throw new HttpError(401, "Sign in again");
  if (role !== "patient" && user.role !== role) throw new HttpError(401, "Sign in again");
  return { role, uid, user };
}

async function requireUser(env, session, roles) {
  const s = await readSession(env, session);
  if (s.role === "patient" || !(roles.includes(s.role) || s.role === "admin")) throw new HttpError(403, "Your login can't open this section");
  return s;
}
async function requireStaff(env, session, roles) { return (await requireUser(env, session, roles)).role; }
async function requirePatient(env, session) {
  const s = await readSession(env, session);
  if (s.role !== "patient") throw new HttpError(401, "Sign in as a patient");
  return s;
}

async function clinicInfo(env) { return Object.assign({}, DEFAULT_CLINIC, await getSetting(env, "clinic", {})); }

/** True once the admin has signed in with the new accounts and changed the starting password. */
async function accountsReady(env) { return !!(await getSetting(env, "accounts_ready", false)); }

/** First run: create the admin account (admin / admin123, must be changed at first sign-in). */
async function ensureAdmin(env) {
  const row = await (await db(env)).prepare("SELECT id FROM docs WHERE coll = 'users' LIMIT 1").first();
  if (row) return;
  await putDoc(env, "users", "admin", {
    username: "admin", name: "Administrator", role: "admin", passHash: await hashPassword("admin123"),
    mustChange: true, active: true, ver: 0, created: Date.now(), createdBy: "setup",
  });
}

function publicUser(id, u) {
  return { id, username: u.username, name: u.name, role: u.role, qual: u.qual || "", reg: u.reg || "", phone: u.phone || "",
    active: u.active !== false, mustChange: !!u.mustChange, created: u.created || 0, lastLogin: u.lastLogin || 0, branch: u.branch || "" };
}

async function findUser(env, username) {
  const r = await (await db(env)).prepare("SELECT id, data FROM docs WHERE coll = 'users' AND json_extract(data, '$.username') = ?").bind(username).first();
  return r ? { id: r.id, u: JSON.parse(r.data) } : null;
}

// ----- patients -----

// Verhoeff checksum used by Aadhaar numbers.
const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
function validAadhaar(n) {
  if (!/^[2-9]\d{11}$/.test(n)) return false;
  let c = 0;
  n.split("").reverse().forEach((d, i) => { c = VD[c][VP[i % 8][Number(d)]]; });
  return c === 0;
}
// Aadhaar is never stored in full: only a keyed hash (to find the patient) and the last 4 digits.
async function aadhaarKey(env, n) { return b64url(await hmac(secret(env), "aadhaar:" + n)); }

function normAadhaar(v) {
  const n = String(v || "").replace(/\D/g, "");
  if (!n) return "";
  if (!validAadhaar(n)) throw new HttpError(400, "That Aadhaar number is not valid. Check the 12 digits.");
  return n;
}

async function nextPatientId(env) {
  const r = await (await db(env)).prepare("INSERT INTO settings (k, v) VALUES ('patient_seq', '100001') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1 RETURNING v").first();
  return "RX" + r.v;
}

function publicPatient(id, p) {
  return { id, name: p.name, age: p.age || "", sex: p.sex || "", phone: p.phone || "", aadhaar: p.aadhaarLast4 ? "XXXX XXXX " + p.aadhaarLast4 : "",
    address: p.address || "", hasLogin: !!p.passHash, created: p.created || 0 };
}

async function patientByAadhaar(env, n) {
  const key = await aadhaarKey(env, n);
  return (await listDocs(env, "patients", "json_extract(data, '$.aadhaarKey') = ?", [key]))[0] || null;
}

/** Creates a patient record from a request body; returns { id, p }. */
async function createPatient(env, b, createdBy, password) {
  const name = clean(b.name, 60);
  if (!name) throw new HttpError(400, "Enter the patient's name");
  const phone = digits(b.phone);
  if (phone && phone.length !== 10) throw new HttpError(400, "Enter a 10-digit mobile number");
  const aadhaar = normAadhaar(b.aadhaar);
  if (!phone && !aadhaar) throw new HttpError(400, "Enter a mobile number or an Aadhaar number");
  if (aadhaar) {
    const old = await patientByAadhaar(env, aadhaar);
    if (old) throw Object.assign(new HttpError(409, "This Aadhaar number is already registered"), { existing: old.id });
  }
  const id = await nextPatientId(env);
  const p = {
    name, age: clean(b.age, 3), sex: clean(b.sex, 10), phone, address: clean(b.address, 200),
    aadhaarKey: aadhaar ? await aadhaarKey(env, aadhaar) : "", aadhaarLast4: aadhaar ? aadhaar.slice(-4) : "",
    passHash: password ? await hashPassword(validPassword(password)) : "", ver: 0, active: true, created: Date.now(), createdBy,
  };
  await putDoc(env, "patients", id, p);
  return { id, p };
}

/** Finds the patient a login refers to: Patient ID, Aadhaar, or mobile number. */
async function patientsForLogin(env, login) {
  const t = String(login || "").trim().toUpperCase().replace(/\s/g, "");
  if (/^RX\d{6,}$/.test(t)) { const p = await getDoc(env, "patients", t); return p ? [Object.assign({ id: t }, p)] : []; }
  const d = t.replace(/\D/g, "");
  if (d.length === 12) { const p = validAadhaar(d) ? await patientByAadhaar(env, d) : null; return p ? [p] : []; }
  if (d.length >= 10) return listDocs(env, "patients", "json_extract(data, '$.phone') = ?", [d.slice(-10)]);
  return [];
}

async function patientHistory(env, pid) {
  const visits = (await listDocs(env, "visits", "json_extract(data, '$.patient.id') = ?", [pid])).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 50);
  const out = [];
  for (const v of visits) {
    const orders = await listDocs(env, "orders", "json_extract(data, '$.visitId') = ?", [v.id]);
    out.push({
      id: v.id, date: v.date, token: v.token, status: v.status, complaint: visitSummary(v.id, v).complaint,
      diagnosis: v.rx?.dx || v.work?.provisional?.diagnosis || "", doctor: v.doctor?.name || "",
      rx: v.status === "sent" || v.status === "dispensed" ? v.rx : null,
      reports: orders.map((o) => ({ test: o.test, modality: o.modality, status: o.status, result: o.status === "reported" ? o.result : "", impression: o.status === "reported" ? o.impression : "", date: o.date })),
    });
  }
  return out;
}

// ---------- LiveKit (same approach as the SRK Meet server) ----------

function liveKitReady(env) { return !!(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET); }

function apiBase(env) {
  return env.LIVEKIT_URL.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/+$/, "");
}

async function roomService(env, method, body, room) {
  const token = await signJwt(env, {
    iss: env.LIVEKIT_API_KEY, sub: "rx-clinic-server", nbf: now() - 10, exp: now() + 600,
    video: { room, roomAdmin: true, roomCreate: true, roomList: true },
  });
  const res = await fetch(`${apiBase(env)}/twirp/livekit.RoomService/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `LiveKit ${method}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function getParticipant(env, room, identity) {
  try { return await roomService(env, "GetParticipant", { room, identity }, room); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

function roleOf(info) {
  try { return JSON.parse(info?.metadata || "{}").role || "guest"; } catch { return "guest"; }
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "guest";
}

async function issueToken(env, { room, name, identity, role }) {
  const full = role !== "waiting";
  return signJwt(env, {
    iss: env.LIVEKIT_API_KEY, sub: identity, jti: identity, name,
    metadata: JSON.stringify({ role }),
    nbf: now() - 10, exp: now() + 4 * 3600,
    video: { room, roomJoin: true, canPublish: full, canSubscribe: full, canPublishData: full, canUpdateOwnMetadata: full },
  });
}

async function ensureRoom(env, appt) {
  if (appt.room && ROOM_RE.test(appt.room)) return appt.room;
  const room = "rx-" + randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 16);
  await (await db(env)).prepare("UPDATE appointments SET room = ? WHERE id = ?").bind(room, appt.id).run();
  return room;
}

// ---------- OpenAI ----------

const DOCTOR_SYSTEM = "You assist qualified doctors in an Indian hospital. The doctor makes every decision. Be accurate and concise.";

async function askOpenAI(env, prompt, wantJson, system = DOCTOR_SYSTEM) {
  return chatOpenAI(env, [{ role: "system", content: system }, { role: "user", content: prompt }], wantJson);
}

// Pulls one JSON object out of a model's reply (tolerates code fences or a sentence around it).
function parseJsonReply(text) {
  try { return JSON.parse(text); } catch { /* try harder */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* fall through */ } }
  throw new HttpError(502, "The AI reply was not valid JSON. Try again.");
}

// Claude (Anthropic) is used when ANTHROPIC_API_KEY is set; otherwise OpenAI.
async function chatClaude(env, messages, wantJson) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = [];
  for (const m of messages.filter((x) => x.role !== "system")) {
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content; // Claude needs alternating turns
    else turns.push({ role: m.role, content: m.content });
  }
  if (!turns.length || turns[0].role !== "user") turns.unshift({ role: "user", content: "Begin." });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-sonnet-5-5",
      max_tokens: 4000,
      system: system + (wantJson ? "\n\nReply with only one valid JSON object and no other text." : ""),
      messages: turns,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, data?.error?.message || `AI error (${res.status})`);
  const text = (data?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return wantJson ? { json: parseJsonReply(text) } : { text };
}

// Cloudflare Workers AI: free daily allowance, no API key (binding "AI" in wrangler.toml).
async function chatWorkersAI(env, messages, wantJson) {
  if (!env.AI) throw new HttpError(503, "AI is not set up yet: add ANTHROPIC_API_KEY or OPENAI_API_KEY in the worker settings");
  const msgs = messages.map((m) => ({ role: m.role, content: m.content }));
  if (wantJson && msgs[0]?.role === "system") msgs[0] = { role: "system", content: msgs[0].content + "\n\nReply with only one valid JSON object and no other text." };
  let out;
  try {
    out = await env.AI.run(env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: msgs, max_tokens: 2500 });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/neuron|limit|quota|429/i.test(msg)) throw new HttpError(429, "Today's free AI allowance is used up. It resets at 5:30 am, or add a Claude or OpenAI key.");
    throw new HttpError(502, "AI error: " + msg);
  }
  const r = out?.response;
  if (r && typeof r === "object") return wantJson ? { json: r } : { text: JSON.stringify(r) };
  const text = String(r || "");
  return wantJson ? { json: parseJsonReply(text) } : { text };
}

// Order: Claude key → OpenAI key → free Cloudflare Workers AI. A paid provider that fails
// for billing reasons (no credit, quota) falls back to Workers AI so the clinic keeps working.
async function chatOpenAI(env, messages, wantJson) {
  const fallback = async (e) => {
    if (env.AI && /credit|quota|billing|insufficient|429|balance/i.test(String(e?.message))) return chatWorkersAI(env, messages, wantJson);
    throw e;
  };
  if (env.ANTHROPIC_API_KEY) { try { return await chatClaude(env, messages, wantJson); } catch (e) { return fallback(e); } }
  if (env.OPENAI_API_KEY) { try { return await chatOpenAIDirect(env, messages, wantJson); } catch (e) { return fallback(e); } }
  return chatWorkersAI(env, messages, wantJson);
}

async function chatOpenAIDirect(env, messages, wantJson) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
      ...(wantJson ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, data?.error?.message || `AI error (${res.status})`);
  const text = data?.choices?.[0]?.message?.content || "";
  if (!wantJson) return { text };
  return { json: parseJsonReply(text) };
}

// ---------- patient check-in (AI history taking) ----------

const LANG_NAMES = { en: "English", ta: "Tamil", hi: "Hindi" };

function intakeRules(lang, age, sex) {
  const L = LANG_NAMES[lang] || "English";
  return `You are the history-taking assistant of an Indian outpatient clinic (general surgery and general medicine). You interview the PATIENT on a phone or tablet before the doctor sees them.
Patient: ${age} years, ${sex}.
Language: write every question and option in ${L}${lang === "en" ? "" : " script"}, in simple everyday words a non-medical person understands. Medical terms may follow in brackets.
Rules:
- One short question per turn, like a careful resident taking history. Offer 2-6 tappable answer options in the same language when sensible; set "multi": true when several may apply. The patient can also type freely.
- Cover: chief complaints with duration; history of the presenting illness explored like a clinician (site, onset, character, radiation, severity, timing, aggravating and relieving factors, associated symptoms relevant to the complaint); red-flag symptoms; past illnesses (diabetes, hypertension, TB, asthma, heart disease, thyroid, epilepsy, jaundice); past surgeries; blood transfusions; drug allergies; current medicines; habits (smoking, alcohol, tobacco chewing); diet; sleep; appetite; bowel and bladder; menstrual and obstetric history if female aged 12-55; family history.
- Never diagnose, reassure or advise treatment.
- If the patient reports an emergency symptom happening now (chest pain, severe breathlessness, heavy bleeding, fainting, confusion, thoughts of self-harm), set "urgent": true and begin that question by asking them to tell the staff immediately.
- Finish when you have enough for a complete case sheet, usually 12-20 questions.
Reply with ONLY one JSON object:
{"done": false, "question": "...", "options": ["..."], "multi": false, "urgent": false}
When finished reply: {"done": true, "closing": "<one thank-you sentence in ${L}>"}`;
}

function caseSheetPrompt(qa, age, sex, lang) {
  return `Convert this outpatient intake interview into a structured case sheet in ENGLISH for the treating doctor. The patient answered in ${LANG_NAMES[lang] || "English"}; translate faithfully. Use only what the patient said. Write "Not asked" for topics not covered and "Nil" for denied ones. Do not diagnose.
Patient: ${age} years, ${sex}.
Interview:
${qa.map((x, i) => `Q${i + 1}: ${x.q}\nA: ${x.a}`).join("\n")}
Reply with ONLY this JSON:
{"chiefComplaints":[{"complaint":"","duration":""}],"hpi":"one clinical paragraph","past":{"medical":"","surgical":"","transfusion":"","drugs":"","allergies":""},"habits":{"smoking":"","alcohol":"","tobacco":"","diet":"","sleep":"","appetiteBowelBladder":""},"menstrualObstetric":"","family":"","redFlags":[]}`;
}

async function getDoc(env, coll, id) {
  const r = await (await db(env)).prepare("SELECT data FROM docs WHERE coll = ? AND id = ?").bind(coll, id).first();
  return r ? JSON.parse(r.data) : null;
}

async function putDoc(env, coll, id, data) {
  await (await db(env)).prepare("INSERT INTO docs (coll, id, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(coll, id) DO UPDATE SET data = excluded.data, updated = excluded.updated")
    .bind(coll, id, JSON.stringify(data), Date.now()).run();
}

function visitSummary(id, v) {
  const cc = (v.caseSheet?.chiefComplaints || []).map((c) => c.complaint + (c.duration ? " · " + c.duration : "")).join("; ") || v.qa?.[0]?.a || "";
  return { id, token: v.token, date: v.date, createdAt: v.createdAt, status: v.status, urgent: !!v.urgent, lang: v.lang, patient: v.patient, complaint: cc };
}

// ---------- orders, pharmacy, nursing ----------

const IMAGING = [
  ["PET-CT", /\bpet\b|pet[- ]?ct/i], ["MRI", /\bmri\b|\bmrcp\b|magnetic resonance/i], ["CT", /\bct\b|\bcect\b|\bhrct\b|computed tomograph/i],
  ["USG", /\busg\b|ultrasound|ultrasonograph|sonograph|doppler|\becho\b|\bfast\b/i], ["X-ray", /x[- ]?ray|\bcxr\b|radiograph/i],
  ["Mammogram", /mammo/i], ["Endoscopy", /endoscop|colonoscop|\bogd\b|\bercp\b/i],
];
function classifyTest(name) {
  for (const [modality, re] of IMAGING) if (re.test(name)) return { kind: "imaging", modality };
  return { kind: "lab", modality: "Lab" };
}

async function listDocs(env, coll, where = "", args = []) {
  const rows = (await (await db(env)).prepare(`SELECT id, data FROM docs WHERE coll = ?${where ? " AND " + where : ""}`).bind(coll, ...args).all()).results || [];
  return rows.map((r) => Object.assign({ id: r.id }, JSON.parse(r.data)));
}

// ---------- subscription plans ----------
// Bronze: 1 doctor, OPD. Silver: 2–4 doctors + inpatient. Gold: 5–20 doctors, full hospital. Platinum: 21+, OT, units, branches.
// true = included, "addon" = needs the add-on switched on, false = not in the plan.
const PLANS = {
  bronze:   { name: "Bronze",   maxDoctors: 1,    maxStaff: 3,    fee: 0,     f: { lab: "addon", diagnostics: false, ip: false, ot: false, insurance: "addon", homecare: false, mobileunit: false, chat: false, reports: false, expenses: false, goals: false, templates: false, nondrug: false, purchase: false, branches: false, bookingfee: "addon" } },
  silver:   { name: "Silver",   maxDoctors: 4,    maxStaff: 10,   fee: 2000,  f: { lab: true, diagnostics: true, ip: true, ot: false, insurance: "addon", homecare: "addon", mobileunit: false, chat: true, reports: true, expenses: true, goals: false, templates: false, nondrug: true, purchase: false, branches: false, bookingfee: "addon" } },
  gold:     { name: "Gold",     maxDoctors: 20,   maxStaff: 9999, fee: 7500,  f: { lab: true, diagnostics: true, ip: true, ot: "addon", insurance: true, homecare: true, mobileunit: "addon", chat: true, reports: true, expenses: true, goals: true, templates: true, nondrug: true, purchase: true, branches: false, bookingfee: true } },
  platinum: { name: "Platinum", maxDoctors: 9999, maxStaff: 9999, fee: 20000, f: { lab: true, diagnostics: true, ip: true, ot: true, insurance: true, homecare: true, mobileunit: true, chat: true, reports: true, expenses: true, goals: true, templates: true, nondrug: true, purchase: true, branches: "addon", bookingfee: true } },
};
const FEATURE_NAMES = { lab: "Lab", diagnostics: "Diagnostics", ip: "Inpatient", ot: "Operation theatre", insurance: "Insurance desk", homecare: "Home care", mobileunit: "Mobile unit", chat: "Patient chat", reports: "Sales reports", expenses: "Expenses ledger", goals: "Sales goals", templates: "Speciality templates", nondrug: "Non-drug items", purchase: "Supplier purchases", branches: "Branches", bookingfee: "Online booking fee" };

async function planInfo(env) {
  const p = await getSetting(env, "plan", { tier: "platinum", addons: [] }); // new installs start on Platinum (trial) so every feature can be tried
  if (!p.expires) { p.expires = addDays(clinicNow(env).date, 30); p.trial = true; await setSetting(env, "plan", p); }
  const tier = PLANS[p.tier] ? p.tier : "platinum";
  const def = PLANS[tier];
  const features = {};
  for (const [k, v] of Object.entries(def.f)) features[k] = v === true || (v === "addon" && (p.addons || []).includes(k));
  return { tier, name: def.name, maxDoctors: def.maxDoctors, maxStaff: def.maxStaff, fee: def.fee, addons: p.addons || [], available: def.f, features,
    expires: p.expires, trial: !!p.trial, expired: p.expires < clinicNow(env).date };
}
async function needFeature(env, key) {
  const pl = await planInfo(env);
  if (!pl.features[key]) throw new HttpError(403, `${FEATURE_NAMES[key] || key} is not in your ${pl.name} plan. The admin can upgrade under Admin → Plan.`);
}

// ---------- documents: certificates, referral letters, timeslips ----------
const LETTER_TYPES = { certificate: "Medical certificate", fitness: "Fitness certificate", referral: "Referral letter", timeslip: "Timeslip" };

// ---------- billing ----------
// Department bills (pharmacy, lab, diagnostics, OPD) and inpatient (IP) admissions with a final bill.
// Amounts are in rupees; medicine prices are MRP (tax included); clinical services carry no GST.

const DEPTS = { pharmacy: "PH", lab: "LB", diagnostics: "DG", opd: "OP", ip: "IP" };
const DEPT_ROLES = { pharmacy: ["pharmacy"], lab: ["lab"], diagnostics: ["diagnostics"], opd: ["billing", "staff"], ip: ["billing"] };
const PAY_MODES = ["Cash", "UPI", "Card", "Insurance", "Advance", "Other"];
const money = (x) => Math.round((Number(x) || 0) * 100) / 100;

// Example prices so billing works on day one. The admin edits them under Admin → Price list.
const DEFAULT_TARIFF = [
  ["opd", "Registration", 100, "each"], ["opd", "Consultation", 500, "each"], ["opd", "Review consultation", 300, "each"],
  ["opd", "Dressing", 200, "each"], ["opd", "Injection charges", 100, "each"], ["opd", "Minor procedure", 1500, "each"],
  ["lab", "CBC", 300, "each"], ["lab", "LFT", 600, "each"], ["lab", "RFT", 600, "each"], ["lab", "RBS", 100, "each"],
  ["lab", "FBS", 100, "each"], ["lab", "PPBS", 100, "each"], ["lab", "HbA1c", 500, "each"], ["lab", "Lipid profile", 600, "each"],
  ["lab", "Thyroid profile", 600, "each"], ["lab", "TSH", 400, "each"], ["lab", "Urine routine", 150, "each"], ["lab", "Serum electrolytes", 500, "each"],
  ["lab", "Serum amylase", 500, "each"], ["lab", "Serum lipase", 700, "each"], ["lab", "PT INR", 400, "each"], ["lab", "Blood grouping", 150, "each"],
  ["lab", "HIV HBsAg HCV", 900, "each"], ["lab", "CRP", 400, "each"], ["lab", "ESR", 100, "each"],
  ["diagnostics", "USG abdomen", 1200, "each"], ["diagnostics", "USG pelvis", 1000, "each"], ["diagnostics", "USG neck", 1000, "each"],
  ["diagnostics", "Doppler", 2000, "each"], ["diagnostics", "Chest X-ray", 400, "each"], ["diagnostics", "X-ray", 400, "each"],
  ["diagnostics", "CT brain", 2500, "each"], ["diagnostics", "CECT abdomen", 6000, "each"], ["diagnostics", "HRCT chest", 4000, "each"],
  ["diagnostics", "MRI brain", 6500, "each"], ["diagnostics", "MRI spine", 7000, "each"], ["diagnostics", "MRCP", 7500, "each"],
  ["diagnostics", "PET-CT whole body", 22000, "each"], ["diagnostics", "Mammogram", 1500, "each"], ["diagnostics", "UGI endoscopy", 2500, "each"],
  ["diagnostics", "Colonoscopy", 4500, "each"], ["diagnostics", "ECG", 250, "each"], ["diagnostics", "Echo", 2000, "each"],
  ["ip", "General ward", 1500, "per day"], ["ip", "Semi-private room", 3000, "per day"], ["ip", "Private room", 5000, "per day"],
  ["ip", "ICU", 10000, "per day"], ["ip", "Nursing charges", 500, "per day"], ["ip", "Doctor visit", 500, "each"],
  ["ip", "Surgeon fee", 20000, "each"], ["ip", "Anaesthetist fee", 8000, "each"], ["ip", "OT charges", 15000, "each"],
  ["ip", "Consumables", 0, "each"], ["ip", "Oxygen", 1000, "per day"],
];

async function tariff(env, dept) {
  let list = await listDocs(env, "tariff");
  if (!list.length && !(await getSetting(env, "tariff_seeded", false))) {
    for (const [d, name, price, unit] of DEFAULT_TARIFF) await putDoc(env, "tariff", crypto.randomUUID(), { dept: d, name, price, unit });
    await setSetting(env, "tariff_seeded", true);
    list = await listDocs(env, "tariff");
  }
  return list.filter((t) => !dept || t.dept === dept).sort((a, b) => a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name));
}

/** Best price-list match for a test name (word overlap). */
function matchTariff(list, name) {
  const words = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const w = words(name);
  let best = null, score = 0;
  for (const t of list) {
    const tw = words(t.name);
    const hit = tw.filter((x) => w.includes(x)).length;
    const sc = hit / Math.max(tw.length, 1) + (t.name.toLowerCase() === name.toLowerCase() ? 1 : 0);
    if (hit && sc > score) { best = t; score = sc; }
  }
  return score >= 0.5 ? best : null;
}

/** Units to dispense from a prescription line: frequency (1-0-1) × days. */
function rxQuantity(r) {
  const form = String(r.form || "").toLowerCase();
  if (/syr|susp|cream|oint|gel|drop|lotion|inhal|spray|powder|sachet/.test(form)) return 1;
  const parts = String(r.frequency || "").match(/\d+(\.\d+)?|½/g) || [];
  let perDay = parts.reduce((a, x) => a + (x === "½" ? 0.5 : Number(x)), 0);
  if (!perDay) perDay = /sos|as needed|stat/i.test(`${r.frequency} ${r.timing}`) ? 0 : 1;
  const d = String(r.duration || "").toLowerCase();
  const n = Number((d.match(/\d+/) || [0])[0]);
  const days = /month/.test(d) ? n * 30 : /week/.test(d) ? n * 7 : n;
  const doses = String(r.dose || "").match(/^\s*(\d+(\.\d+)?)/);
  const per = doses ? Number(doses[1]) : 1;
  return Math.max(1, Math.ceil(perDay * per * (days || 1)));
}

function findStock(stock, generic) {
  const g = String(generic || "").toLowerCase();
  if (!g) return null;
  return stock.find((s) => s.generic.toLowerCase() === g) || stock.find((s) => s.generic.length >= 4 && (g.includes(s.generic.toLowerCase()) || s.generic.toLowerCase().includes(g))) || null;
}

async function nextNo(env, key, prefix) {
  const r = await (await db(env)).prepare("INSERT INTO settings (k, v) VALUES (?, '1') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1 RETURNING v").bind("seq_" + key).first();
  return `${prefix}-${String(r.v).padStart(6, "0")}`;
}

function billPatient(p) { return { id: p?.id || "", name: clean(p?.name, 60), age: clean(p?.age, 3), sex: clean(p?.sex, 10), phone: digits(p?.phone) }; }

function computeBill(b) {
  b.items = (Array.isArray(b.items) ? b.items : []).slice(0, 200).map((it) => {
    const qty = Math.max(0, Number(it.qty) || 0), rate = Math.max(0, money(it.rate));
    return { desc: clean(it.desc, 160), qty, rate, amount: money(qty * rate), unit: clean(it.unit, 20), ref: typeof it.ref === "string" ? it.ref.slice(0, 64) : "" };
  }).filter((it) => it.desc && it.qty > 0);
  b.subtotal = money(b.items.reduce((a, it) => a + it.amount, 0));
  b.discount = Math.min(b.subtotal, Math.max(0, money(b.discount)));
  b.total = money(b.subtotal - b.discount);
  b.paid = money((b.payments || []).reduce((a, x) => a + x.amount, 0));
  b.balance = money(b.total - b.paid);
  if (b.status !== "cancelled" && b.status !== "to-ip" && b.status !== "on-ip-bill") b.status = b.total > 0 && b.paid >= b.total ? "paid" : b.paid > 0 ? "partial" : "unpaid";
  return b;
}

/** Pharmacy: keeps stock in step with what a bill dispenses. */
async function applyStock(env, bill, restore = false) {
  const want = {};
  if (!restore) for (const it of bill.items) if (it.ref) want[it.ref] = (want[it.ref] || 0) + it.qty;
  const had = bill.stockApplied || {};
  for (const ref of new Set([...Object.keys(want), ...Object.keys(had)])) {
    const delta = (want[ref] || 0) - (had[ref] || 0);
    if (!delta) continue;
    const s = await getDoc(env, "stock", ref);
    if (!s) continue;
    s.stock = Math.max(0, (Number(s.stock) || 0) - delta);
    useBatches(s, delta);
    await putDoc(env, "stock", ref, s);
  }
  bill.stockApplied = want;
}

/** Keeps batch quantities in step with stock: issue from the earliest expiry first; returns go back to the latest batch. */
function useBatches(s, delta) {
  if (!Array.isArray(s.batches) || !s.batches.length) return;
  s.batches.sort((a, b) => String(a.expiry || "9999").localeCompare(String(b.expiry || "9999")));
  if (delta > 0) { let left = delta; for (const b of s.batches) { const t = Math.min(b.qty, left); b.qty -= t; left -= t; if (!left) break; } }
  else s.batches[s.batches.length - 1].qty += -delta;
  s.batches = s.batches.filter((b) => b.qty > 0).slice(-50);
}

// ---------- notifications ----------
async function notify(env, n) {
  // n: { to: "role:doctor" | "user:<name>", title, body, link }
  await putDoc(env, "notifications", crypto.randomUUID(), { to: clean(n.to, 100), title: clean(n.title, 120), body: clean(n.body, 400), link: clean(n.link, 120), at: Date.now(), readBy: [] });
}

// ---------- simple records (expenses, suppliers, insurance, home care, camps, wards, goals, branches, packages) ----------
const REC = {
  expenses: { read: ["billing"], write: ["billing"], feature: "expenses" },
  suppliers: { read: ["pharmacy", "billing"], write: ["pharmacy"], feature: "purchase" },
  policies: { read: ["billing", "staff", "doctor"], write: ["billing", "staff"], feature: "insurance" },
  claims: { read: ["billing", "doctor"], write: ["billing"], feature: "insurance" },
  corporates: { read: ["billing"], write: ["billing"], feature: "insurance" },
  homevisits: { read: ["staff", "doctor", "billing"], write: ["staff", "doctor", "billing"], feature: "homecare" },
  camps: { read: ["staff", "doctor", "billing"], write: ["staff", "doctor"], feature: "mobileunit" },
  campregs: { read: ["staff", "doctor"], write: ["staff", "doctor"], feature: "mobileunit" },
  wards: { read: ["staff", "doctor", "billing"], write: [], feature: "ip" },
  goals: { read: ["billing"], write: [], feature: "goals" },
  branches: { read: ["doctor", "staff", "billing", "pharmacy", "lab", "diagnostics"], write: [] },
  packages: { read: ["billing", "staff", "doctor"], write: [] },
};
function sanitize(v, depth = 0) {
  if (depth > 5) return null;
  if (typeof v === "string") return v.trim().slice(0, 4000);
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "boolean" || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 300).map((x) => sanitize(x, depth + 1));
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 100).map(([k, x]) => [String(k).slice(0, 60), sanitize(x, depth + 1)]));
  return null;
}

function canDept(role, dept) { return role === "admin" || (DEPT_ROLES[dept] || []).includes(role); }

function payment(x, by) {
  const amount = money(x?.amount);
  if (amount <= 0) return null;
  const mode = PAY_MODES.includes(x.mode) ? x.mode : "Cash";
  return { amount, mode, ref: clean(x.ref, 60), at: Date.now(), by };
}

async function activeAdmission(env, pid) {
  if (!pid) return null;
  return (await listDocs(env, "admissions", "json_extract(data, '$.patient.id') = ? AND json_extract(data, '$.status') = 'admitted'", [pid]))[0] || null;
}

/** Live inpatient account: room days, charges, department bills sent to IP, advances. */
async function ipAccount(env, a) {
  const end = a.dischargedAt || Date.now();
  const days = Math.max(1, Math.ceil((end - a.admittedAt) / 86400000));
  const lines = [];
  if (a.wardRate > 0) lines.push({ desc: `${a.ward} (${days} day${days > 1 ? "s" : ""})`, qty: days, rate: a.wardRate, amount: money(days * a.wardRate), kind: "room" });
  for (const c of a.charges || []) lines.push(Object.assign({ kind: "charge" }, c));
  const deptBills = (await listDocs(env, "bills", "json_extract(data, '$.admissionId') = ?", [a.id])).filter((b) => b.status === "to-ip" || b.status === "on-ip-bill");
  for (const b of deptBills) lines.push({ desc: `${b.deptName} bill ${b.no}`, qty: 1, rate: b.total, amount: b.total, kind: "bill", billId: b.id });
  const total = money(lines.reduce((x, l) => x + l.amount, 0));
  const advance = money((a.deposits || []).reduce((x, d) => x + d.amount, 0));
  return { days, lines, total, advance, due: money(total - advance) };
}

const DEPT_NAMES = { pharmacy: "Pharmacy", lab: "Lab", diagnostics: "Diagnostics", opd: "OPD", ip: "Inpatient" };

// ---------- routes ----------

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS") return json({ ok: true });

  if (request.method === "GET") {
    // Browsers get the product website; the app and health checks get JSON (or /status).
    if ((path === "/" && (request.headers.get("accept") || "").includes("text/html")) || path === "/home")
      return new Response(landingPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
    if (path === "/" || path === "/status") {
      let database = false;
      try { await db(env); database = true; } catch { /* reported below */ }
      return json({ ok: true, service: "rx-clinic", database, video: liveKitReady(env), ai: !!(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.AI), aiProvider: env.ANTHROPIC_API_KEY ? "claude" : env.OPENAI_API_KEY ? "openai" : env.AI ? "cloudflare-workers-ai" : "none", freeFallback: !!env.AI });
    }
    if (path === "/login" || path === "/portal" || path === "/terms" || path === "/hmis" || path === "/me") {
      const page = path === "/login" ? loginPage : path === "/portal" ? portalPage : path === "/hmis" ? hmisPage : path === "/me" ? mePage : termsPage;
      return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (path === "/api/license") {
      const pl = await planInfo(env), c = await clinicInfo(env);
      return json({ licensedTo: c.name, address: c.address, plan: pl.name, expires: pl.expires, trial: pl.trial, expired: pl.expired });
    }
    if (path === "/book") return new Response(bookingPage(await clinicInfo(env)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (path === "/api/slots") {
      const date = url.searchParams.get("date") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "Invalid date");
      const { date: today, minutes } = clinicNow(env);
      const rows = (await (await db(env)).prepare("SELECT time FROM appointments WHERE date = ? AND status != 'cancelled'").bind(date).all()).results || [];
      const taken = new Set(rows.map((r) => r.time));
      const slots = allSlots().map((t) => {
        const [h, m] = t.split(":").map(Number);
        const past = date < today || (date === today && h * 60 + m <= minutes);
        return { t, free: !taken.has(t) && !past };
      });
      return json({ date, slots });
    }
    return json({ error: "Not found" }, 404);
  }

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (path === "/api/pay/webhook") return razorpayWebhook(request, env);
  let body = {};
  try { body = await request.json(); } catch { throw new HttpError(400, "Invalid JSON"); }
  const D = await db(env);

  switch (path) {
    // ----- patients -----
    case "/api/book": {
      const name = clean(body.name, 60), phone = digits(body.phone), date = String(body.date || ""), time = String(body.time || "");
      const mode = body.mode === "tele" ? "tele" : "clinic";
      if (!name) throw new HttpError(400, "Enter your name");
      if (phone.length !== 10) throw new HttpError(400, "Enter a 10-digit mobile number");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !allSlots().includes(time)) throw new HttpError(400, "Choose a valid day and time");
      const { date: today, minutes } = clinicNow(env);
      const [h, m] = time.split(":").map(Number);
      if (date < today || date > addDays(today, 30) || (date === today && h * 60 + m <= minutes)) throw new HttpError(400, "That time has passed. Choose another slot.");
      const clash = await D.prepare("SELECT id FROM appointments WHERE date = ? AND time = ? AND status != 'cancelled'").bind(date, time).first();
      if (clash) throw new HttpError(409, "That slot was just taken. Choose another time.");
      let patientId = null;
      if (body.patientSession) patientId = (await requirePatient(env, body.patientSession)).uid;
      const id = crypto.randomUUID();
      const code = randomFrom("0123456789", 6);
      const row = {
        id, created_at: Date.now(), date, time, mode, status: "booked", name, age: clean(body.age, 3), sex: clean(body.sex, 10),
        phone, reason: clean(body.reason, 300), lang: ["en", "ta", "hi"].includes(body.lang) ? body.lang : "en", code, room: null, source: "patient", patient_id: patientId,
      };
      await D.prepare(`INSERT INTO appointments (id, created_at, date, time, mode, status, name, age, sex, phone, reason, lang, code, room, source, patient_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(row.id, row.created_at, row.date, row.time, row.mode, row.status, row.name, row.age, row.sex, row.phone, row.reason, row.lang, row.code, row.room, row.source, patientId).run();
      await notify(env, { to: "role:doctor", title: "New appointment", body: `${row.name} · ${row.date} ${row.time}${row.mode === "tele" ? " · video" : ""}`, link: "" });
      return json({ appointment: publicAppt(row) });
    }

    case "/api/appt": {
      const r = await D.prepare("SELECT * FROM appointments WHERE code = ? AND phone = ? ORDER BY created_at DESC LIMIT 1")
        .bind(digits(body.code, 6), digits(body.phone)).first();
      if (!r) throw new HttpError(404, "No appointment found for that code and mobile number");
      return json({ appointment: publicAppt(r) });
    }

    // ----- staff -----
    case "/api/login": {
      // Old app (0.5) sends { role, pin }: allowed only until the admin finishes account setup.
      if (body.pin !== undefined && !body.username) {
        if (await accountsReady(env)) throw new HttpError(401, "PIN sign-in is off. Update the app and sign in with your username and password.");
        const role = String(body.role || "");
        if (!STAFF_ROLES.includes(role)) throw new HttpError(400, "Unknown role");
        const pins = Object.assign({}, DEFAULT_PINS, await getSetting(env, "pins", {}));
        if (!safeEqual(String(pins[role]), String(body.pin || ""))) throw new HttpError(401, "That PIN is not right");
        return json({ session: await makeSession(env, role), role, clinic: await clinicInfo(env) });
      }
      await ensureAdmin(env);
      const username = String(body.username || "").trim().toLowerCase();
      const lockKey = "u:" + username;
      await checkLock(env, lockKey);
      const f = USER_RE.test(username) ? await findUser(env, username) : null;
      if (!f || !(await checkPassword(body.password, f.u.passHash))) {
        if (USER_RE.test(username)) await noteFail(env, lockKey);
        throw new HttpError(401, "Wrong username or password");
      }
      if (f.u.active === false) throw new HttpError(403, "This login is disabled. Ask the admin.");
      await clearFail(env, lockKey);
      f.u.lastLogin = Date.now();
      await putDoc(env, "users", f.id, f.u);
      return json({ session: await makeSession(env, f.u.role, f.id, f.u.ver || 0), role: f.u.role, user: publicUser(f.id, f.u), clinic: await clinicInfo(env) });
    }

    case "/api/admin/recover": {
      // Forgotten admin password: needs the ADMIN_RESET_CODE secret set in Cloudflare (never stored in the app).
      const code = String(env.ADMIN_RESET_CODE || "");
      if (code.length < 8) throw new HttpError(400, "Password reset is off. In Cloudflare, add the secret ADMIN_RESET_CODE to the rx-clinic worker, then try again.");
      await checkLock(env, "recover");
      if (!safeEqual(code, String(body.code || "").trim())) { await noteFail(env, "recover"); throw new HttpError(401, "That reset code is not right"); }
      await clearFail(env, "recover");
      const pw = String(body.password || "");
      if (pw.length < 8) throw new HttpError(400, "Choose a new password of at least 8 characters");
      await ensureAdmin(env);
      const rows = (await listDocs(env, "users")).filter((d) => d.role === "admin");
      const pick = rows.find((d) => d.username === "admin") || rows[0];
      const id = pick ? pick.id : "admin";
      if (pick) delete pick.id;
      const u = pick ? pick : { username: "admin", name: "Administrator", role: "admin", created: Date.now(), createdBy: "reset" };
      Object.assign(u, { passHash: await hashPassword(pw), mustChange: false, active: true, ver: (u.ver || 0) + 1 });
      await putDoc(env, "users", id, u);
      await clearFail(env, "u:" + u.username);
      return json({ ok: true, username: u.username });
    }

    case "/api/me": {
      const s = await readSession(env, body.session);
      if (s.role === "patient") return json({ role: "patient", patient: publicPatient(s.uid, s.user) });
      return json({ role: s.role, user: s.uid === "pin" ? { name: s.user.name, role: s.role, username: "" } : publicUser(s.uid, s.user), clinic: await clinicInfo(env) });
    }

    case "/api/me/password": {
      const s = await readSession(env, body.session);
      if (s.uid === "pin") throw new HttpError(400, "Sign in with a username first");
      const coll = s.role === "patient" ? "patients" : "users";
      const u = s.user;
      if (u.passHash && !(await checkPassword(body.old, u.passHash))) throw new HttpError(401, "Your current password is not right");
      const pw = validPassword(body.password);
      if (pw === String(body.old || "")) throw new HttpError(400, "Choose a new password, different from the old one");
      u.passHash = await hashPassword(pw);
      u.mustChange = false;
      u.ver = (u.ver || 0) + 1;
      await putDoc(env, coll, s.uid, u);
      if (s.role === "admin") await setSetting(env, "accounts_ready", true);
      return json({ ok: true, session: await makeSession(env, s.role, s.uid, u.ver, s.role === "patient" ? 24 * 30 : 12) });
    }

    // ----- admin: staff logins -----
    case "/api/admin/users": {
      await requireUser(env, body.session, ["admin"]);
      const list = (await listDocs(env, "users")).map((u) => publicUser(u.id, u))
        .sort((a, b) => STAFF_ROLES.indexOf(a.role) - STAFF_ROLES.indexOf(b.role) || a.name.localeCompare(b.name));
      return json({ users: list });
    }

    case "/api/admin/users/save": {
      const me = await requireUser(env, body.session, ["admin"]);
      const x = body.user || {};
      const isNew = !x.id;
      const id = isNew ? randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 10) : String(x.id);
      const u = isNew ? { created: Date.now(), createdBy: me.user.username || "admin", ver: 0 } : await getDoc(env, "users", id);
      if (!u) throw new HttpError(404, "Login not found");
      const username = String(x.username ?? u.username ?? "").trim().toLowerCase();
      if (!USER_RE.test(username)) throw new HttpError(400, "Username: 3 to 32 letters, numbers, dot, dash or underscore");
      const clash = await findUser(env, username);
      if (clash && clash.id !== id) throw new HttpError(409, "That username is taken");
      const role = String(x.role ?? u.role ?? "");
      if (!STAFF_ROLES.includes(role)) throw new HttpError(400, "Choose a role");
      const name = clean(x.name ?? u.name, 80);
      if (!name) throw new HttpError(400, "Enter the person's name");
      const active = x.active === undefined ? u.active !== false : !!x.active;
      if (!isNew && u.role === "admin" && (role !== "admin" || !active)) {
        const admins = (await listDocs(env, "users")).filter((a) => a.role === "admin" && a.active !== false && a.id !== id);
        if (!admins.length) throw new HttpError(400, "Keep at least one active admin login");
      }
      if (active && (isNew || u.role !== role || u.active === false) && role !== "admin") {
        const pl = await planInfo(env);
        const others = (await listDocs(env, "users")).filter((o) => o.active !== false && o.id !== id);
        if (role === "doctor" && others.filter((o) => o.role === "doctor").length >= pl.maxDoctors)
          throw new HttpError(409, `Your ${pl.name} plan allows ${pl.maxDoctors} doctor login${pl.maxDoctors > 1 ? "s" : ""}. Upgrade under Admin → Plan, or disable another doctor login.`);
        if (role !== "doctor" && others.filter((o) => o.role !== "doctor" && o.role !== "admin").length >= pl.maxStaff)
          throw new HttpError(409, `Your ${pl.name} plan allows ${pl.maxStaff} staff logins. Upgrade under Admin → Plan.`);
        if (["lab", "diagnostics"].includes(role) && !pl.features[role]) throw new HttpError(409, `${FEATURE_NAMES[role]} is not in your ${pl.name} plan`);
      }
      if (!isNew && (u.role !== role || (u.active !== false) !== active)) u.ver = (u.ver || 0) + 1; // signs them out
      Object.assign(u, { username, role, name, active, qual: clean(x.qual ?? u.qual, 80), reg: clean(x.reg ?? u.reg, 40), phone: digits(x.phone ?? u.phone), branch: clean(x.branch ?? u.branch, 40) });
      if (isNew || x.password) {
        u.passHash = await hashPassword(validPassword(x.password));
        u.mustChange = true;
        if (!isNew) u.ver = (u.ver || 0) + 1;
      }
      await putDoc(env, "users", id, u);
      return json({ ok: true, user: publicUser(id, u) });
    }

    case "/api/settings": {
      const who = await requireStaff(env, body.session, ["doctor", "staff", "pharmacy", "lab", "diagnostics", "billing"]);
      if (body.clinic && typeof body.clinic === "object") {
        if (who !== "admin") throw new HttpError(403, "Only the admin can change clinic details");
        const c = await clinicInfo(env);
        for (const k of ["name", "doctor", "qual", "reg", "address", "phone", "hours", "upi", "gstin"]) if (k in body.clinic) c[k] = clean(body.clinic[k], 200);
        await setSetting(env, "clinic", c);
      }
      return json({ ok: true, clinic: await clinicInfo(env) });
    }

    // ----- patient accounts -----
    case "/api/patient/register": {
      let r;
      try { r = await createPatient(env, body, "self", validPassword(body.password)); }
      catch (e) { if (e.existing) throw new HttpError(409, "This Aadhaar number is already registered. Sign in, or ask the reception to reset your password."); throw e; }
      return json({ patient: publicPatient(r.id, r.p), session: await makeSession(env, "patient", r.id, 0, 24 * 30) });
    }

    case "/api/patient/login": {
      const login = String(body.login || "").trim();
      const lockKey = "p:" + login.toUpperCase().replace(/\s/g, "");
      await checkLock(env, lockKey);
      const found = (await patientsForLogin(env, login)).filter((p) => p.passHash && p.active !== false);
      const ok = [];
      for (const p of found) if (await checkPassword(body.password, p.passHash)) ok.push(p);
      if (!ok.length) { await noteFail(env, lockKey); throw new HttpError(401, "Wrong Patient ID / mobile / Aadhaar or password"); }
      if (ok.length > 1) throw new HttpError(409, "More than one patient uses this mobile number. Sign in with your Patient ID.");
      await clearFail(env, lockKey);
      const p = ok[0];
      return json({ patient: publicPatient(p.id, p), session: await makeSession(env, "patient", p.id, p.ver || 0, 24 * 30) });
    }

    case "/api/patient/me": {
      const s = await requirePatient(env, body.session);
      const appts = (await D.prepare("SELECT * FROM appointments WHERE patient_id = ? OR (patient_id IS NULL AND phone = ? AND lower(name) = lower(?)) ORDER BY date DESC, time DESC LIMIT 30")
        .bind(s.uid, s.user.phone || "-", s.user.name).all()).results || [];
      const bills = (await listDocs(env, "bills", "json_extract(data, '$.patient.id') = ?", [s.uid])).filter((b) => b.status !== "cancelled")
        .sort((a, b) => b.created - a.created).slice(0, 50).map((b) => ({ id: b.id, no: b.no, dept: b.dept, deptName: b.deptName, date: b.date, total: b.total, paid: b.paid, balance: b.balance, status: b.status, items: b.items.map((i) => ({ desc: i.desc, qty: i.qty, amount: i.amount })) }));
      return json({ patient: publicPatient(s.uid, s.user), visits: await patientHistory(env, s.uid), appointments: appts.map(publicAppt), bills });
    }

    case "/api/patient/update": {
      const s = await requirePatient(env, body.session);
      const p = s.user;
      if ("name" in body) p.name = clean(body.name, 60) || p.name;
      if ("age" in body) p.age = clean(body.age, 3);
      if ("sex" in body) p.sex = clean(body.sex, 10);
      if ("address" in body) p.address = clean(body.address, 200);
      if ("phone" in body) { const ph = digits(body.phone); if (ph && ph.length !== 10) throw new HttpError(400, "Enter a 10-digit mobile number"); p.phone = ph; }
      if (body.aadhaar) {
        const n = normAadhaar(body.aadhaar);
        const old = await patientByAadhaar(env, n);
        if (old && old.id !== s.uid) throw new HttpError(409, "This Aadhaar number is already linked to another Patient ID");
        p.aadhaarKey = await aadhaarKey(env, n); p.aadhaarLast4 = n.slice(-4);
      }
      if (!p.phone && !p.aadhaarKey) throw new HttpError(400, "Keep a mobile number or an Aadhaar number");
      await putDoc(env, "patients", s.uid, p);
      return json({ patient: publicPatient(s.uid, p) });
    }

    // ----- staff: patient registry -----
    case "/api/patients/register": {
      const me = await requireUser(env, body.session, ["staff", "doctor", "billing"]);
      try {
        const r = await createPatient(env, body, me.user.username || me.role, body.password ? body.password : "");
        return json({ patient: publicPatient(r.id, r.p) });
      } catch (e) {
        if (e.existing) throw new HttpError(409, `This Aadhaar number is already registered as ${e.existing}`);
        throw e;
      }
    }

    case "/api/patients/search": {
      await requireUser(env, body.session, ["staff", "doctor", "pharmacy", "lab", "diagnostics", "billing"]);
      const q = String(body.q || "").trim();
      let list = [];
      if (q.length >= 2) {
        list = await patientsForLogin(env, q);
        if (!list.length && !/\d/.test(q)) list = await listDocs(env, "patients", "lower(json_extract(data, '$.name')) LIKE ?", [q.toLowerCase().replace(/[%_]/g, "") + "%"]);
      }
      return json({ patients: list.slice(0, 30).map((p) => publicPatient(p.id, p)) });
    }

    case "/api/patients/get": {
      await requireUser(env, body.session, ["staff", "doctor", "billing"]);
      const id = String(body.id || "").toUpperCase();
      const p = await getDoc(env, "patients", id);
      if (!p) throw new HttpError(404, "Patient not found");
      return json({ patient: publicPatient(id, p), visits: await patientHistory(env, id) });
    }

    case "/api/patients/update": {
      await requireUser(env, body.session, ["staff", "doctor", "billing"]);
      const id = String(body.id || "").toUpperCase();
      const p = await getDoc(env, "patients", id);
      if (!p) throw new HttpError(404, "Patient not found");
      const x = body.patient || {};
      if (x.name) p.name = clean(x.name, 60);
      for (const k of ["age", "sex"]) if (k in x) p[k] = clean(x[k], k === "age" ? 3 : 10);
      if ("address" in x) p.address = clean(x.address, 200);
      if ("phone" in x) { const ph = digits(x.phone); if (ph && ph.length !== 10) throw new HttpError(400, "Enter a 10-digit mobile number"); p.phone = ph; }
      if (x.aadhaar) {
        const n = normAadhaar(x.aadhaar);
        const old = await patientByAadhaar(env, n);
        if (old && old.id !== id) throw new HttpError(409, `This Aadhaar number is already registered as ${old.id}`);
        p.aadhaarKey = await aadhaarKey(env, n); p.aadhaarLast4 = n.slice(-4);
      }
      if (x.password) { p.passHash = await hashPassword(validPassword(x.password)); p.ver = (p.ver || 0) + 1; }
      await putDoc(env, "patients", id, p);
      return json({ patient: publicPatient(id, p) });
    }

    case "/api/doctor/appointments": {
      await requireStaff(env, body.session, ["doctor"]);
      const date = String(body.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "Invalid date");
      const rows = (await D.prepare("SELECT * FROM appointments WHERE date = ? ORDER BY time").bind(date).all()).results || [];
      return json({ appointments: rows.map(publicAppt) });
    }

    case "/api/doctor/status": {
      await requireStaff(env, body.session, ["doctor"]);
      if (!STATUSES.includes(body.status)) throw new HttpError(400, "Invalid status");
      await D.prepare("UPDATE appointments SET status = ? WHERE id = ?").bind(body.status, String(body.id || "")).run();
      return json({ ok: true });
    }

    // ----- video teleconsult -----
    case "/api/tele/token": {
      if (!liveKitReady(env)) throw new HttpError(500, "Video is not set up: add LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET");
      if (body.session) {
        // Doctor: host of the teleconsult
        const me = await requireUser(env, body.session, ["doctor"]);
        const a = await D.prepare("SELECT * FROM appointments WHERE id = ?").bind(String(body.id || "")).first();
        if (!a || a.mode !== "tele") throw new HttpError(404, "Teleconsult not found");
        const room = await ensureRoom(env, a);
        if (["booked", "arrived"].includes(a.status)) await D.prepare("UPDATE appointments SET status = 'in-call' WHERE id = ?").bind(a.id).run();
        const name = me.user.name || "Doctor";
        const identity = `dr-${slug(name)}-${randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 5)}`;
        const token = await issueToken(env, { room, name, identity, role: "host" });
        return json({ url: env.LIVEKIT_URL, token, identity, role: "host", room, title: `Teleconsult · ${a.name}` });
      }
      // Patient: waits until the doctor admits them
      const a = await D.prepare("SELECT * FROM appointments WHERE code = ? AND phone = ? AND mode = 'tele' ORDER BY created_at DESC LIMIT 1")
        .bind(digits(body.code, 6), digits(body.phone)).first();
      if (!a) throw new HttpError(404, "No teleconsult found for that code and mobile number");
      if (["completed", "cancelled", "no-show"].includes(a.status)) throw new HttpError(410, "This teleconsult has ended");
      const room = await ensureRoom(env, a);
      let identity = typeof body.identity === "string" && ID_RE.test(body.identity)
        ? body.identity : `pt-${slug(a.name)}-${randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 5)}`;
      let role = "waiting";
      if (body.identity) {
        const info = await getParticipant(env, room, identity);
        if (info && roleOf(info) === "guest") role = "guest";
      }
      const token = await issueToken(env, { room, name: a.name, identity, role });
      return json({ url: env.LIVEKIT_URL, token, identity, role, room, title: "Teleconsult with your doctor" });
    }

    case "/api/meet/admit":
    case "/api/meet/remove":
    case "/api/meet/mute":
    case "/api/meet/end": {
      await requireStaff(env, body.session, ["doctor"]);
      const room = String(body.room || "");
      if (!ROOM_RE.test(room)) throw new HttpError(400, "Invalid room");
      const identity = String(body.identity || "");
      const action = path.split("/").pop();
      if (action !== "end" && !ID_RE.test(identity)) throw new HttpError(400, "Invalid participant");
      if (action === "admit") {
        await roomService(env, "UpdateParticipant", { room, identity, metadata: JSON.stringify({ role: "guest" }) }, room);
      } else if (action === "remove") {
        await roomService(env, "RemoveParticipant", { room, identity }, room);
      } else if (action === "mute") {
        const info = await getParticipant(env, room, identity);
        const tracks = (info?.tracks || []).filter((t) => t.type === "AUDIO" || t.type === 0 || t.source === "MICROPHONE" || t.source === 2);
        for (const t of tracks) if (!t.muted) await roomService(env, "MutePublishedTrack", { room, identity, track_sid: t.sid, muted: true }, room);
      } else {
        await roomService(env, "DeleteRoom", { room }, room);
        await D.prepare("UPDATE appointments SET status = 'completed' WHERE room = ? AND status = 'in-call'").bind(room).run();
      }
      return json({ ok: true });
    }

    // ----- patient check-in: AI interview -----
    case "/api/checkin/next": {
      const lang = ["en", "ta", "hi"].includes(body.lang) ? body.lang : "en";
      const turns = Array.isArray(body.turns) ? body.turns.slice(-60) : [];
      const msgs = [{ role: "system", content: intakeRules(lang, clean(body.age, 3), clean(body.sex, 10)) }];
      msgs.push({ role: "user", content: "Begin the interview now with the first question." });
      for (const t of turns) {
        if (t && (t.role === "user" || t.role === "assistant")) msgs.push({ role: t.role, content: clean(t.content, 1500) });
      }
      const r = await chatOpenAI(env, msgs, true);
      return json(r.json || {});
    }

    case "/api/checkin/finish": {
      const p = body.patient || {};
      const name = clean(p.name, 60);
      if (!name) throw new HttpError(400, "Enter the patient's name");
      const lang = ["en", "ta", "hi"].includes(body.lang) ? body.lang : "en";
      const qa = (Array.isArray(body.qa) ? body.qa : []).slice(0, 60).map((x) => ({ q: clean(x?.q, 600), a: clean(x?.a, 600) }));
      let caseSheet = null;
      try { caseSheet = (await askOpenAI(env, caseSheetPrompt(qa, clean(p.age, 3), clean(p.sex, 10), lang), true)).json || null; } catch { caseSheet = null; }
      const { date } = clinicNow(env);
      const today = (await D.prepare("SELECT data FROM docs WHERE coll = 'visits' AND json_extract(data, '$.date') = ?").bind(date).all()).results || [];
      const token = today.reduce((m, r) => Math.max(m, Number(JSON.parse(r.data).token) || 0), 0) + 1;
      // Link the visit to a Patient ID: the signed-in patient, a Patient ID with its mobile number,
      // the same name and mobile seen before, or a new registration.
      const phone = digits(p.phone);
      let pid = null, newPatient = false;
      if (body.patientSession) pid = (await requirePatient(env, body.patientSession)).uid;
      if (!pid && p.id) {
        const known = await getDoc(env, "patients", String(p.id).toUpperCase().trim());
        if (known && phone && known.phone === phone) pid = String(p.id).toUpperCase().trim();
      }
      if (!pid && phone) {
        const same = (await listDocs(env, "patients", "json_extract(data, '$.phone') = ?", [phone])).filter((x) => x.name.trim().toLowerCase() === name.toLowerCase());
        if (same.length === 1) pid = same[0].id;
      }
      if (!pid) {
        try { pid = (await createPatient(env, { name, age: p.age, sex: p.sex, phone, aadhaar: p.aadhaar }, "check-in", "")).id; newPatient = true; }
        catch (e) { if (e.existing) pid = e.existing; /* otherwise check in without an ID */ }
      }
      const id = crypto.randomUUID();
      const visit = {
        patient: { id: pid || "", name, age: clean(p.age, 3), sex: clean(p.sex, 10), phone }, lang, qa, caseSheet,
        urgent: !!body.urgent, status: "waiting", token, date, createdAt: Date.now(), work: null, rx: null,
      };
      await putDoc(env, "visits", id, visit);
      return json({ id, token, patientId: pid || "", newPatient });
    }

    // ----- doctor: OPD visits -----
    case "/api/doctor/visits": {
      await requireStaff(env, body.session, ["doctor"]);
      const date = String(body.date || clinicNow(env).date);
      const rows = (await D.prepare("SELECT id, data FROM docs WHERE coll = 'visits' AND json_extract(data, '$.date') = ? ORDER BY updated DESC").bind(date).all()).results || [];
      // Emergency queue first, then by token.
      const list = rows.map((r) => visitSummary(r.id, JSON.parse(r.data))).sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || (a.token || 0) - (b.token || 0));
      return json({ visits: list });
    }

    case "/api/doctor/visit": {
      await requireStaff(env, body.session, ["doctor"]);
      const v = await getDoc(env, "visits", String(body.id || ""));
      if (!v) throw new HttpError(404, "Visit not found");
      const history = v.patient?.id ? (await patientHistory(env, v.patient.id)).filter((h) => h.id !== body.id).slice(0, 10) : [];
      return json({ id: body.id, visit: v, history });
    }

    case "/api/doctor/visit/save": {
      const me = await requireUser(env, body.session, ["doctor"]);
      const id = String(body.id || "");
      const v = await getDoc(env, "visits", id);
      if (!v) throw new HttpError(404, "Visit not found");
      const patch = body.patch || {};
      for (const k of ["work", "rx", "caseSheet"]) if (k in patch) v[k] = patch[k];
      if (patch.rx && me.uid !== "pin") v.doctor = { id: me.uid, name: me.user.name, qual: me.user.qual || "", reg: me.user.reg || "" };
      if (["waiting", "consult", "sent", "dispensed", "done"].includes(patch.status)) v.status = patch.status;
      if (JSON.stringify(v).length > 900000) throw new HttpError(413, "This case sheet is too large to save");
      await putDoc(env, "visits", id, v);
      return json({ ok: true, status: v.status });
    }

    // ----- investigation orders: lab and diagnostics -----
    case "/api/orders/create": {
      await requireStaff(env, body.session, ["doctor"]);
      const admissionId = String(body.admissionId || "");
      const visitId = admissionId ? "ip:" + admissionId : String(body.visitId || "");
      const v = admissionId ? await getDoc(env, "admissions", admissionId) : await getDoc(env, "visits", visitId);
      if (!v) throw new HttpError(404, "Visit not found");
      if (admissionId) v.token = v.no;
      const existing = (await listDocs(env, "orders", "json_extract(data, '$.visitId') = ?", [visitId])).filter((o) => !admissionId || o.date === clinicNow(env).date);
      const have = new Set(existing.map((o) => o.test.toLowerCase()));
      const { date } = clinicNow(env);
      const made = [];
      for (const t of (Array.isArray(body.tests) ? body.tests : []).slice(0, 30)) {
        const test = clean(t, 120);
        if (!test || have.has(test.toLowerCase())) continue;
        const c = classifyTest(test);
        const o = { visitId, patient: { id: v.patient?.id || "", name: v.patient?.name || "", age: v.patient?.age || "", sex: v.patient?.sex || "" }, token: v.token,
          test, kind: c.kind, modality: c.modality, status: "ordered", date, orderedAt: Date.now(), result: "", impression: "" };
        const id = crypto.randomUUID();
        await putDoc(env, "orders", id, o);
        have.add(test.toLowerCase()); made.push(Object.assign({ id }, o));
      }
      return json({ created: made.length, orders: made });
    }

    case "/api/orders/list": {
      const role = await requireStaff(env, body.session, ["doctor", "lab", "diagnostics"]);
      let list;
      if (body.visitId) list = await listDocs(env, "orders", "json_extract(data, '$.visitId') = ?", [String(body.visitId)]);
      else {
        const kind = role === "lab" ? "lab" : role === "diagnostics" ? "imaging" : (body.kind === "imaging" ? "imaging" : "lab");
        const since = addDays(clinicNow(env).date, -7);
        list = await listDocs(env, "orders", "json_extract(data, '$.kind') = ? AND json_extract(data, '$.date') >= ?", [kind, since]);
        list = list.filter((o) => o.status !== "reported" || o.date === clinicNow(env).date);
      }
      list.sort((a, b) => (a.orderedAt || 0) - (b.orderedAt || 0));
      return json({ orders: list });
    }

    case "/api/orders/update": {
      await requireStaff(env, body.session, ["lab", "diagnostics"]);
      const id = String(body.id || "");
      const o = await getDoc(env, "orders", id);
      if (!o) throw new HttpError(404, "Order not found");
      const st = String(body.status || "");
      if (!["ordered", "collected", "scheduled", "reported"].includes(st)) throw new HttpError(400, "Invalid status");
      o.status = st;
      if (st === "collected" || st === "scheduled") o[st + "At"] = Date.now();
      if (st === "reported") {
        o.result = clean(body.result, 6000);
        o.impression = clean(body.impression, 2000);
        if (!o.result && !o.impression) throw new HttpError(400, "Enter the report first");
        o.reportedAt = Date.now();
        await notify(env, { to: "role:doctor", title: `Report ready: ${o.test}`, body: `${o.patient?.name || ""} (${o.patient?.id || ""})`, link: o.visitId?.startsWith("ip:") ? "ip-" + o.visitId.slice(3) : "v-" + o.visitId });
      }
      await putDoc(env, "orders", id, o);
      return json({ ok: true });
    }

    // ----- pharmacy -----
    case "/api/pharmacy/stock": {
      await requireStaff(env, body.session, ["pharmacy", "doctor"]);
      const list = (await listDocs(env, "stock")).sort((a, b) => a.generic.localeCompare(b.generic));
      return json({ stock: list });
    }

    case "/api/pharmacy/stock/save": {
      await requireStaff(env, body.session, ["pharmacy"]);
      const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [body.item || {}];
      let n = 0;
      for (const it of items) {
        const generic = clean(it.generic, 120);
        if (!generic) continue;
        const id = typeof it.id === "string" && ID_RE.test(it.id) ? it.id : crypto.randomUUID();
        const old = (await getDoc(env, "stock", id)) || {};
        await putDoc(env, "stock", id, Object.assign(old, { generic, brand: clean(it.brand, 80), form: clean(it.form, 20) || "Tab", strength: clean(it.strength, 40), stock: Math.max(0, Math.floor(Number(it.stock) || 0)), price: Math.max(0, money(it.price)),
          category: it.category === "non-drug" ? "non-drug" : (it.category === "drug" ? "drug" : old.category || "drug"), reorder: it.reorder !== undefined ? Math.max(0, Math.floor(Number(it.reorder) || 0)) : (old.reorder ?? 10) }));
        n++;
      }
      return json({ saved: n });
    }

    case "/api/pharmacy/stock/delete": {
      await requireStaff(env, body.session, ["pharmacy"]);
      await D.prepare("DELETE FROM docs WHERE coll = 'stock' AND id = ?").bind(String(body.id || "")).run();
      return json({ ok: true });
    }

    case "/api/pharmacy/queue": {
      await requireStaff(env, body.session, ["pharmacy"]);
      const since = addDays(clinicNow(env).date, -2);
      const list = (await listDocs(env, "visits", "json_extract(data, '$.status') IN ('sent', 'dispensed') AND json_extract(data, '$.date') >= ?", [since]))
        .map((v) => ({ id: v.id, token: v.token, date: v.date, status: v.status, patient: v.patient, rx: v.rx, dispensedAt: v.dispensedAt || null, billId: v.pharmacyBillId || "" }))
        .sort((a, b) => (a.status === b.status ? (b.rx?.sentAt || 0) - (a.rx?.sentAt || 0) : a.status === "sent" ? -1 : 1));
      return json({ queue: list });
    }

    case "/api/pharmacy/dispense": {
      await requireStaff(env, body.session, ["pharmacy"]);
      const id = String(body.id || "");
      const v = await getDoc(env, "visits", id);
      if (!v) throw new HttpError(404, "Prescription not found");
      v.status = "dispensed"; v.dispensedAt = Date.now();
      await putDoc(env, "visits", id, v);
      return json({ ok: true });
    }

    // ----- nursing: OPD triage vitals -----
    case "/api/nurse/queue": {
      await requireStaff(env, body.session, ["staff"]);
      const { date } = clinicNow(env);
      const list = (await listDocs(env, "visits", "json_extract(data, '$.date') = ?", [date]))
        .map((v) => Object.assign(visitSummary(v.id, v), { triage: v.triage || null }))
        .sort((a, b) => (a.token || 0) - (b.token || 0));
      return json({ visits: list });
    }

    case "/api/nurse/vitals": {
      await requireStaff(env, body.session, ["staff"]);
      const id = String(body.id || "");
      const v = await getDoc(env, "visits", id);
      if (!v) throw new HttpError(404, "Patient not found");
      const vit = {};
      for (const k of ["bp", "pulse", "temp", "spo2", "rr", "rbs", "weight", "height"]) vit[k] = clean(body.vitals?.[k], 12);
      v.triage = { vitals: vit, note: clean(body.note, 500), at: Date.now() };
      if (typeof body.urgent === "boolean") v.urgent = body.urgent;
      await putDoc(env, "visits", id, v);
      return json({ ok: true });
    }

    // ----- admin -----
    case "/api/admin/overview": {
      await requireStaff(env, body.session, ["admin"]);
      const { date } = clinicNow(env);
      const visits = await listDocs(env, "visits", "json_extract(data, '$.date') = ?", [date]);
      const orders = await listDocs(env, "orders", "json_extract(data, '$.date') = ?", [date]);
      const appts = (await D.prepare("SELECT mode, status FROM appointments WHERE date = ?").bind(date).all()).results || [];
      const stock = await listDocs(env, "stock");
      const users = await listDocs(env, "users");
      const pc = await D.prepare("SELECT COUNT(*) AS n FROM docs WHERE coll = 'patients'").first();
      const count = (arr, f) => arr.filter(f).length;
      return json({
        date, accountsReady: await accountsReady(env),
        people: { patients: pc?.n || 0, logins: count(users, (u) => u.active !== false) },
        opd: { checkedIn: visits.length, waiting: count(visits, (v) => v.status === "waiting"), prescribed: count(visits, (v) => v.status === "sent" || v.status === "dispensed"), urgent: count(visits, (v) => v.urgent) },
        appointments: { total: count(appts, (a) => a.status !== "cancelled"), tele: count(appts, (a) => a.mode === "tele" && a.status !== "cancelled") },
        lab: { pending: count(orders, (o) => o.kind === "lab" && o.status !== "reported"), reported: count(orders, (o) => o.kind === "lab" && o.status === "reported") },
        diagnostics: { pending: count(orders, (o) => o.kind === "imaging" && o.status !== "reported"), reported: count(orders, (o) => o.kind === "imaging" && o.status === "reported") },
        billing: await (async () => {
          const bills = (await listDocs(env, "bills", "json_extract(data, '$.date') = ?", [date])).filter((b) => b.status !== "cancelled" && b.status !== "to-ip" && b.status !== "on-ip-bill");
          const sum = (f) => money(bills.filter(f).reduce((x, b) => x + b.total, 0));
          const paid = money(bills.reduce((x, b) => x + (b.payments || []).filter((p) => p.mode !== "Advance").reduce((y, p) => y + p.amount, 0), 0));
          const inpatients = (await listDocs(env, "admissions", "json_extract(data, '$.status') = 'admitted'")).length;
          return { billed: sum(() => true), collected: paid, pharmacy: sum((b) => b.dept === "pharmacy"), lab: sum((b) => b.dept === "lab"), diagnostics: sum((b) => b.dept === "diagnostics"), opd: sum((b) => b.dept === "opd"), ip: sum((b) => b.dept === "ip"), inpatients };
        })(),
        pharmacy: { toDispense: count(visits, (v) => v.status === "sent"), dispensed: count(visits, (v) => v.status === "dispensed"), outOfStock: count(stock, (x) => !x.stock) },
      });
    }

    // ----- simple records -----
    case "/api/rec/list": {
      const coll = String(body.coll || ""), cfg = REC[coll];
      if (!cfg) throw new HttpError(400, "Unknown list");
      await requireUser(env, body.session, [...new Set([...cfg.read, ...cfg.write])]);
      if (cfg.feature) await needFeature(env, cfg.feature);
      let list;
      const f = body.where && typeof body.where === "object" ? Object.entries(body.where).slice(0, 3) : [];
      if (f.length) list = await listDocs(env, coll, f.map(([k]) => `json_extract(data, '$.${k.replace(/[^\w.]/g, "")}') = ?`).join(" AND "), f.map(([, v]) => v));
      else list = await listDocs(env, coll);
      if (body.from) list = list.filter((x) => (x.date || "") >= body.from && (!body.to || (x.date || "") <= body.to));
      return json({ items: list.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.created || 0) - (a.created || 0)).slice(0, 1000) });
    }

    case "/api/rec/save": {
      const coll = String(body.coll || ""), cfg = REC[coll];
      if (!cfg) throw new HttpError(400, "Unknown list");
      const me = await requireUser(env, body.session, cfg.write.length ? cfg.write : ["admin"]);
      if (cfg.feature) await needFeature(env, cfg.feature);
      const data = sanitize(body.item || {});
      if (JSON.stringify(data).length > 60000) throw new HttpError(400, "Too much data in one record");
      const id = typeof body.id === "string" && ID_RE.test(body.id) ? body.id : crypto.randomUUID();
      const old = (await getDoc(env, coll, id)) || { created: Date.now(), createdBy: me.user.name || me.role };
      const doc = Object.assign(old, data, { updated: Date.now(), updatedBy: me.user.name || me.role });
      if (!doc.date) doc.date = clinicNow(env).date;
      if (coll === "claims" && !doc.no) doc.no = await nextNo(env, "claim", "CLM");
      if (coll === "homevisits" && !doc.no) doc.no = await nextNo(env, "hv", "HV");
      if (coll === "camps" && !doc.no) doc.no = await nextNo(env, "camp", "CAMP");
      await putDoc(env, coll, id, doc);
      return json({ item: Object.assign({ id }, doc) });
    }

    case "/api/rec/delete": {
      const coll = String(body.coll || ""), cfg = REC[coll];
      if (!cfg) throw new HttpError(400, "Unknown list");
      await requireUser(env, body.session, cfg.write.length ? cfg.write : ["admin"]);
      await D.prepare("DELETE FROM docs WHERE coll = ? AND id = ?").bind(coll, String(body.id || "")).run();
      return json({ ok: true });
    }

    // ----- pharmacy: purchases, batches, alerts -----
    case "/api/pharmacy/purchase": {
      const me = await requireUser(env, body.session, ["pharmacy"]);
      await needFeature(env, "purchase");
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 200);
      if (!items.length) throw new HttpError(400, "Add at least one item");
      const stock = await listDocs(env, "stock");
      const lines = [];
      for (const it of items) {
        const generic = clean(it.generic, 120), qty = Math.max(0, Math.floor(Number(it.qty) || 0));
        if (!generic || !qty) continue;
        const strength = clean(it.strength, 40), form = clean(it.form, 20) || "Tab";
        let s = stock.find((x) => x.generic.toLowerCase() === generic.toLowerCase() && (x.strength || "").toLowerCase() === strength.toLowerCase() && (x.form || "").toLowerCase() === form.toLowerCase());
        const id = s ? s.id : crypto.randomUUID();
        s = s || { generic, strength, form, brand: clean(it.brand, 80), stock: 0, price: 0, category: it.category === "non-drug" ? "non-drug" : "drug", reorder: 10, batches: [] };
        delete s.id;
        s.stock = (Number(s.stock) || 0) + qty;
        if (Number(it.mrp) > 0) s.price = money(it.mrp);
        if (it.brand) s.brand = clean(it.brand, 80);
        s.batches = (s.batches || []).concat([{ batch: clean(it.batch, 40), expiry: /^\d{4}-\d{2}(-\d{2})?$/.test(it.expiry || "") ? it.expiry : "", qty, cost: money(it.cost) }]).slice(-50);
        await putDoc(env, "stock", id, s);
        lines.push({ stockId: id, generic, strength, form, batch: clean(it.batch, 40), expiry: clean(it.expiry, 10), qty, cost: money(it.cost), mrp: money(it.mrp), amount: money(qty * (Number(it.cost) || 0)) });
      }
      if (!lines.length) throw new HttpError(400, "Enter the quantity for each item");
      const doc = { supplier: clean(body.supplier, 120), invoice: clean(body.invoice, 60), date: /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : clinicNow(env).date,
        lines, total: money(lines.reduce((x, l) => x + l.amount, 0)), paid: !!body.paid, created: Date.now(), by: me.user.name || me.role, no: await nextNo(env, "purchase", "PUR") };
      const pid = crypto.randomUUID();
      await putDoc(env, "purchases", pid, doc);
      return json({ purchase: Object.assign({ id: pid }, doc) });
    }

    case "/api/pharmacy/purchases": {
      await requireUser(env, body.session, ["pharmacy", "billing"]);
      return json({ purchases: (await listDocs(env, "purchases")).sort((a, b) => b.created - a.created).slice(0, 200) });
    }

    case "/api/pharmacy/alerts": {
      await requireUser(env, body.session, ["pharmacy", "doctor", "billing"]);
      const stock = await listDocs(env, "stock"), today = clinicNow(env).date, soon = addDays(today, 90);
      const low = [], expiring = [], expired = [];
      for (const s of stock) {
        if ((Number(s.stock) || 0) <= (s.reorder ?? 10)) low.push({ id: s.id, name: `${s.form || ""} ${s.generic} ${s.strength || ""}`.trim(), stock: s.stock || 0, reorder: s.reorder ?? 10, category: s.category || "drug" });
        for (const b of s.batches || []) {
          if (!b.expiry || !b.qty) continue;
          const e = b.expiry.length === 7 ? b.expiry + "-28" : b.expiry;
          const row = { id: s.id, name: `${s.form || ""} ${s.generic} ${s.strength || ""}`.trim(), batch: b.batch, expiry: b.expiry, qty: b.qty, value: money(b.qty * (b.cost || 0)) };
          if (e < today) expired.push(row); else if (e <= soon) expiring.push(row);
        }
      }
      expiring.sort((a, b) => a.expiry.localeCompare(b.expiry));
      return json({ low: low.sort((a, b) => a.stock - b.stock), expiring, expired, stock: stock.length });
    }

    // ----- reports -----
    case "/api/reports/sales": {
      await requireUser(env, body.session, ["billing"]);
      await needFeature(env, "reports");
      const today = clinicNow(env).date;
      const from = /^\d{4}-\d{2}-\d{2}$/.test(body.from || "") ? body.from : today.slice(0, 8) + "01", to = /^\d{4}-\d{2}-\d{2}$/.test(body.to || "") ? body.to : today;
      const by = body.groupBy === "month" ? 7 : 10;
      const bills = (await listDocs(env, "bills", "json_extract(data, '$.date') >= ? AND json_extract(data, '$.date') <= ?", [from, to])).filter((b) => b.status !== "cancelled" && b.status !== "to-ip" && b.status !== "on-ip-bill");
      const periods = {}, depts = {}, doctors = {}, branches = {};
      for (const b of bills) {
        const k = b.date.slice(0, by);
        const P = (periods[k] = periods[k] || { period: k, billed: 0, collected: 0, opd: 0, pharmacy: 0, lab: 0, diagnostics: 0, ip: 0 });
        P.billed = money(P.billed + b.total); P.collected = money(P.collected + b.paid); P[b.dept] = money((P[b.dept] || 0) + b.total);
        depts[b.dept] = money((depts[b.dept] || 0) + b.total);
        const br = b.branch || "Main"; branches[br] = money((branches[br] || 0) + b.total);
      }
      // Doctor-wise: patients seen, prescriptions, OPD and linked department revenue
      const visits = await listDocs(env, "visits", "json_extract(data, '$.date') >= ? AND json_extract(data, '$.date') <= ?", [from, to]);
      const vById = Object.fromEntries(visits.map((v) => [v.id, v]));
      for (const v of visits) { const d = v.doctor?.name || "Not recorded"; const D2 = (doctors[d] = doctors[d] || { doctor: d, patients: 0, revenue: 0 }); D2.patients++; }
      for (const b of bills) { const v = b.visitId && vById[b.visitId]; if (v) { const d = v.doctor?.name || "Not recorded"; const D2 = (doctors[d] = doctors[d] || { doctor: d, patients: 0, revenue: 0 }); D2.revenue = money(D2.revenue + b.total); } }
      for (const a of await listDocs(env, "bills", "json_extract(data, '$.dept') = 'ip' AND json_extract(data, '$.date') >= ? AND json_extract(data, '$.date') <= ?", [from, to])) {
        if (a.status === "cancelled") continue; const d = a.doctor || "Not recorded"; const D2 = (doctors[d] = doctors[d] || { doctor: d, patients: 0, revenue: 0 }); D2.revenue = money(D2.revenue + a.total);
      }
      const exps = (await listDocs(env, "expenses")).filter((e) => e.date >= from && e.date <= to);
      const expenses = money(exps.reduce((x, e) => x + (Number(e.amount) || 0), 0));
      const expByCat = {};
      for (const e of exps) expByCat[e.category || "Other"] = money((expByCat[e.category || "Other"] || 0) + (Number(e.amount) || 0));
      const billed = money(bills.reduce((x, b) => x + b.total, 0)), collected = money(bills.reduce((x, b) => x + b.paid, 0));
      const goals = (await listDocs(env, "goals")).filter((g) => g.month && g.month >= from.slice(0, 7) && g.month <= to.slice(0, 7));
      return json({ from, to, billed, collected, expenses, net: money(collected - expenses), byPeriod: Object.values(periods).sort((a, b) => a.period.localeCompare(b.period)), byDept: depts,
        byDoctor: Object.values(doctors).sort((a, b) => b.revenue - a.revenue), byBranch: branches, expByCat, goals, bills: bills.length });
    }

    case "/api/reports/dues": {
      await requireUser(env, body.session, ["billing"]);
      const bills = (await listDocs(env, "bills", "json_extract(data, '$.date') >= ?", [addDays(clinicNow(env).date, -365)])).filter((b) => (b.status === "unpaid" || b.status === "partial") && b.balance > 0.004);
      const now = Date.now();
      const rows = bills.map((b) => ({ id: b.id, no: b.no, dept: b.deptName, date: b.date, patient: b.patient, total: b.total, balance: b.balance, days: Math.floor((now - b.created) / 864e5) })).sort((a, b) => b.days - a.days);
      const ip = [];
      for (const a of await listDocs(env, "admissions", "json_extract(data, '$.status') = 'admitted'")) { const acc = await ipAccount(env, a); if (acc.due > 0) ip.push({ id: a.id, no: a.no, patient: a.patient, ward: a.ward, total: acc.total, advance: acc.advance, due: acc.due }); }
      const age = { "0–30 days": 0, "31–60 days": 0, "61–90 days": 0, "90+ days": 0 };
      for (const r of rows) age[r.days <= 30 ? "0–30 days" : r.days <= 60 ? "31–60 days" : r.days <= 90 ? "61–90 days" : "90+ days"] = money(age[r.days <= 30 ? "0–30 days" : r.days <= 60 ? "31–60 days" : r.days <= 90 ? "61–90 days" : "90+ days"] + r.balance);
      return json({ bills: rows, inpatients: ip, ageing: age, total: money(rows.reduce((x, r) => x + r.balance, 0) + ip.reduce((x, r) => x + r.due, 0)) });
    }

    case "/api/reports/appointments": {
      await requireUser(env, body.session, ["billing", "doctor"]);
      const today = clinicNow(env).date;
      const from = /^\d{4}-\d{2}-\d{2}$/.test(body.from || "") ? body.from : addDays(today, -30), to = /^\d{4}-\d{2}-\d{2}$/.test(body.to || "") ? body.to : today;
      const rows = (await D.prepare("SELECT date, time, mode, status, source FROM appointments WHERE date >= ? AND date <= ?").bind(from, to).all()).results || [];
      const count = (k) => rows.reduce((m, r) => { const v = typeof k === "function" ? k(r) : r[k] || "unknown"; m[v] = (m[v] || 0) + 1; return m; }, {});
      const byDay = count("date"), byHour = count((r) => (r.time || "").slice(0, 2) + ":00"), byWeekday = count((r) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(r.date + "T00:00:00Z").getUTCDay()]);
      const done = rows.filter((r) => r.status === "completed").length, noShow = rows.filter((r) => r.status === "no-show").length, cancelled = rows.filter((r) => r.status === "cancelled").length;
      const visits = (await listDocs(env, "visits", "json_extract(data, '$.date') >= ? AND json_extract(data, '$.date') <= ?", [from, to])).length;
      return json({ from, to, total: rows.length, completed: done, noShow, cancelled, noShowRate: rows.length ? Math.round((noShow / rows.length) * 100) : 0,
        byMode: count("mode"), bySource: count((r) => r.source === "patient" ? "Online / QR" : "Desk / phone"), byStatus: count("status"), byDay, byHour, byWeekday, walkIns: visits });
    }

    // ----- bed board -----
    case "/api/beds": {
      await requireUser(env, body.session, ["staff", "doctor", "billing"]);
      await needFeature(env, "ip");
      const wards = (await listDocs(env, "wards")).sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name)));
      const adm = await listDocs(env, "admissions", "json_extract(data, '$.status') = 'admitted'");
      const used = new Set();
      const out = wards.map((w) => {
        const beds = String(w.beds || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean).map((bed) => {
          const a = adm.find((x) => String(x.bed || "").trim().toLowerCase() === bed.toLowerCase() && (!w.match || x.ward === w.match || x.ward === w.name));
          if (a) used.add(a.id);
          return { bed, admission: a ? { id: a.id, no: a.no, patient: a.patient, doctor: a.doctor, day: Math.max(1, Math.ceil((Date.now() - a.admittedAt) / 864e5)), reason: a.reason } : null, blocked: (w.blocked || []).includes(bed) };
        });
        return { id: w.id, name: w.name, match: w.match || "", beds, free: beds.filter((b) => !b.admission && !b.blocked).length, occupied: beds.filter((b) => b.admission).length };
      });
      const unassigned = adm.filter((a) => !used.has(a.id)).map((a) => ({ id: a.id, no: a.no, patient: a.patient, ward: a.ward, bed: a.bed }));
      return json({ wards: out, unassigned, totals: { beds: out.reduce((x, w) => x + w.beds.length, 0), occupied: out.reduce((x, w) => x + w.occupied, 0), free: out.reduce((x, w) => x + w.free, 0) } });
    }

    // ----- insurance claims -----
    case "/api/claims/action": {
      const me = await requireUser(env, body.session, ["billing"]);
      await needFeature(env, "insurance");
      const id = String(body.id || "");
      const c = await getDoc(env, "claims", id);
      if (!c) throw new HttpError(404, "Claim not found");
      const steps = { submit: "pre-auth sent", approve: "approved", query: "query", reject: "rejected", enhance: "enhancement sent", final: "final claim sent", settle: "settled", close: "closed" };
      const st = steps[body.action];
      if (!st) throw new HttpError(400, "Unknown step");
      c.status = st;
      const amt = money(body.amount);
      if (body.action === "approve") c.approved = money((c.approved || 0) + amt);
      if (body.action === "settle") {
        c.settled = amt; c.deduction = money(body.deduction); c.utr = clean(body.utr, 60);
        if (c.billId && amt > 0) {
          const b = await getDoc(env, "bills", c.billId);
          if (b && b.status !== "cancelled") { const pay = Math.min(amt, Math.max(0, b.balance)); if (pay > 0) { b.payments.push({ amount: pay, mode: "Insurance", ref: `${c.no} ${c.utr}`.trim(), at: Date.now(), by: me.user.name || me.role }); computeBill(b); await putDoc(env, "bills", c.billId, b); } }
        }
      }
      c.log = (c.log || []).concat([{ step: st, amount: amt, note: clean(body.note, 500), at: Date.now(), by: me.user.name || me.role }]).slice(-50);
      await putDoc(env, "claims", id, c);
      return json({ claim: Object.assign({ id }, c) });
    }

    // ----- notifications -----
    case "/api/notify/list": {
      const s2 = await readSession(env, body.session);
      if (s2.role === "patient") return json({ items: [] });
      const name = s2.user.name || "";
      const list = (await listDocs(env, "notifications", "json_extract(data, '$.at') >= ?", [Date.now() - 14 * 864e5]))
        .filter((n) => n.to === "role:" + s2.role || n.to === "user:" + name || (s2.role === "admin" && n.to.startsWith("role:")))
        .sort((a, b) => b.at - a.at).slice(0, 60).map((n) => ({ id: n.id, title: n.title, body: n.body, link: n.link, at: n.at, read: (n.readBy || []).includes(s2.uid) }));
      return json({ items: list, unread: list.filter((n) => !n.read).length });
    }

    case "/api/notify/read": {
      const s2 = await readSession(env, body.session);
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 100) : [];
      for (const id of ids) { const n = await getDoc(env, "notifications", String(id)); if (n && !(n.readBy || []).includes(s2.uid)) { n.readBy = (n.readBy || []).concat([s2.uid]).slice(-200); await putDoc(env, "notifications", String(id), n); } }
      return json({ ok: true });
    }

    // ----- chat with patients -----
    case "/api/chat/threads": {
      await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      await needFeature(env, "chat");
      const msgs = await listDocs(env, "messages", "json_extract(data, '$.at') >= ?", [Date.now() - 90 * 864e5]);
      const t = {};
      for (const m of msgs) { const x = (t[m.patientId] = t[m.patientId] || { patientId: m.patientId, name: m.patientName, last: null, unread: 0 }); if (!x.last || m.at > x.last.at) x.last = { text: m.text, at: m.at, from: m.from }; if (m.from === "patient" && !m.read) x.unread++; }
      return json({ threads: Object.values(t).sort((a, b) => b.last.at - a.last.at) });
    }

    case "/api/chat/get": {
      let pid, who;
      const s2 = await readSession(env, body.session);
      if (s2.role === "patient") { pid = s2.uid; who = "patient"; }
      else { await requireUser(env, body.session, ["doctor", "staff", "billing"]); pid = String(body.patientId || "").toUpperCase(); who = "clinic"; }
      const msgs = (await listDocs(env, "messages", "json_extract(data, '$.patientId') = ?", [pid])).sort((a, b) => a.at - b.at).slice(-200);
      for (const m of msgs) if (!m.read && m.from !== who) { m.read = true; const id = m.id; delete m.id; await putDoc(env, "messages", id, m); m.id = id; }
      return json({ messages: msgs });
    }

    case "/api/chat/send": {
      const s2 = await readSession(env, body.session);
      const text = clean(body.text, 2000);
      if (!text) throw new HttpError(400, "Write a message");
      let pid, name, from, by;
      if (s2.role === "patient") { pid = s2.uid; name = s2.user.name; from = "patient"; by = s2.user.name; }
      else {
        await requireUser(env, body.session, ["doctor", "staff", "billing"]);
        pid = String(body.patientId || "").toUpperCase();
        const p = await getDoc(env, "patients", pid);
        if (!p) throw new HttpError(404, "Patient not found");
        name = p.name; from = "clinic"; by = s2.user.name || s2.role;
      }
      await putDoc(env, "messages", crypto.randomUUID(), { patientId: pid, patientName: name, from, by, text, at: Date.now(), read: false });
      if (from === "patient") await notify(env, { to: "role:staff", title: "New message from a patient", body: `${name}: ${text.slice(0, 120)}`, link: "msg-" + pid });
      return json({ ok: true });
    }

    // ----- files: report photos and PDFs -----
    case "/api/files/upload": {
      const me = await requireUser(env, body.session, ["doctor", "staff", "lab", "diagnostics"]);
      const data = String(body.data || "");
      if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new HttpError(400, "File data is not valid");
      if (data.length > 1200000) throw new HttpError(400, "File is too large. Keep it under 850 KB (photos are shrunk automatically).");
      const type = ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(body.type) ? body.type : "";
      if (!type) throw new HttpError(400, "Only photos (JPG, PNG) and PDF files");
      const id = crypto.randomUUID();
      await putDoc(env, "files", id, { name: clean(body.name, 120) || "report", type, data, patientId: String(body.patientId || "").toUpperCase(), orderId: clean(body.orderId, 64), visitId: clean(body.visitId, 64), at: Date.now(), by: me.user.name || me.role });
      if (body.orderId) { const o = await getDoc(env, "orders", String(body.orderId)); if (o) { o.files = (o.files || []).concat([id]).slice(-10); await putDoc(env, "orders", String(body.orderId), o); } }
      return json({ id });
    }

    case "/api/files/list": {
      await requireUser(env, body.session, ["doctor", "staff", "lab", "diagnostics"]);
      const pid = String(body.patientId || "").toUpperCase();
      const rows = (await D.prepare("SELECT id, json_extract(data, '$.name') AS name, json_extract(data, '$.type') AS type, json_extract(data, '$.at') AS at, json_extract(data, '$.by') AS by, json_extract(data, '$.orderId') AS orderId FROM docs WHERE coll = 'files' AND json_extract(data, '$.patientId') = ?").bind(pid).all()).results || [];
      return json({ files: rows.sort((a, b) => b.at - a.at) });
    }

    case "/api/files/get": {
      const s2 = await readSession(env, body.session);
      const f = await getDoc(env, "files", String(body.id || ""));
      if (!f) throw new HttpError(404, "File not found");
      if (s2.role === "patient" && f.patientId !== s2.uid) throw new HttpError(403, "Not your file");
      return json({ name: f.name, type: f.type, data: f.data });
    }

    // ----- WhatsApp and online payment -----
    case "/api/wa/send": {
      // Sends through the WhatsApp Cloud API when the clinic has set it up; otherwise returns a wa.me link to open.
      const me = await requireUser(env, body.session, ["doctor", "staff", "billing", "pharmacy", "lab", "diagnostics"]);
      const phone = digits(body.phone), text = clean(body.text, 1500);
      if (phone.length !== 10 || !text) throw new HttpError(400, "Enter a 10-digit mobile number and the message");
      if (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID) {
        const r = await fetch(`https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_ID}/messages`, { method: "POST", headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to: "91" + phone, type: "text", text: { body: text } }) });
        if (r.ok) return json({ sent: true });
      }
      return json({ sent: false, link: `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`, by: me.role });
    }

    case "/api/pay/link": {
      // UPI payment details for a bill; a Razorpay payment link when the clinic has added its keys.
      await requireUser(env, body.session, ["billing", "pharmacy", "lab", "diagnostics", "staff"]);
      const b = await getDoc(env, "bills", String(body.billId || ""));
      if (!b) throw new HttpError(404, "Bill not found");
      if (!(b.balance > 0)) throw new HttpError(400, "Nothing is due on this bill");
      const c = await clinicInfo(env);
      const upi = c.upi ? `upi://pay?pa=${encodeURIComponent(c.upi)}&pn=${encodeURIComponent(c.name)}&am=${b.balance.toFixed(2)}&cu=INR&tn=${encodeURIComponent("Bill " + b.no)}` : "";
      let link = "";
      if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
        const r = await fetch("https://api.razorpay.com/v1/payment_links", { method: "POST", headers: { authorization: "Basic " + btoa(env.RAZORPAY_KEY_ID + ":" + env.RAZORPAY_KEY_SECRET), "content-type": "application/json" },
          body: JSON.stringify({ amount: Math.round(b.balance * 100), currency: "INR", description: `${c.name} · ${b.deptName} bill ${b.no}`, reference_id: String(body.billId),
            customer: { name: b.patient.name, contact: b.patient.phone ? "+91" + b.patient.phone : undefined }, notify: { sms: !!b.patient.phone }, reminder_enable: true }) });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.short_url) link = j.short_url;
      }
      return json({ amount: b.balance, upi, link, no: b.no });
    }

    // ----- HMIS: inpatient chart -----
    case "/api/hmis/ip/chart": {
      const me = await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      await needFeature(env, "ip");
      const id = String(body.admissionId || "");
      const a = await getDoc(env, "admissions", id);
      if (!a) throw new HttpError(404, "Admission not found");
      a.id = id;
      const pid = a.patient?.id || "";
      const p = pid ? await getDoc(env, "patients", pid) : null;
      const orders = await listDocs(env, "orders", "json_extract(data, '$.visitId') = ?", ["ip:" + id]);
      const surgeries = (await listDocs(env, "requests", "json_extract(data, '$.type') = 'surgery'")).filter((r) => r.admissionId === id || (pid && r.patient?.id === pid && r.date >= new Date(a.admittedAt + 330 * 60000).toISOString().slice(0, 10)));
      const deptBills = await listDocs(env, "bills", "json_extract(data, '$.admissionId') = ?", [id]);
      return json({ me: { name: me.user.name, role: me.role }, admission: a, patient: p ? publicPatient(pid, p) : a.patient, flags: { allergy: p?.allergy || "", remarks: p?.remarks || "" },
        account: await ipAccount(env, a), orders: orders.sort((x, y) => x.orderedAt - y.orderedAt), surgeries, history: pid ? (await patientHistory(env, pid)).slice(0, 10) : [],
        deptBills: deptBills.map((b) => ({ id: b.id, no: b.no, deptName: b.deptName, total: b.total, status: b.status })),
        finalBill: a.finalBillId ? Object.assign({ id: a.finalBillId }, await getDoc(env, "bills", a.finalBillId)) : null });
    }

    case "/api/hmis/ip/record": {
      // Clinical entries on an admission: progress notes and ward rounds, nursing notes, vitals, medicine orders, doses given, discharge summary.
      const me = await requireUser(env, body.session, ["doctor", "staff"]);
      const id = String(body.admissionId || "");
      const a = await getDoc(env, "admissions", id);
      if (!a) throw new HttpError(404, "Admission not found");
      const by = me.user.name || me.role, at = Date.now(), kind = String(body.kind || "");
      const rid = () => randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 8);
      const txt = (x, n = 4000) => clean(x, n);
      if (kind === "note") {
        const t = ["round", "progress", "nursing", "procedure"].includes(body.type) ? body.type : "progress";
        if (t !== "nursing" && me.role === "staff") throw new HttpError(403, "Nurses add nursing notes");
        const f = {};
        for (const [k, x] of Object.entries(body.fields || {}).slice(0, 20)) f[clean(k, 40)] = txt(x);
        a.notes = (a.notes || []).concat([{ id: rid(), type: t, fields: f, at, by, role: me.role }]).slice(-300);
      } else if (kind === "vitals") {
        const vit = {};
        for (const k of ["temp", "pulse", "bp", "rr", "spo2", "o2", "rbs", "pain", "intake", "output", "gcs"]) vit[k] = clean(body.vitals?.[k], 12);
        a.vitalsLog = (a.vitalsLog || []).concat([{ at, by, vitals: vit, note: txt(body.note, 300) }]).slice(-500);
      } else if (kind === "drug") {
        if (me.role === "staff") throw new HttpError(403, "Only doctors order medicines");
        const d = body.drug || {};
        if (!clean(d.name, 120)) throw new HttpError(400, "Enter the medicine");
        a.drugs = (a.drugs || []).concat([{ id: rid(), name: clean(d.name, 120), dose: clean(d.dose, 40), route: clean(d.route, 20) || "Oral", freq: clean(d.freq, 30) || "BD",
          times: clean(d.times, 60), notes: clean(d.notes, 200), start: at, by, active: true }]).slice(-200);
      } else if (kind === "drugStop") {
        if (me.role === "staff") throw new HttpError(403, "Only doctors stop medicines");
        for (const d of a.drugs || []) if (d.id === body.drugId) { d.active = false; d.stoppedAt = at; d.stoppedBy = by; }
      } else if (kind === "dose") {
        const d = (a.drugs || []).find((x) => x.id === body.drugId);
        if (!d) throw new HttpError(404, "Medicine not found");
        a.mar = (a.mar || []).concat([{ id: rid(), drugId: d.id, drug: d.name + " " + d.dose, status: body.status === "held" ? "held" : body.status === "refused" ? "refused" : "given", note: txt(body.note, 200), at, by }]).slice(-2000);
      } else if (kind === "discharge") {
        if (me.role === "staff") throw new HttpError(403, "Only doctors write the discharge summary");
        const f = {};
        for (const [k, x] of Object.entries(body.fields || {}).slice(0, 20)) f[clean(k, 40)] = txt(x, 6000);
        a.dischargeSummary = { fields: f, at, by, final: !!body.final };
      } else throw new HttpError(400, "Unknown entry");
      await putDoc(env, "admissions", id, a);
      return json({ ok: true });
    }

    // ----- operation theatre -----
    case "/api/ot/list": {
      await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      await needFeature(env, "ot");
      const from = String(body.from || clinicNow(env).date), to = String(body.to || addDays(from, 7));
      const list = (await listDocs(env, "requests", "json_extract(data, '$.type') = 'surgery'"))
        .filter((r) => (r.date >= from && r.date <= to) || (r.ot?.status === "in-theatre"))
        .sort((x, y) => (x.date + (x.ot?.time || x.fields.time || "")).localeCompare(y.date + (y.ot?.time || y.fields.time || "")));
      return json({ from, to, surgeries: list });
    }

    case "/api/ot/get": {
      await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      const r = await getDoc(env, "requests", String(body.id || ""));
      if (!r || r.type !== "surgery") throw new HttpError(404, "Surgery not found");
      const pid = r.patient?.id;
      const adm = r.admissionId ? await getDoc(env, "admissions", r.admissionId) : pid ? await activeAdmission(env, pid) : null;
      const p = pid ? await getDoc(env, "patients", pid) : null;
      return json({ surgery: Object.assign({ id: String(body.id) }, r), admission: adm ? { id: adm.id || r.admissionId, no: adm.no, ward: adm.ward, bed: adm.bed, status: adm.status } : null,
        allergy: p?.allergy || "", tariff: await tariff(env, "ip") });
    }

    case "/api/ot/update": {
      // Schedule, checklists, operation notes, post-op orders and monitoring, and OT charges.
      const me = await requireUser(env, body.session, ["doctor", "staff"]);
      await needFeature(env, "ot");
      const id = String(body.id || "");
      const r = await getDoc(env, "requests", id);
      if (!r || r.type !== "surgery") throw new HttpError(404, "Surgery not found");
      const by = me.user.name || me.role, at = Date.now();
      r.ot = r.ot || { status: "scheduled", log: [] };
      const ot = r.ot;
      const put = (k, v) => { ot[k] = v; };
      const cleanObj = (o, n = 2000) => Object.fromEntries(Object.entries(o || {}).slice(0, 40).map(([k, v]) => [clean(k, 60), typeof v === "boolean" ? v : clean(v, n)]));
      if (body.schedule) {
        const sc = body.schedule;
        if (/^\d{4}-\d{2}-\d{2}$/.test(sc.date || "")) r.date = sc.date;
        put("time", clean(sc.time, 5)); put("theatre", clean(sc.theatre, 30)); put("team", cleanObj(sc.team, 120));
      }
      if (body.status) {
        const st = ["scheduled", "in-theatre", "done", "cancelled", "postponed"].includes(body.status) ? body.status : ot.status;
        ot.status = st;
        if (st === "in-theatre") ot.inAt = at;
        if (st === "done") { ot.outAt = at; r.status = "done"; }
        if (st === "cancelled") r.status = "cancelled";
      }
      if (body.preop) put("preop", Object.assign(cleanObj(body.preop), { by, at }));
      if (body.who) put("who", Object.assign(ot.who || {}, cleanObj(body.who), { by, at }));
      if (body.opnote) {
        if (me.role !== "doctor" && me.role !== "admin") throw new HttpError(403, "Only doctors write the operation notes");
        put("opnote", Object.assign(cleanObj(body.opnote, 6000), { by, at }));
      }
      if (body.postop) {
        if (me.role !== "doctor" && me.role !== "admin") throw new HttpError(403, "Only doctors write post-op orders");
        put("postop", Object.assign(cleanObj(body.postop, 4000), { by, at }));
      }
      if (body.obs) ot.obs = (ot.obs || []).concat([{ ...cleanObj(body.obs, 200), by, at }]).slice(-200);
      if (body.charges) {
        // Post OT charges to the inpatient account (once).
        if (ot.charged) throw new HttpError(409, "OT charges are already on the bill");
        const adm = r.admissionId ? await getDoc(env, "admissions", r.admissionId) : r.patient?.id ? await activeAdmission(env, r.patient.id) : null;
        const admId = r.admissionId || adm?.id;
        if (!adm || adm.status !== "admitted") throw new HttpError(400, "Admit the patient first; OT charges go on the inpatient bill");
        const lines = (Array.isArray(body.charges) ? body.charges : []).slice(0, 20).map((c) => ({ desc: clean(c.desc, 160), qty: Math.max(0, Number(c.qty) || 1), rate: Math.max(0, money(c.rate)) })).filter((c) => c.desc && c.rate > 0);
        if (!lines.length) throw new HttpError(400, "Add at least one charge");
        adm.charges = (adm.charges || []).concat(lines.map((c) => ({ id: randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 8), desc: `${c.desc} (${r.fields.procedure || "surgery"})`, qty: c.qty, rate: c.rate, amount: money(c.qty * c.rate), date: clinicNow(env).date, by })));
        delete adm.id;
        await putDoc(env, "admissions", admId, adm);
        ot.charged = { at, by, total: money(lines.reduce((x, c) => x + c.qty * c.rate, 0)) };
      }
      ot.log = (ot.log || []).concat([{ at, by, what: Object.keys(body).filter((k) => !["session", "id"].includes(k)).join(", ") }]).slice(-100);
      await putDoc(env, "requests", id, r);
      return json({ surgery: Object.assign({ id }, r) });
    }

    // ----- HMIS web: doctor's dashboard and patient chart -----
    case "/api/hmis/dashboard": {
      const me = await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : clinicNow(env).date;
      const visits = await listDocs(env, "visits", "json_extract(data, '$.date') = ?", [date]);
      const appts = (await D.prepare("SELECT mode, status, source FROM appointments WHERE date = ? AND status != 'cancelled'").bind(date).all()).results || [];
      const admitted = await listDocs(env, "admissions", "json_extract(data, '$.status') = 'admitted'");
      const orders = await listDocs(env, "orders", "json_extract(data, '$.date') = ?", [date]);
      const ots = (await listDocs(env, "requests", "json_extract(data, '$.type') = 'surgery'")).filter((r) => r.date >= date);
      const seen = new Set();
      const rows = [];
      for (const v of visits) {
        const pid = v.patient?.id || "";
        let review = false;
        if (pid) review = (await listDocs(env, "visits", "json_extract(data, '$.patient.id') = ? AND json_extract(data, '$.date') < ?", [pid, date])).length > 0;
        const os = orders.filter((o) => o.visitId === v.id);
        rows.push({ id: v.id, kind: "OP", regNo: pid, token: v.token, at: v.createdAt, patient: v.patient, urgent: !!v.urgent, status: v.status || "waiting",
          review, complaint: visitSummary(v.id, v).complaint, orders: { total: os.length, done: os.filter((o) => o.status === "reported").length }, doctor: v.doctor?.name || "" });
        if (pid) seen.add(pid);
      }
      for (const a of admitted) rows.push({ id: "", admissionId: a.id, day: Math.max(1, Math.ceil((Date.now() - a.admittedAt) / 86400000)), kind: "IP", regNo: a.patient?.id || "", token: a.no, at: a.admittedAt, patient: a.patient, status: "admitted", ward: `${a.ward} ${a.bed}`.trim(), doctor: a.doctor, orders: { total: 0, done: 0 } });
      rows.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || (a.kind === b.kind ? (a.at || 0) - (b.at || 0) : a.kind === "OP" ? -1 : 1));
      const today = date === clinicNow(env).date;
      return json({ date, me: { name: me.user.name, role: me.role },
        tiles: {
          appointment: { total: appts.length, phone: appts.filter((a) => a.source !== "patient").length, online: appts.filter((a) => a.source === "patient").length, video: appts.filter((a) => a.mode === "tele").length },
          outpatient: { total: visits.length, new: rows.filter((r) => r.kind === "OP" && !r.review).length, review: rows.filter((r) => r.kind === "OP" && r.review).length, emergency: visits.filter((v) => v.urgent).length },
          inpatient: { total: admitted.length, today: admitted.filter((a) => new Date(a.admittedAt + 330 * 60000).toISOString().slice(0, 10) === date).length, existing: admitted.filter((a) => new Date(a.admittedAt + 330 * 60000).toISOString().slice(0, 10) !== date).length },
          investigation: { total: orders.length, inProgress: orders.filter((o) => o.status !== "reported").length, completed: orders.filter((o) => o.status === "reported").length },
          surgery: { total: ots.filter((r) => r.date === date).length, scheduled: ots.filter((r) => r.date === date && !["done", "cancelled"].includes(r.ot?.status || r.status)).length, completed: ots.filter((r) => r.date === date && (r.ot?.status || r.status) === "done").length },
        }, rows, today });
    }

    case "/api/hmis/chart": {
      await requireUser(env, body.session, ["doctor", "staff"]);
      const id = String(body.visitId || "");
      const v = await getDoc(env, "visits", id);
      if (!v) throw new HttpError(404, "Visit not found");
      const pid = v.patient?.id || "";
      const p = pid ? await getDoc(env, "patients", pid) : null;
      const orders = await listDocs(env, "orders", "json_extract(data, '$.visitId') = ?", [id]);
      const history = pid ? (await patientHistory(env, pid)) : [];
      const letters = pid ? await listDocs(env, "letters", "json_extract(data, '$.patient.id') = ?", [pid]) : [];
      const requests = await listDocs(env, "requests", "json_extract(data, '$.visitId') = ?", [id]);
      const adm = pid ? await activeAdmission(env, pid) : null;
      return json({ visit: Object.assign({ id }, v), patient: p ? publicPatient(pid, p) : null, flags: { allergy: p?.allergy || "", remarks: p?.remarks || "", photo: "" },
        orders: orders.sort((a, b) => a.orderedAt - b.orderedAt), history, letters: letters.sort((a, b) => b.created - a.created).slice(0, 30),
        requests: requests.sort((a, b) => b.created - a.created), admission: adm ? { id: adm.id, no: adm.no, ward: adm.ward, bed: adm.bed } : null });
    }

    case "/api/hmis/vitals": {
      const me = await requireUser(env, body.session, ["doctor", "staff"]);
      const id = String(body.visitId || "");
      const v = await getDoc(env, "visits", id);
      if (!v) throw new HttpError(404, "Visit not found");
      const vit = {};
      for (const k of ["temp", "pulse", "bp", "rr", "spo2", "o2", "height", "weight", "bmi", "rbs", "pain"]) vit[k] = clean(body.vitals?.[k], 12);
      const h = Number(vit.height), w = Number(vit.weight);
      if (!vit.bmi && h > 0 && w > 0) vit.bmi = (w / ((h / 100) ** 2)).toFixed(1);
      const entry = { at: Date.now(), by: me.user.name || me.role, vitals: vit, note: clean(body.note, 300) };
      v.vitalsLog = (v.vitalsLog || []).concat([entry]).slice(-100);
      v.triage = { vitals: Object.assign({}, v.triage?.vitals || {}, Object.fromEntries(Object.entries(vit).filter(([, x]) => x))), note: v.triage?.note || "", at: Date.now() };
      await putDoc(env, "visits", id, v);
      return json({ ok: true, vitalsLog: v.vitalsLog });
    }

    case "/api/hmis/note": {
      const me = await requireUser(env, body.session, ["doctor", "staff"]);
      const id = String(body.visitId || "");
      const v = await getDoc(env, "visits", id);
      if (!v) throw new HttpError(404, "Visit not found");
      const fields = {};
      for (const [k, x] of Object.entries(body.fields || {}).slice(0, 60)) fields[clean(k, 60)] = Array.isArray(x) ? x.slice(0, 40).map((y) => clean(y, 80)) : clean(x, 4000);
      const note = { id: randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 8), template: clean(body.template, 60), fields, icd: clean(body.icd, 120), at: Date.now(), by: me.user.name || me.role, role: me.role };
      v.notes = (v.notes || []).concat([note]).slice(-50);
      if (note.icd) v.icd = (v.icd || []).concat([{ text: note.icd, at: note.at, by: note.by }]).slice(-20);
      await putDoc(env, "visits", id, v);
      return json({ note });
    }

    case "/api/hmis/flags": {
      await requireUser(env, body.session, ["doctor", "staff"]);
      const pid = String(body.patientId || "").toUpperCase();
      const p = await getDoc(env, "patients", pid);
      if (!p) throw new HttpError(404, "Patient not found");
      if ("allergy" in body) p.allergy = clean(body.allergy, 300);
      if ("remarks" in body) p.remarks = clean(body.remarks, 500);
      await putDoc(env, "patients", pid, p);
      return json({ ok: true });
    }

    case "/api/hmis/doctors": {
      await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      return json({ doctors: (await listDocs(env, "users")).filter((u) => u.role === "doctor" && u.active !== false).map((u) => ({ id: u.id, name: u.name, qual: u.qual || "" })) });
    }

    case "/api/hmis/request": {
      // Cross consultation, surgery booking or diet advice raised from the patient chart.
      const me = await requireUser(env, body.session, ["doctor"]);
      const type = String(body.type || "");
      if (!["consult", "surgery", "diet"].includes(type)) throw new HttpError(400, "Unknown request");
      if (type === "surgery") await needFeature(env, "ot");
      const v = body.admissionId ? await getDoc(env, "admissions", String(body.admissionId)) : await getDoc(env, "visits", String(body.visitId || ""));
      if (!v) throw new HttpError(404, "Patient record not found");
      const f = {};
      for (const [k, x] of Object.entries(body.fields || {}).slice(0, 30)) f[clean(k, 40)] = clean(x, 1500);
      const r = { type, visitId: String(body.visitId || ""), admissionId: String(body.admissionId || ""), admissionNo: v.no || "", patient: billPatient(v.patient || {}), fields: f, toDoctor: clean(body.toDoctor, 80), status: "open",
        date: /^\d{4}-\d{2}-\d{2}$/.test(f.date || "") ? f.date : clinicNow(env).date, created: Date.now(), by: me.user.name || me.role, byId: me.uid };
      const id = crypto.randomUUID();
      await putDoc(env, "requests", id, r);
      if (type === "consult") await notify(env, { to: r.toDoctor ? "user:" + r.toDoctor : "role:doctor", title: "Cross consultation request", body: `${r.patient.name} from ${r.by}: ${f.remarks || f.unit || ""}`, link: r.admissionId ? "ip-" + r.admissionId : "v-" + r.visitId });
      if (type === "surgery") await notify(env, { to: "role:staff", title: "Surgery booked", body: `${r.patient.name}: ${f.procedure} on ${r.date} ${f.time || ""}`, link: "ot-" + id });
      return json({ request: Object.assign({ id }, r) });
    }

    case "/api/hmis/inbox": {
      // Cross consultations sent to me, and surgery list.
      const me = await requireUser(env, body.session, ["doctor", "staff"]);
      const list = (await listDocs(env, "requests", "json_extract(data, '$.status') = 'open'"))
        .filter((r) => (r.type === "consult" && (r.toDoctor === me.user.name || me.role === "admin")) || r.type === "surgery");
      return json({ requests: list.sort((a, b) => a.date.localeCompare(b.date)) });
    }

    case "/api/hmis/request/update": {
      const me = await requireUser(env, body.session, ["doctor"]);
      const id = String(body.id || "");
      const r = await getDoc(env, "requests", id);
      if (!r) throw new HttpError(404, "Request not found");
      if (["open", "done", "declined"].includes(body.status)) r.status = body.status;
      if (body.reply) r.reply = { text: clean(body.reply, 1500), by: me.user.name || me.role, at: Date.now() };
      await putDoc(env, "requests", id, r);
      return json({ ok: true });
    }

    // ----- free trial requests from the website -----
    case "/api/trial": {
      if (body.website) return json({ ok: true }); // hidden field: only bots fill it
      const ip = request.headers.get("cf-connecting-ip") || "local";
      const rl = (await getDoc(env, "ratelimit", "trial:" + ip)) || { n: 0, since: Date.now() };
      if (Date.now() - rl.since > 3600000) { rl.n = 0; rl.since = Date.now(); }
      if (++rl.n > 5) throw new HttpError(429, "Too many requests. Please try again in an hour.");
      await putDoc(env, "ratelimit", "trial:" + ip, rl);
      const name = clean(body.name, 80), hospital = clean(body.hospital, 120), city = clean(body.city, 60), email = clean(body.email, 120).toLowerCase(), phone = digits(body.phone).slice(-10);
      if (!name || !hospital || !city) throw new HttpError(400, "Please fill in your name, hospital name and city.");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Please enter a valid email address.");
      if (phone.length !== 10) throw new HttpError(400, "Please enter a 10-digit mobile number.");
      const plan = ["bronze", "silver", "gold", "platinum"].includes(body.plan) ? body.plan : "";
      await putDoc(env, "leads", crypto.randomUUID(), { name, email, phone, hospital, city, plan, doctors: clean(body.doctors, 6), message: clean(body.message, 500), created: Date.now(), status: "new" });
      return json({ ok: true });
    }

    case "/api/leads": {
      await requireUser(env, body.session, ["admin"]);
      if (body.id && body.status) {
        const l = await getDoc(env, "leads", String(body.id));
        if (l) { l.status = ["new", "contacted", "demo", "won", "lost"].includes(body.status) ? body.status : l.status; await putDoc(env, "leads", String(body.id), l); }
      }
      return json({ leads: (await listDocs(env, "leads")).sort((a, b) => b.created - a.created).slice(0, 300) });
    }

    // ----- plan -----
    case "/api/plan": {
      await readSession(env, body.session);
      const pl = await planInfo(env);
      const users = (await listDocs(env, "users")).filter((u) => u.active !== false);
      return json({ plan: pl, usage: { doctors: users.filter((u) => u.role === "doctor").length, staff: users.filter((u) => u.role !== "doctor" && u.role !== "admin").length }, plans: Object.fromEntries(Object.entries(PLANS).map(([k, v]) => [k, { name: v.name, maxDoctors: v.maxDoctors, maxStaff: v.maxStaff, fee: v.fee, f: v.f }])), featureNames: FEATURE_NAMES });
    }

    case "/api/plan/set": {
      await requireUser(env, body.session, ["admin"]);
      const tier = String(body.tier || "");
      if (!PLANS[tier]) throw new HttpError(400, "Choose a plan");
      const users = (await listDocs(env, "users")).filter((u) => u.active !== false);
      const docs = users.filter((u) => u.role === "doctor").length;
      if (docs > PLANS[tier].maxDoctors) throw new HttpError(409, `${PLANS[tier].name} allows ${PLANS[tier].maxDoctors} doctor login${PLANS[tier].maxDoctors > 1 ? "s" : ""}; you have ${docs} active. Disable some first, or choose a bigger plan.`);
      const addons = (Array.isArray(body.addons) ? body.addons : []).filter((a) => PLANS[tier].f[a] === "addon");
      const old = await getSetting(env, "plan", {});
      const expires = /^\d{4}-\d{2}-\d{2}$/.test(body.expires || "") ? body.expires : old.expires;
      await setSetting(env, "plan", { tier, addons, expires, trial: body.expires ? false : !!old.trial, changedAt: Date.now() });
      return json({ plan: await planInfo(env) });
    }

    // ----- letters and certificates -----
    case "/api/letters/save": {
      const x = body.letter || {};
      const type = String(x.type || "");
      if (!LETTER_TYPES[type]) throw new HttpError(400, "Choose the document type");
      const me = await requireUser(env, body.session, type === "timeslip" ? ["doctor", "staff", "billing"] : ["doctor"]);
      let patient = billPatient(x.patient || {});
      if (x.patientId) {
        const p = await getDoc(env, "patients", String(x.patientId).toUpperCase());
        if (p) patient = billPatient(Object.assign({ id: String(x.patientId).toUpperCase() }, p));
      }
      if (!patient.name) throw new HttpError(400, "Choose the patient");
      const fields = {};
      for (const [k, v] of Object.entries(x.fields || {}).slice(0, 30)) fields[clean(k, 40)] = clean(v, 3000);
      const id = crypto.randomUUID();
      const doc = {
        type, title: LETTER_TYPES[type], no: await nextNo(env, "letter", "DOC"), patient, visitId: clean(x.visitId, 64), fields,
        doctor: { name: me.user.name || "", qual: me.user.qual || "", reg: me.user.reg || "" }, created: Date.now(), date: clinicNow(env).date,
      };
      await putDoc(env, "letters", id, doc);
      return json({ letter: Object.assign({ id }, doc) });
    }

    case "/api/letters/list": {
      await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      const list = body.patientId
        ? await listDocs(env, "letters", "json_extract(data, '$.patient.id') = ?", [String(body.patientId).toUpperCase()])
        : await listDocs(env, "letters", "json_extract(data, '$.date') >= ?", [addDays(clinicNow(env).date, -30)]);
      return json({ letters: list.sort((a, b) => b.created - a.created).slice(0, 200) });
    }

    // ----- follow-ups (review dates) and call-backs -----
    case "/api/followups": {
      await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      const today = clinicNow(env).date;
      const from = String(body.from || addDays(today, -30)), to = String(body.to || addDays(today, 7));
      const visits = await listDocs(env, "visits", "json_extract(data, '$.rx.review') >= ? AND json_extract(data, '$.rx.review') <= ?", [from, to]);
      const out = [];
      for (const v of visits) {
        const pid = v.patient?.id;
        // Came back already? Any later visit by the same patient on or after the review date minus 3 days.
        let came = false;
        if (pid) came = (await listDocs(env, "visits", "json_extract(data, '$.patient.id') = ? AND json_extract(data, '$.date') > ?", [pid, v.date])).length > 0;
        out.push({ visitId: v.id, patient: v.patient, review: v.rx.review, reviewNote: v.rx.reviewNote || "", dx: v.rx.dx || "", visitDate: v.date,
          doctor: v.doctor?.name || "", follow: v.follow || { status: came ? "came" : "due" }, came });
      }
      out.sort((a, b) => a.review.localeCompare(b.review));
      return json({ today, followups: out });
    }

    case "/api/followups/update": {
      const me = await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      const id = String(body.visitId || "");
      const v = await getDoc(env, "visits", id);
      if (!v) throw new HttpError(404, "Visit not found");
      const status = ["due", "called", "no-answer", "booked", "came", "not-coming"].includes(body.status) ? body.status : "called";
      const log = (v.follow?.log || []).concat([{ status, note: clean(body.note, 300), by: me.user.name || me.role, at: Date.now() }]).slice(-20);
      v.follow = { status, note: clean(body.note, 300), log };
      await putDoc(env, "visits", id, v);
      return json({ ok: true, follow: v.follow });
    }

    case "/api/callbacks/list": {
      await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      const status = body.status === "done" ? "done" : "open";
      const list = await listDocs(env, "callbacks", "json_extract(data, '$.status') = ?", [status]);
      return json({ callbacks: list.sort((a, b) => (a.due || "").localeCompare(b.due || "") || b.created - a.created).slice(0, 300) });
    }

    case "/api/callbacks/save": {
      const me = await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      const x = body.callback || {};
      const id = x.id ? String(x.id) : crypto.randomUUID();
      const c = x.id ? await getDoc(env, "callbacks", id) : { created: Date.now(), createdBy: me.user.name || me.role, notes: [], status: "open" };
      if (!c) throw new HttpError(404, "Call-back not found");
      if (!x.id) {
        let patient = billPatient(x.patient || {});
        if (x.patientId) { const p = await getDoc(env, "patients", String(x.patientId).toUpperCase()); if (p) patient = billPatient(Object.assign({ id: String(x.patientId).toUpperCase() }, p)); }
        if (!patient.name || !patient.phone) throw new HttpError(400, "Enter the name and mobile number");
        c.patient = patient;
      }
      if ("reason" in x) c.reason = clean(x.reason, 300);
      if ("due" in x) c.due = /^\d{4}-\d{2}-\d{2}$/.test(x.due) ? x.due : clinicNow(env).date;
      if (x.note) c.notes = (c.notes || []).concat([{ text: clean(x.note, 300), by: me.user.name || me.role, at: Date.now() }]).slice(-30);
      if (x.status === "done" || x.status === "open") c.status = x.status;
      await putDoc(env, "callbacks", id, c);
      return json({ callback: Object.assign({ id }, c) });
    }

    // ----- billing: price list -----
    case "/api/tariff/list": {
      await requireUser(env, body.session, ["doctor", "staff", "pharmacy", "lab", "diagnostics", "billing"]);
      return json({ tariff: await tariff(env, DEPTS[body.dept] ? body.dept : "") });
    }

    case "/api/tariff/save": {
      await requireUser(env, body.session, ["admin"]);
      const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [body.item || {}];
      let n = 0;
      for (const it of items) {
        const name = clean(it.name, 100);
        if (!name || !DEPTS[it.dept] || it.dept === "pharmacy") continue;
        const id = typeof it.id === "string" && ID_RE.test(it.id) ? it.id : crypto.randomUUID();
        await putDoc(env, "tariff", id, { dept: it.dept, name, price: Math.max(0, money(it.price)), unit: it.unit === "per day" ? "per day" : "each" });
        n++;
      }
      await setSetting(env, "tariff_seeded", true);
      return json({ saved: n });
    }

    case "/api/tariff/delete": {
      await requireUser(env, body.session, ["admin"]);
      await D.prepare("DELETE FROM docs WHERE coll = 'tariff' AND id = ?").bind(String(body.id || "")).run();
      return json({ ok: true });
    }

    // ----- billing: department bills -----
    case "/api/bills/draft": {
      // Pre-filled bill for a visit: medicines from the prescription, or unbilled tests, or OPD charges.
      const dept = String(body.dept || "");
      if (!DEPTS[dept] || dept === "ip") throw new HttpError(400, "Unknown department");
      const me = await requireUser(env, body.session, DEPT_ROLES[dept]);
      if (!canDept(me.role, dept)) throw new HttpError(403, "Your login can't bill for this department");
      const vid = String(body.visitId || "");
      const v = vid ? (vid.startsWith("ip:") ? await getDoc(env, "admissions", vid.slice(3)) : await getDoc(env, "visits", vid)) : null;
      let patient = billPatient(v?.patient || {});
      if (!v && body.patientId) {
        const p = await getDoc(env, "patients", String(body.patientId).toUpperCase());
        if (p) patient = billPatient(Object.assign({ id: String(body.patientId).toUpperCase() }, p));
      }
      const items = [], orderIds = [];
      if (dept === "pharmacy" && v?.rx) {
        const stock = await listDocs(env, "stock");
        for (const r of v.rx.items || []) {
          const s = findStock(stock, r.generic);
          items.push({ desc: [r.form, r.generic, r.strength].filter(Boolean).join(" "), qty: rxQuantity(r), rate: s ? money(s.price) : 0, ref: s ? s.id : "", unit: "", inStock: s ? s.stock : 0 });
        }
      } else if ((dept === "lab" || dept === "diagnostics") && v) {
        const kind = dept === "lab" ? "lab" : "imaging";
        const list = await tariff(env, dept);
        for (const o of await listDocs(env, "orders", "json_extract(data, '$.visitId') = ?", [String(body.visitId)])) {
          if (o.kind !== kind || o.billId) continue;
          const t = matchTariff(list, o.test);
          items.push({ desc: o.test, qty: 1, rate: t ? t.price : 0, ref: "" });
          orderIds.push(o.id);
        }
      } else if (dept === "opd") {
        const list = await tariff(env, "opd");
        const first = patient.id ? (await listDocs(env, "visits", "json_extract(data, '$.patient.id') = ?", [patient.id])).length <= 1 : true;
        const pick = (n) => list.find((t) => t.name.toLowerCase() === n.toLowerCase());
        for (const n of first ? ["Registration", "Consultation"] : ["Review consultation"]) { const t = pick(n); if (t) items.push({ desc: t.name, qty: 1, rate: t.price, ref: "" }); }
      }
      const adm = await activeAdmission(env, patient.id);
      return json({ dept, patient, visitId: v ? String(body.visitId) : "", items, orderIds, admission: adm ? { id: adm.id, no: adm.no, ward: adm.ward, bed: adm.bed } : null });
    }

    case "/api/bills/save": {
      const x = body.bill || {};
      const dept = String(x.dept || "");
      if (!DEPTS[dept] || dept === "ip") throw new HttpError(400, "Unknown department");
      const me = await requireUser(env, body.session, DEPT_ROLES[dept]);
      if (!canDept(me.role, dept)) throw new HttpError(403, "Your login can't bill for this department");
      if (dept === "lab" || dept === "diagnostics") await needFeature(env, dept);
      const isNew = !x.id;
      const id = isNew ? crypto.randomUUID() : String(x.id);
      const b = isNew ? { dept, deptName: DEPT_NAMES[dept], payments: [], created: Date.now(), createdBy: me.user.name || me.role, date: clinicNow(env).date } : await getDoc(env, "bills", id);
      if (!b) throw new HttpError(404, "Bill not found");
      if (!isNew && (b.status === "cancelled" || b.status === "on-ip-bill" || (b.paid > 0 && me.role !== "admin"))) throw new HttpError(409, "This bill can't be changed now. Cancel it and make a new one.");
      if (isNew) { b.no = await nextNo(env, dept, DEPTS[dept]); b.branch = me.user.branch || ""; }
      b.patient = billPatient(x.patient || b.patient);
      if (!b.patient.name) throw new HttpError(400, "Enter the patient's name");
      b.visitId = clean(x.visitId ?? b.visitId, 64);
      b.items = x.items; b.discount = x.discount; b.note = clean(x.note, 300);
      // Admitted patient: the bill can go on the inpatient account instead of being paid now.
      if (x.toIp) {
        const adm = await activeAdmission(env, b.patient.id);
        if (!adm) throw new HttpError(400, "This patient is not admitted");
        b.admissionId = adm.id; b.status = "to-ip";
      } else if (b.status === "to-ip") { b.status = "unpaid"; b.admissionId = ""; }
      computeBill(b);
      if (!b.items.length) throw new HttpError(400, "Add at least one item");
      const pay = b.status === "to-ip" ? null : payment(body.pay, me.user.name || me.role);
      if (pay && pay.amount > b.balance + 0.001) throw new HttpError(400, `The bill is ₹${b.balance}. Enter the amount received, up to ₹${b.balance}.`);
      if (pay) { b.payments.push(pay); computeBill(b); }
      if (dept === "pharmacy") await applyStock(env, b);
      await putDoc(env, "bills", id, b);
      for (const oid of Array.isArray(x.orderIds) ? x.orderIds.slice(0, 50) : []) {
        const o = await getDoc(env, "orders", String(oid));
        if (o && !o.billId) { o.billId = id; await putDoc(env, "orders", String(oid), o); }
      }
      if (dept === "pharmacy" && b.visitId) {
        const v = await getDoc(env, "visits", b.visitId);
        if (v) { v.pharmacyBillId = id; if (body.dispense) { v.status = "dispensed"; v.dispensedAt = Date.now(); } await putDoc(env, "visits", b.visitId, v); }
      }
      return json({ bill: Object.assign({ id }, b) });
    }

    case "/api/bills/pay": {
      const id = String(body.id || "");
      const b = await getDoc(env, "bills", id);
      if (!b) throw new HttpError(404, "Bill not found");
      const me = await requireUser(env, body.session, [...DEPT_ROLES[b.dept], "billing"]);
      if (b.status === "cancelled" || b.status === "to-ip" || b.status === "on-ip-bill") throw new HttpError(409, "This bill is not collected at the counter");
      const pay = payment(body, me.user.name || me.role);
      if (!pay) throw new HttpError(400, "Enter the amount received");
      if (pay.amount > b.balance + 0.001) throw new HttpError(400, `Only ₹${b.balance} is due on this bill`);
      b.payments.push(pay); computeBill(b);
      await putDoc(env, "bills", id, b);
      return json({ bill: Object.assign({ id }, b) });
    }

    case "/api/bills/cancel": {
      const id = String(body.id || "");
      const b = await getDoc(env, "bills", id);
      if (!b) throw new HttpError(404, "Bill not found");
      const me = await requireUser(env, body.session, DEPT_ROLES[b.dept]);
      if (b.status === "on-ip-bill") throw new HttpError(409, "This bill is already on a final inpatient bill");
      if (b.paid > 0 && me.role !== "admin") throw new HttpError(403, "Money was received on this bill. Only the admin can cancel it.");
      if (b.dept === "pharmacy") await applyStock(env, b, true);
      b.status = "cancelled"; b.cancelReason = clean(body.reason, 200); b.cancelledBy = me.user.name || me.role; b.cancelledAt = Date.now();
      await putDoc(env, "bills", id, b);
      for (const o of await listDocs(env, "orders", "json_extract(data, '$.billId') = ?", [id])) { delete o.billId; await putDoc(env, "orders", o.id, o); }
      return json({ ok: true });
    }

    case "/api/bills/list": {
      const me = await requireUser(env, body.session, ["pharmacy", "lab", "diagnostics", "billing", "staff"]);
      const conds = [], args = [];
      let dept = String(body.dept || "");
      if (["pharmacy", "lab", "diagnostics"].includes(me.role)) dept = me.role;
      if (dept) { conds.push("json_extract(data, '$.dept') = ?"); args.push(dept); }
      if (body.patientId) { conds.push("json_extract(data, '$.patient.id') = ?"); args.push(String(body.patientId).toUpperCase()); }
      else if (body.from || body.date) {
        conds.push("json_extract(data, '$.date') >= ? AND json_extract(data, '$.date') <= ?");
        args.push(String(body.from || body.date), String(body.to || body.date));
      } else { conds.push("json_extract(data, '$.date') >= ?"); args.push(addDays(clinicNow(env).date, -2)); }
      const list = (await listDocs(env, "bills", conds.join(" AND "), args)).sort((a, b) => b.created - a.created).slice(0, 300);
      return json({ bills: list });
    }

    case "/api/bills/patient": {
      // Hospital total for one patient: every department bill and inpatient stay.
      await requireUser(env, body.session, ["billing", "staff"]);
      const pid = String(body.patientId || "").toUpperCase();
      const p = await getDoc(env, "patients", pid);
      if (!p) throw new HttpError(404, "Patient not found");
      const bills = (await listDocs(env, "bills", "json_extract(data, '$.patient.id') = ?", [pid])).filter((b) => b.status !== "cancelled").sort((a, b) => b.created - a.created);
      const admissions = (await listDocs(env, "admissions", "json_extract(data, '$.patient.id') = ?", [pid])).sort((a, b) => b.admittedAt - a.admittedAt);
      const byDept = {};
      for (const d of Object.keys(DEPTS)) byDept[d] = { billed: 0, paid: 0, due: 0, count: 0 };
      for (const b of bills) {
        if (b.status === "to-ip" || b.status === "on-ip-bill") continue; // counted in the inpatient bill
        const t = byDept[b.dept]; t.billed = money(t.billed + b.total); t.paid = money(t.paid + b.paid); t.due = money(t.due + b.balance); t.count++;
      }
      const running = [];
      for (const a of admissions) if (a.status === "admitted") {
        const acc = await ipAccount(env, a);
        running.push({ id: a.id, no: a.no, total: acc.total, advance: acc.advance, due: acc.due });
        const t = byDept.ip; t.billed = money(t.billed + acc.total); t.paid = money(t.paid + acc.advance); t.due = money(t.due + acc.due); t.count++;
      }
      const total = Object.values(byDept).reduce((x, t) => ({ billed: money(x.billed + t.billed), paid: money(x.paid + t.paid), due: money(x.due + t.due) }), { billed: 0, paid: 0, due: 0 });
      return json({ patient: publicPatient(pid, p), byDept, total, bills, admissions: admissions.map((a) => ({ id: a.id, no: a.no, status: a.status, ward: a.ward, bed: a.bed, admittedAt: a.admittedAt, dischargedAt: a.dischargedAt || 0 })), running });
    }

    case "/api/bills/summary": {
      await requireUser(env, body.session, ["billing"]);
      const from = String(body.from || clinicNow(env).date), to = String(body.to || from);
      const bills = (await listDocs(env, "bills", "json_extract(data, '$.date') >= ? AND json_extract(data, '$.date') <= ?", [from, to])).filter((b) => b.status !== "cancelled");
      const byDept = {}, byMode = {};
      for (const d of Object.keys(DEPTS)) byDept[d] = { billed: 0, collected: 0, count: 0 };
      for (const b of bills) {
        const t = byDept[b.dept];
        if (b.status !== "to-ip" && b.status !== "on-ip-bill") { t.billed = money(t.billed + b.total); t.count++; }
      }
      // Money received in the period, by the day it was received
      const start = Date.parse(from + "T00:00:00Z") - Number(env.CLINIC_TZ_MINUTES ?? 330) * 60000, endT = start + (Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1) * 86400000;
      const recent = await listDocs(env, "bills", "json_extract(data, '$.date') >= ?", [addDays(from, -120)]);
      for (const b of recent) for (const pmt of b.payments || []) if (pmt.at >= start && pmt.at < endT && pmt.mode !== "Advance" && b.status !== "cancelled") {
        byDept[b.dept].collected = money(byDept[b.dept].collected + pmt.amount); byMode[pmt.mode] = money((byMode[pmt.mode] || 0) + pmt.amount);
      }
      for (const a of await listDocs(env, "admissions", "json_extract(data, '$.admittedAt') >= ?", [Date.now() - 400 * 86400000])) for (const d of a.deposits || []) if (d.at >= start && d.at < endT) {
        byDept.ip.collected = money(byDept.ip.collected + d.amount); byMode[d.mode] = money((byMode[d.mode] || 0) + d.amount);
      }
      const totals = Object.values(byDept).reduce((x, t) => ({ billed: money(x.billed + t.billed), collected: money(x.collected + t.collected) }), { billed: 0, collected: 0 });
      return json({ from, to, byDept, byMode, totals });
    }

    // ----- inpatients -----
    case "/api/ip/admit": {
      const me = await requireUser(env, body.session, ["billing", "staff", "doctor"]);
      await needFeature(env, "ip");
      const pid = String(body.patientId || "").toUpperCase();
      const p = await getDoc(env, "patients", pid);
      if (!p) throw new HttpError(404, "Find or register the patient first");
      if (await activeAdmission(env, pid)) throw new HttpError(409, "This patient is already admitted");
      const wards = await tariff(env, "ip");
      const w = wards.find((t) => t.name === body.ward && t.unit === "per day");
      const a = {
        no: await nextNo(env, "ipd", "IPD"), patient: billPatient(Object.assign({ id: pid }, p)), ward: w ? w.name : clean(body.ward, 60) || "General ward",
        wardRate: w ? w.price : Math.max(0, money(body.wardRate)), bed: clean(body.bed, 20), doctor: clean(body.doctor, 80), reason: clean(body.reason, 300),
        admittedAt: Date.now(), admittedBy: me.user.name || me.role, status: "admitted", charges: [], deposits: [],
      };
      const dep = payment(body.deposit, me.user.name || me.role);
      if (dep) a.deposits.push(dep);
      const id = crypto.randomUUID();
      await putDoc(env, "admissions", id, a);
      return json({ admission: Object.assign({ id }, a) });
    }

    case "/api/ip/list": {
      await requireUser(env, body.session, ["billing", "staff", "doctor", "pharmacy", "lab", "diagnostics"]);
      const status = body.status === "discharged" ? "discharged" : "admitted";
      let list = await listDocs(env, "admissions", "json_extract(data, '$.status') = ?", [status]);
      list = list.sort((a, b) => (status === "admitted" ? a.admittedAt - b.admittedAt : b.dischargedAt - a.dischargedAt)).slice(0, 100);
      const out = [];
      for (const a of list) { const acc = await ipAccount(env, a); out.push({ id: a.id, no: a.no, patient: a.patient, ward: a.ward, bed: a.bed, doctor: a.doctor, admittedAt: a.admittedAt, dischargedAt: a.dischargedAt || 0, status: a.status, days: acc.days, total: acc.total, advance: acc.advance, due: acc.due }); }
      return json({ admissions: out });
    }

    case "/api/ip/get": {
      await requireUser(env, body.session, ["billing", "staff", "doctor"]);
      const id = String(body.id || "");
      const a = await getDoc(env, "admissions", id);
      if (!a) throw new HttpError(404, "Admission not found");
      a.id = id;
      return json({ admission: a, account: await ipAccount(env, a), finalBill: a.finalBillId ? Object.assign({ id: a.finalBillId }, await getDoc(env, "bills", a.finalBillId)) : null });
    }

    case "/api/ip/update": {
      // Charges, advances, ward or bed change on an admitted patient.
      const me = await requireUser(env, body.session, ["billing", "staff"]);
      const id = String(body.id || "");
      const a = await getDoc(env, "admissions", id);
      if (!a) throw new HttpError(404, "Admission not found");
      if (a.status !== "admitted") throw new HttpError(409, "This patient is already discharged");
      a.id = id;
      const by = me.user.name || me.role;
      if (body.charge) {
        const c = body.charge, qty = Math.max(0, Number(c.qty) || 1), rate = Math.max(0, money(c.rate));
        if (!clean(c.desc, 160)) throw new HttpError(400, "Enter what the charge is for");
        a.charges.push({ id: randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 8), desc: clean(c.desc, 160), qty, rate, amount: money(qty * rate), date: clinicNow(env).date, by });
      }
      if (body.removeCharge) {
        if (me.role !== "billing" && me.role !== "admin") throw new HttpError(403, "Only billing can remove a charge");
        a.charges = a.charges.filter((c) => c.id !== body.removeCharge);
      }
      if (body.deposit) {
        if (me.role !== "billing" && me.role !== "admin") throw new HttpError(403, "Only billing can take an advance");
        const d = payment(body.deposit, by); if (!d) throw new HttpError(400, "Enter the amount"); a.deposits.push(d);
      }
      if (body.bed !== undefined) a.bed = clean(body.bed, 20);
      if (body.ward) {
        const w = (await tariff(env, "ip")).find((t) => t.name === body.ward && t.unit === "per day");
        if (w) {
          // Bill the days so far at the old rate, then continue at the new one.
          const acc = await ipAccount(env, a);
          if (a.wardRate > 0) a.charges.push({ id: randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 8), desc: `${a.ward} (${acc.days} day${acc.days > 1 ? "s" : ""}, before transfer)`, qty: acc.days, rate: a.wardRate, amount: money(acc.days * a.wardRate), date: clinicNow(env).date, by });
          a.ward = w.name; a.wardRate = w.price; a.admittedAt = Date.now();
          a.transfers = (a.transfers || []).concat([{ to: w.name, at: Date.now(), by }]);
        }
      }
      delete a.id;
      await putDoc(env, "admissions", id, a);
      a.id = id;
      return json({ admission: a, account: await ipAccount(env, a) });
    }

    case "/api/ip/discharge": {
      // Final inpatient bill: room days, charges, department bills sent to IP, advances, discount, balance paid.
      const me = await requireUser(env, body.session, ["billing"]);
      const id = String(body.id || "");
      const a = await getDoc(env, "admissions", id);
      if (!a) throw new HttpError(404, "Admission not found");
      if (a.status !== "admitted") throw new HttpError(409, "Already discharged");
      a.id = id;
      a.dischargedAt = Date.now();
      const acc = await ipAccount(env, a);
      const by = me.user.name || me.role;
      const b = {
        dept: "ip", deptName: "Inpatient", no: await nextNo(env, "ip", "IP"), patient: a.patient, admissionId: id, admissionNo: a.no,
        items: acc.lines.map((l) => ({ desc: l.desc, qty: l.qty, rate: l.rate, ref: l.billId || "" })), discount: body.discount, note: clean(body.note, 300),
        payments: (a.deposits || []).map((d) => ({ amount: d.amount, mode: "Advance", ref: d.mode, at: d.at, by: d.by })),
        created: Date.now(), createdBy: by, date: clinicNow(env).date, admittedAt: a.admittedAt, dischargedAt: a.dischargedAt, ward: a.ward, bed: a.bed, doctor: a.doctor,
      };
      computeBill(b);
      const pay = payment(body.pay, by);
      if (pay && pay.amount > b.balance + 0.001) throw new HttpError(400, b.balance > 0 ? `Only ₹${b.balance} is due after the advance` : "Nothing is due: the advance covers the bill");
      if (pay) { b.payments.push(pay); computeBill(b); }
      const billId = crypto.randomUUID();
      await putDoc(env, "bills", billId, b);
      for (const l of acc.lines) if (l.billId) { const db2 = await getDoc(env, "bills", l.billId); if (db2) { db2.status = "on-ip-bill"; db2.ipBillId = billId; await putDoc(env, "bills", l.billId, db2); } }
      a.status = "discharged"; a.finalBillId = billId; a.dischargedBy = by;
      delete a.id;
      await putDoc(env, "admissions", id, a);
      return json({ bill: Object.assign({ id: billId }, b) });
    }

    // ----- AI (OpenAI), for the doctor's tools -----
    case "/api/ai": {
      await requireStaff(env, body.session, ["doctor"]);
      const prompt = clean(body.prompt, 60000);
      if (!prompt) throw new HttpError(400, "Empty prompt");
      return json(await askOpenAI(env, prompt, !!body.json));
    }
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (e) { return json({ error: e.message || "Server error" }, e.status || 500); }
  },
};

export { allSlots, makeSession, requireStaff, issueToken, clinicNow, validAadhaar, hashPassword, checkPassword };


// Booking page opened from the clinic QR code. Plain HTML, no app needed.
function bookingPage(c) {
  const esc = (x) => String(x || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Book an appointment · ${esc(c.name)}</title>
<style>
:root{--bg:#f4f7f6;--card:#fff;--fg:#14201f;--muted:#5a6b68;--line:#d6e0dd;--teal:#0e6a64;--soft:#dfeeeb;--red:#b3261e}
@media(prefers-color-scheme:dark){:root{--bg:#0f1716;--card:#172221;--fg:#e6efed;--muted:#9db0ac;--line:#2a3a38;--teal:#5fc2b8;--soft:#1d3633;--red:#f2867f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px max(16px,env(safe-area-inset-left))}
main{max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:14px}h1{font:600 26px Georgia,serif;margin:0}.rx{color:var(--red)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:10px}
label{font-size:13px;color:var(--muted);display:flex;flex-direction:column;gap:4px}input,select,textarea{font:inherit;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg)}
.row{display:flex;gap:8px}.row>*{flex:1}.slots{display:flex;flex-wrap:wrap;gap:6px}.slots button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:6px 12px;font:inherit;font-size:14px}
.slots button[aria-pressed=true]{background:var(--teal);color:#fff;border-color:var(--teal)}.slots button:disabled{opacity:.35}
.go{background:var(--teal);color:#fff;border:0;border-radius:999px;padding:13px;font:600 16px system-ui}.go:disabled{opacity:.5}.err{color:var(--red)}.ok{font-size:15px}.code{font:700 34px ui-monospace,monospace;color:var(--teal)}.muted{color:var(--muted);font-size:14px}
</style></head><body><main>
<div><h1><span class="rx">℞</span> ${esc(c.name || "Rx Clinic")}</h1><div class="muted">${esc(c.doctor)} ${c.qual ? "· " + esc(c.qual) : ""}<br>${esc(c.address)} ${c.phone ? "· " + esc(c.phone) : ""}</div></div>
<form class="card" id="f">
<label>Full name<input id="name" required maxlength="60" autocomplete="name"></label>
<div class="row"><label>Age<input id="age" inputmode="numeric" maxlength="3"></label><label>Sex<select id="sex"><option>Female</option><option>Male</option><option>Other</option></select></label></div>
<label>Mobile number<input id="phone" required inputmode="tel" maxlength="10" pattern="[0-9]{10}" autocomplete="tel"></label>
<label>Date<input id="date" type="date" required></label>
<div class="slots" id="slots"></div>
<label>Visit<select id="mode"><option value="clinic">At the clinic</option><option value="tele">Video consultation</option></select></label>
<label>Reason (optional)<textarea id="reason" rows="2" maxlength="300"></textarea></label>
<div class="err" id="err"></div>
<button class="go" id="go" type="submit">Book appointment</button>
</form>
<div class="card ok" id="done" hidden></div>
</main><script>
const $=(i)=>document.getElementById(i);let time="";
const t=new Date();const iso=(d)=>new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10);
$("date").min=iso(t);$("date").value=iso(t);
async function slots(){time="";$("slots").textContent="Loading times…";try{const r=await fetch("/api/slots?date="+$("date").value);const j=await r.json();
$("slots").innerHTML="";(j.slots||[]).forEach(s=>{const b=document.createElement("button");b.type="button";b.textContent=s.t;b.disabled=!s.free;b.setAttribute("aria-pressed","false");
b.onclick=()=>{time=s.t;[...$("slots").children].forEach(x=>x.setAttribute("aria-pressed",x===b?"true":"false"))};$("slots").appendChild(b)});
if(!$("slots").children.length)$("slots").textContent="No times left on this day. Choose another date.";}catch(e){$("slots").textContent="Couldn't load times."}}
$("date").onchange=slots;slots();
$("f").onsubmit=async(e)=>{e.preventDefault();$("err").textContent="";if(!time){$("err").textContent="Choose a time.";return}$("go").disabled=true;
try{const r=await fetch("/api/book",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:$("name").value,age:$("age").value,sex:$("sex").value,phone:$("phone").value,date:$("date").value,time,mode:$("mode").value,reason:$("reason").value,lang:"en"})});
const j=await r.json();if(!r.ok)throw new Error(j.error||"Couldn't book");const a=j.appointment;$("f").hidden=true;$("done").hidden=false;
$("done").innerHTML="<b>Booked.</b><div>"+a.date+" at "+a.time+(a.mode==="tele"?" · video consultation":"")+"</div><div class=muted>Your booking code</div><div class=code>"+a.code+"</div><div class=muted>Keep this code. "+(a.mode==="tele"?"Open the Rx Clinic app at the time and join with this code and your mobile number.":"Show it at the desk when you arrive.")+"</div>";}
catch(err){$("err").textContent=err.message}finally{$("go").disabled=false}};
</script></body></html>`;
}

// ---------- web sign-in and portal ----------
// Same look as the app's sign-in screen. Works in any browser and inside the app (WebView).

const WEB_CSS = `
:root{--bg:#eef3f2;--card:#fff;--fg:#14201f;--muted:#5a6b68;--line:#cfdcd9;--teal:#0e6a64;--teal2:#0a524d;--soft:#e3efed;--red:#b3261e;--rose:#c95c5c;--band:#eef1f1}
@media(prefers-color-scheme:dark){:root{--bg:#0d1514;--card:#16211f;--fg:#e6efed;--muted:#9db0ac;--line:#2b3b38;--teal:#5fc2b8;--teal2:#7fd3c9;--soft:#1b3330;--red:#f2867f;--rose:#d27272;--band:#1b2826}}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 "Segoe UI",Roboto,system-ui,-apple-system,sans-serif}
a{color:var(--teal)}button{font:inherit;cursor:pointer}:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.logo{display:flex;align-items:center;justify-content:center;gap:10px;font:700 40px/1 Georgia,"Times New Roman",serif;color:var(--teal);letter-spacing:-.5px}
.logo .rx{color:var(--red);font-size:46px}.logo small{display:block;font:600 11px/1 system-ui;letter-spacing:.32em;color:var(--muted);text-transform:uppercase;margin-top:6px;text-align:center}
`;

function loginPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Sign in · Rx Clinic</title><style>${WEB_CSS}
.wrap{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px max(16px,env(safe-area-inset-left))}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;box-shadow:0 18px 40px -28px rgba(10,40,36,.45)}
.top{padding:36px 30px 26px;display:flex;flex-direction:column;gap:18px}
h1{font:600 30px/1.2 "Segoe UI",system-ui;text-align:center;margin:4px 0 4px}
.field{position:relative}.field input{width:100%;padding:15px 48px 15px 16px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit;font-size:17px}
.field input:focus{border-color:var(--teal);outline:0;box-shadow:0 0 0 3px var(--soft)}
.field svg{position:absolute;right:14px;top:50%;transform:translateY(-50%);width:24px;height:24px;stroke:var(--muted);fill:none;stroke-width:1.7}
.field .eye{position:absolute;right:46px;top:50%;transform:translateY(-50%);background:none;border:0;color:var(--muted);font-size:13px}
.row{display:flex;justify-content:space-between;align-items:center;font-size:15px}
.row label{display:flex;align-items:center;gap:8px;color:var(--teal);cursor:pointer}.row input{width:20px;height:20px;accent-color:var(--teal)}
.row a{display:flex;align-items:center;gap:6px;text-decoration:none}
.btns{display:flex;flex-direction:column;align-items:center;gap:0;margin-top:6px}
.btn{width:78%;display:flex;align-items:center;justify-content:center;gap:12px;border:0;color:#fff;padding:14px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:15px}
.btn.new{background:var(--rose);width:72%}.btn.go{background:var(--teal)}.btn.go:hover{background:var(--teal2)}.btn:disabled{opacity:.6}
.btn svg{width:18px;height:18px;stroke:#fff;fill:none;stroke-width:2}
.err{color:var(--red);text-align:center;min-height:1.3em;font-size:14.5px}
.lic{background:var(--band);padding:20px 30px 22px;font-size:16px;line-height:1.45}
.lic b{color:var(--teal);letter-spacing:.04em;display:flex;align-items:center;gap:8px;font-size:15px}
.lic .exp{color:var(--red)}.lic .exp strong{font-weight:700}
.foot{margin-top:18px;color:var(--muted);font-size:14px;text-align:center}
</style></head><body><div class="wrap">
<form class="card" id="f" autocomplete="on">
<div class="top">
<div><div class="logo"><span class="rx">℞</span>Rx Clinic</div><div class="logo"><small>Hospital &amp; Clinic Suite</small></div></div>
<h1>Sign in</h1>
<div class="field"><input id="u" name="username" placeholder="Username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg></div>
<div class="field"><input id="p" name="password" type="password" placeholder="Password" autocomplete="current-password" required>
<button type="button" class="eye" id="eye" aria-label="Show password">Show</button>
<svg viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3m-3 3 2.5 2.5M14.5 8.5 17 11"/></svg></div>
<div class="row"><label><input type="checkbox" id="rem" checked>Remember me</label>
<a href="/terms"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/></svg>Terms</a></div>
<div class="err" id="err" role="alert"></div><div style="text-align:right;margin:-4px 0 6px"><a href="#" id="forgot" style="font-size:14px">Forgot admin password?</a></div>
<div class="btns">
<button type="button" class="btn new" id="new">New session <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></button>
<button type="submit" class="btn go" id="go">Login <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg></button>
</div></div>
<div class="lic" id="lic"><b><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.6M8.2 13.2l7.6 4.6"/></svg>LICENSED TO :</b>
<div id="who">Loading…</div><div class="exp" id="exp"></div></div>
</form>
<div class="foot">${new Date().getFullYear()} © ShazVerse Technologies · Rx Clinic</div>
</div><script>
const $=(i)=>document.getElementById(i);
const store=()=>{try{return localStorage.getItem("rx_remember")==="0"?sessionStorage:localStorage}catch{return null}};
const NEXT=(new URLSearchParams(location.search).get("next")||"").replace(/[^a-z/]/g,"");
const dest=(role)=>NEXT||(["doctor","staff","admin","billing","pharmacy","lab","diagnostics"].includes(role)?"/hmis":"/portal");
try{const s=localStorage.getItem("rx_session")||sessionStorage.getItem("rx_session");if(s&&!location.hash.includes("new"))location.replace(dest(localStorage.getItem("rx_role")||sessionStorage.getItem("rx_role")))}catch{}
try{$("u").value=localStorage.getItem("rx_user")||""}catch{}
$("eye").onclick=()=>{const t=$("p").type==="password";$("p").type=t?"text":"password";$("eye").textContent=t?"Hide":"Show"};
fetch("/api/license").then(r=>r.json()).then(l=>{
 const d=new Date(l.expires+"T00:00:00");const ds=d.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}).toUpperCase();
 $("who").innerHTML=(l.licensedTo||"Rx Clinic").replace(/</g,"&lt;")+",<br>"+(l.address||"").replace(/</g,"&lt;")+(l.address?"<br>":"")+l.plan+" plan"+(l.trial?" (trial)":"");
 $("exp").innerHTML=(l.expired?"License expired on ":"License expires on ")+"<strong>"+ds+"</strong>";
}).catch(()=>{$("who").textContent="Server not reachable"});
$("forgot").onclick=async(e)=>{e.preventDefault();const c=prompt("Reset code (the ADMIN_RESET_CODE secret you set in Cloudflare):");if(!c)return;const p=prompt("New admin password (at least 8 characters):");if(!p)return;
 try{const r=await fetch("/api/admin/recover",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:c,password:p})});const j=await r.json();if(!r.ok)throw new Error(j.error||"Couldn\x27t reset");$("u").value=j.username;$("p").value="";$("err").textContent="Admin password changed. Sign in as "+j.username+" with the new password."}catch(err){$("err").textContent=err.message}};
$("new").onclick=()=>{try{["rx_session","rx_role"].forEach(k=>{localStorage.removeItem(k);sessionStorage.removeItem(k)})}catch{};$("p").value="";$("err").textContent="Started a new session. Sign in again.";$("u").focus()};
$("f").onsubmit=async(e)=>{e.preventDefault();$("err").textContent="";$("go").disabled=true;
 try{const r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:$("u").value.trim().toLowerCase(),password:$("p").value})});
 const j=await r.json();if(!r.ok)throw new Error(j.error||"Couldn't sign in");
 try{localStorage.setItem("rx_remember",$("rem").checked?"1":"0");if($("rem").checked)localStorage.setItem("rx_user",$("u").value.trim().toLowerCase());else localStorage.removeItem("rx_user");
 const s=store();s.setItem("rx_session",j.session);s.setItem("rx_role",j.role);s.setItem("rx_name",(j.user&&j.user.name)||"");if(j.user&&j.user.mustChange)s.setItem("rx_must","1");else s.removeItem("rx_must")}catch{}
 location.href=dest(j.role)}catch(err){$("err").textContent=err.message}finally{$("go").disabled=false}};
</script></body></html>`;
}

function portalPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Rx Clinic</title><style>${WEB_CSS}
header{background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2}
.bar{max-width:1080px;margin:0 auto;display:flex;align-items:center;gap:14px;padding:12px max(16px,env(safe-area-inset-left))}
.bar .logo{font-size:24px;justify-content:flex-start}.bar .logo .rx{font-size:28px}.sp{flex:1}
.me{text-align:right;font-size:14px;line-height:1.3}.me b{display:block}.me span{color:var(--muted)}
.out{border:1px solid var(--line);background:none;color:var(--fg);border-radius:8px;padding:8px 12px}
main{max-width:1080px;margin:0 auto;padding:22px max(16px,env(safe-area-inset-left)) 48px;display:flex;flex-direction:column;gap:18px}
h1{font:600 26px/1.2 Georgia,serif;margin:0}.muted{color:var(--muted)}
.lic{background:var(--band);border-radius:10px;padding:10px 14px;font-size:14px;display:flex;flex-wrap:wrap;gap:6px 18px}.lic .exp{color:var(--red);font-weight:600}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.stat small{display:block;color:var(--muted);font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:600}
.stat b{font:600 26px ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}.stat span{display:block;color:var(--muted);font-size:13px}
.list{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.item{display:flex;gap:12px;align-items:center;padding:12px 14px;border-bottom:1px solid var(--line)}.item:last-child{border:0}
.tok{font:600 20px ui-monospace,monospace;color:var(--teal);min-width:40px}.grow{flex:1;min-width:0}.grow b{display:block}.grow span{color:var(--muted);font-size:13.5px}
.pill{font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px;background:var(--soft);color:var(--teal);white-space:nowrap}.pill.r{background:rgba(179,38,30,.12);color:var(--red)}
.app{background:var(--soft);border-radius:12px;padding:14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.app a{background:var(--teal);color:#fff;text-decoration:none;border-radius:8px;padding:10px 14px;font-weight:600}
.empty{padding:18px;color:var(--muted)}
</style></head><body>
<header><div class="bar"><div class="logo"><span class="rx">℞</span>Rx Clinic</div><div class="sp"></div><div class="me"><b id="nm"></b><span id="rl"></span></div><button class="out" id="out">Sign out</button></div></header>
<main><div class="lic" id="lic"></div><div><h1 id="hi"></h1><div class="muted" id="sub"></div></div>
<div class="stats" id="stats"></div><div id="listWrap"></div>
<div class="app"><div>Case sheets, prescribing, billing and video calls are in the Rx Clinic app. The web portal shows today's work.</div><span style="display:flex;gap:8px"><a href="/hmis">Open HMIS</a><a href="/login#new">Switch user</a></span></div>
</main><script>
const $=(i)=>document.getElementById(i);
const get=(k)=>{try{return localStorage.getItem(k)||sessionStorage.getItem(k)}catch{return null}};
const session=get("rx_session");if(!session)location.replace("/login");
const ROLES={doctor:"Doctor",staff:"Nursing staff",pharmacy:"Pharmacy",lab:"Lab",diagnostics:"Diagnostics",billing:"Billing",admin:"Admin"};
const esc=(s)=>String(s??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const inr=(x)=>"₹"+Math.round(x||0).toLocaleString("en-IN");
async function api(p,b={}){const r=await fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session,...b})});const j=await r.json();
 if(r.status===401){signOut();throw new Error("signed out")}if(!r.ok)throw new Error(j.error||"Error");return j}
function signOut(){try{["rx_session","rx_role","rx_name","rx_must"].forEach(k=>{localStorage.removeItem(k);sessionStorage.removeItem(k)})}catch{};location.replace("/login")}
$("out").onclick=signOut;
const stat=(l,v,s="")=>'<div class="stat"><small>'+esc(l)+'</small><b>'+esc(v)+'</b><span>'+esc(s)+'</span></div>';
const list=(rows,empty)=>'<div class="list">'+(rows.length?rows.join(""):'<div class="empty">'+esc(empty)+'</div>')+'</div>';
(async()=>{
 const me=await api("/api/me");const role=me.role;const u=me.user||{};
 $("nm").textContent=u.name||"";$("rl").textContent=ROLES[role]||role;
 const h=new Date().getHours();$("hi").textContent=(h<12?"Good morning":h<17?"Good afternoon":"Good evening")+(u.name?", "+u.name:"");
 $("sub").textContent=new Date().toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
 fetch("/api/license").then(r=>r.json()).then(l=>{$("lic").innerHTML="<span><b>Licensed to:</b> "+esc(l.licensedTo)+"</span><span><b>Plan:</b> "+esc(l.plan)+(l.trial?" (trial)":"")+"</span><span class=exp>"+(l.expired?"License expired on ":"License expires on ")+esc(new Date(l.expires+"T00:00").toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}))+"</span>"});
 if(get("rx_must"))$("sub").textContent+=" · Please set your own password in the app.";
 let S="",L="";
 if(role==="admin"){const o=await api("/api/admin/overview");
  S=stat("OPD checked in",o.opd.checkedIn,o.opd.waiting+" waiting")+stat("Appointments",o.appointments.total,o.appointments.tele+" video")+stat("Lab pending",o.lab.pending,o.lab.reported+" reported")+stat("Scans pending",o.diagnostics.pending,o.diagnostics.reported+" reported")+stat("To dispense",o.pharmacy.toDispense,o.pharmacy.outOfStock+" out of stock")+(o.billing?stat("Billed today",inr(o.billing.billed),"collected "+inr(o.billing.collected))+stat("Inpatients",o.billing.inpatients,"admitted"):"");}
 else if(role==="doctor"||role==="staff"){const v=(role==="doctor"?await api("/api/doctor/visits"):await api("/api/nurse/queue")).visits||[];
  S=stat("Checked in",v.length)+stat("Waiting",v.filter(x=>x.status!=="sent"&&x.status!=="dispensed"&&x.status!=="done").length)+stat("Emergency",v.filter(x=>x.urgent).length);
  L=list(v.map(x=>'<div class="item"><div class="tok">'+esc(x.token)+'</div><div class="grow"><b>'+esc(x.patient&&x.patient.name)+'</b><span>'+esc([x.patient&&x.patient.age?x.patient.age+" y":"",x.patient&&x.patient.sex,x.complaint].filter(Boolean).join(" · "))+'</span></div>'+(x.urgent?'<span class="pill r">Emergency</span>':'<span class="pill">'+esc(x.status||"waiting")+'</span>')+'</div>'),"No patients have checked in today.");}
 else if(role==="pharmacy"){const q=(await api("/api/pharmacy/queue")).queue||[];const t=q.filter(x=>x.status==="sent");
  S=stat("To dispense",t.length)+stat("Dispensed",q.length-t.length);
  L=list(q.map(x=>'<div class="item"><div class="tok">'+esc(x.token)+'</div><div class="grow"><b>'+esc(x.patient&&x.patient.name)+'</b><span>'+esc(((x.rx&&x.rx.items)||[]).map(i=>i.generic).join(", "))+'</span></div><span class="pill'+(x.status==="sent"?" r":"")+'">'+(x.status==="sent"?"To dispense":"Dispensed")+'</span></div>'),"No prescriptions yet.");}
 else if(role==="lab"||role==="diagnostics"){const o=(await api("/api/orders/list",{kind:role==="lab"?"lab":"imaging"})).orders||[];const p=o.filter(x=>x.status!=="reported");
  S=stat("Pending",p.length)+stat("Reported",o.length-p.length);
  L=list(o.map(x=>'<div class="item"><div class="grow"><b>'+esc(x.test)+'</b><span>'+esc((x.patient&&x.patient.name)+" · token "+x.token)+'</span></div><span class="pill'+(x.status==="reported"?"":" r")+'">'+esc(x.status)+'</span></div>'),"No orders.");}
 else if(role==="billing"){const s=await api("/api/bills/summary");
  S=stat("Billed today",inr(s.totals.billed))+stat("Collected today",inr(s.totals.collected))+Object.entries(s.byMode||{}).map(([k,v])=>stat(k,inr(v))).join("");
  L=list(Object.entries(s.byDept).map(([k,v])=>'<div class="item"><div class="grow"><b>'+esc({opd:"OPD",pharmacy:"Pharmacy",lab:"Lab",diagnostics:"Diagnostics",ip:"Inpatient"}[k])+'</b><span>'+v.count+' bills</span></div><span class="pill">'+inr(v.billed)+' billed · '+inr(v.collected)+' collected</span></div>'),"");}
 $("stats").innerHTML=S;$("listWrap").innerHTML=L;
})().catch(e=>{if(e.message!=="signed out")$("sub").textContent=e.message});
</script></body></html>`;
}

function termsPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terms · Rx Clinic</title>
<style>${WEB_CSS}main{max-width:720px;margin:0 auto;padding:28px 18px 48px}h1{font:600 28px Georgia,serif}li{margin-bottom:8px}</style></head><body><main>
<div class="logo" style="justify-content:flex-start"><span class="rx">℞</span>Rx Clinic</div><h1>Terms of use</h1>
<ol>
<li>Rx Clinic is software for registered medical practitioners and their staff. Clinical decisions remain the responsibility of the treating doctor.</li>
<li>AI suggestions (history, diagnosis, investigations, treatment) are aids for a qualified doctor to check, edit or reject. They are not a diagnosis.</li>
<li>Each login is for one person. Do not share passwords. The clinic admin creates, resets and disables logins.</li>
<li>Patient information is confidential. Use it only for the patient's care, billing and records, as required by law.</li>
<li>Aadhaar numbers are never stored in full. Only a protected key for search and the last four digits are kept.</li>
<li>The licence is for the plan and period shown on the sign-in page. Renew before the expiry date to keep access.</li>
<li>Back up exported records and keep printed copies as your local rules require.</li>
</ol>
<p><a href="/login">Back to sign in</a></p></main></body></html>`;
}

// ---------- product website (opened at the server's main address in a browser) ----------
function landingPage() {
  const ic = (d, c) => `<svg viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const I = {
    cal: ic('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h2M14 14h2M8 18h2"/>', "#1b6f8a"),
    mic: ic('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', "#e0573f"),
    brain: ic('<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h1V4z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h-1V4z"/>', "#4447a3"),
    id: ic('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.5"/><path d="M5.5 16.5c.7-1.6 2-2.5 3.5-2.5s2.8.9 3.5 2.5M15 10h3M15 13h3"/>', "#d8a51c"),
    rx: ic('<path d="M6 20V4h5a4 4 0 0 1 0 8H6M10 12l8 8M18 13l-6 6"/>', "#b3261e"),
    video: ic('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>', "#1b6f8a"),
    bed: ic('<path d="M3 18V6M3 14h18v4M21 14v-3a3 3 0 0 0-3-3h-7v6"/><circle cx="7" cy="10" r="2"/>', "#2e9e8a"),
    ot: ic('<circle cx="12" cy="5" r="2"/><path d="M4 12h16M7 12l-2 8M17 12l2 8M9 12V9h6v3"/>', "#1b6f8a"),
    flask: ic('<path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M7 15h10"/>', "#e0573f"),
    scan: ic('<rect x="3" y="3" width="18" height="18" rx="9"/><circle cx="12" cy="12" r="4"/><path d="M12 3v3M12 18v3"/>', "#4447a3"),
    pill: ic('<rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)"/><path d="m9.5 9.5 5 5"/>', "#1b6f8a"),
    bill: ic('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>', "#f08c2e"),
    shield: ic('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>', "#2e9e8a"),
    home: ic('<path d="M3 11 12 4l9 7M5 10v10h14V10"/><path d="M12 13v5M9.5 15.5h5"/>', "#e0573f"),
    van: ic('<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M8.5 9.5v4M6.5 11.5h4"/>', "#1b6f8a"),
    bell: ic('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>', "#f08c2e"),
    chart: ic('<path d="M4 20V4M4 20h16"/><path d="m7 15 4-4 3 3 5-6"/>', "#2e9e8a"),
    users: ic('<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14c2.8 0 5 2.2 5 5"/>', "#1b6f8a"),
    doc: ic('<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>', "#4447a3"),
    globe: ic('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>', "#1b6f8a"),
    qr: ic('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>', "#14201f"),
  };
  const feats = [
    [I.mic, "AI voice check-in", "Patients answer by voice in Tamil, Hindi or English. The doctor gets an English case sheet."],
    [I.brain, "AI diagnosis support", "Differential and provisional diagnosis, tests to order and results analysis, each with reasons."],
    [I.rx, "Smart prescriptions", "Doses, timing and duration, diet and lifestyle advice, review date. Checks your pharmacy stock."],
    [I.cal, "Appointments", "Booking slots, clinic QR code for patients, emergency and normal queues."],
    [I.video, "Video teleconsult", "Built in, with a waiting room. No Zoom or Meet needed."],
    [I.id, "Unique Patient IDs", "Linked to mobile or Aadhaar (stored masked). Every visit, report and bill in one record."],
    [I.users, "Out-patient management", "Nurse vitals, doctor queue, case sheets, certificates and referral letters."],
    [I.bed, "In-patient management", "Admission, wards and beds, transfers, daily charges, advances and discharge bill."],
    [I.ot, "OT management", "Theatre schedule, surgeons, checklists, consent and post-op notes."],
    [I.flask, "Laboratory", "Orders from the case sheet, samples, reports back to the doctor, lab billing."],
    [I.scan, "Diagnostics", "USG, CT, MRI, PET-CT and X-ray: schedule, findings, impression, billing."],
    [I.pill, "Pharmacy", "Stock and MRP, dispensing from the prescription, counter sales, stock alerts."],
    [I.bill, "Automated billing", "OPD, pharmacy, lab and scan bills; cash, UPI, card, insurance; the patient's hospital total."],
    [I.shield, "Insurance desk", "Pre-authorisation, claims and settlements, PM-JAY and CMCHIS."],
    [I.home, "Home care", "Doctor, nurse and physio visits at home with notes, vitals and billing."],
    [I.van, "Mobile medical units", "Health camps and van trips: team roster, screening, referrals."],
    [I.bell, "Reminders and follow-ups", "Review dates due, call-back lists, WhatsApp and AI reminder calls."],
    [I.chart, "Reports and analytics", "Daily collections, monthly sales, doctor-wise revenue, goals."],
    [I.doc, "Patient portal", "Patients see their ID, prescriptions, reports and bills on their phone."],
    [I.globe, "Web and mobile", "Android app plus a web portal for any computer. One login for both."],
  ];
  const art = {
    clinic: `<svg viewBox="0 0 120 100"><rect x="30" y="20" width="60" height="70" rx="3" fill="#fff" stroke="#14201f" stroke-width="3"/><rect x="14" y="44" width="16" height="46" fill="#e9c24c" stroke="#14201f" stroke-width="3"/><rect x="90" y="44" width="16" height="46" fill="#e9c24c" stroke="#14201f" stroke-width="3"/><path d="M60 30v20M50 40h20" stroke="#e0573f" stroke-width="7"/><rect x="48" y="66" width="24" height="24" fill="#dbe9f6" stroke="#14201f" stroke-width="3"/><path d="M60 66v24" stroke="#14201f" stroke-width="3"/></svg>`,
    hospital: `<svg viewBox="0 0 120 100"><rect x="38" y="10" width="44" height="82" fill="#5cc3b8"/><rect x="44" y="16" width="32" height="24" fill="#efe9da"/><path d="M60 20v16M52 28h16" stroke="#e0573f" stroke-width="5"/><rect x="14" y="40" width="24" height="52" fill="#a8ddd4"/><rect x="82" y="40" width="24" height="52" fill="#a8ddd4"/><g fill="#f4e27a"><rect x="20" y="48" width="6" height="6"/><rect x="20" y="62" width="6" height="6"/><rect x="20" y="76" width="6" height="6"/><rect x="94" y="48" width="6" height="6"/><rect x="94" y="62" width="6" height="6"/><rect x="94" y="76" width="6" height="6"/></g><rect x="50" y="62" width="20" height="30" fill="#cdeef0" stroke="#2d4a47" stroke-width="2"/></svg>`,
    pharmacy: `<svg viewBox="0 0 120 100"><rect x="44" y="6" width="32" height="22" fill="#4f8fd8" stroke="#2d3a4a" stroke-width="2.5"/><path d="M60 10v14M53 17h14" stroke="#fff" stroke-width="4"/><path d="M18 46 28 32h64l10 14z" fill="#4f8fd8" stroke="#2d3a4a" stroke-width="2.5"/><path d="M40 32l-5 14M60 32v14M80 32l5 14" stroke="#f6e6c8" stroke-width="7"/><rect x="24" y="46" width="72" height="42" fill="#c48a5a" stroke="#2d3a4a" stroke-width="2.5"/><rect x="34" y="54" width="18" height="34" fill="#dbe9f6" stroke="#2d3a4a" stroke-width="2.5"/><rect x="58" y="56" width="30" height="16" fill="#dbe9f6" stroke="#2d3a4a" stroke-width="2.5"/><rect x="16" y="88" width="88" height="5" fill="#2d3a4a"/></svg>`,
    lab: `<svg viewBox="0 0 120 100"><path d="M46 12h18M50 12v26L30 76a8 8 0 0 0 7 12h34a8 8 0 0 0 7-12L60 38V12" fill="#fff" stroke="#2d3a4a" stroke-width="3"/><path d="M36 66h38l6 12a6 6 0 0 1-5 8H35a6 6 0 0 1-5-8z" fill="#8fd3c4"/><rect x="80" y="24" width="14" height="62" rx="7" fill="#fff" stroke="#2d3a4a" stroke-width="3"/><rect x="81.5" y="52" width="11" height="32" rx="5" fill="#e0573f"/></svg>`,
  };
  const plans = [
    ["Bronze", "Solo clinic · 1 doctor · OPD", "₹1,000", "/month"],
    ["Silver", "2–4 doctors · OPD + inpatient", "₹1,000/doctor", "+ ₹2,000/month"],
    ["Gold", "5–20 doctors · full hospital", "₹1,000/doctor", "+ ₹7,500/month"],
    ["Platinum", "21+ doctors · OT · multi-speciality", "₹1,000/doctor", "+ ₹20,000/month"],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Rx Clinic · AI hospital and clinic software</title>
<meta name="description" content="AI hospital and clinic management software for India: voice check-in in Tamil, Hindi and English, AI diagnosis support, prescriptions, teleconsult, lab, diagnostics, pharmacy, inpatient, OT, billing and insurance.">
<style>
:root{--teal:#1b7f8f;--teal-d:#14606c;--mint:#55c1a9;--ink:#14201f;--muted:#5b6b70;--bg:#ffffff;--soft:#f2f6f6;--line:#e2eaea;--rx:#c62f26;--orange:#f2784b;--sky:#22b7dc}
*{box-sizing:border-box}body{margin:0;font:17px/1.6 "Segoe UI",Roboto,system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--bg)}
a{color:inherit}img,svg{max-width:100%}.in{max-width:1100px;margin:0 auto;padding-left:max(18px,env(safe-area-inset-left));padding-right:max(18px,env(safe-area-inset-right))}
header{position:sticky;top:0;background:#fff;z-index:5;box-shadow:0 1px 0 var(--line)}
.nav{display:flex;align-items:center;gap:14px;padding-block:12px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:8px;text-decoration:none;font:700 30px/1 Georgia,"Times New Roman",serif;color:var(--teal)}.brand b{color:var(--rx);font-size:34px}
.sp{flex:1}.btn{display:inline-block;text-decoration:none;font-weight:600;letter-spacing:.03em;padding:11px 18px;border:0;cursor:pointer;font-size:16px}
.btn.trial{background:var(--mint);color:#fff}.btn.login{background:var(--sky);color:#fff}.btn.big{padding:15px 28px;font-size:18px;letter-spacing:.08em;text-transform:uppercase}
.hero{background:var(--teal);color:#fff;position:relative;overflow:hidden}
.hero:before{content:"";position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.07) 1.5px,transparent 1.5px);background-size:26px 26px}
.hero .in{position:relative;display:grid;grid-template-columns:1.1fr .9fr;gap:36px;align-items:center;padding-block:56px}
.hero h1{font:700 clamp(30px,4.6vw,48px)/1.12 Georgia,serif;margin:0 0 16px}.hero p{font-size:18px;margin:0 0 14px;opacity:.95;max-width:56ch}
.hero .cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:22px}.hero .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.chip{border:1px solid rgba(255,255,255,.45);border-radius:999px;padding:4px 12px;font-size:14px}
.phone{justify-self:center;width:270px;max-width:100%;background:#0f1d1c;border-radius:34px;padding:10px;box-shadow:0 30px 60px -30px rgba(0,0,0,.6)}
.scr{background:#f4f7f6;border-radius:26px;overflow:hidden;color:var(--ink);font-size:12.5px;padding:14px 12px;display:flex;flex-direction:column;gap:8px;min-height:470px}
.scr .t{font:700 16px Georgia,serif;display:flex;justify-content:space-between}.scr .t span{color:var(--rx)}
.q{background:#fff;border:1px solid #d6e0dd;border-radius:12px;padding:10px}.q b{display:block;font-size:13px}.q small{color:var(--muted)}
.opt{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.opt span{background:#e8efed;border-radius:8px;padding:4px 8px}.opt .on{background:#0e6a64;color:#fff}
.ai{background:#edeefa;border:1px solid #c9cbf0;border-radius:12px;padding:10px}.ai b{color:#4447a3}.mic{align-self:center;width:54px;height:54px;border-radius:50%;background:#0e6a64;display:grid;place-items:center;margin-top:auto}
.mic svg{width:26px;height:26px}
section{padding-block:60px}h2{font:600 clamp(26px,3.4vw,36px)/1.2 "Segoe UI",system-ui;text-align:center;margin:0 0 36px;color:#4b5a5f}
.prods{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:22px}
.prod{text-align:center;display:flex;flex-direction:column;align-items:center;gap:10px;padding:10px}.prod h3{margin:0;font-size:20px;color:#4b5a5f}.prod svg{width:150px;height:125px}.prod p{margin:0;color:var(--muted)}
.feat{background:var(--mint);color:#fff}.feat h2{color:#fff}
.fg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 36px}
.f{display:flex;gap:16px;align-items:center}.f .c{flex:none;width:76px;height:76px;border-radius:50%;background:#fff;display:grid;place-items:center;box-shadow:0 8px 20px -14px rgba(0,0,0,.5)}
.f .c svg{width:38px;height:38px}.f b{display:block;font-size:19px}.f span{font-size:15px;opacity:.95}
.why{background:var(--soft)}.wg{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}
.w{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px}.w b{font:700 34px Georgia,serif;color:var(--teal);display:block}.w p{margin:4px 0 0;color:var(--muted)}
.pg{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.p{border:1px solid var(--line);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:6px}.p h3{margin:0;font-size:20px}.p .pr{font:700 22px ui-monospace,Menlo,monospace;color:var(--teal)}.p small{color:var(--muted)}
.p.hl{border:2px solid var(--mint)}
.note{text-align:center;color:var(--muted);margin-top:16px;font-size:15px}
.trialsec{background:var(--teal);color:#fff;position:relative}.trialsec:before{content:"";position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.07) 1.5px,transparent 1.5px);background-size:26px 26px}
.trialsec .in{position:relative;max-width:640px}.trialsec h2{color:#fff}
form{display:grid;gap:14px}label{display:block;font-weight:600;color:#d9f0f2}label input,label select,label textarea{display:block;width:100%;margin-top:6px}label i{color:#ffb3a7;font-style:normal}
input,select,textarea{font:inherit;padding:13px 14px;border:1px solid #cfdde0;background:#f5f9fa;color:var(--ink);border-radius:2px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.hp{position:absolute;left:-9999px}
.submit{background:var(--orange);color:#fff;border:0;padding:15px 34px;font:700 18px system-ui;cursor:pointer;justify-self:start}.submit:disabled{opacity:.6}
.msg{min-height:1.4em;font-weight:600}.msg.ok{color:#c9ffe9}.msg.err{color:#ffd0c8}
.contact{background:#f2f2f2;text-align:center}.contact p{color:var(--muted);font-size:19px;margin:-18px 0 22px}
footer{background:var(--mint);color:#fff;padding-block:30px}.fgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}footer b{font-size:18px;display:block;margin-bottom:6px}footer a{display:block;text-decoration:none;opacity:.95}
:focus-visible{outline:3px solid var(--orange);outline-offset:2px}
@media(max-width:900px){.hero .in{grid-template-columns:1fr}.prods,.pg{grid-template-columns:repeat(2,minmax(0,1fr))}.wg{grid-template-columns:1fr}.fg{grid-template-columns:1fr}}
@media(max-width:520px){.prods{grid-template-columns:1fr}.pg{grid-template-columns:1fr}.two{grid-template-columns:1fr}.fgrid{grid-template-columns:1fr}.brand{font-size:26px}.btn{padding:10px 13px;font-size:15px}}
</style></head><body>
<header><div class="in nav"><a class="brand" href="/home"><b>℞</b>Rx Clinic</a><div class="sp"></div><a class="btn trial" href="#trial">Start a free trial</a><a class="btn login" href="/login">Register / Login</a></div></header>

<div class="hero"><div class="in"><div>
<h1>AI hospital and clinic software, made for India</h1>
<p><b>Rx Clinic</b> runs your OPD, IPD, OT, lab, diagnostics, pharmacy and billing in one app, with AI that helps at every step.</p>
<p>Patients check in by voice in their own language. Doctors get an English case sheet, AI diagnosis support with reasons, and a prescription that checks pharmacy stock.</p>
<div class="cta"><a class="btn trial big" href="#trial">Start a free trial</a><a class="btn login big" href="/login">Login</a></div>
<div class="chips"><span class="chip">தமிழ்</span><span class="chip">हिन्दी</span><span class="chip">English</span><span class="chip">Android + web</span><span class="chip">30-day free trial</span></div>
</div>
<div class="phone" aria-hidden="true"><div class="scr">
<div class="t">Check-in <span>℞</span></div>
<div class="q"><small>Question 3 of 9 · Tamil</small><b>வயிற்று வலி எத்தனை நாட்களாக உள்ளது?</b><small>How many days have you had stomach pain?</small><div class="opt"><span>1 நாள்</span><span class="on">1 வாரம்</span><span>1 மாதம்</span></div></div>
<div class="ai"><b>AI · Provisional diagnosis</b><br>Acid peptic disease<br><small>Why: burning epigastric pain, worse when hungry, NSAID use</small></div>
<div class="q"><b>℞ Tab Pantoprazole 40 mg</b><small>1-0-0 · before food · 14 days · <span style="color:#24734a">In pharmacy</span></small></div>
<div class="mic">${ic('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', "#fff")}</div>
</div></div></div></div>

<section><div class="in"><h2>Tailored products that fit your needs</h2><div class="prods">
<div class="prod">${art.clinic}<h3>Private practices &amp; clinics</h3><p>AI case sheets and prescriptions for the independent practice.</p></div>
<div class="prod">${art.hospital}<h3>Hospitals</h3><p>OPD, IPD, OT, wards, insurance and billing in one place.</p></div>
<div class="prod">${art.pharmacy}<h3>Pharmacies</h3><p>Stock, MRP, dispensing straight from the prescription, alerts.</p></div>
<div class="prod">${art.lab}<h3>Labs &amp; diagnostics</h3><p>Orders, reports and billing for lab tests, USG, CT, MRI and PET-CT.</p></div>
</div></div></section>

<section class="feat"><div class="in"><h2>Key features</h2><div class="fg">
${feats.map(([i, t, d]) => `<div class="f"><div class="c">${i}</div><div><b>${t}</b><span>${d}</span></div></div>`).join("")}
</div></div></section>

<section class="why"><div class="in"><h2>Why Rx Clinic</h2><div class="wg">
<div class="w"><b>3 languages</b><p>Voice check-in in Tamil, Hindi and English. The case sheet comes out in English for the doctor.</p></div>
<div class="w"><b>AI with reasons</b><p>Every suggestion explains why. The doctor accepts, edits or rejects; nothing goes on the prescription by itself.</p></div>
<div class="w"><b>One Patient ID</b><p>OPD, inpatient, lab, scans, pharmacy and bills under one ID, linked to mobile or Aadhaar.</p></div>
</div></div></section>

<section><div class="in"><h2>Simple pricing</h2><div class="pg">
${plans.map(([n, d, p, f], i) => `<div class="p${i === 2 ? " hl" : ""}"><h3>${n}</h3><small>${d}</small><div class="pr">${p}</div><small>${f}</small></div>`).join("")}
</div><p class="note">Prices per month, plus GST. Pay yearly and get 2 months free. Every plan starts with a 30-day free trial.</p></div></section>

<section class="trialsec" id="trial"><div class="in"><h2>Start a free trial</h2>
<form id="tf" novalidate>
<label>Name <i>*</i><input name="name" required maxlength="80" autocomplete="name"></label>
<div class="two"><label>Email <i>*</i><input name="email" type="email" required maxlength="120" autocomplete="email"></label>
<label>Phone number <i>*</i><input name="phone" required inputmode="tel" maxlength="14" autocomplete="tel"></label></div>
<label>Hospital or clinic name <i>*</i><input name="hospital" required maxlength="120" autocomplete="organization"></label>
<div class="two"><label>City <i>*</i><input name="city" required maxlength="60" autocomplete="address-level2"></label>
<label>Number of doctors<select name="plan"><option value="bronze">1 (Bronze)</option><option value="silver">2–4 (Silver)</option><option value="gold" selected>5–20 (Gold)</option><option value="platinum">21+ (Platinum)</option></select></label></div>
<label>Anything we should know? (optional)<textarea name="message" rows="3" maxlength="500"></textarea></label>
<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<div class="msg" id="tm" role="status"></div>
<button class="submit" id="ts" type="submit">Submit</button>
</form></div></section>

<section class="contact"><div class="in"><h2>Contact us</h2><p>Get in touch with us for a demo or more information.</p><a class="btn big" style="background:var(--sky);color:#fff" href="#trial">Start a free trial</a></div></section>

<footer><div class="in fgrid">
<div><b>Rx Clinic</b><a href="#trial">Free trial</a><a href="/login">Login</a><a href="/book">Book an appointment</a></div>
<div><b>Product</b><a href="/terms">Terms of use</a><span>Android app and web portal</span></div>
<div><b>ShazVerse Technologies</b><span>Made in India · ${new Date().getFullYear()}</span></div>
</div></footer>
<script>
const f=document.getElementById("tf"),m=document.getElementById("tm"),b=document.getElementById("ts");
f.onsubmit=async(e)=>{e.preventDefault();m.className="msg";m.textContent="";b.disabled=true;
 const d=Object.fromEntries(new FormData(f).entries());
 try{const r=await fetch("/api/trial",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(d)});const j=await r.json();
 if(!r.ok)throw new Error(j.error||"Couldn't send. Please try again.");f.reset();m.className="msg ok";m.textContent="Thank you. We'll call you within one working day to set up your free trial."}
 catch(err){m.className="msg err";m.textContent=err.message}finally{b.disabled=false}};
</script></body></html>`;
}

// ---------- HMIS web: doctor's dashboard and patient chart (/hmis) ----------
function hmisPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Rx Clinic HMIS</title><style>
:root{--top:#0f5f6b;--top2:#0b4c56;--bg:#f3f6f7;--card:#fff;--fg:#17242a;--muted:#5d6d74;--line:#dbe4e7;--head:#1d6f86;--accent:#0e8a7d;--soft:#e6f2f1;--red:#c0392b;--amber:#b7791f;--green:#23855a;--banner:#f6c343;
--t1:#ece9fb;--t1i:#5b4fcf;--t2:#fbe8f1;--t2i:#c2457f;--t3:#e2f4ec;--t3i:#23855a;--t4:#e0f3f8;--t4i:#1d7f9b;--t5:#fde7e5;--t5i:#c0392b}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 "Segoe UI",Roboto,system-ui,sans-serif}
button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.top{background:var(--top);color:#fff;display:flex;align-items:center;gap:12px;padding:8px max(14px,env(safe-area-inset-left));position:sticky;top:0;z-index:20}
.logo{font:700 21px Georgia,serif;display:flex;gap:6px;align-items:center;white-space:nowrap;cursor:pointer}.logo b{color:#ffb4ab}.logo small{font:600 10px system-ui;letter-spacing:.2em;opacity:.8;margin-left:4px}
.top .sp{flex:1}.top input{border:0;border-radius:6px;padding:7px 10px;width:min(320px,38vw);color:#17242a}.top .u{font-size:13px;text-align:right;line-height:1.2}.top .u span{opacity:.8}
.top button{background:var(--top2);border:1px solid rgba(255,255,255,.25);color:#fff;border-radius:6px;padding:6px 10px}
main{padding:12px max(14px,env(safe-area-inset-left)) 40px}
.bar2{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}.bar2 h1{font-size:15px;margin:0;font-weight:700;text-transform:uppercase;letter-spacing:.03em}.bar2 .sp{flex:1}
.chip{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:4px 12px;font-size:13px}.chip.on{background:var(--head);color:#fff;border-color:var(--head)}
.tiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:12px}
.tile{border-radius:8px;padding:10px 12px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;align-items:center;cursor:pointer;border:1px solid transparent}.tile:hover{border-color:var(--line)}
.tile svg{width:26px;height:26px;grid-row:span 2}.tile b{font-size:20px;line-height:1}.tile .n{font-size:13px;font-weight:600}.tile .s{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px 10px;font-size:12px;color:var(--muted);margin-top:4px}
.tile .s i{font-style:normal;background:rgba(255,255,255,.75);border-radius:4px;padding:0 5px;font-weight:600;color:var(--fg)}
.tbl-wrap{background:var(--card);border:1px solid var(--line);border-radius:6px;overflow:auto}
table{border-collapse:collapse;width:100%;min-width:900px}th{background:var(--head);color:#fff;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.03em;padding:8px 10px;white-space:nowrap;font-weight:600}
td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}tr.r:hover td{background:#f5fafa;cursor:pointer}
.pn b{display:block}.pn small{color:var(--muted)}.pill{display:inline-block;font-size:11.5px;font-weight:600;border-radius:999px;padding:2px 8px;background:var(--soft);color:var(--accent);white-space:nowrap}
.pill.red{background:#fde7e5;color:var(--red)}.pill.amb{background:#fdf1dc;color:var(--amber)}.pill.grn{background:#e2f4ec;color:var(--green)}.pill.gry{background:#eef1f2;color:var(--muted)}
.prog{width:80px;height:6px;background:#e4ecee;border-radius:3px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:6px}.prog i{display:block;height:100%;background:var(--accent)}
.btn{border:1px solid var(--line);background:var(--card);border-radius:6px;padding:6px 12px}.btn.p{background:var(--accent);color:#fff;border-color:var(--accent)}.btn.d{color:var(--red)}.btn:disabled{opacity:.55}
.empty{padding:24px;text-align:center;color:var(--muted)}
/* chart */
.chart{display:grid;grid-template-columns:230px minmax(0,1fr);gap:12px;align-items:start}.chart>section,.side{min-width:0}.rx td:nth-child(2){min-width:170px}.rx td:nth-child(8){min-width:150px}
.side{background:var(--card);border:1px solid var(--line);border-radius:6px;overflow:hidden;position:sticky;top:100px}
.nav{background:#fff;border-bottom:1px solid var(--line);display:flex;gap:2px;align-items:center;padding:4px max(14px,env(safe-area-inset-left));overflow-x:auto;position:sticky;top:50px;z-index:19}
.nav a{padding:7px 12px;border-radius:6px;text-decoration:none;color:var(--muted);font-weight:600;white-space:nowrap;font-size:13.5px}.nav a.on{background:var(--soft);color:var(--head)}.nav .sp{flex:1}
#bell{border:0;background:none;font-size:18px;position:relative;padding:4px 8px}#bn{position:absolute;top:0;right:0;background:var(--red);color:#fff;border-radius:999px;font-size:10px;padding:1px 5px;display:none;font-style:normal}
.side .ban{background:var(--banner);font-weight:700;padding:6px 10px;text-transform:uppercase;font-size:13px}
.side .id{display:flex;gap:10px;padding:10px;align-items:center;border-bottom:1px solid var(--line)}.av{width:52px;height:52px;border-radius:8px;background:#dfe7ea;display:grid;place-items:center;font:700 20px Georgia,serif;color:var(--head);flex:none}
.side dl{margin:0;padding:8px 10px;display:grid;gap:6px;border-bottom:1px solid var(--line)}.side dt{font-size:11px;color:var(--muted)}.side dd{margin:0;font-weight:600;font-size:12.5px}
.side h4{margin:0;padding:7px 10px;font-size:12px;display:flex;justify-content:space-between;align-items:center;background:#f6f9fa;border-bottom:1px solid var(--line);text-transform:uppercase;letter-spacing:.04em}
.side h4 button{border:0;background:none;color:var(--accent);font-size:18px;line-height:1;padding:0 2px}
.vit{padding:6px 10px;display:grid;grid-template-columns:1fr auto;gap:3px 8px;font-size:12.5px;border-bottom:1px solid var(--line)}.vit span{color:var(--muted)}.vit b.hi{color:var(--red)}
.side p{margin:0;padding:6px 10px 10px;font-size:12.5px;border-bottom:1px solid var(--line);white-space:pre-wrap}
.tabs{display:flex;gap:2px;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px;overflow-x:auto;margin-bottom:10px}
.tabs button{border:0;background:none;padding:7px 12px;border-radius:5px;white-space:nowrap;color:var(--muted);font-weight:600;font-size:13px;display:flex;gap:6px;align-items:center}.tabs button.on{background:var(--head);color:#fff}
.tabs svg{width:15px;height:15px}
.sub{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:10px;overflow-x:auto}.sub button{border:0;background:none;padding:8px 14px;color:var(--muted);font-weight:600;border-bottom:2px solid transparent;white-space:nowrap}.sub button.on{color:var(--head);border-color:var(--head)}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:6px;overflow:hidden;min-width:0}.panel>h3{margin:0;background:var(--head);color:#fff;font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding:7px 10px;display:flex;justify-content:space-between;align-items:center}
.panel>h3 small{text-transform:none;letter-spacing:0;opacity:.85;font-weight:400}.panel table{min-width:0}.panel th{background:#f1f6f7;color:var(--muted);font-size:11px}.panel td{font-size:12.5px}.pb{padding:12px;display:grid;gap:10px}
label.f{display:grid;gap:4px;font-size:12px;color:var(--muted);font-weight:600}label.f input,label.f select,label.f textarea{border:1px solid var(--line);border-radius:5px;padding:7px 9px;background:#fff;color:var(--fg);font-weight:400;font-size:13.5px;width:100%}
.fr{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.cks{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px}.cks label{display:flex;gap:5px;align-items:center}.cks b{width:100%;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-top:4px}
.acts{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.note{border:1px solid var(--line);border-radius:6px;padding:10px;font-size:13px}.note h5{margin:0 0 4px;font-size:13px}.note .m{color:var(--muted);font-size:12px}.note dl{margin:6px 0 0;display:grid;grid-template-columns:160px 1fr;gap:3px 10px}.note dt{color:var(--muted)}.note dd{margin:0;white-space:pre-wrap}
.slots{display:flex;flex-wrap:wrap;gap:6px}.slots button{border:1px solid var(--line);background:#fff;border-radius:5px;padding:5px 9px;font-size:12.5px}.slots button.on{background:var(--head);color:#fff;border-color:var(--head)}.slots button:disabled{opacity:.35}
.days{display:flex;gap:6px;overflow-x:auto}.days button{border:1px solid var(--line);background:#fff;border-radius:6px;padding:6px 10px;text-align:center;min-width:64px;font-size:12px}.days button.on{border-color:var(--head);background:var(--soft)}.days b{display:block;font-size:15px}
.cat{max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:6px}.cat label{display:flex;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line);font-size:13px;align-items:center}.cat label span{margin-left:auto;color:var(--muted);font-size:12px}
.rx td input,.rx td select{width:100%;border:1px solid var(--line);border-radius:4px;padding:5px 6px;font-size:12.5px}
.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#17242a;color:#fff;padding:10px 16px;border-radius:8px;z-index:50;font-size:14px;max-width:90vw}
.modal{position:fixed;inset:0;background:rgba(10,25,30,.45);display:grid;place-items:center;z-index:40;padding:16px}.modal>div{background:#fff;border-radius:10px;max-width:760px;width:100%;max-height:88vh;overflow:auto;padding:18px}
.rep h2{margin:0 0 4px;font:700 18px Georgia,serif;color:var(--head)}.rep table{min-width:0}
@media(max-width:1000px){.tiles{grid-template-columns:repeat(3,minmax(0,1fr))}.grid2{grid-template-columns:1fr}}
@media(max-width:760px){.chart{grid-template-columns:1fr}.side{position:static}.side dl{grid-template-columns:1fr 1fr}.vit{grid-template-columns:auto 1fr auto 1fr}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.top input{display:none}.logo small{display:none}}
@media print{.top,.tabs,.side,.acts,.btn,.sub{display:none!important}.chart{display:block}body{background:#fff}}
</style></head><body>
<div class="top"><div class="logo" id="home"><b>℞</b>Rx Clinic<small>HMIS</small></div><input id="q" placeholder="Search patient: name, Patient ID, mobile"><div class="sp"></div>
<div class="u"><b id="me"></b><br><span id="role"></span></div><button id="out">Sign out</button></div>
<main id="app"><div class="empty">Loading…</div></main>
<script>
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
// The Rx Clinic app opens /hmis#s=<session> so the signed-in user doesn't sign in again.
(()=>{const m=location.hash.match(/^#s=([^&]+)(?:&r=(\\w+))?(?:&go=([\\w-]+))?/);if(m){try{sessionStorage.setItem("rx_session",decodeURIComponent(m[1]));if(m[2])sessionStorage.setItem("rx_role",m[2])}catch{}history.replaceState(null,"","/hmis"+(m[3]?"#"+m[3]:""))}})();
const store=(()=>{try{return sessionStorage.getItem("rx_session")?sessionStorage:localStorage.getItem("rx_session")?localStorage:sessionStorage}catch{return null}})();
const session=store&&store.getItem("rx_session");if(!session)location.replace("/login?next=/hmis");
const esc=(s)=>String(s??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const tm=(ms)=>ms?new Date(ms).toLocaleString("en-IN",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}):"";
const dt=(d)=>d?new Date(d+"T00:00").toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}):"";
const today=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)};
function toast(m){const t=document.createElement("div");t.className="toast";t.textContent=m;document.body.appendChild(t);setTimeout(()=>t.remove(),3200)}
async function api(p,b={}){const r=await fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session,...b})});const j=await r.json().catch(()=>({}));
 if(r.status===401){try{store.removeItem("rx_session")}catch{};location.replace("/login?next=/hmis");throw new Error("Signed out")}if(!r.ok)throw new Error(j.error||"Something went wrong");return j}
$("#out").onclick=()=>{try{["rx_session","rx_role","rx_name"].forEach(k=>{localStorage.removeItem(k);sessionStorage.removeItem(k)})}catch{};location.replace("/login")};
$("#home").onclick=()=>{location.hash="";route()};
const ROLE={doctor:"Doctor",staff:"Nursing",billing:"Billing",admin:"Admin"};
const IC={cal:'<path d="M3 5h18v16H3zM3 10h18M8 3v4M16 3v4"/>',op:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M18 8v6M15 11h6"/>',ip:'<path d="M3 18V6M3 14h18v4M21 14v-3a3 3 0 0 0-3-3h-7v6"/><circle cx="7" cy="10" r="2"/>',inv:'<path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/>',sx:'<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 20M8.1 15.9 20 4"/>',
 asmt:'<path d="M9 3h6v3H9zM6 5h3M15 5h3v16H6V5"/><path d="M9 12h6M9 16h4"/>',home:'<path d="m3 11 9-7 9 7M5 10v10h14V10"/>',hist:'<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3"/>',mon:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',res:'<path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-8"/>',ord:'<path d="M6 6h15l-2 9H8L6 3H3"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>',med:'<rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)"/>',req:'<path d="M4 12h12M12 6l6 6-6 6M20 4v16"/>'};
const ic=(k,c="currentColor")=>'<svg viewBox="0 0 24 24" fill="none" stroke="'+c+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+IC[k]+'</svg>';
let ME={},DASH=null,FILTER="all";

async function route(){const h=location.hash;let m;if((m=h.match(/^#v-(.+)$/)))return chart(m[1]);if((m=h.match(/^#ip-(.+)$/)))return ipChart(m[1]);if((m=h.match(/^#ot-(.+)$/)))return otRecord(m[1]);if(h==="#ot")return otList();return dashboard()}
window.onhashchange=()=>route();

// ---------- dashboard ----------
async function dashboard(date){
 const app=$("#app");
 try{DASH=await api("/api/hmis/dashboard",{date})}catch(e){app.innerHTML='<div class="empty">'+esc(e.message)+'</div>';return}
 ME=DASH.me;$("#me").textContent=ME.name||"";$("#role").textContent=ROLE[ME.role]||ME.role;
 const t=DASH.tiles;
 const tile=(cls,i,n,label,sub,f)=>'<div class="tile" data-f="'+f+'" style="background:var(--'+cls+')">'+ic(i,"var(--"+cls+"i)")+'<b>'+n+'</b><span class="n">'+label+'</span><div class="s">'+sub.map(([k,v])=>k+' <i>'+v+'</i>').join("")+'</div></div>';
 app.innerHTML='<div class="bar2"><h1>'+esc(ME.name||"")+'</h1><div class="sp"></div><a class="chip" href="#ot" style="text-decoration:none;color:inherit">Theatre list</a><input type="date" id="dd" class="chip" value="'+DASH.date+'"><button class="chip" id="rf">Refresh</button></div>'+
 '<div class="tiles">'+tile("t1","cal",t.appointment.total,"Appointment",[["Phone",t.appointment.phone],["Online",t.appointment.online],["Video",t.appointment.video]],"appt")+
 tile("t2","op",t.outpatient.total,"Outpatient",[["New",t.outpatient.new],["Review",t.outpatient.review],["Emergency",t.outpatient.emergency]],"OP")+
 tile("t3","ip",t.inpatient.total,"Inpatients",[["Today",t.inpatient.today],["Existing",t.inpatient.existing]],"IP")+
 tile("t4","inv",t.investigation.total,"Investigation",[["In progress",t.investigation.inProgress],["Completed",t.investigation.completed]],"inv")+
 tile("t5","sx",t.surgery.total,"Surgery",[["Scheduled",t.surgery.scheduled],["Completed",t.surgery.completed]],"sx")+'</div>'+
 '<div class="bar2"><div id="fl"></div><div class="sp"></div><input id="ps" class="chip" placeholder="My patient search" style="min-width:200px"></div><div class="tbl-wrap" id="tw"></div>';
 $$(".tile").forEach(x=>x.onclick=()=>{const f=x.dataset.f;if(f==="sx"){location.hash="ot";return}FILTER=f==="OP"||f==="IP"?f:f==="inv"?"inv":"all";drawRows()});
 $("#dd").onchange=(e)=>dashboard(e.target.value);$("#rf").onclick=()=>dashboard($("#dd").value);$("#ps").oninput=drawRows;drawRows();
}
function drawRows(){
 const q=($("#ps")?.value||"").toLowerCase();
 $("#fl").innerHTML=[["all","All"],["OP","Outpatient"],["IP","Inpatient"],["urgent","Emergency"],["inv","Investigation"]].map(([k,l])=>'<button class="chip'+(FILTER===k?" on":"")+'" data-k="'+k+'">'+l+'</button>').join(" ");
 $$("#fl button").forEach(b=>b.onclick=()=>{FILTER=b.dataset.k;drawRows()});
 const rows=DASH.rows.filter(r=>(FILTER==="all"||(FILTER==="urgent"?r.urgent:FILTER==="inv"?r.orders.total>0:r.kind===FILTER))&&(!q||(r.patient?.name+" "+r.regNo+" "+(r.patient?.phone||"")).toLowerCase().includes(q)));
 const st=(r)=>r.urgent?'<span class="pill red">Emergency</span>':r.status==="admitted"?'<span class="pill">Admitted</span>':r.status==="sent"?'<span class="pill grn">Seen · Rx sent</span>':r.status==="dispensed"?'<span class="pill grn">Seen · dispensed</span>':r.status==="seen"||r.status==="done"?'<span class="pill grn">Seen</span>':'<span class="pill amb">Not seen</span>';
 $("#tw").innerHTML='<table><thead><tr><th>Reg no</th><th>Token / IP no</th><th>Encounter</th><th>Patient name</th><th>Complaint</th><th>Status</th><th>Ward</th><th>Order status</th><th>Action</th></tr></thead><tbody>'+
 (rows.length?rows.map(r=>'<tr class="r" data-v="'+esc(r.id)+'" data-a="'+esc(r.admissionId||"")+'"><td>'+esc(r.regNo||"—")+' · '+r.kind+'</td><td>'+esc(r.token)+'</td><td>'+tm(r.at)+'</td><td class="pn"><b>'+esc(r.patient?.name)+'</b><small>'+esc([r.patient?.age?r.patient.age+"Y":"",r.patient?.sex].filter(Boolean).join(" / "))+(r.review?" · Review":r.kind==="OP"?" · New":"")+'</small></td><td>'+esc(r.complaint||"")+'</td><td>'+st(r)+'</td><td>'+esc(r.ward||"")+(r.day?' · day '+r.day:"")+'</td><td>'+(r.orders.total?'<span class="prog"><i style="width:'+Math.round(r.orders.done/r.orders.total*100)+'%"></i></span>'+r.orders.done+'/'+r.orders.total:"")+'</td><td><button class="btn">Open</button></td></tr>').join(""):'<tr><td colspan="9" class="empty">No patients'+(DASH.today?" yet today":"")+'.</td></tr>')+'</tbody></table><div style="padding:8px 10px;color:var(--muted);font-size:12px">Showing '+rows.length+' of '+DASH.rows.length+' records</div>';
 $$("#tw tr.r").forEach(tr=>tr.onclick=()=>{location.hash=tr.dataset.v?"v-"+tr.dataset.v:"ip-"+tr.dataset.a});
}
$("#q").onkeydown=async(e)=>{if(e.key!=="Enter")return;const q=e.target.value.trim();if(q.length<2)return;
 try{const r=await api("/api/patients/search",{q});if(!r.patients.length)return toast("No patient found");
 const p=r.patients[0];const g=await api("/api/patients/get",{id:p.id});const last=g.visits[0];if(last)location.hash="v-"+last.id;else toast(p.name+" ("+p.id+") has no visits yet")}catch(err){toast(err.message)}};

// ---------- patient chart ----------
let C=null,TAB="home",SUB="consult";
async function chart(id,keepTab){
 try{C=await api("/api/hmis/chart",{visitId:id})}catch(e){$("#app").innerHTML='<div class="empty">'+esc(e.message)+' <button class="btn" onclick="location.hash=\\'\\'">Back</button></div>';return}
 if(!ME.name){try{const m=await api("/api/me");ME={name:m.user?.name,role:m.role};$("#me").textContent=ME.name||"";$("#role").textContent=ROLE[ME.role]||ME.role}catch{}}
 if(!keepTab)TAB="home";drawChart();
}
function latestVitals(){const v=C.visit;const log=v.vitalsLog||[];return log.length?log[log.length-1].vitals:(v.triage?.vitals||{})}
function hi(k,x){const n=parseFloat(x);if(isNaN(n))return false;return (k==="temp"&&n>=99.5)||(k==="pulse"&&(n>100||n<55))||(k==="spo2"&&n<94)||(k==="rr"&&(n>22||n<10))||(k==="rbs"&&n>200)}
function drawChart(){
 const v=C.visit,p=C.patient||v.patient||{},vit=latestVitals();
 const side='<aside class="side"><div class="ban">'+esc(p.name)+'</div><div class="id"><div class="av">'+esc((p.name||"?").trim()[0]||"?")+'</div><div><b>'+esc(p.id||v.patient?.id||"")+'</b><br><small>'+esc([p.age?p.age+"Y":"",p.sex].filter(Boolean).join(" / "))+'</small><br><span class="pill">'+(C.admission?"IP":"OP")+'</span></div></div>'+
 '<dl><dt>Registration</dt><dd>'+tm(p.created)+'</dd><dt>Encounter</dt><dd>'+tm(v.createdAt)+' · Token '+esc(v.token)+'</dd><dt>Primary consultant</dt><dd>'+esc(v.doctor?.name||ME.name||"")+'</dd><dt>Patient type</dt><dd>'+(C.admission?"Inpatient · "+esc(C.admission.no+" "+C.admission.ward+" "+C.admission.bed):"Outpatient")+'</dd><dt>Visit type</dt><dd>'+(C.history.length>1?"Review":"New")+'</dd><dt>Mobile</dt><dd>'+esc(p.phone||v.patient?.phone||"")+'</dd></dl>'+
 '<h4>Vitals <button data-go="monitor" title="Add vitals">+</button></h4><div class="vit">'+[["temp","Body temp","°F"],["pulse","Pulse","/min"],["bp","Blood pressure",""],["rr","Resp. rate","/min"],["spo2","SpO₂","%"],["height","Height","cm"],["weight","Weight","kg"],["bmi","BMI",""]].map(([k,l,u])=>'<span>'+l+'</span><b class="'+(hi(k,vit[k])?"hi":"")+'">'+(vit[k]?esc(vit[k])+(u?" "+u:""):"–")+'</b>').join("")+'</div>'+
 '<h4>Allergy <button data-flag="allergy" title="Edit allergy">+</button></h4><p style="color:'+(C.flags.allergy?"var(--red)":"inherit")+'">'+esc(C.flags.allergy||"–")+'</p>'+
 '<h4>Remarks <button data-flag="remarks" title="Edit remarks">+</button></h4><p>'+esc(C.flags.remarks||"–")+'</p><div style="padding:8px 10px"><button class="btn" onclick="location.hash=\\'\\'">‹ All patients</button></div></aside>';
 const tabs=[["asmt","Assessment"],["home","Home"],["hist","Visit History"],["monitor","Monitoring","mon"],["res","Results"],["ord","Orders"],["med","Medicines"],["req","Requests"]];
 $("#app").innerHTML='<div class="chart">'+side+'<section><div class="tabs">'+tabs.map(([k,l,i])=>'<button data-t="'+k+'" class="'+(TAB===k?"on":"")+'">'+ic(i||k)+l+'</button>').join("")+'</div><div id="pane"></div></section></div>';
 $$(".tabs button").forEach(b=>b.onclick=()=>{TAB=b.dataset.t;drawChart()});
 $$("[data-go]").forEach(b=>b.onclick=()=>{TAB=b.dataset.go;drawChart()});
 $$("[data-flag]").forEach(b=>b.onclick=async()=>{const k=b.dataset.flag;const pid=p.id||v.patient?.id;if(!pid)return toast("This patient has no Patient ID yet");
  const x=prompt2(k==="allergy"?"Allergies (drugs, food)":"Remarks",C.flags[k],async(val)=>{await api("/api/hmis/flags",{patientId:pid,[k]:val});C.flags[k]=val;drawChart();toast("Saved")})});
 ({asmt:paneAssessment,home:paneHome,hist:paneHistory,monitor:paneMonitor,res:paneResults,ord:paneOrders,med:paneMeds,req:paneRequests}[TAB])();
}
function prompt2(title,val,onOk){const m=document.createElement("div");m.className="modal";m.innerHTML='<div><h3 style="margin-top:0">'+esc(title)+'</h3><textarea id="pv" rows="4" style="width:100%;border:1px solid var(--line);border-radius:6px;padding:8px">'+esc(val||"")+'</textarea><div class="acts" style="margin-top:10px"><button class="btn" id="pc">Cancel</button><button class="btn p" id="po">Save</button></div></div>';
 document.body.appendChild(m);$("#pc",m).onclick=()=>m.remove();$("#po",m).onclick=async()=>{try{await onOk($("#pv",m).value);m.remove()}catch(e){toast(e.message)}}}
const panel=(title,head,rows,empty="No data available",extra="")=>'<div class="panel"><h3>'+title+extra+'</h3><table><thead><tr>'+head.map(h=>'<th>'+h+'</th>').join("")+'</tr></thead><tbody>'+(rows.length?rows.join(""):'<tr><td colspan="'+head.length+'" class="empty">'+empty+'</td></tr>')+'</tbody></table></div>';

function paneHome(){
 const H=C.history,v=C.visit;
 const notes=[];H.forEach(h=>{});(v.notes||[]).forEach(n=>notes.push('<tr><td>'+tm(n.at).slice(0,10)+'</td><td>'+esc(n.template)+'</td><td>'+esc(n.by)+'</td></tr>'));
 const icd=(v.icd||[]).map(i=>'<tr><td>'+tm(i.at).slice(0,10)+'</td><td>'+esc(i.text)+'</td><td>'+esc(i.by)+'</td></tr>');
 const labs=[];H.forEach(h=>(h.reports||[]).forEach(r=>labs.push('<tr><td>'+dt(r.date)+'</td><td>'+esc(r.test)+'</td><td>'+(r.status==="reported"?'<span class="pill grn">Reported</span>':'<span class="pill amb">'+esc(r.status)+'</span>')+'</td></tr>')));
 const rx=[];H.forEach(h=>((h.rx&&h.rx.items)||[]).forEach(i=>rx.push('<tr><td>'+dt(h.date)+'</td><td>'+esc([i.form,i.generic,i.strength].filter(Boolean).join(" "))+'</td><td>'+esc(i.frequency)+'</td><td>'+esc(i.duration)+'</td></tr>')));
 const dx=H.filter(h=>h.diagnosis).map(h=>'<tr><td>'+dt(h.date)+'</td><td>'+esc(h.diagnosis)+'</td><td>'+esc(h.doctor)+'</td></tr>');
 const svc=C.letters.map(l=>'<tr><td>'+dt(l.date)+'</td><td>'+esc(l.title)+' '+esc(l.no)+'</td><td>'+esc(l.doctor?.name)+'</td></tr>');
 $("#pane").innerHTML='<div class="grid2">'+panel("Visit history",["Date","Visit type","Doctor","Diagnosis"],H.slice(0,8).map(h=>'<tr><td>'+dt(h.date)+'</td><td>OP</td><td>'+esc(h.doctor)+'</td><td>'+esc(h.diagnosis||h.complaint)+'</td></tr>'))+
 panel("Diagnosis",["Date","Diagnosis","Doctor"],dx)+panel("Lab & scan history",["Date","Test","Status"],labs)+panel("ICD history",["Date","ICD / diagnosis","Doctor"],icd)+
 panel("Notes history",["Date","Notes","Doctor"],notes)+panel("Prescription history",["Date","Medicine","Frequency","Days"],rx.slice(0,15))+panel("Certificates & letters",["Date","Document","Doctor"],svc)+'</div>';
}

// ---------- assessment templates ----------
const TPL={
 "OPD assessment":{f:[["cc","Chief complaints",3],["hpi","History of present illness",4],["past","Past history (medical, surgical)",2],["drug","Drug history",2],["family","Family history",1],["social","Social history",1]],
  ck:[["Individual history",["Smoker","Alcohol","Tobacco chewing","Vegetarian","Mixed diet","Sleep normal","Bowel normal","Bladder normal"]],["General examination",["Conscious","Oriented","Pallor","Icterus","Cyanosis","Clubbing","Lymphadenopathy","Pedal oedema"]],["Systems",["CVS: S1 S2 heard","RS: B/L air entry equal","P/A: soft, non-tender","CNS: no focal deficit"]]],
  f2:[["local","Local examination",3],["impression","Clinical impression",2],["plan","Plan",3]]},
 "Doctor's progress note":{f:[["subj","Subjective",2],["obj","Objective / examination",3],["assess","Assessment",2],["plan","Plan",3]],ck:[],f2:[]},
 "Pre-anaesthetic check":{f:[["airway","Airway (Mallampati, mouth opening, neck)",2],["cvsrs","Cardio-respiratory",2],["inv","Investigations reviewed",2]],ck:[["Risk",["ASA I","ASA II","ASA III","ASA IV","Difficult airway","NBM confirmed","Consent taken"]]],f2:[["plan","Anaesthesia plan",2]]},
 "Post-operative note":{f:[["proc","Procedure done",2],["find","Findings",3],["anaes","Anaesthesia",1],["ebl","Blood loss / drains / specimens",2]],ck:[["Status",["Stable","Shifted to ward","Shifted to ICU","Specimen sent for HPE"]]],f2:[["orders","Post-op orders",4]]},
 "Discharge summary":{f:[["dx","Final diagnosis",2],["course","Course in hospital",4],["proc","Procedures done",2],["cond","Condition at discharge",1],["meds","Medicines on discharge",4],["advice","Advice and review",3]],ck:[],f2:[]},
};
let TP="OPD assessment";
function paneAssessment(){
 const v=C.visit,cs=v.caseSheet||{},t=TPL[TP];
 const pre={cc:(cs.chiefComplaints||[]).map(c=>c.complaint+(c.duration?" – "+c.duration:"")).join("; "),hpi:cs.hpi||"",past:[cs.past?.medical,cs.past?.surgical].filter(Boolean).join("; "),drug:cs.past?.drugs||"",family:cs.family||"",social:[cs.habits?.smoking,cs.habits?.alcohol].filter(Boolean).join("; "),dx:v.rx?.dx||"",meds:((v.rx&&v.rx.items)||[]).map(i=>[i.form,i.generic,i.strength,i.dose,i.frequency,i.timing,i.duration].filter(Boolean).join(" ")).join("\\n")};
 const fld=([k,l,r])=>'<label class="f">'+l+'<textarea name="'+k+'" rows="'+r+'">'+esc(pre[k]||"")+'</textarea></label>';
 $("#pane").innerHTML='<div class="panel"><h3>Assessment <small>Choose a template; the check-in answers are filled in.</small></h3><div class="pb"><div class="fr"><label class="f">Template<select id="tp">'+Object.keys(TPL).map(k=>'<option'+(k===TP?" selected":"")+'>'+k+'</option>').join("")+'</select></label><label class="f">Diagnosis / ICD-10 (optional)<input id="icd" placeholder="e.g. K30 Functional dyspepsia"></label></div>'+
 t.f.map(fld).join("")+t.ck.map(([g,items])=>'<div class="cks"><b>'+g+'</b>'+items.map(x=>'<label><input type="checkbox" data-g="'+esc(g)+'" value="'+esc(x)+'">'+esc(x)+'</label>').join("")+'</div>').join("")+t.f2.map(fld).join("")+
 '<div class="acts"><button class="btn" onclick="window.print()">Print</button><button class="btn p" id="sv">Save note</button></div></div></div><h3 style="margin:16px 0 8px;font-size:14px">Saved notes</h3><div style="display:grid;gap:8px">'+
 ((v.notes||[]).slice().reverse().map(n=>'<div class="note"><h5>'+esc(n.template)+'</h5><div class="m">'+tm(n.at)+' · '+esc(n.by)+(n.icd?" · "+esc(n.icd):"")+'</div><dl>'+Object.entries(n.fields).filter(([,x])=>x&&x.length).map(([k,x])=>'<dt>'+esc(k)+'</dt><dd>'+esc(Array.isArray(x)?x.join(", "):x)+'</dd>').join("")+'</dl></div>').join("")||'<div class="empty">No notes yet.</div>')+'</div>';
 $("#tp").onchange=(e)=>{TP=e.target.value;paneAssessment()};
 $("#sv").onclick=async()=>{const fields={};const labels={};[...t.f,...t.f2].forEach(([k,l])=>labels[k]=l);
  $$("#pane textarea").forEach(x=>{if(x.value.trim())fields[labels[x.name]||x.name]=x.value.trim()});
  t.ck.forEach(([g])=>{const on=$$('#pane input[data-g="'+g+'"]:checked').map(x=>x.value);if(on.length)fields[g]=on});
  try{await api("/api/hmis/note",{visitId:v.id,template:TP,fields,icd:$("#icd").value});toast("Note saved");chart(v.id,true)}catch(e){toast(e.message)}};
}
function paneHistory(){
 $("#pane").innerHTML=panel("Visit history",["Date","Visit","Doctor","Diagnosis","Prescription","Results"],C.history.map((h,i)=>'<tr><td>'+dt(h.date)+'</td><td>OP · token '+esc(h.token)+'</td><td>'+esc(h.doctor)+'</td><td>'+esc(h.diagnosis||h.complaint)+'</td><td>'+(h.rx&&h.rx.items&&h.rx.items.length?'<button class="btn" data-h="'+i+'">View ('+h.rx.items.length+')</button>':"–")+'</td><td>'+(h.reports||[]).filter(r=>r.status==="reported").length+'/'+(h.reports||[]).length+'</td></tr>'));
 $$("[data-h]").forEach(b=>b.onclick=()=>{const h=C.history[+b.dataset.h];modal('<div class="rep"><h2>Prescription · '+dt(h.date)+'</h2><p>'+esc(h.diagnosis)+'</p>'+rxTable(h.rx.items)+'</div>')});
}
function rxTable(items){return '<table><thead><tr><th>#</th><th>Medicine</th><th>Dose</th><th>Frequency</th><th>Food</th><th>Duration</th></tr></thead><tbody>'+items.map((i,n)=>'<tr><td>'+(n+1)+'</td><td><b>'+esc([i.form,i.generic,i.strength].filter(Boolean).join(" "))+'</b>'+(i.instructions?'<br><small>'+esc(i.instructions)+'</small>':"")+'</td><td>'+esc(i.dose)+'</td><td>'+esc(i.frequency)+'</td><td>'+esc(i.timing)+'</td><td>'+esc(i.duration)+'</td></tr>').join("")+'</tbody></table>'}
function modal(html){const m=document.createElement("div");m.className="modal";m.innerHTML='<div>'+html+'<div class="acts" style="margin-top:12px"><button class="btn" id="mp">Print</button><button class="btn p" id="mc">Close</button></div></div>';document.body.appendChild(m);
 $("#mc",m).onclick=()=>m.remove();m.onclick=(e)=>{if(e.target===m)m.remove()};$("#mp",m).onclick=()=>{const w=window.open("","_blank");if(!w){toast("Allow pop-ups to print");return}w.document.write('<html><head><title>Rx Clinic</title><style>body{font:14px system-ui;padding:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}</style></head><body>'+m.firstChild.innerHTML.replace(/<div class="acts"[\\s\\S]*$/,"")+'</body></html>');w.document.close();w.print()}}

// ---------- monitoring ----------
function paneMonitor(){
 const log=(C.visit.vitalsLog||[]).slice().reverse();
 const F=[["temp","Body temp (°F)"],["pulse","Pulse (/min)"],["bp","Blood pressure (mmHg)"],["rr","Resp. rate (/min)"],["spo2","SpO₂ (%)"],["o2","O₂ support (L/min)"],["height","Height (cm)"],["weight","Weight (kg)"],["rbs","RBS (mg/dL)"],["pain","Pain score (0–10)"]];
 $("#pane").innerHTML='<div class="grid2" style="grid-template-columns:minmax(0,.9fr) minmax(0,1.4fr)"><div class="panel"><h3>Add vitals <small>'+tm(Date.now())+'</small></h3><div class="pb"><div class="fr">'+F.map(([k,l])=>'<label class="f">'+l+'<input name="'+k+'" inputmode="'+(k==="bp"?"text":"decimal")+'"></label>').join("")+'</div><label class="f">Note<input name="note"></label><div class="acts"><button class="btn p" id="vs">Save vitals</button></div></div></div>'+
 panel("Vitals chart",["Time","Temp","Pulse","BP","RR","SpO₂","O₂","Wt","BMI","RBS","Pain","By"],log.map(e=>'<tr><td>'+tm(e.at)+'</td>'+["temp","pulse","bp","rr","spo2","o2","weight","bmi","rbs","pain"].map(k=>'<td style="'+(hi(k,e.vitals[k])?"color:var(--red);font-weight:700":"")+'">'+esc(e.vitals[k]||"")+'</td>').join("")+'<td>'+esc(e.by)+'</td></tr>'),"No vitals recorded yet")+'</div>';
 $("#vs").onclick=async()=>{const vit={};$$("#pane .pb input").forEach(x=>{if(x.name!=="note")vit[x.name]=x.value.trim()});if(!Object.values(vit).some(Boolean))return toast("Enter at least one value");
  try{await api("/api/hmis/vitals",{visitId:C.visit.id,vitals:vit,note:$('#pane input[name=note]').value});toast("Vitals saved");chart(C.visit.id,true)}catch(e){toast(e.message)}};
}

// ---------- results ----------
function paneResults(){
 const done=C.orders.filter(o=>o.status==="reported"),pend=C.orders.filter(o=>o.status!=="reported");
 $("#pane").innerHTML='<div class="grid2" style="grid-template-columns:minmax(0,.8fr) minmax(0,1.6fr)">'+panel("Investigations",["Test","Status"],C.orders.map((o,i)=>'<tr class="r" data-o="'+i+'"><td><b>'+esc(o.test)+'</b><br><small>'+esc(o.modality||"Lab")+' · '+dt(o.date)+'</small></td><td>'+(o.status==="reported"?'<span class="pill grn">Reported</span>':'<span class="pill amb">'+esc(o.status)+'</span>')+'</td></tr>'),"No tests ordered for this visit")+'<div id="rv" class="panel"><h3>Result view</h3><div class="empty">'+(done.length?"Choose a report on the left.":pend.length?pend.length+" test(s) waiting for results.":"Order tests from the Orders tab.")+'</div></div></div>';
 $$("[data-o]").forEach(tr=>tr.onclick=()=>{const o=C.orders[+tr.dataset.o],p=C.patient||C.visit.patient||{};
  $("#rv").innerHTML='<h3>Result view <small>'+esc(o.status==="reported"?"Final report":"Pending")+'</small></h3><div class="pb rep" id="rep"><h2>'+esc(o.test)+'</h2><div class="m" style="color:var(--muted)">'+esc(p.name)+' · '+esc(p.id||"")+' · '+esc([p.age?p.age+"Y":"",p.sex].filter(Boolean).join(" / "))+' · ordered '+tm(o.orderedAt)+(o.reportedAt?" · reported "+tm(o.reportedAt):"")+'</div>'+
  (o.status==="reported"?'<div style="white-space:pre-wrap;border:1px solid var(--line);border-radius:6px;padding:10px">'+esc(o.result||"")+'</div>'+(o.impression?'<p><b>Impression:</b> '+esc(o.impression)+'</p>':""):'<p>Status: '+esc(o.status)+'</p>')+'<div class="acts"><button class="btn" id="rp">Print report</button></div></div>';
  $("#rp").onclick=()=>modal($("#rep").innerHTML.replace(/<div class="acts">[\\s\\S]*$/,""))});
}

// ---------- orders ----------
let CAT=null;
async function paneOrders(){
 $("#pane").innerHTML='<div class="empty">Loading price list…</div>';
 if(!CAT){try{const [l,d]=await Promise.all([api("/api/tariff/list",{dept:"lab"}),api("/api/tariff/list",{dept:"diagnostics"})]);CAT=[...l.tariff.map(t=>({...t,k:"Lab"})),...d.tariff.map(t=>({...t,k:"Imaging"}))]}catch{CAT=[]}}
 const have=new Set(C.orders.map(o=>o.test.toLowerCase()));
 $("#pane").innerHTML='<div class="grid2"><div class="panel"><h3>New orders</h3><div class="pb"><input id="os" placeholder="Search tests and scans" style="border:1px solid var(--line);border-radius:5px;padding:7px 9px"><div class="cat" id="oc"></div><label class="f">Other test (type and press Add)<div style="display:flex;gap:6px"><input id="ot" style="flex:1"><button class="btn" id="oa">Add</button></div></label><div id="sel" class="cks"></div><div class="acts"><button class="btn p" id="op">Place orders</button></div></div></div>'+
 panel("Orders for this visit",["Test","Type","Status","Ordered"],C.orders.map(o=>'<tr><td>'+esc(o.test)+'</td><td>'+esc(o.modality||"Lab")+'</td><td>'+(o.status==="reported"?'<span class="pill grn">Reported</span>':'<span class="pill amb">'+esc(o.status)+'</span>')+'</td><td>'+tm(o.orderedAt)+'</td></tr>'),"No orders yet")+'</div>';
 const pick=new Set();
 const drawCat=()=>{const q=$("#os").value.toLowerCase();$("#oc").innerHTML=CAT.filter(t=>!q||t.name.toLowerCase().includes(q)).map(t=>'<label><input type="checkbox" value="'+esc(t.name)+'"'+(pick.has(t.name)?" checked":"")+(have.has(t.name.toLowerCase())?" disabled":"")+'>'+esc(t.name)+'<span>'+t.k+' · ₹'+Math.round(t.price).toLocaleString("en-IN")+'</span></label>').join("")||'<div class="empty">No match. Use "Other test".</div>';
  $$("#oc input").forEach(c=>c.onchange=()=>{c.checked?pick.add(c.value):pick.delete(c.value);drawSel()})};
 const drawSel=()=>{$("#sel").innerHTML=[...pick].map(x=>'<span class="pill">'+esc(x)+'</span>').join(" ")};
 $("#os").oninput=drawCat;drawCat();
 $("#oa").onclick=()=>{const x=$("#ot").value.trim();if(x){pick.add(x);$("#ot").value="";drawSel()}};
 $("#op").onclick=async()=>{if(!pick.size)return toast("Choose at least one test");try{const r=await api("/api/orders/create",{visitId:C.visit.id,tests:[...pick]});toast(r.created+" order(s) sent to lab and diagnostics");chart(C.visit.id,true)}catch(e){toast(e.message)}};
}

// ---------- medicines ----------
let STOCK=null;
async function paneMeds(){
 if(!STOCK){try{STOCK=(await api("/api/pharmacy/stock")).stock}catch{STOCK=[]}}
 const v=C.visit,rx=JSON.parse(JSON.stringify(v.rx||{items:[]}));rx.items=rx.items||[];
 const inStock=(g)=>{g=(g||"").toLowerCase();return STOCK.some(s=>s.generic.length>=4&&(s.stock||0)>0&&(g.includes(s.generic.toLowerCase())||s.generic.toLowerCase().includes(g)))};
 const row=(i,n)=>'<tr data-n="'+n+'">'+["form","generic","strength","dose","frequency","timing","duration","instructions"].map(k=>k==="timing"?'<td><select data-k="timing">'+["After food","Before food","With food","Empty stomach","At bedtime","As needed"].map(o=>'<option'+(i.timing===o?" selected":"")+'>'+o+'</option>').join("")+'</select></td>':'<td><input data-k="'+k+'" value="'+esc(i[k]||"")+'"'+(k==="generic"?' list="stk"':"")+'></td>').join("")+'<td>'+(i.generic?(inStock(i.generic)?'<span class="pill grn">In pharmacy</span>':'<span class="pill red">Not in pharmacy</span>'):"")+'</td><td><button class="btn d" data-del="'+n+'">✕</button></td></tr>';
 $("#pane").innerHTML='<div class="panel"><h3>Prescription <small>'+(v.status==="sent"||v.status==="dispensed"?"Sent to pharmacy":"Draft")+'</small></h3><div class="pb"><label class="f">Diagnosis<input id="dx" value="'+esc(rx.dx||"")+'"></label><div style="overflow:auto"><table class="rx" style="min-width:980px"><thead><tr><th>Form</th><th>Generic</th><th>Strength</th><th>Dose</th><th>Frequency</th><th>Food</th><th>Duration</th><th>Instructions</th><th>Stock</th><th></th></tr></thead><tbody id="rb">'+rx.items.map(row).join("")+'</tbody></table></div>'+
 '<datalist id="stk">'+STOCK.map(s=>'<option value="'+esc(s.generic)+'">'+esc([s.strength,s.form,(s.stock||0)+" in stock"].filter(Boolean).join(" · "))+'</option>').join("")+'</datalist><div><button class="btn" id="add">+ Add medicine</button></div>'+
 '<label class="f">Advice (one per line)<textarea id="adv" rows="3">'+esc((rx.advice||[]).join("\\n"))+'</textarea></label><div class="fr"><label class="f">Review date<input type="date" id="rvd" value="'+esc(rx.review||"")+'"></label><label class="f">Review note<input id="rvn" value="'+esc(rx.reviewNote||"")+'"></label></div>'+
 '<div class="acts"><button class="btn" id="pr">Print</button><button class="btn" id="dr">Save draft</button><button class="btn p" id="snd">Finish & send to pharmacy</button></div></div></div>';
 const read=()=>{rx.items=$$("#rb tr").map(tr=>{const o={};$$("[data-k]",tr).forEach(x=>o[x.dataset.k]=x.value.trim());return o}).filter(i=>i.generic);rx.dx=$("#dx").value.trim();rx.advice=$("#adv").value.split("\\n").map(x=>x.trim()).filter(Boolean);rx.review=$("#rvd").value;rx.reviewNote=$("#rvn").value.trim();return rx};
 const redraw=()=>{$("#rb").innerHTML=rx.items.map(row).join("");$$("[data-del]").forEach(b=>b.onclick=()=>{read();rx.items.splice(+b.dataset.del,1);redraw()});$$('#rb input[data-k=generic]').forEach(x=>x.onchange=()=>{read();redraw()})};
 redraw();
 $("#add").onclick=()=>{read();rx.items.push({form:"Tab",dose:"1 tab",frequency:"1-0-1",timing:"After food",duration:"5 days"});redraw();$$('#rb input[data-k=generic]').slice(-1)[0].focus()};
 const save=async(send)=>{read();if(send&&!rx.items.length)return toast("Add at least one medicine");
  try{await api("/api/doctor/visit/save",{id:v.id,patch:Object.assign({rx},send?{status:"sent"}:{})});toast(send?"Prescription saved and sent to the pharmacy":"Draft saved");chart(v.id,true)}catch(e){toast(e.message)}};
 $("#dr").onclick=()=>save(false);$("#snd").onclick=()=>save(true);
 $("#pr").onclick=()=>{read();const p=C.patient||v.patient||{};modal('<div class="rep"><h2>℞ Prescription</h2><p><b>'+esc(p.name)+'</b> · '+esc(p.id||"")+' · '+esc([p.age?p.age+"Y":"",p.sex].filter(Boolean).join(" / "))+' · '+new Date().toLocaleDateString("en-GB")+'</p>'+(rx.dx?'<p><b>Diagnosis:</b> '+esc(rx.dx)+'</p>':"")+rxTable(rx.items)+(rx.advice.length?'<p><b>Advice</b></p><ul>'+rx.advice.map(a=>'<li>'+esc(a)+'</li>').join("")+'</ul>':"")+(rx.review?'<p><b>Review:</b> '+dt(rx.review)+' '+esc(rx.reviewNote)+'</p>':"")+'<p style="text-align:right;margin-top:30px">'+esc(ME.name||"")+'</p></div>')};
}

// ---------- requests ----------
let DOCS=null;
async function paneRequests(){
 const subs=[["consult","Cross consultation"],["admit","Admission"],["surgery","Surgery"],["appt","Appointment"],["diet","Diet advice"]];
 $("#pane").innerHTML='<div class="sub">'+subs.map(([k,l])=>'<button data-s="'+k+'" class="'+(SUB===k?"on":"")+'">'+l+'</button>').join("")+'</div><div class="grid2" style="grid-template-columns:minmax(0,1fr) minmax(0,1.2fr)"><div class="panel"><div class="pb" id="rf"></div></div>'+
 panel("History",["Date","Request","Details","Status"],C.requests.map(r=>'<tr><td>'+tm(r.created)+'</td><td>'+esc({consult:"Cross consultation",surgery:"Surgery",diet:"Diet advice"}[r.type])+'</td><td>'+esc(r.toDoctor||r.fields.procedure||r.fields.diet||r.fields.remarks||"")+(r.reply?'<br><small>Reply: '+esc(r.reply.text)+'</small>':"")+'</td><td><span class="pill '+(r.status==="open"?"amb":"grn")+'">'+esc(r.status)+'</span></td></tr>'),"No requests yet")+'</div>';
 $$(".sub button").forEach(b=>b.onclick=()=>{SUB=b.dataset.s;paneRequests()});
 const f=$("#rf"),v=C.visit,p=C.patient||v.patient||{};
 const send=async(type,fields,toDoctor)=>{try{await api("/api/hmis/request",{visitId:v.id,type,fields,toDoctor});toast("Request sent");chart(v.id,true)}catch(e){toast(e.message)}};
 if(SUB==="consult"){if(!DOCS){try{DOCS=(await api("/api/hmis/doctors")).doctors}catch{DOCS=[]}}
  f.innerHTML='<label class="f">Doctor<select id="cd"><option value="">Choose a doctor</option>'+DOCS.filter(d=>d.name!==ME.name).map(d=>'<option>'+esc(d.name)+'</option>').join("")+'</select></label><label class="f">Department / unit (optional)<input id="cu" placeholder="e.g. Cardiology"></label><label class="f">Reason and remarks<textarea id="cr" rows="4"></textarea></label><div class="acts"><button class="btn p" id="cs">Send request</button></div>';
  $("#cs").onclick=()=>{if(!$("#cd").value&&!$("#cu").value)return toast("Choose a doctor or a unit");send("consult",{unit:$("#cu").value,remarks:$("#cr").value},$("#cd").value)}}
 else if(SUB==="admit"){
  if(C.admission){f.innerHTML='<p>Already admitted: <b>'+esc(C.admission.no)+'</b> · '+esc(C.admission.ward+" "+C.admission.bed)+'</p>';return}
  let wards=[];try{wards=(await api("/api/tariff/list",{dept:"ip"})).tariff.filter(t=>t.unit==="per day"&&!/nursing|oxygen/i.test(t.name))}catch{}
  f.innerHTML='<label class="f">Ward / room<select id="aw">'+wards.map(w=>'<option value="'+esc(w.name)+'">'+esc(w.name)+' · ₹'+Math.round(w.price).toLocaleString("en-IN")+'/day</option>').join("")+'</select></label><div class="fr"><label class="f">Bed<input id="ab"></label><label class="f">Expected stay (days)<input id="ad" inputmode="numeric"></label></div><label class="f">Reason / diagnosis<textarea id="ar" rows="3">'+esc(v.rx?.dx||"")+'</textarea></label><div class="acts"><button class="btn p" id="as">Admit</button></div>';
  $("#as").onclick=async()=>{if(!p.id)return toast("Register the patient first");try{await api("/api/ip/admit",{patientId:p.id,ward:$("#aw").value,bed:$("#ab").value,doctor:ME.name,reason:$("#ar").value+($("#ad").value?" · expected "+$("#ad").value+" days":"")});toast("Patient admitted");chart(v.id,true)}catch(e){toast(e.message)}}}
 else if(SUB==="surgery"){
  f.innerHTML='<div class="fr"><label class="f">Surgery date<input type="date" id="sd" value="'+today()+'"></label><label class="f">Time<input type="time" id="st"></label></div><label class="f">Procedure<input id="sp" placeholder="e.g. Laparoscopic cholecystectomy"></label><div class="fr"><label class="f">Surgeon<input id="ss" value="'+esc(ME.name||"")+'"></label><label class="f">Anaesthetist<input id="sa"></label></div><div class="fr"><label class="f">Anaesthesia<select id="sn"><option>General</option><option>Spinal</option><option>Regional block</option><option>Local</option><option>Sedation</option></select></label><label class="f">Urgency<select id="su"><option>Elective</option><option>Urgent</option><option>Emergency</option></select></label></div><label class="f">Remarks / special equipment<textarea id="sr" rows="2"></textarea></label><div class="acts"><button class="btn p" id="sb">Book surgery</button></div>';
  $("#sb").onclick=()=>{if(!$("#sp").value.trim())return toast("Enter the procedure");send("surgery",{date:$("#sd").value,time:$("#st").value,procedure:$("#sp").value,surgeon:$("#ss").value,anaesthetist:$("#sa").value,anaesthesia:$("#sn").value,urgency:$("#su").value,remarks:$("#sr").value})}}
 else if(SUB==="appt"){
  let day=today(),slot="",part="all";
  const draw=async()=>{const days=[...Array(7)].map((_,i)=>{const d=new Date();d.setDate(d.getDate()+i+1);return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)});if(day===today())day=days[0];
   let sl=[];try{sl=(await (await fetch("/api/slots?date="+day)).json()).slots||[]}catch{}
   const inPart=(t)=>{const h=+t.slice(0,2);return part==="all"||(part==="m"&&h<12)||(part==="a"&&h>=12&&h<16)||(part==="e"&&h>=16)};
   f.innerHTML='<b>Review appointment for '+esc(p.name)+'</b><div class="days">'+days.map(d=>{const x=new Date(d+"T00:00");return '<button data-d="'+d+'" class="'+(d===day?"on":"")+'">'+x.toLocaleDateString("en-GB",{weekday:"short"})+'<b>'+x.getDate()+'</b>'+x.toLocaleDateString("en-GB",{month:"short"})+'</button>'}).join("")+'</div><div class="sub">'+[["all","All"],["m","Morning"],["a","Afternoon"],["e","Evening"]].map(([k,l])=>'<button data-p="'+k+'" class="'+(part===k?"on":"")+'">'+l+'</button>').join("")+'</div><div class="slots">'+(sl.filter(s=>inPart(s.t)).map(s=>'<button data-t="'+s.t+'" '+(s.free?"":"disabled")+' class="'+(slot===s.t?"on":"")+'">'+s.t+'</button>').join("")||'<span style="color:var(--muted)">No slots</span>')+'</div><label class="f">Mode<select id="am"><option value="clinic">At the clinic</option><option value="tele">Video consultation</option></select></label><div class="acts"><button class="btn p" id="ab2">Save appointment</button></div>';
   $$("[data-d]",f).forEach(b=>b.onclick=()=>{day=b.dataset.d;slot="";draw()});$$("[data-p]",f).forEach(b=>b.onclick=()=>{part=b.dataset.p;draw()});$$("[data-t]",f).forEach(b=>b.onclick=()=>{slot=b.dataset.t;$$("[data-t]",f).forEach(x=>x.classList.toggle("on",x===b))});
   $("#ab2").onclick=async()=>{if(!slot)return toast("Choose a time");if(!(p.phone||v.patient?.phone))return toast("This patient has no mobile number");
    try{const r=await fetch("/api/book",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:p.name,age:p.age,sex:p.sex,phone:p.phone||v.patient.phone,date:day,time:slot,mode:$("#am").value,reason:"Review",lang:v.lang||"en"})});const j=await r.json();if(!r.ok)throw new Error(j.error);toast("Booked "+dt(day)+" "+slot+" · code "+j.appointment.code)}catch(e){toast(e.message)}}};
  draw()}
 else{const T={"Diabetic":"Avoid sugar, sweets and fruit juices. Small meals every 3–4 hours. Whole grains, vegetables, dal. Walk 30 minutes daily.","Low salt (BP / heart)":"Less than 5 g salt a day. Avoid pickles, papad, chips and processed food. More fruits and vegetables.","Acid peptic":"Avoid spicy, sour and oily food, tea and coffee on an empty stomach. Eat on time. No smoking or alcohol. Do not lie down for 2 hours after food.","Soft / liquid diet":"Soft, easily digestible food: idli, kanji, curd rice, soups. Plenty of fluids.","High protein":"Eggs, dal, paneer, milk, fish or chicken daily. Helps healing after surgery and illness.","Renal":"Limit salt, potassium-rich fruits and protein as advised. Measure fluid intake."};
  f.innerHTML='<label class="f">Quick templates</label><div class="cks">'+Object.keys(T).map(k=>'<button class="chip" data-tp="'+esc(k)+'">'+esc(k)+'</button>').join("")+'</div><label class="f">Diet advice<textarea id="dt" rows="6"></textarea></label><div class="acts"><button class="btn p" id="ds">Save diet advice</button></div>';
  $$("[data-tp]",f).forEach(b=>b.onclick=()=>{$("#dt").value=($("#dt").value?$("#dt").value+"\\n":"")+T[b.dataset.tp]});
  $("#ds").onclick=()=>{if(!$("#dt").value.trim())return toast("Write the advice");send("diet",{diet:$("#dt").value})}}
}
// ---------- shared form helpers ----------
const fld=(k,l,o={})=>o.rows?'<label class="f">'+l+'<textarea name="'+k+'" rows="'+o.rows+'">'+esc(o.v||"")+'</textarea></label>'
 :o.opts?'<label class="f">'+l+'<select name="'+k+'">'+o.opts.map(x=>'<option'+(x===o.v?" selected":"")+'>'+esc(x)+'</option>').join("")+'</select></label>'
 :'<label class="f">'+l+'<input name="'+k+'" type="'+(o.type||"text")+'" value="'+esc(o.v||"")+'"'+(o.list?' list="'+o.list+'"':"")+(o.ph?' placeholder="'+esc(o.ph)+'"':"")+'></label>';
const ckl=(k,items,val={})=>'<div class="cks" style="flex-direction:column;gap:8px">'+items.map(([n,l])=>'<label><input type="checkbox" name="'+k+"."+n+'"'+(val[n]===true||val[n]==="true"?" checked":"")+'>'+esc(l)+'</label>').join("")+'</div>';
function readForm(root){const o={};$$("input,select,textarea",root).forEach(x=>{if(!x.name)return;if(x.type==="checkbox"){const [g,n]=x.name.split(".");if(n){(o[g]=o[g]||{})[n]=x.checked}else o[x.name]=x.checked}else o[x.name]=x.value.trim()});return o}
const isDoc=()=>ME.role==="doctor"||ME.role==="admin";
const isBill=()=>ME.role==="billing"||ME.role==="admin";
const inr=(x)=>"₹"+Math.round(x||0).toLocaleString("en-IN");
async function aiJson(prompt){const r=await api("/api/ai",{prompt,json:true});if(!r.json)throw new Error("The AI gave no answer. Try again.");return r.json}

// ---------- inpatient chart ----------
let IPD=null,ITAB="over";
async function ipChart(id,keep){
 try{IPD=await api("/api/hmis/ip/chart",{admissionId:id})}catch(e){$("#app").innerHTML='<div class="empty">'+esc(e.message)+'</div>';return}
 ME=IPD.me;$("#me").textContent=ME.name||"";$("#role").textContent=ROLE[ME.role]||ME.role;
 if(!keep)ITAB="over";drawIp();
}
function ipVitals(){const l=IPD.admission.vitalsLog||[];return l.length?l[l.length-1].vitals:{}}
function drawIp(){
 const a=IPD.admission,p=IPD.patient||a.patient||{},vit=ipVitals(),day=Math.max(1,Math.ceil(((a.dischargedAt||Date.now())-a.admittedAt)/864e5));
 const side='<aside class="side"><div class="ban" style="background:#9fd8cf">'+esc(p.name)+'</div><div class="id"><div class="av">'+esc((p.name||"?").trim()[0])+'</div><div><b>'+esc(p.id||"")+'</b><br><small>'+esc([p.age?p.age+"Y":"",p.sex].filter(Boolean).join(" / "))+'</small><br><span class="pill '+(a.status==="admitted"?"":"grn")+'">'+(a.status==="admitted"?"IP · day "+day:"Discharged")+'</span></div></div>'+
 '<dl><dt>IP number</dt><dd>'+esc(a.no)+'</dd><dt>Ward / bed</dt><dd>'+esc(a.ward)+' · '+esc(a.bed||"–")+'</dd><dt>Admitted</dt><dd>'+tm(a.admittedAt)+'</dd>'+(a.dischargedAt?'<dt>Discharged</dt><dd>'+tm(a.dischargedAt)+'</dd>':"")+'<dt>Consultant</dt><dd>'+esc(a.doctor||"")+'</dd><dt>Reason</dt><dd>'+esc(a.reason||"")+'</dd></dl>'+
 '<h4>Latest vitals <button data-it="nurse" title="Add vitals">+</button></h4><div class="vit">'+[["temp","Temp","°F"],["pulse","Pulse",""],["bp","BP",""],["rr","RR",""],["spo2","SpO₂","%"],["rbs","RBS",""],["pain","Pain",""]].map(([k,l,u])=>'<span>'+l+'</span><b class="'+(hi(k,vit[k])?"hi":"")+'">'+(vit[k]?esc(vit[k])+(u?" "+u:""):"–")+'</b>').join("")+'</div>'+
 '<h4>Allergy</h4><p style="color:'+(IPD.flags.allergy?"var(--red)":"inherit")+'">'+esc(IPD.flags.allergy||"–")+'</p><div style="padding:8px 10px"><button class="btn" onclick="location.hash=\\'\\'">‹ All patients</button></div></aside>';
 const tabs=[["over","Overview","home"],["round","Ward rounds","asmt"],["nurse","Nursing","mon"],["meds","Medicines","med"],["ord","Orders & results","res"],["sx","Surgery","req"],["bill","Billing","ord"],["dis","Discharge","hist"]];
 $("#app").innerHTML='<div class="chart">'+side+'<section><div class="tabs">'+tabs.map(([k,l,i])=>'<button data-t="'+k+'" class="'+(ITAB===k?"on":"")+'">'+ic(i)+l+'</button>').join("")+'</div><div id="pane"></div></section></div>';
 $$(".tabs button").forEach(b=>b.onclick=()=>{ITAB=b.dataset.t;drawIp()});$$("[data-it]").forEach(b=>b.onclick=()=>{ITAB=b.dataset.it;drawIp()});
 ({over:ipOver,round:ipRounds,nurse:ipNursing,meds:ipMeds,ord:ipOrders,sx:ipSurgery,bill:ipBill,dis:ipDischarge}[ITAB])();
}
async function ipRec(kind,b){const a=IPD.admission;try{await api("/api/hmis/ip/record",Object.assign({admissionId:a.id,kind},b));toast("Saved");ipChart(a.id,true)}catch(e){toast(e.message)}}
const noteHtml=(n)=>'<div class="note"><h5>'+esc({round:"Ward round",progress:"Progress note",nursing:"Nursing note",procedure:"Procedure note"}[n.type]||n.type)+'</h5><div class="m">'+tm(n.at)+' · '+esc(n.by)+'</div><dl>'+Object.entries(n.fields).filter(([,x])=>x).map(([k,x])=>'<dt>'+esc(k)+'</dt><dd>'+esc(x)+'</dd>').join("")+'</dl></div>';
function ipOver(){
 const a=IPD.admission,acc=IPD.account,act=(a.drugs||[]).filter(d=>d.active);
 const notes=(a.notes||[]).filter(n=>n.type!=="nursing").slice(-3).reverse();
 $("#pane").innerHTML='<div class="grid2">'+
 '<div class="panel"><h3>Latest rounds</h3><div class="pb">'+(notes.map(noteHtml).join("")||'<div class="empty">No ward round notes yet.</div>')+'</div></div>'+
 panel("Active medicines",["Medicine","Route","Frequency","Since"],act.map(d=>'<tr><td><b>'+esc(d.name)+'</b> '+esc(d.dose)+'</td><td>'+esc(d.route)+'</td><td>'+esc(d.freq)+'</td><td>'+tm(d.start).slice(0,10)+'</td></tr>'),"No medicines ordered")+
 panel("Investigations",["Test","Status","Ordered"],IPD.orders.map(o=>'<tr><td>'+esc(o.test)+'</td><td>'+(o.status==="reported"?'<span class="pill grn">Reported</span>':'<span class="pill amb">'+esc(o.status)+'</span>')+'</td><td>'+tm(o.orderedAt)+'</td></tr>'),"No investigations")+
 panel("Surgery",["Date","Procedure","Status"],IPD.surgeries.map(r=>'<tr class="r" onclick="location.hash=\\'ot-'+r.id+'\\'"><td>'+dt(r.date)+'</td><td>'+esc(r.fields.procedure)+'</td><td><span class="pill">'+esc(r.ot?.status||"scheduled")+'</span></td></tr>'),"No surgery booked")+
 '<div class="panel"><h3>Bill so far</h3><div class="pb"><div style="display:flex;justify-content:space-between"><span>Total</span><b>'+inr(acc.total)+'</b></div><div style="display:flex;justify-content:space-between"><span>Advance</span><b style="color:var(--green)">'+inr(acc.advance)+'</b></div><div style="display:flex;justify-content:space-between"><span>'+(acc.due>=0?"Balance":"Refund")+'</span><b style="color:var(--red)">'+inr(Math.abs(acc.due))+'</b></div></div></div></div>';
}
function ipCase(){const a=IPD.admission,p=IPD.patient||{};
 return "Patient: "+p.name+", "+(p.age||"?")+" y "+(p.sex||"")+". Admitted "+tm(a.admittedAt)+" (day "+Math.max(1,Math.ceil((Date.now()-a.admittedAt)/864e5))+") to "+a.ward+" for: "+(a.reason||"not stated")+". Allergy: "+(IPD.flags.allergy||"none recorded")+".\\n"+
 "Vitals (latest first): "+(a.vitalsLog||[]).slice(-6).reverse().map(e=>tm(e.at)+" "+Object.entries(e.vitals).filter(([,x])=>x).map(([k,x])=>k+" "+x).join(", ")).join(" | ")+"\\n"+
 "Medicines: "+(a.drugs||[]).map(d=>d.name+" "+d.dose+" "+d.route+" "+d.freq+(d.active?"":" (stopped)")).join("; ")+"\\n"+
 "Investigations: "+IPD.orders.map(o=>o.test+": "+(o.status==="reported"?(o.impression||o.result||"").slice(0,300):o.status)).join("; ")+"\\n"+
 "Surgery: "+IPD.surgeries.map(r=>r.fields.procedure+" on "+r.date+" ("+(r.ot?.status||"scheduled")+")"+(r.ot?.opnote?". Findings: "+(r.ot.opnote.findings||""):"")).join("; ")+"\\n"+
 "Notes (latest last): "+(a.notes||[]).slice(-8).map(n=>n.type+" "+tm(n.at)+": "+Object.entries(n.fields).map(([k,x])=>k+": "+x).join("; ")).join("\\n")}
function ipRounds(){
 const a=IPD.admission,list=(a.notes||[]).filter(n=>n.type!=="nursing").slice().reverse();
 $("#pane").innerHTML='<div class="grid2" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr)"><div class="panel"><h3>Ward round <small>'+tm(Date.now())+'</small></h3><div class="pb" id="rf">'+
 (isDoc()?fld("Subjective","Subjective (patient\\'s complaints today)",{rows:2})+fld("Objective","Objective (examination, drains, wound)",{rows:3})+fld("Assessment","Assessment",{rows:2})+fld("Plan","Plan",{rows:3})+
 '<div class="acts"><button class="btn" id="ai">AI suggestions</button><button class="btn p" id="sr">Save round</button></div><div id="aib"></div>':'<div class="empty">Doctors write ward rounds. Add nursing notes in the Nursing tab.</div>')+
 '</div></div><div class="panel"><h3>Round notes</h3><div class="pb">'+(list.map(noteHtml).join("")||'<div class="empty">No notes yet.</div>')+'</div></div></div>';
 if(!isDoc())return;
 $("#sr").onclick=()=>{const f=readForm($("#rf"));if(!Object.values(f).some(Boolean))return toast("Write the round note");ipRec("note",{type:"round",fields:f})};
 $("#ai").onclick=async()=>{const b=$("#aib");b.innerHTML='<div class="empty">Asking the AI…</div>';const f=readForm($("#rf"));
  try{const j=await aiJson("You assist a qualified doctor on a ward round in an Indian hospital. Suggest, do not decide. Be brief and specific.\\n"+ipCase()+"\\nToday's round so far: "+JSON.stringify(f)+
   '\\nReply with ONLY JSON: {"summary":"one line","concerns":["red flags or worsening trends"],"investigations":["tests to consider, with reason"],"medication":["changes to consider: add/stop/adjust, with reason"],"nursing":["instructions"],"discharge":{"ready":false,"why":""}}');
   const L=(t,a)=>a&&a.length?'<b>'+t+'</b><ul style="margin:4px 0 8px;padding-left:18px">'+a.map(x=>'<li>'+esc(typeof x==="string"?x:JSON.stringify(x))+'</li>').join("")+'</ul>':"";
   b.innerHTML='<div class="note" style="background:#eef0fb;border-color:#c9cbf0"><h5 style="color:#4447a3">AI suggestion box</h5><p style="margin:4px 0 8px">'+esc(j.summary||"")+'</p>'+L("Concerns",j.concerns)+L("Investigations to consider",j.investigations)+L("Medication to consider",j.medication)+L("Nursing",j.nursing)+
   (j.discharge?'<b>Discharge:</b> '+(j.discharge.ready?"May be ready":"Not yet")+' · '+esc(j.discharge.why||""):"")+'<div class="acts"><button class="btn" id="cp">Copy into plan</button></div><div class="m">For the doctor to check. Nothing is applied automatically.</div></div>';
   $("#cp").onclick=()=>{const t=$('#rf textarea[name="Plan"]');t.value=(t.value?t.value+"\\n":"")+[...(j.investigations||[]),...(j.medication||[]),...(j.nursing||[])].map(x=>"- "+(typeof x==="string"?x:JSON.stringify(x))).join("\\n")}}
  catch(e){b.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}};
}
function ipNursing(){
 const a=IPD.admission,log=(a.vitalsLog||[]).slice().reverse(),nn=(a.notes||[]).filter(n=>n.type==="nursing").slice().reverse();
 const F=[["temp","Temp °F"],["pulse","Pulse"],["bp","BP"],["rr","Resp. rate"],["spo2","SpO₂ %"],["o2","O₂ L/min"],["rbs","RBS"],["pain","Pain 0–10"],["intake","Intake ml"],["output","Output ml"],["gcs","GCS"]];
 $("#pane").innerHTML='<div class="grid2" style="grid-template-columns:minmax(0,.9fr) minmax(0,1.4fr)"><div style="display:grid;gap:12px"><div class="panel"><h3>Record vitals</h3><div class="pb" id="vf"><div class="fr">'+F.map(([k,l])=>fld(k,l)).join("")+'</div><div class="acts"><button class="btn p" id="vs">Save vitals</button></div></div></div>'+
 '<div class="panel"><h3>Nursing note</h3><div class="pb" id="nf">'+fld("Note","Note (care given, wound, drain, position change, patient complaints)",{rows:3})+'<div class="acts"><button class="btn p" id="ns">Save note</button></div></div></div></div>'+
 '<div style="display:grid;gap:12px;min-width:0">'+panel("Vitals chart",["Time","Temp","Pulse","BP","RR","SpO₂","RBS","Pain","I/O","By"],log.map(e=>{const v=e.vitals;return '<tr><td>'+tm(e.at)+'</td>'+["temp","pulse","bp","rr","spo2","rbs","pain"].map(k=>'<td style="'+(hi(k,v[k])?"color:var(--red);font-weight:700":"")+'">'+esc(v[k]||"")+'</td>').join("")+'<td>'+esc((v.intake||"")+(v.output?"/"+v.output:""))+'</td><td>'+esc(e.by)+'</td></tr>'}),"No vitals yet")+
 '<div class="panel"><h3>Nursing notes</h3><div class="pb">'+(nn.map(noteHtml).join("")||'<div class="empty">No nursing notes yet.</div>')+'</div></div></div></div>';
 $("#vs").onclick=()=>{const v=readForm($("#vf"));if(!Object.values(v).some(Boolean))return toast("Enter at least one value");ipRec("vitals",{vitals:v})};
 $("#ns").onclick=()=>{const f=readForm($("#nf"));if(!f.Note)return toast("Write the note");ipRec("note",{type:"nursing",fields:f})};
}
let IPSTOCK=null;
async function ipMeds(){
 const a=IPD.admission,drugs=a.drugs||[],mar=a.mar||[],td=today();
 if(isDoc()&&!IPSTOCK){try{IPSTOCK=(await api("/api/pharmacy/stock")).stock}catch{IPSTOCK=[]}}
 const given=(d)=>mar.filter(m=>m.drugId===d.id&&new Date(m.at-new Date().getTimezoneOffset()*6e4).toISOString().slice(0,10)===td);
 $("#pane").innerHTML=(isDoc()&&a.status==="admitted"?'<div class="panel" style="margin-bottom:12px"><h3>Order a medicine</h3><div class="pb" id="df"><div class="fr">'+fld("name","Medicine",{list:"ipstk",ph:"e.g. Inj Ceftriaxone"})+fld("dose","Dose",{ph:"1 g"})+fld("route","Route",{opts:["IV","IM","Oral","SC","Nebulisation","Topical","PR","SL","Infusion"]})+fld("freq","Frequency",{opts:["OD","BD","TDS","QID","Q6H","Q8H","HS","SOS","STAT","Continuous"]})+fld("times","Times",{ph:"8 am, 8 pm"})+fld("notes","Notes",{ph:"Infuse over 30 min"})+
 '</div><datalist id="ipstk">'+(IPSTOCK||[]).map(s=>'<option value="'+esc((s.form?s.form+" ":"")+s.generic+(s.strength?" "+s.strength:""))+'">').join("")+'</datalist><div class="acts"><button class="btn p" id="da">Add to chart</button></div></div></div>':"")+
 '<div class="panel"><h3>Medication chart <small>Today\\'s doses · tap Given or Held after each dose</small></h3><table><thead><tr><th>Medicine</th><th>Route</th><th>Frequency</th><th>Times</th><th>Given today</th><th></th></tr></thead><tbody>'+
 (drugs.length?drugs.slice().reverse().map(d=>{const g=given(d);return '<tr style="'+(d.active?"":"opacity:.55")+'"><td><b>'+esc(d.name)+'</b> '+esc(d.dose)+(d.notes?'<br><small>'+esc(d.notes)+'</small>':"")+(d.active?"":'<br><small>Stopped '+tm(d.stoppedAt)+'</small>')+'</td><td>'+esc(d.route)+'</td><td>'+esc(d.freq)+'</td><td>'+esc(d.times||"")+'</td><td>'+(g.map(m=>'<span class="pill '+(m.status==="given"?"grn":"red")+'" title="'+esc(m.by)+'">'+new Date(m.at).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})+(m.status==="given"?"":" "+m.status)+'</span>').join(" ")||"–")+'</td><td style="white-space:nowrap">'+
  (d.active&&a.status==="admitted"?'<button class="btn p" data-g="'+d.id+'">Given</button> <button class="btn" data-h="'+d.id+'">Held</button>'+(isDoc()?' <button class="btn d" data-s="'+d.id+'">Stop</button>':""):"")+'</td></tr>'}).join(""):'<tr><td colspan="6" class="empty">No medicines on the chart.</td></tr>')+'</tbody></table></div>';
 $("#da")&&($("#da").onclick=()=>{const d=readForm($("#df"));if(!d.name)return toast("Enter the medicine");ipRec("drug",{drug:d})});
 $$("[data-g]").forEach(b=>b.onclick=()=>ipRec("dose",{drugId:b.dataset.g,status:"given"}));
 $$("[data-h]").forEach(b=>b.onclick=()=>prompt2("Why was the dose held?","",(n)=>ipRec("dose",{drugId:b.dataset.h,status:"held",note:n})));
 $$("[data-s]").forEach(b=>b.onclick=()=>prompt2("Stop this medicine? Add a reason (optional)","",()=>ipRec("drugStop",{drugId:b.dataset.s})));
}
async function ipOrders(){
 const a=IPD.admission;if(!CAT){try{const [l,d]=await Promise.all([api("/api/tariff/list",{dept:"lab"}),api("/api/tariff/list",{dept:"diagnostics"})]);CAT=[...l.tariff.map(t=>({...t,k:"Lab"})),...d.tariff.map(t=>({...t,k:"Imaging"}))]}catch{CAT=[]}}
 const pick=new Set();
 $("#pane").innerHTML='<div class="grid2">'+(isDoc()&&a.status==="admitted"?'<div class="panel"><h3>New orders</h3><div class="pb"><input id="os" placeholder="Search tests and scans" style="border:1px solid var(--line);border-radius:5px;padding:7px 9px"><div class="cat" id="oc"></div><div id="sel" class="cks"></div><div class="acts"><button class="btn p" id="op">Place orders</button></div></div></div>':"")+
 '<div class="panel"><h3>Orders and results</h3><table><thead><tr><th>Test</th><th>Status</th><th>Result</th></tr></thead><tbody>'+(IPD.orders.length?IPD.orders.slice().reverse().map(o=>'<tr><td><b>'+esc(o.test)+'</b><br><small>'+tm(o.orderedAt)+'</small></td><td>'+(o.status==="reported"?'<span class="pill grn">Reported</span>':'<span class="pill amb">'+esc(o.status)+'</span>')+'</td><td style="white-space:pre-wrap;font-size:12.5px">'+esc(o.status==="reported"?(o.result||"")+(o.impression?"\\nImpression: "+o.impression:""):"")+'</td></tr>').join(""):'<tr><td colspan="3" class="empty">No orders yet</td></tr>')+'</tbody></table></div></div>';
 if(!$("#oc"))return;
 const drawCat=()=>{const q=$("#os").value.toLowerCase();$("#oc").innerHTML=CAT.filter(t=>!q||t.name.toLowerCase().includes(q)).map(t=>'<label><input type="checkbox" value="'+esc(t.name)+'"'+(pick.has(t.name)?" checked":"")+'>'+esc(t.name)+'<span>'+t.k+' · '+inr(t.price)+'</span></label>').join("");
  $$("#oc input").forEach(c=>c.onchange=()=>{c.checked?pick.add(c.value):pick.delete(c.value);$("#sel").innerHTML=[...pick].map(x=>'<span class="pill">'+esc(x)+'</span>').join(" ")})};
 $("#os").oninput=drawCat;drawCat();
 $("#op").onclick=async()=>{if(!pick.size)return toast("Choose at least one test");try{const r=await api("/api/orders/create",{admissionId:a.id,tests:[...pick]});toast(r.created+" order(s) sent");ipChart(a.id,true)}catch(e){toast(e.message)}};
}
function ipSurgery(){
 const a=IPD.admission;
 $("#pane").innerHTML='<div class="grid2">'+(isDoc()&&a.status==="admitted"?'<div class="panel"><h3>Book surgery</h3><div class="pb" id="sf"><div class="fr">'+fld("date","Date",{type:"date",v:today()})+fld("time","Time",{type:"time"})+'</div>'+fld("procedure","Procedure",{ph:"e.g. Laparoscopic cholecystectomy"})+'<div class="fr">'+fld("surgeon","Surgeon",{v:ME.name})+fld("anaesthetist","Anaesthetist")+fld("anaesthesia","Anaesthesia",{opts:["General","Spinal","Regional block","Local","Sedation"]})+fld("urgency","Urgency",{opts:["Elective","Urgent","Emergency"]})+'</div>'+fld("remarks","Remarks, implants, special equipment",{rows:2})+'<div class="acts"><button class="btn p" id="sb">Book</button></div></div></div>':"")+
 panel("Surgeries",["Date","Procedure","Surgeon","Status",""],IPD.surgeries.map(r=>'<tr><td>'+dt(r.date)+' '+esc(r.ot?.time||r.fields.time||"")+'</td><td>'+esc(r.fields.procedure)+'</td><td>'+esc(r.ot?.team?.surgeon||r.fields.surgeon||"")+'</td><td><span class="pill">'+esc(r.ot?.status||"scheduled")+'</span></td><td><button class="btn" onclick="location.hash=\\'ot-'+r.id+'\\'">Open OT record</button></td></tr>'),"No surgery booked")+'</div>';
 $("#sb")&&($("#sb").onclick=async()=>{const f=readForm($("#sf"));if(!f.procedure)return toast("Enter the procedure");try{await api("/api/hmis/request",{admissionId:a.id,type:"surgery",fields:f});toast("Surgery booked on the theatre list");ipChart(a.id,true)}catch(e){toast(e.message)}});
}
let IPT=null;
async function ipBill(){
 const a=IPD.admission,acc=IPD.account,open=a.status==="admitted",canEdit=open&&(isBill()||ME.role==="staff");
 if(canEdit&&!IPT){try{IPT=(await api("/api/tariff/list",{dept:"ip"})).tariff}catch{IPT=[]}}
 $("#pane").innerHTML='<div class="grid2" style="grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)">'+
 '<div class="panel"><h3>Inpatient bill '+(open?"(running)":"(final)")+'</h3><table><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>'+acc.lines.map(l=>'<tr><td>'+esc(l.desc)+'</td><td>'+esc(l.qty)+'</td><td>'+inr(l.rate)+'</td><td>'+inr(l.amount)+'</td></tr>').join("")+
 '<tr><td colspan="3"><b>Total</b></td><td><b>'+inr(acc.total)+'</b></td></tr><tr><td colspan="3">Advance received</td><td style="color:var(--green)">'+inr(acc.advance)+'</td></tr><tr><td colspan="3"><b>'+(acc.due>=0?"Balance":"Refund")+'</b></td><td style="color:var(--red)"><b>'+inr(Math.abs(acc.due))+'</b></td></tr></tbody></table>'+
 (IPD.finalBill?'<div class="pb"><button class="btn p" id="fb">View final bill '+esc(IPD.finalBill.no)+'</button></div>':"")+'</div><div style="display:grid;gap:12px;align-content:start">'+
 (canEdit?'<div class="panel"><h3>Add charge</h3><div class="pb" id="cf"><div class="cks">'+(IPT||[]).filter(t=>t.unit!=="per day"||/nursing|oxygen/i.test(t.name)).map(t=>'<button class="chip" data-c="'+esc(t.name)+'" data-r="'+t.price+'">'+esc(t.name)+'</button>').join("")+'</div><div class="fr">'+fld("desc","Charge for")+fld("qty","Qty / days",{v:"1"})+fld("rate","Rate ₹")+'</div><div class="acts"><button class="btn p" id="ca">Add</button></div></div></div>':"")+
 (open&&isBill()?'<div class="panel"><h3>Advance</h3><div class="pb" id="af"><div class="fr">'+fld("amount","Amount ₹")+fld("mode","Mode",{opts:["Cash","UPI","Card","Insurance"]})+'</div><div class="acts"><button class="btn p" id="aa">Save advance</button></div></div></div>'+
 '<div class="panel"><h3>Discharge and final bill</h3><div class="pb" id="xf"><div class="fr">'+fld("discount","Discount ₹",{v:"0"})+fld("amount","Received now ₹",{v:String(Math.max(0,Math.round(acc.due)))})+fld("mode","Mode",{opts:["Cash","UPI","Card","Insurance"]})+'</div><div class="acts"><button class="btn p" id="xd">Discharge & make final bill</button></div></div></div>':"")+
 panel("Department bills on this account",["Bill","Department","Amount"],IPD.deptBills.map(b=>'<tr><td>'+esc(b.no)+'</td><td>'+esc(b.deptName)+'</td><td>'+inr(b.total)+'</td></tr>'),"None")+'</div></div>';
 $$("[data-c]").forEach(b=>b.onclick=()=>{$('#cf input[name=desc]').value=b.dataset.c;$('#cf input[name=rate]').value=b.dataset.r});
 const up=async(body,msg)=>{try{await api("/api/ip/update",Object.assign({id:a.id},body));toast(msg);ipChart(a.id,true)}catch(e){toast(e.message)}};
 $("#ca")&&($("#ca").onclick=()=>{const f=readForm($("#cf"));if(!f.desc)return toast("Enter the charge");up({charge:{desc:f.desc,qty:+f.qty||1,rate:+f.rate||0}},"Charge added")});
 $("#aa")&&($("#aa").onclick=()=>{const f=readForm($("#af"));if(!(+f.amount>0))return toast("Enter the amount");up({deposit:{amount:+f.amount,mode:f.mode}},"Advance saved")});
 $("#xd")&&($("#xd").onclick=async()=>{const f=readForm($("#xf"));try{const r=await api("/api/ip/discharge",{id:a.id,discount:+f.discount||0,pay:+f.amount>0?{amount:+f.amount,mode:f.mode}:undefined});toast("Discharged · final bill "+r.bill.no);ipChart(a.id,true)}catch(e){toast(e.message)}});
 $("#fb")&&($("#fb").onclick=()=>{const b=IPD.finalBill;modal('<div class="rep"><h2>Inpatient final bill '+esc(b.no)+'</h2><p>'+esc(b.patient.name)+' · '+esc(b.patient.id)+' · '+esc(a.no)+' · '+tm(b.admittedAt)+' to '+tm(b.dischargedAt)+'</p><table><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>'+b.items.map(i=>'<tr><td>'+esc(i.desc)+'</td><td>'+i.qty+'</td><td>'+inr(i.rate)+'</td><td>'+inr(i.amount)+'</td></tr>').join("")+'<tr><td colspan="3">Discount</td><td>'+inr(b.discount)+'</td></tr><tr><td colspan="3"><b>Total</b></td><td><b>'+inr(b.total)+'</b></td></tr>'+b.payments.map(p=>'<tr><td colspan="3">Paid · '+esc(p.mode)+'</td><td>'+inr(p.amount)+'</td></tr>').join("")+'<tr><td colspan="3"><b>'+(b.balance>=0?"Balance":"Refund")+'</b></td><td><b>'+inr(Math.abs(b.balance))+'</b></td></tr></tbody></table></div>')});
}
const DIS=[["Final diagnosis",2],["Presenting complaints",2],["Course in hospital",5],["Procedures done",2],["Key investigations",3],["Condition at discharge",1],["Medicines on discharge",4],["Advice",3],["Review",1]];
function ipDischarge(){
 const a=IPD.admission,ds=a.dischargeSummary?.fields||{};
 $("#pane").innerHTML='<div class="panel"><h3>Discharge summary '+(a.dischargeSummary?'<small>Saved '+tm(a.dischargeSummary.at)+' by '+esc(a.dischargeSummary.by)+(a.dischargeSummary.final?" · final":" · draft")+'</small>':"")+'</h3><div class="pb" id="ds">'+
 DIS.map(([k,r])=>fld(k,k,{rows:r,v:ds[k]||(k==="Final diagnosis"?a.reason:"")})).join("")+
 '<div class="acts">'+(isDoc()?'<button class="btn" id="ad">Draft with AI</button><button class="btn" id="sd">Save draft</button><button class="btn p" id="sf">Save final</button>':"")+'<button class="btn" id="pd">Print</button></div></div></div>';
 if(isDoc()){
  $("#sd").onclick=()=>ipRec("discharge",{fields:readForm($("#ds")),final:false});$("#sf").onclick=()=>ipRec("discharge",{fields:readForm($("#ds")),final:true});
  $("#ad").onclick=async()=>{$("#ad").disabled=true;$("#ad").textContent="Writing…";
   try{const j=await aiJson("Write a discharge summary for an Indian hospital from this record. Use only facts given; write 'not recorded' where missing. Plain clinical English, no markdown.\\n"+ipCase()+'\\nReply with ONLY JSON whose keys are exactly: '+JSON.stringify(DIS.map(d=>d[0]))+' and values are strings.');
    DIS.forEach(([k])=>{const t=$('#ds textarea[name="'+k+'"]');if(j[k]&&!t.value.trim())t.value=j[k]});toast("Draft filled in. Please check every section.")}catch(e){toast(e.message)}
   $("#ad").disabled=false;$("#ad").textContent="Draft with AI"}}
 $("#pd").onclick=()=>{const f=readForm($("#ds")),p=IPD.patient||{};modal('<div class="rep"><h2>Discharge summary</h2><p><b>'+esc(p.name)+'</b> · '+esc(p.id||"")+' · '+esc([p.age?p.age+"Y":"",p.sex].filter(Boolean).join(" / "))+'<br>'+esc(a.no)+' · '+esc(a.ward)+' · admitted '+tm(a.admittedAt)+(a.dischargedAt?' · discharged '+tm(a.dischargedAt):"")+' · '+esc(a.doctor||"")+'</p>'+DIS.filter(([k])=>f[k]).map(([k])=>'<h4 style="margin:10px 0 2px">'+esc(k)+'</h4><div style="white-space:pre-wrap">'+esc(f[k])+'</div>').join("")+'<p style="text-align:right;margin-top:30px">'+esc(a.doctor||ME.name||"")+'</p></div>')};
}

// ---------- operation theatre ----------
let OTF=today();
async function otList(){
 let d;try{d=await api("/api/ot/list",{from:OTF,to:new Date(new Date(OTF+"T00:00:00Z").getTime()+6*864e5).toISOString().slice(0,10)})}catch(e){$("#app").innerHTML='<div class="empty">'+esc(e.message)+'</div>';return}
 if(!ME.name){try{const m=await api("/api/me");ME={name:m.user?.name,role:m.role};$("#me").textContent=ME.name||"";$("#role").textContent=ROLE[ME.role]||ME.role}catch{}}
 const S=d.surgeries,st=(r)=>r.ot?.status||(r.status==="done"?"done":r.status==="cancelled"?"cancelled":"scheduled");
 const pill=(x)=>'<span class="pill '+({done:"grn","in-theatre":"red",cancelled:"gry",postponed:"amb"}[x]||"")+'">'+esc({"in-theatre":"In theatre"}[x]||x)+'</span>';
 const days={};S.forEach(r=>(days[r.date]=days[r.date]||[]).push(r));
 $("#app").innerHTML='<div class="bar2"><button class="btn" onclick="location.hash=\\'\\'">‹ Dashboard</button><h1>Operation theatre list</h1><div class="sp"></div>From <input type="date" id="of" class="chip" value="'+OTF+'"> · 7 days</div>'+
 '<div class="tiles" style="grid-template-columns:repeat(4,minmax(0,1fr))">'+[["Scheduled","scheduled","t1"],["In theatre","in-theatre","t5"],["Done","done","t3"],["Cancelled / postponed","x","t2"]].map(([l,k,c])=>'<div class="tile" style="background:var(--'+c+')">'+ic("sx","var(--"+c+"i)")+'<b>'+S.filter(r=>k==="x"?["cancelled","postponed"].includes(st(r)):st(r)===k).length+'</b><span class="n">'+l+'</span></div>').join("")+'</div>'+
 (Object.keys(days).length?Object.keys(days).sort().map(dd=>'<h3 style="margin:14px 0 6px;font-size:14px">'+dt(dd)+'</h3><div class="tbl-wrap"><table><thead><tr><th>Time</th><th>Theatre</th><th>Patient</th><th>Procedure</th><th>Surgeon</th><th>Anaesthesia</th><th>Urgency</th><th>Status</th></tr></thead><tbody>'+
  days[dd].map(r=>'<tr class="r" data-id="'+r.id+'"><td>'+esc(r.ot?.time||r.fields.time||"–")+'</td><td>'+esc(r.ot?.theatre||"–")+'</td><td class="pn"><b>'+esc(r.patient.name)+'</b><small>'+esc(r.patient.id)+(r.admissionNo?" · "+esc(r.admissionNo):"")+'</small></td><td>'+esc(r.fields.procedure)+'</td><td>'+esc(r.ot?.team?.surgeon||r.fields.surgeon||"")+'</td><td>'+esc(r.fields.anaesthesia||"")+'</td><td>'+(r.fields.urgency==="Emergency"?'<span class="pill red">Emergency</span>':esc(r.fields.urgency||""))+'</td><td>'+pill(st(r))+'</td></tr>').join("")+'</tbody></table></div>').join(""):'<div class="empty">No surgeries in these 7 days. Book one from a patient chart (Requests → Surgery, or Surgery in the inpatient chart).</div>');
 $("#of").onchange=(e)=>{OTF=e.target.value;otList()};$$("tr[data-id]").forEach(t=>t.onclick=()=>location.hash="ot-"+t.dataset.id);
}
let OT=null,OTAB="sched";
async function otRecord(id,keep){
 try{OT=await api("/api/ot/get",{id})}catch(e){$("#app").innerHTML='<div class="empty">'+esc(e.message)+'</div>';return}
 if(!ME.name){try{const m=await api("/api/me");ME={name:m.user?.name,role:m.role};$("#me").textContent=ME.name||"";$("#role").textContent=ROLE[ME.role]||ME.role}catch{}}
 if(!keep)OTAB="sched";drawOt();
}
async function otSave(b,msg){try{await api("/api/ot/update",Object.assign({id:OT.surgery.id},b));toast(msg||"Saved");otRecord(OT.surgery.id,true)}catch(e){toast(e.message)}}
const PREOP=[["consent","Consent signed"],["highrisk","High-risk consent (if needed)"],["nbm","Nil by mouth confirmed"],["site","Operation site marked"],["pac","Pre-anaesthetic check: fit"],["inv","Investigations reviewed"],["blood","Blood arranged / cross-matched"],["abx","Antibiotic prophylaxis given"],["jewel","Jewellery, dentures, nail polish removed"],["bladder","Bladder emptied / catheter"],["prep","Part prepared"],["iv","IV line secured"]];
const WHO={signin:["Sign in (before anaesthesia)",[["id","Patient identity, site, procedure and consent confirmed"],["mark","Site marked"],["machine","Anaesthesia machine and medicines checked"],["oxi","Pulse oximeter on and working"],["allergy","Known allergy checked"],["airway","Difficult airway / aspiration risk assessed"],["bloodloss","Risk of >500 ml blood loss assessed"]]],
 timeout:["Time out (before skin incision)",[["team","Team introduced by name and role"],["confirm","Patient, site and procedure confirmed"],["abx","Antibiotic given within the last 60 minutes"],["critical","Anticipated critical events reviewed"],["imaging","Essential imaging displayed"],["sterile","Sterility confirmed, equipment ready"]]],
 signout:["Sign out (before the patient leaves theatre)",[["recorded","Name of the procedure recorded"],["counts","Instrument, sponge and needle counts correct"],["specimen","Specimen labelled"],["equipment","Equipment problems addressed"],["recovery","Key concerns for recovery reviewed"]]]};
const OPN=[["procedure","Procedure performed",1],["indication","Indication",1],["incision","Position and incision",1],["findings","Operative findings",4],["steps","Procedure steps",6],["implants","Implants / mesh / prosthesis",1],["ebl","Estimated blood loss",1],["drains","Drains",1],["specimen","Specimens sent (HPE / culture)",1],["closure","Closure",1],["complications","Complications",1]];
const POSTOP=[["shift","Shift to",["Ward","ICU","HDU","Recovery then ward"]],["position","Position",["Propped up 30°","Supine","Lateral","As comfortable"]],["nbm","Nil by mouth until",null],["fluids","IV fluids",null],["abx","Antibiotics",null],["analgesia","Analgesia",null],["monitor","Monitoring",["Pulse, BP, SpO₂ every 15 min × 1 h, then hourly","Hourly for 6 h, then 4-hourly","4-hourly"]],["drain","Drain / catheter care",null],["mobil","Mobilisation",null],["diet","Diet plan",null],["inv","Investigations",null],["special","Special instructions",null]];
function drawOt(){
 const r=OT.surgery,o=r.ot||{},st=o.status||"scheduled",p=r.patient;
 const tabs=[["sched","Schedule & team"],["preop","Pre-op checklist"],["who","WHO safety checklist"],["opn","Operation notes"],["post","Post-op orders"],["obs","Post-op monitoring"],["chg","OT charges"]];
 $("#app").innerHTML='<div class="bar2"><button class="btn" onclick="location.hash=\\'ot\\'">‹ Theatre list</button><h1>'+esc(r.fields.procedure||"Surgery")+'</h1><div class="sp"></div>'+
 [["scheduled","Scheduled"],["in-theatre","In theatre"],["done","Done"],["postponed","Postpone"],["cancelled","Cancel"]].map(([k,l])=>'<button class="chip'+(st===k?" on":"")+'" data-st="'+k+'">'+l+'</button>').join(" ")+'</div>'+
 '<div class="panel" style="margin-bottom:10px"><div class="pb" style="display:flex;flex-wrap:wrap;gap:6px 22px"><span><b>'+esc(p.name)+'</b> · '+esc(p.id)+' · '+esc([p.age?p.age+"Y":"",p.sex].filter(Boolean).join(" / "))+'</span><span>'+dt(r.date)+' '+esc(o.time||r.fields.time||"")+(o.theatre?" · "+esc(o.theatre):"")+'</span><span>Surgeon: '+esc(o.team?.surgeon||r.fields.surgeon||"")+'</span><span>'+esc(r.fields.anaesthesia||"")+' · '+esc(r.fields.urgency||"")+'</span>'+
 (OT.admission?'<span><a href="#ip-'+esc(OT.admission.id)+'">'+esc(OT.admission.no)+'</a> · '+esc(OT.admission.ward+" "+OT.admission.bed)+'</span>':'<span class="pill amb">Not admitted</span>')+(OT.allergy?'<span class="pill red">Allergy: '+esc(OT.allergy)+'</span>':"")+'</div></div>'+
 '<div class="tabs">'+tabs.map(([k,l])=>'<button data-t="'+k+'" class="'+(OTAB===k?"on":"")+'">'+l+'</button>').join("")+'</div><div id="pane"></div>';
 $$("[data-st]").forEach(b=>b.onclick=()=>otSave({status:b.dataset.st},"Status updated"));
 $$(".tabs button").forEach(b=>b.onclick=()=>{OTAB=b.dataset.t;drawOt()});
 const pane=$("#pane"),by=(x)=>x?'<div class="m" style="color:var(--muted);font-size:12px">Last saved '+tm(x.at)+' by '+esc(x.by)+'</div>':"";
 if(OTAB==="sched"){const t=o.team||{};pane.innerHTML='<div class="panel"><div class="pb" id="f"><div class="fr">'+fld("date","Date",{type:"date",v:r.date})+fld("time","Time",{type:"time",v:o.time||r.fields.time||""})+fld("theatre","Theatre",{opts:["OT 1","OT 2","OT 3","Minor OT","Labour OT","Cath lab"],v:o.theatre})+'</div><div class="fr">'+fld("surgeon","Surgeon",{v:t.surgeon||r.fields.surgeon})+fld("assistant","Assistant")+fld("anaesthetist","Anaesthetist",{v:t.anaesthetist||r.fields.anaesthetist})+fld("scrub","Scrub nurse",{v:t.scrub})+fld("circulating","Circulating nurse",{v:t.circulating})+'</div><div class="acts"><button class="btn p" id="sv">Save schedule</button></div></div></div>';
  if(t.assistant)$('#f input[name=assistant]').value=t.assistant;
  $("#sv").onclick=()=>{const f=readForm($("#f"));otSave({schedule:{date:f.date,time:f.time,theatre:f.theatre,team:{surgeon:f.surgeon,assistant:f.assistant,anaesthetist:f.anaesthetist,scrub:f.scrub,circulating:f.circulating}}},"Schedule saved")}}
 else if(OTAB==="preop"){const v=o.preop||{};pane.innerHTML='<div class="panel"><div class="pb" id="f">'+ckl("c",PREOP,v.c?JSON.parse(v.c):{})+'<div class="fr">'+fld("nbmFrom","Nil by mouth since",{v:v.nbmFrom,ph:"10 pm"})+fld("bloodUnits","Blood units reserved",{v:v.bloodUnits})+fld("asa","ASA grade",{opts:["","I","II","III","IV","V","E"],v:v.asa})+'</div>'+fld("notes","Notes",{rows:2,v:v.notes})+by(v)+'<div class="acts"><button class="btn p" id="sv">Save checklist</button></div></div></div>';
  $("#sv").onclick=()=>{const f=readForm($("#f"));const c=f.c||{};delete f.c;f.c=JSON.stringify(c);otSave({preop:f},"Checklist saved")}}
 else if(OTAB==="who"){const v=o.who||{};pane.innerHTML='<div class="grid2" style="grid-template-columns:repeat(3,minmax(0,1fr))">'+Object.entries(WHO).map(([k,[t,items]])=>'<div class="panel"><h3>'+t+'</h3><div class="pb" data-w="'+k+'">'+ckl(k,items,v[k]?JSON.parse(v[k]):{})+'</div></div>').join("")+'</div>'+by(o.who)+'<div class="acts" style="margin-top:10px"><button class="btn p" id="sv">Save WHO checklist</button></div>';
  $("#sv").onclick=()=>{const w={};Object.keys(WHO).forEach(k=>w[k]=JSON.stringify(readForm($('[data-w="'+k+'"]'))[k]||{}));otSave({who:w},"WHO checklist saved")}}
 else if(OTAB==="opn"){const v=o.opnote||{};pane.innerHTML='<div class="panel"><div class="pb" id="f"><div class="fr">'+fld("start","Start time",{type:"time",v:v.start})+fld("end","End time",{type:"time",v:v.end})+fld("anaesthesia","Anaesthesia",{v:v.anaesthesia||r.fields.anaesthesia})+'</div>'+OPN.map(([k,l,rw])=>fld(k,l,{rows:rw,v:v[k]||(k==="procedure"?r.fields.procedure:"")})).join("")+by(o.opnote)+
  '<div class="acts">'+(isDoc()?'<button class="btn" id="ai">Draft steps with AI</button><button class="btn p" id="sv">Save operation notes</button>':"")+'<button class="btn" id="pr">Print</button></div></div></div>';
  if(isDoc()){$("#sv").onclick=()=>otSave({opnote:readForm($("#f"))},"Operation notes saved");
   $("#ai").onclick=async()=>{const f=readForm($("#f"));$("#ai").disabled=true;try{const j=await aiJson("Draft the standard operative steps for: "+f.procedure+". Findings noted by the surgeon: "+(f.findings||"none yet")+". Anaesthesia: "+f.anaesthesia+". Write numbered steps as one string, in the style of an Indian operation theatre register. The surgeon will edit. Reply ONLY JSON {\\"steps\\":\\"\\",\\"closure\\":\\"\\",\\"specimen\\":\\"\\"}");
    [["steps",j.steps],["closure",j.closure],["specimen",j.specimen]].forEach(([k,x])=>{const t=$('#f textarea[name="'+k+'"]');if(x&&!t.value.trim())t.value=x});toast("Draft filled in. Edit to match what was done.")}catch(e){toast(e.message)}$("#ai").disabled=false}}
  $("#pr").onclick=()=>{const f=readForm($("#f"));modal('<div class="rep"><h2>Operation notes</h2><p><b>'+esc(p.name)+'</b> · '+esc(p.id)+' · '+dt(r.date)+' · '+esc(f.start||"")+'–'+esc(f.end||"")+'<br>Surgeon: '+esc(o.team?.surgeon||r.fields.surgeon||"")+(o.team?.assistant?" · Assistant: "+esc(o.team.assistant):"")+' · Anaesthetist: '+esc(o.team?.anaesthetist||r.fields.anaesthetist||"")+' · '+esc(f.anaesthesia)+'</p>'+OPN.filter(([k])=>f[k]).map(([k,l])=>'<h4 style="margin:10px 0 2px">'+l+'</h4><div style="white-space:pre-wrap">'+esc(f[k])+'</div>').join("")+'<p style="text-align:right;margin-top:30px">'+esc(o.team?.surgeon||r.fields.surgeon||"")+'</p></div>')}}
 else if(OTAB==="post"){const v=o.postop||{};pane.innerHTML='<div class="panel"><div class="pb" id="f"><div class="fr">'+POSTOP.map(([k,l,opts])=>opts?fld(k,l,{opts:[""].concat(opts),v:v[k]}):fld(k,l,{v:v[k]})).join("")+'</div>'+by(o.postop)+(isDoc()?'<div class="acts"><button class="btn p" id="sv">Save post-op orders</button></div>':"")+'</div></div>';
  $("#sv")&&($("#sv").onclick=()=>otSave({postop:readForm($("#f"))},"Post-op orders saved"))}
 else if(OTAB==="obs"){const L=(o.obs||[]).slice().reverse();pane.innerHTML='<div class="grid2" style="grid-template-columns:minmax(0,.8fr) minmax(0,1.5fr)"><div class="panel"><h3>Record observation</h3><div class="pb" id="f"><div class="fr">'+[["pulse","Pulse"],["bp","BP"],["spo2","SpO₂ %"],["rr","Resp. rate"],["pain","Pain 0–10"],["sedation","Sedation score"],["drain","Drain output ml"],["urine","Urine output ml"]].map(([k,l])=>fld(k,l)).join("")+'</div>'+fld("note","Note")+'<div class="acts"><button class="btn p" id="sv">Save</button></div></div></div>'+
  panel("Observations",["Time","Pulse","BP","SpO₂","RR","Pain","Drain","Urine","Note","By"],L.map(x=>'<tr><td>'+tm(x.at)+'</td>'+["pulse","bp","spo2","rr","pain","drain","urine","note"].map(k=>'<td style="'+(hi(k,x[k])?"color:var(--red);font-weight:700":"")+'">'+esc(x[k]||"")+'</td>').join("")+'<td>'+esc(x.by)+'</td></tr>'),"No observations yet")+'</div>';
  $("#sv").onclick=()=>{const f=readForm($("#f"));if(!Object.values(f).some(Boolean))return toast("Enter at least one value");otSave({obs:f},"Observation saved")}}
 else{const T=OT.tariff||[],pick=(n)=>T.find(t=>t.name.toLowerCase()===n.toLowerCase());
  const rows=o.charged?[]:[["OT charges",1],["Surgeon fee",1],["Anaesthetist fee",1],["Consumables",1]].map(([n,q])=>({desc:n,qty:q,rate:pick(n)?.price||0}));
  pane.innerHTML=o.charged?'<div class="panel"><div class="pb">OT charges of <b>'+inr(o.charged.total)+'</b> were added to the inpatient bill on '+tm(o.charged.at)+' by '+esc(o.charged.by)+'.</div></div>':
  '<div class="panel"><h3>Charges for this surgery <small>Added to the inpatient bill</small></h3><div class="pb"><table class="rx"><thead><tr><th>Item</th><th>Qty</th><th>Rate ₹</th><th></th></tr></thead><tbody id="cb">'+rows.map(c=>'<tr><td><input data-k="desc" value="'+esc(c.desc)+'"></td><td><input data-k="qty" value="'+c.qty+'"></td><td><input data-k="rate" value="'+c.rate+'"></td><td><button class="btn d" data-x>✕</button></td></tr>').join("")+'</tbody></table><div><button class="btn" id="ad">+ Implant or other item</button></div>'+
  (OT.admission?'':'<div class="pill amb">Admit the patient first: OT charges go on the inpatient bill.</div>')+'<div class="acts"><button class="btn p" id="sv"'+(OT.admission?"":" disabled")+'>Add to inpatient bill</button></div></div></div>';
  const bind=()=>$$("[data-x]").forEach(b=>b.onclick=()=>b.closest("tr").remove());bind();
  $("#ad")&&($("#ad").onclick=()=>{$("#cb").insertAdjacentHTML("beforeend",'<tr><td><input data-k="desc" placeholder="e.g. Mesh 15×15 cm"></td><td><input data-k="qty" value="1"></td><td><input data-k="rate"></td><td><button class="btn d" data-x>✕</button></td></tr>');bind()});
  $("#sv")&&($("#sv").onclick=()=>{const c=$$("#cb tr").map(tr=>{const x={};$$("[data-k]",tr).forEach(i=>x[i.dataset.k]=i.value);return {desc:x.desc,qty:+x.qty||1,rate:+x.rate||0}}).filter(x=>x.desc&&x.rate>0);if(!c.length)return toast("Enter at least one charge with a rate");otSave({charges:c},"Charges added to the inpatient bill")})}
}

// ================= menu, notifications, modules =================
let PLANF=null;
const has=(f)=>!PLANF||PLANF[f]!==false;
const MENU=[["","Dashboard",["doctor","staff","billing"],null],["beds","Beds",["doctor","staff","billing"],"ip"],["ot","Theatre",["doctor","staff","billing"],"ot"],["followups","Follow-ups",["doctor","staff","billing"],null],
 ["pharmacy","Pharmacy",["pharmacy"],null],["lab","Lab & scans",["lab","diagnostics"],null],["insurance","Insurance",["billing"],"insurance"],["homecare","Home care",["doctor","staff","billing"],"homecare"],
 ["camps","Camps",["doctor","staff","billing"],"mobileunit"],["accounts","Accounts",["billing"],"reports"],["messages","Messages",["doctor","staff","billing"],"chat"]];
const canSee=(roles)=>ME.role==="admin"||roles.includes(ME.role);
async function ensureMe(){
 if(!ME.role){const m=await api("/api/me");ME={name:m.user?.name,role:m.role,branch:m.user?.branch||""};$("#me").textContent=ME.name||"";$("#role").textContent=ROLE[ME.role]||ME.role}
 if(!PLANF){try{PLANF=(await api("/api/plan")).plan.features}catch{PLANF={}}}
 drawMenu();
}
function drawMenu(){
 let nav=$("#nav");if(!nav){nav=document.createElement("nav");nav.id="nav";nav.className="nav";$(".top").after(nav)}
 const cur=(location.hash.replace("#","").split("-")[0])||"";
 nav.innerHTML=MENU.filter(([,,r,f])=>canSee(r)&&(!f||has(f))).map(([h,l])=>'<a href="#'+h+'" class="'+(cur===h||(h===""&&["v","ip"].includes(cur))||(h==="ot"&&cur==="ot")?"on":"")+'">'+l+'</a>').join("")+'<span class="sp"></span><button id="bell" title="Notifications">🔔<b id="bn"></b></button>';
 $("#bell").onclick=showBell;bellCount();
}
async function bellCount(){try{const r=await api("/api/notify/list");$("#bn").textContent=r.unread||"";$("#bn").style.display=r.unread?"inline-block":"none";window._notes=r.items}catch{}}
setInterval(()=>{if(document.visibilityState==="visible"&&ME.role)bellCount()},60000);
function showBell(){const items=window._notes||[];const m=document.createElement("div");m.className="modal";
 m.innerHTML='<div><h3 style="margin-top:0">Notifications</h3>'+(items.length?items.map(n=>'<div class="note" style="margin-bottom:6px;cursor:pointer;'+(n.read?"opacity:.6":"")+'" data-l="'+esc(n.link)+'"><h5>'+esc(n.title)+'</h5><div>'+esc(n.body)+'</div><div class="m">'+tm(n.at)+'</div></div>').join(""):'<div class="empty">Nothing new.</div>')+'<div class="acts"><button class="btn p" id="nc">Close</button></div></div>';
 document.body.appendChild(m);$("#nc",m).onclick=()=>m.remove();
 $$("[data-l]",m).forEach(d=>d.onclick=()=>{m.remove();if(d.dataset.l)location.hash=d.dataset.l});
 const ids=items.filter(n=>!n.read).map(n=>n.id);if(ids.length)api("/api/notify/read",{ids}).then(bellCount).catch(()=>{});}
const shell=(title,tabs,cur,cb)=>'<div class="bar2"><h1>'+esc(title)+'</h1><div class="sp"></div></div>'+(tabs?'<div class="sub">'+tabs.map(([k,l])=>'<button data-tb="'+k+'" class="'+(cur===k?"on":"")+'">'+l+'</button>').join("")+'</div>':"")+'<div id="mb"></div>';
function bindTabs(set){$$("[data-tb]").forEach(b=>b.onclick=()=>set(b.dataset.tb))}
const tiles=(arr)=>'<div class="tiles" style="grid-template-columns:repeat('+Math.min(arr.length,5)+',minmax(0,1fr))">'+arr.map(([l,v,c,s])=>'<div class="tile" style="background:var(--'+(c||"t4")+');cursor:default"><b style="grid-column:1/-1">'+esc(v)+'</b><span class="n" style="grid-column:1/-1">'+esc(l)+'</span>'+(s?'<div class="s">'+esc(s)+'</div>':"")+'</div>').join("")+'</div>';
const bars=(rows,max)=>'<div style="display:grid;gap:6px">'+rows.map(([l,v,t])=>'<div style="display:grid;grid-template-columns:120px 1fr 110px;gap:8px;align-items:center;font-size:12.5px"><span>'+esc(l)+'</span><span style="background:#e4ecee;border-radius:4px;height:12px;overflow:hidden"><i style="display:block;height:100%;background:var(--accent);width:'+(max?Math.round(v/max*100):0)+'%"></i></span><b style="text-align:right">'+esc(t??v)+'</b></div>').join("")+'</div>';
async function findPatient(q){const r=await api("/api/patients/search",{q});if(!r.patients.length)throw new Error("No patient found");return r.patients[0]}
async function waSend(phone,text){if(!phone)return toast("No mobile number");try{const r=await api("/api/wa/send",{phone,text});if(r.sent)toast("WhatsApp message sent");else window.open(r.link,"_blank")}catch(e){toast(e.message)}}

// ---------- pharmacy ----------
let PTAB="alerts";
async function pagePharmacy(){
 $("#app").innerHTML=shell("Pharmacy",[["alerts","Alerts"],["purchase","Purchases"],["stock","Stock"]],PTAB);bindTabs(t=>{PTAB=t;pagePharmacy()});const mb=$("#mb");
 if(PTAB==="alerts"){const a=await api("/api/pharmacy/alerts");
  mb.innerHTML=tiles([["Low stock",a.low.length,"t2"],["Expiring in 90 days",a.expiring.length,"t5"],["Expired",a.expired.length,"t5"],["Items in stock list",a.stock,"t3"]])+'<div class="grid2">'+
  panel("Low stock (at or below reorder level)",["Item","Stock","Reorder at","Type"],a.low.map(x=>'<tr><td>'+esc(x.name)+'</td><td style="color:var(--red);font-weight:700">'+x.stock+'</td><td>'+x.reorder+'</td><td>'+esc(x.category)+'</td></tr>'),"All items are above their reorder level")+
  panel("Expiring soon",["Item","Batch","Expiry","Qty"],a.expiring.map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+esc(x.batch)+'</td><td style="color:var(--amber);font-weight:600">'+esc(x.expiry)+'</td><td>'+x.qty+'</td></tr>'),"Nothing expires in the next 90 days")+
  panel("Expired: remove from shelves",["Item","Batch","Expiry","Qty"],a.expired.map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+esc(x.batch)+'</td><td style="color:var(--red);font-weight:700">'+esc(x.expiry)+'</td><td>'+x.qty+'</td></tr>'),"No expired stock")+'</div>'}
 else if(PTAB==="purchase"){let sup=[];try{sup=(await api("/api/rec/list",{coll:"suppliers"})).items}catch{}const pu=(await api("/api/pharmacy/purchases")).purchases;
  const row='<tr><td><select data-k="category"><option value="drug">Drug</option><option value="non-drug">Non-drug</option></select></td><td><input data-k="generic" placeholder="Generic / item"></td><td><input data-k="strength"></td><td><input data-k="form" value="Tab"></td><td><input data-k="brand"></td><td><input data-k="batch"></td><td><input data-k="expiry" type="month"></td><td><input data-k="qty" inputmode="numeric"></td><td><input data-k="cost" inputmode="decimal"></td><td><input data-k="mrp" inputmode="decimal"></td><td><button class="btn d" data-x>✕</button></td></tr>';
  mb.innerHTML='<div class="panel" style="margin-bottom:12px"><h3>New purchase (stock in)</h3><div class="pb" id="pf"><div class="fr">'+fld("supplier","Supplier",{list:"sups"})+fld("invoice","Invoice no")+fld("date","Invoice date",{type:"date",v:today()})+fld("paid","Paid?",{opts:["Not paid","Paid"]})+'</div><datalist id="sups">'+sup.map(x=>'<option value="'+esc(x.name)+'">').join("")+'</datalist>'+
  '<div style="overflow:auto"><table class="rx" style="min-width:1100px"><thead><tr><th>Type</th><th>Item</th><th>Strength</th><th>Form</th><th>Brand</th><th>Batch</th><th>Expiry</th><th>Qty</th><th>Cost/unit</th><th>MRP/unit</th><th></th></tr></thead><tbody id="pb">'+row+row+'</tbody></table></div><div><button class="btn" id="pa">+ Row</button></div><div class="acts"><button class="btn p" id="ps">Save purchase and add to stock</button></div></div></div>'+
  '<div class="grid2" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)">'+panel("Purchases",["No","Date","Supplier","Invoice","Items","Total"],pu.map(x=>'<tr><td>'+esc(x.no)+'</td><td>'+dt(x.date)+'</td><td>'+esc(x.supplier)+'</td><td>'+esc(x.invoice)+'</td><td>'+x.lines.length+'</td><td>'+inr(x.total)+(x.paid?"":' <span class="pill amb">Unpaid</span>')+'</td></tr>'),"No purchases yet")+
  '<div class="panel"><h3>Suppliers</h3><div class="pb" id="sf"><div class="fr">'+fld("name","Name")+fld("phone","Phone")+fld("gstin","GSTIN")+'</div><div class="acts"><button class="btn p" id="ss">Add supplier</button></div>'+sup.map(x=>'<div>'+esc(x.name)+' · '+esc(x.phone||"")+' '+esc(x.gstin||"")+'</div>').join("")+'</div></div></div>';
  const bindX=()=>$$("[data-x]").forEach(b=>b.onclick=()=>b.closest("tr").remove());bindX();
  $("#pa").onclick=()=>{$("#pb").insertAdjacentHTML("beforeend",row);bindX()};
  $("#ps").onclick=async()=>{const f=readForm($("#pf"));const items=$$("#pb tr").map(tr=>{const o={};$$("[data-k]",tr).forEach(x=>o[x.dataset.k]=x.value.trim());return o}).filter(x=>x.generic&&+x.qty>0);
   if(!items.length)return toast("Enter at least one item with quantity");try{const r=await api("/api/pharmacy/purchase",{supplier:f.supplier,invoice:f.invoice,date:f.date,paid:f.paid==="Paid",items});toast("Purchase "+r.purchase.no+" saved: "+r.purchase.lines.length+" items added to stock");pagePharmacy()}catch(e){toast(e.message)}};
  $("#ss").onclick=async()=>{const f=readForm($("#sf"));if(!f.name)return toast("Enter the supplier name");try{await api("/api/rec/save",{coll:"suppliers",item:f});pagePharmacy()}catch(e){toast(e.message)}}}
 else{const st=(await api("/api/pharmacy/stock")).stock;let q="",cat="all";
  const draw=()=>{const L=st.filter(s=>(cat==="all"||(s.category||"drug")===cat)&&(!q||(s.generic+" "+(s.brand||"")).toLowerCase().includes(q)));
   $("#sl").innerHTML='<table><thead><tr><th>Item</th><th>Type</th><th>Stock</th><th>Reorder at</th><th>MRP</th><th>Batches (expiry · qty)</th><th></th></tr></thead><tbody>'+L.map(s=>'<tr data-id="'+s.id+'"><td><b>'+esc([s.form,s.generic,s.strength].filter(Boolean).join(" "))+'</b><br><small>'+esc(s.brand||"")+'</small></td><td><select data-k="category"><option value="drug"'+((s.category||"drug")==="drug"?" selected":"")+'>Drug</option><option value="non-drug"'+(s.category==="non-drug"?" selected":"")+'>Non-drug</option></select></td><td><input data-k="stock" value="'+(s.stock||0)+'" style="width:70px"></td><td><input data-k="reorder" value="'+(s.reorder??10)+'" style="width:60px"></td><td><input data-k="price" value="'+(s.price||0)+'" style="width:70px"></td><td style="font-size:12px">'+(s.batches||[]).map(b=>esc((b.batch||"–")+" · "+(b.expiry||"–")+" · "+b.qty)).join("<br>")+'</td><td><button class="btn" data-sv>Save</button></td></tr>').join("")+'</tbody></table>';
   $$("[data-sv]").forEach(b=>b.onclick=async()=>{const tr=b.closest("tr"),s=st.find(x=>x.id===tr.dataset.id),o={};$$("[data-k]",tr).forEach(x=>o[x.dataset.k]=x.value);
    try{await api("/api/pharmacy/stock/save",{item:Object.assign({},s,{stock:+o.stock,reorder:+o.reorder,price:+o.price,category:o.category})});toast("Saved")}catch(e){toast(e.message)}})};
  mb.innerHTML='<div class="bar2"><input id="sq" class="chip" placeholder="Search"><button class="chip on" data-c="all">All</button><button class="chip" data-c="drug">Drugs</button><button class="chip" data-c="non-drug">Non-drug</button></div><div class="tbl-wrap" id="sl"></div>';
  $("#sq").oninput=(e)=>{q=e.target.value.toLowerCase();draw()};$$("[data-c]").forEach(b=>b.onclick=()=>{cat=b.dataset.c;$$("[data-c]").forEach(x=>x.classList.toggle("on",x===b));draw()});draw()}
}

// ---------- files ----------
function pickFile(){return new Promise(res=>{const i=document.createElement("input");i.type="file";i.accept="image/*,application/pdf";i.onchange=()=>res(i.files[0]);i.click()})}
async function toB64(file){
 if(file.type.startsWith("image/")){const img=await createImageBitmap(file);const s=Math.min(1,1600/Math.max(img.width,img.height));const c=document.createElement("canvas");c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);c.getContext("2d").drawImage(img,0,0,c.width,c.height);return {type:"image/jpeg",data:c.toDataURL("image/jpeg",.75).split(",")[1]}}
 if(file.size>850000)throw new Error("PDF is too large. Keep it under 850 KB.");
 const u=new Uint8Array(await file.arrayBuffer());let bin="";for(let i=0;i<u.length;i+=8192)bin+=String.fromCharCode(...u.subarray(i,i+8192));return {type:"application/pdf",data:btoa(bin)}}
async function uploadFor(meta){const f=await pickFile();if(!f)return false;try{const b=await toB64(f);await api("/api/files/upload",Object.assign({name:f.name,type:b.type,data:b.data},meta));toast("Uploaded");return true}catch(e){toast(e.message);return false}}
async function viewFile(id){try{const f=await api("/api/files/get",{id});const url="data:"+f.type+";base64,"+f.data;
 const m=document.createElement("div");m.className="modal";m.innerHTML='<div style="max-width:900px"><h3 style="margin-top:0">'+esc(f.name)+'</h3>'+(f.type==="application/pdf"?'<iframe src="'+url+'" style="width:100%;height:70vh;border:1px solid var(--line)"></iframe>':'<img src="'+url+'" style="max-width:100%">')+'<div class="acts"><a class="btn" download="'+esc(f.name)+'" href="'+url+'">Download</a><button class="btn p" id="fc">Close</button></div></div>';
 document.body.appendChild(m);$("#fc",m).onclick=()=>m.remove()}catch(e){toast(e.message)}}

// ---------- lab and diagnostics ----------
async function pageLab(){
 const kind=ME.role==="diagnostics"?"imaging":"lab";const o=(await api("/api/orders/list",{kind})).orders;
 $("#app").innerHTML=shell(ME.role==="diagnostics"?"Diagnostics":"Lab")+'';
 $("#mb").innerHTML='<div class="tbl-wrap"><table><thead><tr><th>Test</th><th>Patient</th><th>Ordered</th><th>Status</th><th>Files</th><th></th></tr></thead><tbody>'+(o.length?o.map(x=>'<tr data-id="'+x.id+'"><td><b>'+esc(x.test)+'</b><br><small>'+esc(x.modality||"Lab")+'</small></td><td>'+esc(x.patient?.name)+'<br><small>'+esc(x.patient?.id||"")+' · token '+esc(x.token)+'</small></td><td>'+tm(x.orderedAt)+'</td><td>'+(x.status==="reported"?'<span class="pill grn">Reported</span>':'<span class="pill amb">'+esc(x.status)+'</span>')+'</td><td>'+(x.files||[]).map((f,i)=>'<button class="btn" data-f="'+f+'">File '+(i+1)+'</button>').join(" ")+'</td><td style="white-space:nowrap"><button class="btn" data-up>Upload photo/PDF</button> '+(x.status!=="reported"?'<button class="btn p" data-rep>Enter report</button>':"")+'</td></tr>').join(""):'<tr><td colspan="6" class="empty">No orders.</td></tr>')+'</tbody></table></div>';
 $$("[data-f]").forEach(b=>b.onclick=()=>viewFile(b.dataset.f));
 $$("[data-up]").forEach(b=>b.onclick=async()=>{const x=o.find(y=>y.id===b.closest("tr").dataset.id);if(await uploadFor({orderId:x.id,patientId:x.patient?.id,visitId:x.visitId}))pageLab()});
 $$("[data-rep]").forEach(b=>b.onclick=()=>{const x=o.find(y=>y.id===b.closest("tr").dataset.id);const m=document.createElement("div");m.className="modal";
  m.innerHTML='<div><h3 style="margin-top:0">'+esc(x.test)+' · '+esc(x.patient?.name)+'</h3><div id="rf">'+fld("result",kind==="imaging"?"Findings":"Results (values with units and ranges)",{rows:8})+fld("impression",kind==="imaging"?"Impression":"Comment",{rows:2})+'</div><div class="acts"><button class="btn" id="rc">Cancel</button><button class="btn p" id="rs">Send report</button></div></div>';
  document.body.appendChild(m);$("#rc",m).onclick=()=>m.remove();$("#rs",m).onclick=async()=>{const f=readForm($("#rf",m));try{await api("/api/orders/update",{id:x.id,status:"reported",result:f.result,impression:f.impression});m.remove();toast("Report sent to the doctor");pageLab()}catch(e){toast(e.message)}}});
}

// ---------- accounts ----------
let ATAB="sales",AF={from:today().slice(0,8)+"01",to:today(),g:"day"};
const EXPCAT=["Salary","Rent","Electricity","Water","Internet & phone","Consumables","Medicines purchase","Equipment","Maintenance","Marketing","Bank charges","Taxes","Other"];
async function pageAccounts(){
 const tabs=[["sales","Sales"],["doctors","Doctor revenue"],["dues","Dues"],["expenses","Expenses"],["goals","Goals"],["appts","Appointments"],["branches","Branches"]];
 $("#app").innerHTML=shell("Accounts",tabs,ATAB);bindTabs(t=>{ATAB=t;pageAccounts()});const mb=$("#mb");
 const range='<div class="bar2">From <input type="date" id="af" class="chip" value="'+AF.from+'"> to <input type="date" id="at" class="chip" value="'+AF.to+'">'+(ATAB==="sales"?' <select id="ag" class="chip"><option value="day"'+(AF.g==="day"?" selected":"")+'>By day</option><option value="month"'+(AF.g==="month"?" selected":"")+'>By month</option></select>':"")+' <button class="chip" data-q="m">This month</button><button class="chip" data-q="y">This year</button><button class="chip" data-q="l">Last month</button></div>';
 const bindRange=()=>{$("#af")&&($("#af").onchange=e=>{AF.from=e.target.value;pageAccounts()});$("#at")&&($("#at").onchange=e=>{AF.to=e.target.value;pageAccounts()});$("#ag")&&($("#ag").onchange=e=>{AF.g=e.target.value;pageAccounts()});
  $$("[data-q]").forEach(b=>b.onclick=()=>{const t=today();if(b.dataset.q==="m"){AF.from=t.slice(0,8)+"01";AF.to=t;AF.g="day"}else if(b.dataset.q==="y"){AF.from=t.slice(0,5)+"01-01";AF.to=t;AF.g="month"}else{const d=new Date(t.slice(0,8)+"01T00:00:00Z");d.setUTCDate(0);AF.to=d.toISOString().slice(0,10);AF.from=AF.to.slice(0,8)+"01";AF.g="day"}pageAccounts()})};
 if(["sales","doctors","branches","goals"].includes(ATAB)){
  const r=await api("/api/reports/sales",{from:AF.from,to:AF.to,groupBy:AF.g});
  if(ATAB==="sales"){const mx=Math.max(1,...r.byPeriod.map(p=>p.billed));
   mb.innerHTML=range+tiles([["Billed",inr(r.billed),"t4"],["Collected",inr(r.collected),"t3"],["Expenses",inr(r.expenses),"t2"],["Net (collected − expenses)",inr(r.net),r.net>=0?"t3":"t5"],["Bills",r.bills,"t1"]])+
   '<div class="grid2"><div class="panel"><h3>Billed by '+(AF.g==="month"?"month":"day")+'</h3><div class="pb">'+(r.byPeriod.length?bars(r.byPeriod.map(p=>[p.period,p.billed,inr(p.billed)]),mx):'<div class="empty">No bills in this period</div>')+'</div></div>'+
   '<div class="panel"><h3>By department</h3><div class="pb">'+bars(Object.entries(r.byDept).map(([k,v])=>[{opd:"OPD",pharmacy:"Pharmacy",lab:"Lab",diagnostics:"Diagnostics",ip:"Inpatient"}[k]||k,v,inr(v)]),Math.max(1,...Object.values(r.byDept)))+'</div></div></div>'+
   '<div class="tbl-wrap" style="margin-top:12px"><table><thead><tr><th>Period</th><th>OPD</th><th>Pharmacy</th><th>Lab</th><th>Diagnostics</th><th>Inpatient</th><th>Billed</th><th>Collected</th></tr></thead><tbody>'+r.byPeriod.map(p=>'<tr><td>'+esc(p.period)+'</td>'+["opd","pharmacy","lab","diagnostics","ip","billed","collected"].map(k=>'<td>'+inr(p[k])+'</td>').join("")+'</tr>').join("")+'</tbody></table></div>'+
   (Object.keys(r.expByCat).length?'<div class="panel" style="margin-top:12px"><h3>Expenses by category</h3><div class="pb">'+bars(Object.entries(r.expByCat).map(([k,v])=>[k,v,inr(v)]),Math.max(...Object.values(r.expByCat)))+'</div></div>':"")}
  else if(ATAB==="doctors"){const mx=Math.max(1,...r.byDoctor.map(d=>d.revenue));mb.innerHTML=range+'<div class="panel"><h3>Doctor-wise revenue</h3><div class="pb">'+(r.byDoctor.length?bars(r.byDoctor.map(d=>[d.doctor,d.revenue,inr(d.revenue)+" · "+d.patients+" pts"]),mx):'<div class="empty">No data</div>')+'</div></div><p class="m" style="color:var(--muted)">Revenue counts bills linked to each doctor\\'s OPD visits and inpatient final bills.</p>'}
  else if(ATAB==="branches"){let br=[];try{br=(await api("/api/rec/list",{coll:"branches"})).items}catch{}
   mb.innerHTML=range+'<div class="grid2"><div class="panel"><h3>Revenue by branch</h3><div class="pb">'+bars(Object.entries(r.byBranch).map(([k,v])=>[k,v,inr(v)]),Math.max(1,...Object.values(r.byBranch)))+'</div></div>'+
   '<div class="panel"><h3>Branches</h3><div class="pb">'+br.map(b=>'<div>'+esc(b.name)+' · '+esc(b.address||"")+'</div>').join("")+(ME.role==="admin"?'<div id="bf" class="fr">'+fld("name","Branch name")+fld("address","Address")+'</div><div class="acts"><button class="btn p" id="ba">Add branch</button></div><p class="m" style="color:var(--muted)">Set each person\\'s branch in the app: Admin → Staff logins. Their bills are counted under that branch.</p>':"")+'</div></div></div>';
   $("#ba")&&($("#ba").onclick=async()=>{const f=readForm($("#bf"));if(!f.name)return toast("Enter the name");try{await api("/api/rec/save",{coll:"branches",item:f});pageAccounts()}catch(e){toast(e.message)}})}
  else{let G=[];try{G=(await api("/api/rec/list",{coll:"goals"})).items}catch{}
   const mth=AF.to.slice(0,7);const g=G.find(x=>x.month===mth)||{};const m=await api("/api/reports/sales",{from:mth+"-01",to:AF.to,groupBy:"month"});
   const prog=(l,t,v)=>t>0?'<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between"><b>'+l+'</b><span>'+inr(v)+' of '+inr(t)+' · '+Math.round(v/t*100)+'%</span></div><div style="background:#e4ecee;border-radius:6px;height:14px;overflow:hidden"><i style="display:block;height:100%;width:'+Math.min(100,Math.round(v/t*100))+'%;background:'+(v>=t?"var(--green)":"var(--accent)")+'"></i></div></div>':"";
   mb.innerHTML='<div class="bar2">Month <input type="month" id="gm" class="chip" value="'+mth+'"></div><div class="grid2"><div class="panel"><h3>Progress · '+mth+'</h3><div class="pb">'+(g.total?prog("Total",+g.total,m.billed)+["opd","pharmacy","lab","diagnostics","ip"].map(k=>prog({opd:"OPD",pharmacy:"Pharmacy",lab:"Lab",diagnostics:"Diagnostics",ip:"Inpatient"}[k],+g[k]||0,m.byDept[k]||0)).join(""):'<div class="empty">No goal set for this month.</div>')+'</div></div>'+
   (ME.role==="admin"?'<div class="panel"><h3>Set goals for '+mth+'</h3><div class="pb" id="gf"><div class="fr">'+[["total","Total ₹"],["opd","OPD ₹"],["pharmacy","Pharmacy ₹"],["lab","Lab ₹"],["diagnostics","Diagnostics ₹"],["ip","Inpatient ₹"]].map(([k,l])=>fld(k,l,{v:g[k]||""})).join("")+'</div><div class="acts"><button class="btn p" id="gs">Save goals</button></div></div></div>':"")+'</div>';
   $("#gm").onchange=e=>{AF.to=e.target.value+"-28";AF.from=e.target.value+"-01";pageAccounts()};
   $("#gs")&&($("#gs").onclick=async()=>{const f=readForm($("#gf"));Object.keys(f).forEach(k=>f[k]=+f[k]||0);f.month=mth;try{await api("/api/rec/save",{coll:"goals",id:g.id,item:f});toast("Goals saved");pageAccounts()}catch(e){toast(e.message)}})}
  bindRange()}
 else if(ATAB==="dues"){const r=await api("/api/reports/dues");
  mb.innerHTML=tiles([["Total outstanding",inr(r.total),"t5"],...Object.entries(r.ageing).map(([k,v])=>[k,inr(v),"t2"])])+
  '<div class="tbl-wrap"><table><thead><tr><th>Bill</th><th>Patient</th><th>Date</th><th>Age</th><th>Total</th><th>Balance</th><th></th></tr></thead><tbody>'+(r.bills.map(b=>'<tr data-id="'+b.id+'"><td>'+esc(b.no)+'<br><small>'+esc(b.dept)+'</small></td><td>'+esc(b.patient?.name)+'<br><small>'+esc(b.patient?.id||"")+' '+esc(b.patient?.phone||"")+'</small></td><td>'+dt(b.date)+'</td><td>'+b.days+' d</td><td>'+inr(b.total)+'</td><td style="color:var(--red);font-weight:700">'+inr(b.balance)+'</td><td style="white-space:nowrap"><button class="btn" data-wa>WhatsApp reminder</button> <button class="btn p" data-pay>Collect online</button></td></tr>').join("")||'<tr><td colspan="7" class="empty">No pending dues</td></tr>')+'</tbody></table></div>'+
  (r.inpatients.length?panel("Running inpatient balances",["IP no","Patient","Ward","Total","Advance","Due"],r.inpatients.map(x=>'<tr class="r" onclick="location.hash=\\'ip-'+x.id+'\\'"><td>'+esc(x.no)+'</td><td>'+esc(x.patient?.name)+'</td><td>'+esc(x.ward)+'</td><td>'+inr(x.total)+'</td><td>'+inr(x.advance)+'</td><td style="color:var(--red)">'+inr(x.due)+'</td></tr>')):"");
  $$("[data-wa]").forEach(b=>b.onclick=()=>{const x=r.bills.find(y=>y.id===b.closest("tr").dataset.id);waSend(x.patient?.phone,"Dear "+x.patient?.name+", a balance of "+inr(x.balance)+" is pending on your "+x.dept+" bill "+x.no+". Please pay at the clinic or by UPI. Thank you.")});
  $$("[data-pay]").forEach(b=>b.onclick=()=>payOnline(b.closest("tr").dataset.id,r.bills.find(y=>y.id===b.closest("tr").dataset.id)))}
 else if(ATAB==="expenses"){const L=(await api("/api/rec/list",{coll:"expenses",from:AF.from,to:AF.to})).items;const tot=L.reduce((x,e)=>x+(+e.amount||0),0);
  mb.innerHTML=range+'<div class="grid2" style="grid-template-columns:minmax(0,.8fr) minmax(0,1.5fr)"><div class="panel"><h3>Add expense</h3><div class="pb" id="ef"><div class="fr">'+fld("date","Date",{type:"date",v:today()})+fld("category","Category",{opts:EXPCAT})+fld("amount","Amount ₹")+fld("mode","Paid by",{opts:["Cash","UPI","Bank transfer","Card","Cheque"]})+'</div>'+fld("paidTo","Paid to")+fld("note","Note")+'<div class="acts"><button class="btn p" id="es">Save</button></div></div></div>'+
  panel("Expenses · total "+inr(tot),["Date","Category","Paid to","Mode","Amount",""],L.map(e=>'<tr><td>'+dt(e.date)+'</td><td>'+esc(e.category)+'</td><td>'+esc(e.paidTo||"")+'<br><small>'+esc(e.note||"")+'</small></td><td>'+esc(e.mode)+'</td><td>'+inr(e.amount)+'</td><td><button class="btn d" data-del="'+e.id+'">✕</button></td></tr>'),"No expenses in this period")+'</div>';
  bindRange();$("#es").onclick=async()=>{const f=readForm($("#ef"));f.amount=+f.amount;if(!(f.amount>0))return toast("Enter the amount");try{await api("/api/rec/save",{coll:"expenses",item:f});toast("Expense saved");pageAccounts()}catch(e){toast(e.message)}};
  $$("[data-del]").forEach(b=>b.onclick=async()=>{try{await api("/api/rec/delete",{coll:"expenses",id:b.dataset.del});pageAccounts()}catch(e){toast(e.message)}})}
 else{const a=await api("/api/reports/appointments",{from:AF.from,to:AF.to});const wk=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  mb.innerHTML=range+tiles([["Appointments",a.total,"t1"],["Completed",a.completed,"t3"],["No-show",a.noShow+" ("+a.noShowRate+"%)","t5"],["Cancelled",a.cancelled,"t2"],["Check-ins (all visits)",a.walkIns,"t4"]])+
  '<div class="grid2"><div class="panel"><h3>By weekday</h3><div class="pb">'+bars(wk.map(d=>[d,a.byWeekday[d]||0]),Math.max(1,...Object.values(a.byWeekday)))+'</div></div><div class="panel"><h3>By hour</h3><div class="pb">'+bars(Object.keys(a.byHour).sort().map(h=>[h,a.byHour[h]]),Math.max(1,...Object.values(a.byHour)))+'</div></div>'+
  '<div class="panel"><h3>Clinic or video</h3><div class="pb">'+bars(Object.entries(a.byMode).map(([k,v])=>[k==="tele"?"Video":"Clinic",v]),Math.max(1,...Object.values(a.byMode)))+'</div></div><div class="panel"><h3>How they booked</h3><div class="pb">'+bars(Object.entries(a.bySource),Math.max(1,...Object.values(a.bySource)))+'</div></div></div>';bindRange()}
}
let QRLIB=null;
async function payOnline(id,b){try{const r=await api("/api/pay/link",{billId:id});
 const m=document.createElement("div");m.className="modal";m.innerHTML='<div style="max-width:420px;text-align:center"><h3 style="margin-top:0">Collect '+inr(r.amount)+'</h3><p>Bill '+esc(r.no)+'</p><div id="qr" style="display:inline-block;padding:8px;background:#fff"></div>'+(r.upi?'<p class="m">Patient scans with any UPI app (GPay, PhonePe, Paytm).</p>':'<p class="m">Add your clinic UPI ID in the app: Admin → Clinic details.</p>')+(r.link?'<p><a href="'+esc(r.link)+'" target="_blank">'+esc(r.link)+'</a></p>':"")+'<div class="acts">'+(r.link||r.upi?'<button class="btn" id="qw">Send on WhatsApp</button>':"")+'<button class="btn p" id="qc">Close</button></div></div>';
 document.body.appendChild(m);$("#qc",m).onclick=()=>m.remove();
 if(r.upi){if(!QRLIB){await new Promise((ok,no)=>{const s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";s.onload=ok;s.onerror=no;document.head.appendChild(s)});QRLIB=1}new QRCode($("#qr",m),{text:r.upi,width:220,height:220})}
 $("#qw",m)&&($("#qw",m).onclick=()=>waSend(b?.patient?.phone,"Please pay "+inr(r.amount)+" for bill "+r.no+". "+(r.link?"Pay online: "+r.link:"UPI: "+r.upi)))}catch(e){toast(e.message)}}

// ---------- bed board ----------
async function pageBeds(){
 const d=await api("/api/beds");
 $("#app").innerHTML=shell("Bed board")+'';
 const mb=$("#mb");
 mb.innerHTML=tiles([["Beds",d.totals.beds,"t4"],["Occupied",d.totals.occupied,"t5"],["Free",d.totals.free,"t3"],["Admitted without a matching bed",d.unassigned.length,"t2"]])+
 d.wards.map(w=>'<div class="panel" style="margin-bottom:12px"><h3>'+esc(w.name)+' <small>'+w.occupied+' occupied · '+w.free+' free</small></h3><div class="pb" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">'+
  w.beds.map(b=>b.admission?'<a href="#ip-'+b.admission.id+'" style="text-decoration:none;color:inherit;border:1px solid #f1b8b0;background:#fde7e5;border-radius:8px;padding:8px"><b>'+esc(b.bed)+'</b><br>'+esc(b.admission.patient?.name)+'<br><small>'+esc(b.admission.no)+' · day '+b.admission.day+'</small></a>'
   :'<div style="border:1px solid #bfe3cf;background:#e2f4ec;border-radius:8px;padding:8px"><b>'+esc(b.bed)+'</b><br><span style="color:var(--green)">'+(b.blocked?"Blocked":"Free")+'</span></div>').join("")+'</div></div>').join("")+
 (d.unassigned.length?panel("Admitted, bed not on the board",["IP no","Patient","Ward","Bed"],d.unassigned.map(a=>'<tr class="r" onclick="location.hash=\\'ip-'+a.id+'\\'"><td>'+esc(a.no)+'</td><td>'+esc(a.patient?.name)+'</td><td>'+esc(a.ward)+'</td><td>'+esc(a.bed||"–")+'</td></tr>')):"")+
 (ME.role==="admin"?'<div class="panel" style="margin-top:12px"><h3>Set up wards and beds</h3><div class="pb" id="wf"><div class="fr">'+fld("name","Ward name",{ph:"Private rooms, 2nd floor"})+fld("match","Room type (from price list)",{ph:"Private room"})+fld("order","Order",{v:"1"})+'</div>'+fld("beds","Bed numbers, separated by commas",{rows:2,ph:"P-201, P-202, P-203"})+'<div class="acts"><button class="btn p" id="ws">Add ward</button></div>'+d.wards.map(w=>'<div style="display:flex;gap:8px;align-items:center">'+esc(w.name)+' · '+w.beds.length+' beds <button class="btn d" data-wd="'+w.id+'">Remove</button></div>').join("")+'</div></div>':(d.wards.length?"":'<div class="empty">No wards set up yet. The admin adds wards and beds here.</div>'));
 $("#ws")&&($("#ws").onclick=async()=>{const f=readForm($("#wf"));if(!f.name||!f.beds)return toast("Enter the ward name and beds");f.order=+f.order||1;try{await api("/api/rec/save",{coll:"wards",item:f});pageBeds()}catch(e){toast(e.message)}});
 $$("[data-wd]").forEach(b=>b.onclick=async()=>{try{await api("/api/rec/delete",{coll:"wards",id:b.dataset.wd});pageBeds()}catch(e){toast(e.message)}});
}

// ---------- insurance ----------
let ITB="claims",ISF="open";
const SCHEMES=["Private insurance","PM-JAY (Ayushman Bharat)","CMCHIS (Tamil Nadu)","CGHS","ECHS","ESI","Corporate","Other"];
const CST={"draft":"amb","pre-auth sent":"amb","query":"red","approved":"grn","enhancement sent":"amb","final claim sent":"amb","settled":"grn","rejected":"red","closed":"gry"};
async function pageInsurance(){
 $("#app").innerHTML=shell("Insurance desk",[["claims","Claims"],["policies","Patient policies"],["corporates","Corporates"]],ITB);bindTabs(t=>{ITB=t;pageInsurance()});const mb=$("#mb");
 if(ITB==="claims"){const L=(await api("/api/rec/list",{coll:"claims"})).items;const open=(c)=>!["settled","rejected","closed"].includes(c.status);const S=L.filter(c=>ISF==="all"||(ISF==="open"?open(c):!open(c)));
  mb.innerHTML=tiles([["Open claims",L.filter(open).length,"t2"],["Approved amount",inr(L.reduce((x,c)=>x+(c.approved||0),0)),"t3"],["Settled",inr(L.reduce((x,c)=>x+(c.settled||0),0)),"t4"],["Deductions",inr(L.reduce((x,c)=>x+(c.deduction||0),0)),"t5"]])+
  '<div class="bar2">'+[["open","Open"],["done","Closed"],["all","All"]].map(([k,l])=>'<button class="chip'+(ISF===k?" on":"")+'" data-f="'+k+'">'+l+'</button>').join(" ")+'<div class="sp"></div><button class="btn p" id="nc">New claim</button></div>'+
  '<div class="tbl-wrap"><table><thead><tr><th>Claim</th><th>Patient</th><th>Insurer / TPA</th><th>Scheme</th><th>Requested</th><th>Approved</th><th>Settled</th><th>Status</th></tr></thead><tbody>'+(S.map(c=>'<tr class="r" data-id="'+c.id+'"><td>'+esc(c.no)+'<br><small>'+dt(c.date)+'</small></td><td>'+esc(c.patientName)+'<br><small>'+esc(c.patientId)+' '+esc(c.admissionNo||"")+'</small></td><td>'+esc(c.insurer||"")+'<br><small>'+esc(c.tpa||"")+'</small></td><td>'+esc(c.scheme||"")+'</td><td>'+inr(c.requested)+'</td><td>'+inr(c.approved)+'</td><td>'+inr(c.settled)+'</td><td><span class="pill '+(CST[c.status]||"")+'">'+esc(c.status||"draft")+'</span></td></tr>').join("")||'<tr><td colspan="8" class="empty">No claims</td></tr>')+'</tbody></table></div>';
  $$("[data-f]").forEach(b=>b.onclick=()=>{ISF=b.dataset.f;pageInsurance()});$$("tr[data-id]").forEach(t=>t.onclick=()=>claimView(L.find(c=>c.id===t.dataset.id)));$("#nc").onclick=newClaim}
 else if(ITB==="policies"){const L=(await api("/api/rec/list",{coll:"policies"})).items;
  mb.innerHTML='<div class="grid2" style="grid-template-columns:minmax(0,.9fr) minmax(0,1.5fr)"><div class="panel"><h3>Add a policy</h3><div class="pb" id="pf">'+fld("pid","Patient ID or mobile")+'<div class="fr">'+fld("scheme","Scheme",{opts:SCHEMES})+fld("insurer","Insurer")+fld("tpa","TPA")+fld("policyNo","Policy / card no")+fld("memberId","Member ID")+fld("sumInsured","Sum insured ₹")+fld("validTill","Valid till",{type:"date"})+fld("corporate","Corporate (if any)")+'</div><div class="acts"><button class="btn p" id="ps">Save policy</button></div></div></div>'+
  panel("Policies",["Patient","Scheme","Insurer / TPA","Policy","Sum insured","Valid till"],L.map(x=>'<tr><td>'+esc(x.patientName)+'<br><small>'+esc(x.patientId)+'</small></td><td>'+esc(x.scheme)+'</td><td>'+esc(x.insurer||"")+'<br><small>'+esc(x.tpa||"")+'</small></td><td>'+esc(x.policyNo||"")+'</td><td>'+inr(x.sumInsured)+'</td><td style="'+(x.validTill&&x.validTill<today()?"color:var(--red)":"")+'">'+dt(x.validTill)+'</td></tr>'),"No policies yet")+'</div>';
  $("#ps").onclick=async()=>{const f=readForm($("#pf"));try{const p=await findPatient(f.pid);delete f.pid;f.patientId=p.id;f.patientName=p.name;f.phone=p.phone;f.sumInsured=+f.sumInsured||0;await api("/api/rec/save",{coll:"policies",item:f});toast("Policy saved for "+p.name);pageInsurance()}catch(e){toast(e.message)}}}
 else{const L=(await api("/api/rec/list",{coll:"corporates"})).items;
  mb.innerHTML='<div class="grid2" style="grid-template-columns:minmax(0,.9fr) minmax(0,1.5fr)"><div class="panel"><h3>Add a corporate or panel company</h3><div class="pb" id="cf"><div class="fr">'+fld("name","Company")+fld("contact","Contact person")+fld("phone","Phone")+fld("email","Email")+fld("credit","Credit limit ₹")+fld("discount","Discount %")+'</div>'+fld("notes","Agreement notes",{rows:2})+'<div class="acts"><button class="btn p" id="cs">Save</button></div></div></div>'+
  panel("Corporates and panels",["Company","Contact","Credit limit","Discount"],L.map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+esc(x.contact||"")+'<br><small>'+esc(x.phone||"")+'</small></td><td>'+inr(x.credit)+'</td><td>'+esc(x.discount||0)+'%</td></tr>'),"None yet")+'</div>';
  $("#cs").onclick=async()=>{const f=readForm($("#cf"));if(!f.name)return toast("Enter the company");f.credit=+f.credit||0;f.discount=+f.discount||0;try{await api("/api/rec/save",{coll:"corporates",item:f});pageInsurance()}catch(e){toast(e.message)}}}
}
function newClaim(){const m=document.createElement("div");m.className="modal";
 m.innerHTML='<div><h3 style="margin-top:0">New claim</h3><div id="cf">'+fld("pid","Patient ID or mobile")+'<div class="fr">'+fld("scheme","Scheme",{opts:SCHEMES})+fld("insurer","Insurer")+fld("tpa","TPA")+fld("policyNo","Policy / card no")+'</div>'+fld("diagnosis","Diagnosis")+fld("procedure","Procedure / treatment")+'<div class="fr">'+fld("estimate","Estimated cost ₹")+fld("requested","Pre-auth amount requested ₹")+'</div></div><div class="acts"><button class="btn" id="cc">Cancel</button><button class="btn p" id="cs">Create claim</button></div></div>';
 document.body.appendChild(m);$("#cc",m).onclick=()=>m.remove();
 $("#cs",m).onclick=async()=>{const f=readForm($("#cf",m));try{const p=await findPatient(f.pid);delete f.pid;f.patientId=p.id;f.patientName=p.name;f.estimate=+f.estimate||0;f.requested=+f.requested||0;f.status="draft";
  const ad=(await api("/api/ip/list",{status:"admitted"})).admissions.find(a=>a.patient?.id===p.id);if(ad){f.admissionId=ad.id;f.admissionNo=ad.no}
  const pol=(await api("/api/rec/list",{coll:"policies",where:{patientId:p.id}})).items[0];if(pol){f.insurer=f.insurer||pol.insurer;f.tpa=f.tpa||pol.tpa;f.policyNo=f.policyNo||pol.policyNo;f.policyId=pol.id}
  const r=await api("/api/rec/save",{coll:"claims",item:f});m.remove();toast("Claim "+r.item.no+" created");pageInsurance()}catch(e){toast(e.message)}}}
function claimView(c){const m=document.createElement("div");m.className="modal";
 const acts=[["submit","Send pre-auth"],["query","Query received"],["approve","Approved"],["enhance","Enhancement sent"],["final","Final claim sent"],["settle","Settled"],["reject","Rejected"],["close","Close"]];
 m.innerHTML='<div><h3 style="margin-top:0">'+esc(c.no)+' · '+esc(c.patientName)+'</h3><p>'+esc(c.scheme||"")+' · '+esc(c.insurer||"")+' '+esc(c.tpa||"")+' · '+esc(c.policyNo||"")+'<br>'+esc(c.diagnosis||"")+' · '+esc(c.procedure||"")+'<br>Requested '+inr(c.requested)+' · Approved '+inr(c.approved)+' · Settled '+inr(c.settled)+(c.deduction?' · Deduction '+inr(c.deduction):"")+(c.admissionNo?'<br>Admission '+esc(c.admissionNo):"")+'</p>'+
 '<div id="af" class="fr">'+fld("amount","Amount ₹")+fld("deduction","Deduction ₹ (on settlement)")+fld("utr","UTR / reference")+'</div>'+fld("note","Note (query details, documents sent…)",{rows:2})+'<div class="cks">'+acts.map(([k,l])=>'<button class="chip" data-a="'+k+'">'+l+'</button>').join("")+'</div>'+
 '<h4>History</h4>'+((c.log||[]).slice().reverse().map(l=>'<div class="m" style="font-size:12.5px">'+tm(l.at)+' · <b>'+esc(l.step)+'</b>'+(l.amount?' · '+inr(l.amount):"")+(l.note?' · '+esc(l.note):"")+' · '+esc(l.by)+'</div>').join("")||'<div class="m">Created '+tm(c.created)+'</div>')+'<div class="acts"><button class="btn p" id="xc">Close</button></div></div>';
 document.body.appendChild(m);$("#xc",m).onclick=()=>m.remove();
 $$("[data-a]",m).forEach(b=>b.onclick=async()=>{const f=readForm($("#af",m));f.note=$('textarea[name=note]',m).value;
  try{if(b.dataset.a==="final"&&c.admissionId){const g=await api("/api/ip/get",{id:c.admissionId});if(g.finalBill){await api("/api/rec/save",{coll:"claims",id:c.id,item:{billId:g.finalBill.id}})}}
  await api("/api/claims/action",{id:c.id,action:b.dataset.a,amount:+f.amount||0,deduction:+f.deduction||0,utr:f.utr,note:f.note});m.remove();toast("Claim updated");pageInsurance()}catch(e){toast(e.message)}})}

// ---------- home care ----------
let HCD=today();
const HCS=["Doctor visit","Nursing care","Physiotherapy","Sample collection","Wound dressing","Injection / IV","Catheter care","Elderly care","Palliative care"];
async function pageHomecare(){
 const L=(await api("/api/rec/list",{coll:"homevisits",from:HCD,to:new Date(new Date(HCD+"T00:00:00Z").getTime()+6*864e5).toISOString().slice(0,10)})).items.sort((a,b)=>(a.date+(a.time||"")).localeCompare(b.date+(b.time||"")));
 $("#app").innerHTML=shell("Home care");const mb=$("#mb");
 mb.innerHTML='<div class="bar2">From <input type="date" id="hd" class="chip" value="'+HCD+'"> · 7 days<div class="sp"></div><button class="btn p" id="hn">Book a home visit</button></div>'+tiles([["Visits",L.length,"t4"],["Done",L.filter(x=>x.status==="done").length,"t3"],["Pending",L.filter(x=>x.status!=="done"&&x.status!=="cancelled").length,"t2"],["Billed",L.filter(x=>x.billNo).length,"t1"]])+
 '<div class="tbl-wrap"><table><thead><tr><th>When</th><th>Patient</th><th>Address</th><th>Service</th><th>Staff</th><th>Fee</th><th>Status</th><th></th></tr></thead><tbody>'+(L.map(x=>'<tr data-id="'+x.id+'"><td>'+dt(x.date)+'<br><small>'+esc(x.time||"")+'</small></td><td>'+esc(x.patientName)+'<br><small>'+esc(x.patientId||"")+' '+esc(x.phone||"")+'</small></td><td style="max-width:220px">'+esc(x.address||"")+'</td><td>'+esc(x.service)+'</td><td>'+esc(x.staff||"")+'</td><td>'+inr(x.fee)+'</td><td><span class="pill '+(x.status==="done"?"grn":x.status==="cancelled"?"gry":"amb")+'">'+esc(x.status||"booked")+'</span>'+(x.billNo?'<br><small>'+esc(x.billNo)+'</small>':"")+'</td><td style="white-space:nowrap"><button class="btn" data-o>Open</button></td></tr>').join("")||'<tr><td colspan="8" class="empty">No home visits in these 7 days</td></tr>')+'</tbody></table></div>';
 $("#hd").onchange=e=>{HCD=e.target.value;pageHomecare()};$("#hn").onclick=()=>hvForm();
 $$("[data-o]").forEach(b=>b.onclick=()=>hvForm(L.find(x=>x.id===b.closest("tr").dataset.id)));
}
function hvForm(x){const v=x||{};const m=document.createElement("div");m.className="modal";
 m.innerHTML='<div><h3 style="margin-top:0">'+(x?"Home visit "+esc(v.no||""):"Book a home visit")+'</h3><div id="hf">'+(x?'<p><b>'+esc(v.patientName)+'</b> · '+esc(v.patientId||"")+' · '+esc(v.phone||"")+'</p>':fld("pid","Patient ID or mobile (registered patients)")+'<div class="fr">'+fld("patientName","Or name")+fld("phone","Mobile")+'</div>')+
 fld("address","Address",{rows:2,v:v.address})+'<div class="fr">'+fld("service","Service",{opts:HCS,v:v.service})+fld("date","Date",{type:"date",v:v.date||today()})+fld("time","Time",{type:"time",v:v.time})+fld("staff","Assigned to",{v:v.staff})+fld("fee","Fee ₹",{v:v.fee||""})+fld("status","Status",{opts:["booked","on the way","done","cancelled"],v:v.status||"booked"})+'</div>'+
 (x?'<div class="fr">'+fld("bp","BP",{v:v.bp})+fld("pulse","Pulse",{v:v.pulse})+fld("temp","Temp",{v:v.temp})+fld("spo2","SpO₂",{v:v.spo2})+fld("rbs","RBS",{v:v.rbs})+'</div>'+fld("notes","Visit notes",{rows:3,v:v.notes}):"")+'</div>'+
 '<div class="acts">'+(x?'<button class="btn" id="hw">WhatsApp patient</button>'+(!v.billNo&&(isBill()||ME.role==="staff")?'<button class="btn" id="hb">Make bill</button>':""):"")+'<button class="btn" id="hc">Close</button><button class="btn p" id="hs">Save</button></div></div>';
 document.body.appendChild(m);$("#hc",m).onclick=()=>m.remove();
 $("#hs",m).onclick=async()=>{const f=readForm($("#hf",m));try{if(!x){if(f.pid){const p=await findPatient(f.pid);f.patientId=p.id;f.patientName=p.name;f.phone=p.phone;if(!f.address)f.address=p.address||""}delete f.pid;if(!f.patientName)return toast("Choose or enter the patient")}
  f.fee=+f.fee||0;await api("/api/rec/save",{coll:"homevisits",id:x?.id,item:f});m.remove();toast("Saved");pageHomecare()}catch(e){toast(e.message)}};
 $("#hw",m)&&($("#hw",m).onclick=()=>waSend(v.phone,"Dear "+v.patientName+", your "+v.service+" home visit is on "+dt(v.date)+" "+(v.time||"")+". Our "+(v.staff?v.staff:"team")+" will reach you. Thank you."));
 $("#hb",m)&&($("#hb",m).onclick=async()=>{try{const b=await api("/api/bills/save",{bill:{dept:"opd",patient:{id:v.patientId||"",name:v.patientName,phone:v.phone},items:[{desc:"Home visit · "+v.service,qty:1,rate:+v.fee||0}]}});await api("/api/rec/save",{coll:"homevisits",id:v.id,item:{billNo:b.bill.no,billId:b.bill.id}});m.remove();toast("Bill "+b.bill.no+" made · collect it in Billing");pageHomecare()}catch(e){toast(e.message)}})}

// ---------- mobile medical units: camps ----------
let CAMP=null;
async function pageCamps(id){
 if(id){return campView(id)}
 const L=(await api("/api/rec/list",{coll:"camps"})).items;
 $("#app").innerHTML=shell("Mobile units and health camps");const mb=$("#mb");
 mb.innerHTML='<div class="grid2" style="grid-template-columns:minmax(0,.9fr) minmax(0,1.5fr)"><div class="panel"><h3>Plan a camp or van trip</h3><div class="pb" id="cf">'+fld("name","Camp name",{ph:"Diabetes and BP screening"})+'<div class="fr">'+fld("type","Type",{opts:["General screening","Diabetes & BP","Eye camp","Dental camp","Women's health","Child health","School health","Elderly care"]})+fld("date","Date",{type:"date",v:today()})+fld("place","Village / place")+fld("vehicle","Vehicle / van no")+'</div>'+fld("team","Team (names and roles)",{rows:2})+fld("notes","Notes",{rows:2})+'<div class="acts"><button class="btn p" id="cs">Save camp</button></div></div></div>'+
 panel("Camps",["No","Date","Camp","Place","Team"],L.map(c=>'<tr class="r" onclick="location.hash=\\'camps-'+c.id+'\\'"><td>'+esc(c.no)+'</td><td>'+dt(c.date)+'</td><td>'+esc(c.name)+'<br><small>'+esc(c.type)+'</small></td><td>'+esc(c.place||"")+'<br><small>'+esc(c.vehicle||"")+'</small></td><td style="font-size:12px">'+esc(c.team||"")+'</td></tr>'),"No camps yet")+'</div>';
 $("#cs").onclick=async()=>{const f=readForm($("#cf"));if(!f.name)return toast("Enter the camp name");try{const r=await api("/api/rec/save",{coll:"camps",item:f});location.hash="camps-"+r.item.id}catch(e){toast(e.message)}};
}
async function campView(id){
 const c=(await api("/api/rec/list",{coll:"camps"})).items.find(x=>x.id===id);if(!c){$("#app").innerHTML='<div class="empty">Camp not found</div>';return}
 const R=(await api("/api/rec/list",{coll:"campregs",where:{campId:id}})).items.sort((a,b)=>(a.created||0)-(b.created||0));
 const hiBP=(b)=>{const m=String(b||"").match(/(\\d+)\\s*\\/\\s*(\\d+)/);return m&&(+m[1]>=140||+m[2]>=90)},hiS=(s)=>+s>=200;
 $("#app").innerHTML=shell(c.name+" · "+dt(c.date));const mb=$("#mb");
 mb.innerHTML='<div class="bar2"><button class="btn" onclick="location.hash=\\'camps\\'">‹ All camps</button><span>'+esc(c.place||"")+' · '+esc(c.vehicle||"")+' · '+esc(c.team||"")+'</span><div class="sp"></div><button class="btn" id="cp">Print camp report</button></div>'+
 tiles([["Registered",R.length,"t4"],["High BP (≥140/90)",R.filter(r=>hiBP(r.bp)).length,"t5"],["High sugar (≥200)",R.filter(r=>hiS(r.sugar)).length,"t2"],["Referred to hospital",R.filter(r=>r.refer==="Yes").length,"t1"]])+
 '<div class="panel" style="margin-bottom:12px"><h3>Register and screen</h3><div class="pb" id="rf"><div class="fr">'+fld("name","Name")+fld("age","Age")+fld("sex","Sex",{opts:["Female","Male","Other"]})+fld("phone","Mobile")+fld("village","Village / street")+'</div><div class="fr">'+fld("complaint","Complaint")+fld("bp","BP")+fld("sugar","RBS mg/dL")+fld("weight","Weight kg")+fld("height","Height cm")+fld("refer","Refer to hospital?",{opts:["No","Yes"]})+'</div>'+fld("advice","Advice / medicines given")+'<div class="acts"><button class="btn p" id="rs">Save and next</button></div></div></div>'+
 '<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Name</th><th>Age/Sex</th><th>Mobile</th><th>Complaint</th><th>BP</th><th>RBS</th><th>BMI</th><th>Refer</th><th></th></tr></thead><tbody>'+R.map((r,i)=>{const bmi=+r.weight&&+r.height?(r.weight/((r.height/100)**2)).toFixed(1):"";return '<tr data-id="'+r.id+'"><td>'+(i+1)+'</td><td>'+esc(r.name)+'<br><small>'+esc(r.village||"")+'</small></td><td>'+esc(r.age||"")+' '+esc((r.sex||"")[0]||"")+'</td><td>'+esc(r.phone||"")+'</td><td>'+esc(r.complaint||"")+'</td><td style="'+(hiBP(r.bp)?"color:var(--red);font-weight:700":"")+'">'+esc(r.bp||"")+'</td><td style="'+(hiS(r.sugar)?"color:var(--red);font-weight:700":"")+'">'+esc(r.sugar||"")+'</td><td>'+bmi+'</td><td>'+(r.refer==="Yes"?'<span class="pill red">Yes</span>':"")+'</td><td>'+(r.patientId?'<small>'+esc(r.patientId)+'</small>':(r.refer==="Yes"?'<button class="btn" data-reg>Register as patient</button>':""))+'</td></tr>'}).join("")+'</tbody></table></div>';
 $("#rs").onclick=async()=>{const f=readForm($("#rf"));if(!f.name)return toast("Enter the name");f.campId=id;f.date=c.date;try{await api("/api/rec/save",{coll:"campregs",item:f});toast("Saved");campView(id)}catch(e){toast(e.message)}};
 $$("[data-reg]").forEach(b=>b.onclick=async()=>{const r=R.find(x=>x.id===b.closest("tr").dataset.id);try{const p=(await api("/api/patients/register",{name:r.name,age:r.age,sex:r.sex,phone:r.phone,address:r.village})).patient;await api("/api/rec/save",{coll:"campregs",id:r.id,item:{patientId:p.id}});toast("Registered "+p.id);campView(id)}catch(e){toast(e.message)}});
 $("#cp").onclick=()=>modal('<div class="rep"><h2>'+esc(c.name)+'</h2><p>'+dt(c.date)+' · '+esc(c.place||"")+' · '+esc(c.type||"")+'<br>Team: '+esc(c.team||"")+'</p><p><b>'+R.length+'</b> people screened · <b>'+R.filter(r=>hiBP(r.bp)).length+'</b> high BP · <b>'+R.filter(r=>hiS(r.sugar)).length+'</b> high sugar · <b>'+R.filter(r=>r.refer==="Yes").length+'</b> referred</p><table><thead><tr><th>#</th><th>Name</th><th>Age/Sex</th><th>BP</th><th>RBS</th><th>Complaint</th><th>Referred</th></tr></thead><tbody>'+R.map((r,i)=>'<tr><td>'+(i+1)+'</td><td>'+esc(r.name)+'</td><td>'+esc(r.age||"")+' '+esc(r.sex||"")+'</td><td>'+esc(r.bp||"")+'</td><td>'+esc(r.sugar||"")+'</td><td>'+esc(r.complaint||"")+'</td><td>'+esc(r.refer||"")+'</td></tr>').join("")+'</tbody></table></div>');
}

// ---------- follow-ups with WhatsApp ----------
async function pageFollowups(){
 const t=today(),r=await api("/api/followups",{from:new Date(new Date(t+"T00:00:00Z").getTime()-60*864e5).toISOString().slice(0,10),to:new Date(new Date(t+"T00:00:00Z").getTime()+7*864e5).toISOString().slice(0,10)});
 const L=r.followups.filter(f=>!["came","booked","not-coming"].includes(f.follow?.status));
 $("#app").innerHTML=shell("Follow-ups");$("#mb").innerHTML=tiles([["Overdue",L.filter(f=>f.review<t).length,"t5"],["Due today",L.filter(f=>f.review===t).length,"t2"],["Next 7 days",L.filter(f=>f.review>t).length,"t4"]])+
 '<div class="tbl-wrap"><table><thead><tr><th>Review</th><th>Patient</th><th>Diagnosis</th><th>Note</th><th>Status</th><th></th></tr></thead><tbody>'+(L.map(f=>'<tr data-id="'+f.visitId+'"><td style="'+(f.review<t?"color:var(--red);font-weight:700":"")+'">'+dt(f.review)+'</td><td>'+esc(f.patient?.name)+'<br><small>'+esc(f.patient?.id||"")+' '+esc(f.patient?.phone||"")+'</small></td><td>'+esc(f.dx)+'</td><td>'+esc(f.reviewNote||"")+'</td><td><span class="pill amb">'+esc(f.follow?.status||"due")+'</span></td><td style="white-space:nowrap"><button class="btn p" data-wa>WhatsApp reminder</button> <select data-st class="chip"><option value="">Mark…</option><option value="called">Called</option><option value="no-answer">No answer</option><option value="booked">Booked</option><option value="not-coming">Not coming</option></select></td></tr>').join("")||'<tr><td colspan="6" class="empty">No reviews due.</td></tr>')+'</tbody></table></div>';
 $$("[data-wa]").forEach(b=>b.onclick=()=>{const f=L.find(x=>x.visitId===b.closest("tr").dataset.id);waSend(f.patient?.phone,"Dear "+f.patient?.name+", this is a reminder of your review visit on "+dt(f.review)+(f.reviewNote?" ("+f.reviewNote+")":"")+". Please reply to book a time. Thank you.");api("/api/followups/update",{visitId:f.visitId,status:"called",note:"WhatsApp reminder"}).catch(()=>{})});
 $$("[data-st]").forEach(s=>s.onchange=async()=>{if(!s.value)return;try{await api("/api/followups/update",{visitId:s.closest("tr").dataset.id,status:s.value});pageFollowups()}catch(e){toast(e.message)}});
}

// ---------- messages ----------
async function pageMessages(pid){
 const th=(await api("/api/chat/threads")).threads;
 $("#app").innerHTML=shell("Messages");const mb=$("#mb");
 mb.innerHTML='<div class="grid2" style="grid-template-columns:minmax(0,.8fr) minmax(0,1.6fr)"><div class="panel"><h3>Patients</h3><div class="pb"><div style="display:flex;gap:6px"><input id="np" placeholder="Patient ID or mobile to start" style="flex:1;border:1px solid var(--line);border-radius:5px;padding:7px"><button class="btn" id="ns">Start</button></div>'+
 (th.map(t=>'<a href="#msg-'+esc(t.patientId)+'" style="display:block;text-decoration:none;color:inherit;padding:8px;border-radius:6px;'+(t.patientId===pid?"background:var(--soft)":"")+'"><b>'+esc(t.name)+'</b>'+(t.unread?' <span class="pill red">'+t.unread+'</span>':"")+'<br><small style="color:var(--muted)">'+esc((t.last.from==="clinic"?"You: ":"")+t.last.text.slice(0,60))+' · '+tm(t.last.at)+'</small></a>').join("")||'<div class="empty">No conversations yet</div>')+'</div></div><div class="panel" id="cv"><h3>Conversation</h3><div class="empty">Choose a patient.</div></div></div>';
 $("#ns").onclick=async()=>{try{const p=await findPatient($("#np").value.trim());location.hash="msg-"+p.id}catch(e){toast(e.message)}};
 if(!pid)return;const r=await api("/api/chat/get",{patientId:pid});const name=(th.find(t=>t.patientId===pid)||{}).name||pid;
 $("#cv").innerHTML='<h3>'+esc(name)+' <small>'+esc(pid)+'</small></h3><div class="pb"><div id="ml" style="max-height:55vh;overflow:auto;display:flex;flex-direction:column;gap:6px">'+r.messages.map(m=>'<div style="align-self:'+(m.from==="clinic"?"flex-end":"flex-start")+';max-width:78%;background:'+(m.from==="clinic"?"var(--soft)":"#f1f3f4")+';border-radius:10px;padding:7px 10px"><div style="white-space:pre-wrap">'+esc(m.text)+'</div><small style="color:var(--muted)">'+esc(m.from==="clinic"?m.by:"Patient")+' · '+tm(m.at)+'</small></div>').join("")+'</div><div style="display:flex;gap:6px"><textarea id="mt" rows="2" style="flex:1;border:1px solid var(--line);border-radius:6px;padding:7px" placeholder="Write a message"></textarea><button class="btn p" id="ms">Send</button></div><small style="color:var(--muted)">The patient sees this in the Rx Clinic app under My Patient ID → Messages.</small></div>';
 const ml=$("#ml");ml.scrollTop=ml.scrollHeight;
 $("#ms").onclick=async()=>{const t=$("#mt").value.trim();if(!t)return;try{await api("/api/chat/send",{patientId:pid,text:t});pageMessages(pid)}catch(e){toast(e.message)}};
}

// ---------- speciality templates (Gold and Platinum) ----------
const SPEC={
 "General surgery":{f:[["cc","Chief complaints",2],["hpi","History of present illness",3],["local","Local examination (site, size, tenderness, swelling, lymph nodes)",3],["pr","Per rectal / hernial orifices / genitalia",2]],ck:[["Abdomen",["Soft","Distended","Guarding","Rigidity","Rebound tenderness","Bowel sounds present","Free fluid","Palpable mass"]]],f2:[["impression","Provisional diagnosis",2],["plan","Plan (conservative / surgery, investigations)",3]]},
 "Obstetrics & gynaecology":{f:[["lmp","LMP and EDD",1],["obs","Obstetric score (G P L A) and past deliveries",2],["menstrual","Menstrual history",2],["complaints","Complaints",2],["pa","Per abdomen (fundal height, lie, presentation, FHR)",2],["pv","Per speculum / per vaginal",2]],ck:[["Antenatal checks",["BP normal","No pedal oedema","Fetal movements felt","Iron & folic acid","Tetanus toxoid","Anomaly scan done","GDM screen done"]]],f2:[["plan","Plan",3]]},
 "Paediatrics":{f:[["complaints","Complaints (from parent)",2],["birth","Birth history",2],["immunisation","Immunisation status",1],["development","Developmental milestones",2],["feeding","Feeding / diet",1],["growth","Weight, height, head circumference, centile",1]],ck:[["Danger signs",["Unable to feed","Lethargy","Convulsions","Chest indrawing","Dehydration","Fever > 5 days"]]],f2:[["plan","Plan (doses by weight)",3]]},
 "Orthopaedics":{f:[["injury","Mode of injury / onset",2],["look","Look (swelling, deformity, wound)",2],["feel","Feel (tenderness, warmth, crepitus)",2],["move","Move (range of motion, power)",2],["neuro","Distal neurovascular status",1],["xray","X-ray findings",2]],ck:[],f2:[["plan","Plan (POP, splint, surgery, physiotherapy)",3]]},
 "ENT":{f:[["ear","Ear (otoscopy, tuning fork)",2],["nose","Nose and sinuses",2],["throat","Throat and neck",2]],ck:[["Symptoms",["Hearing loss","Ear discharge","Tinnitus","Vertigo","Nasal block","Epistaxis","Sore throat","Dysphagia","Hoarseness"]]],f2:[["plan","Plan",2]]},
 "Ophthalmology":{f:[["va","Visual acuity (RE / LE, with pinhole)",1],["iop","IOP (RE / LE)",1],["anterior","Anterior segment",2],["fundus","Fundus",2],["refraction","Refraction",1]],ck:[],f2:[["plan","Plan (glasses, drops, surgery)",2]]},
 "Dermatology":{f:[["lesion","Lesion: site, type, size, distribution, colour",3],["duration","Duration and progression",1],["itch","Itching, triggers, contacts",1]],ck:[["Findings",["Macule","Papule","Plaque","Vesicle","Pustule","Scaling","Nail involvement","Hair involvement","Mucosal involvement"]]],f2:[["plan","Plan",2]]},
 "Cardiology":{f:[["cp","Chest pain (site, radiation, exertional)",2],["nyha","Breathlessness / NYHA class",1],["cvs","CVS examination (JVP, apex, murmurs)",2],["ecg","ECG",2],["echo","Echo",2]],ck:[["Risk factors",["Hypertension","Diabetes","Smoking","Dyslipidaemia","Family history","Obesity"]]],f2:[["plan","Plan",3]]},
 "Psychiatry":{f:[["complaints","Presenting complaints",2],["mse","Mental status examination",4],["risk","Risk assessment (self-harm, harm to others)",2]],ck:[],f2:[["plan","Plan (medicines, therapy, follow-up)",3]]},
};

// ---------- report files in the OPD Results tab ----------
const _paneResults=paneResults;
paneResults=async function(){_paneResults();const p=C.patient||C.visit.patient||{};if(!p.id)return;
 let files=[];try{files=(await api("/api/files/list",{patientId:p.id})).files}catch{}
 const box=document.createElement("div");box.className="panel";box.style.marginTop="12px";
 box.innerHTML='<h3>Report files (photos and PDFs) <small>'+files.length+'</small></h3><div class="pb"><div class="acts" style="justify-content:flex-start"><button class="btn p" id="up">Upload a report (photo or PDF)</button></div>'+files.map(f=>'<div style="display:flex;gap:10px;align-items:center"><button class="btn" data-fv="'+f.id+'">View</button>'+esc(f.name)+' · <small>'+tm(f.at)+' · '+esc(f.by)+'</small></div>').join("")+'</div>';
 $("#pane").appendChild(box);$$("[data-fv]",box).forEach(b=>b.onclick=()=>viewFile(b.dataset.fv));
 $("#up",box).onclick=async()=>{if(await uploadFor({patientId:p.id,visitId:C.visit.id}))chart(C.visit.id,true)}};

// ---------- routing ----------
route=async function(){
 const h=location.hash;let m;
 try{await ensureMe()}catch(e){$("#app").innerHTML='<div class="empty">'+esc(e.message)+'</div>';return}
 if(has("templates")&&!TPL["General surgery"])Object.assign(TPL,SPEC);
 drawMenu();
 try{
 if((m=h.match(/^#v-(.+)$/)))return await chart(m[1]);if((m=h.match(/^#ip-(.+)$/)))return await ipChart(m[1]);if((m=h.match(/^#ot-(.+)$/)))return await otRecord(m[1]);if(h==="#ot")return await otList();
 if(h==="#beds")return await pageBeds();if(h==="#followups")return await pageFollowups();if(h==="#pharmacy")return await pagePharmacy();if(h==="#lab")return await pageLab();
 if(h==="#insurance")return await pageInsurance();if(h==="#homecare")return await pageHomecare();if(h==="#accounts")return await pageAccounts();
 if((m=h.match(/^#camps-(.+)$/)))return await campView(m[1]);if(h==="#camps")return await pageCamps();
 if((m=h.match(/^#msg-(.+)$/)))return await pageMessages(m[1]);if(h==="#messages")return await pageMessages();
 if(ME.role==="pharmacy")return await pagePharmacy();if(ME.role==="lab"||ME.role==="diagnostics")return await pageLab();
 return await dashboard()}catch(e){$("#app").innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
};

route();
</script></body></html>`;
}


// Razorpay calls this when a payment link is paid; the bill gets the payment.
async function razorpayWebhook(request, env) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return json({ error: "Not set up" }, 404);
  const raw = await request.text();
  const sig = request.headers.get("x-razorpay-signature") || "";
  const mac = [...new Uint8Array(await hmac(env.RAZORPAY_WEBHOOK_SECRET, raw))].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (!safeEqual(mac, sig)) return json({ error: "Bad signature" }, 401);
  const e = JSON.parse(raw);
  if (e.event !== "payment_link.paid") return json({ ok: true });
  const pl = e.payload?.payment_link?.entity || {}, pay = e.payload?.payment?.entity || {};
  const id = String(pl.reference_id || "");
  const b = await getDoc(env, "bills", id);
  if (b && b.status !== "cancelled" && !(b.payments || []).some((p) => p.ref === pay.id)) {
    b.payments.push({ amount: Math.min(b.balance, money((pay.amount || pl.amount_paid || 0) / 100)), mode: "UPI", ref: pay.id || "razorpay", at: Date.now(), by: "Online payment" });
    computeBill(b); await putDoc(env, "bills", id, b);
    await notify(env, { to: "role:billing", title: "Online payment received", body: `${b.no} · ${b.patient?.name} · ₹${money((pay.amount || 0) / 100)}`, link: "" });
  }
  return json({ ok: true });
}


// ---------- patient web portal (/me): records, bills, reports and messages ----------
function mePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>My Patient ID · Rx Clinic</title>
<style>${WEB_CSS}main{max-width:680px;margin:0 auto;padding:16px max(16px,env(safe-area-inset-left)) 40px;display:flex;flex-direction:column;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.id{background:var(--teal);color:#fff;border-radius:14px;padding:16px}.id b{font:600 28px ui-monospace,monospace;display:block}
input,textarea{width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--card);color:var(--fg)}button{background:var(--teal);color:#fff;border:0;border-radius:8px;padding:12px 16px;font-weight:600}
.tabs{display:flex;gap:6px;overflow-x:auto}.tabs button{background:var(--soft);color:var(--fg)}.tabs button.on{background:var(--teal);color:#fff}.m{color:var(--muted);font-size:13px}.msg{max-width:80%;border-radius:10px;padding:8px 10px;margin:4px 0}
.err{color:var(--red)}</style></head><body><main id="app"></main><script>
const $=(s)=>document.querySelector(s);const esc=(s)=>String(s??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
(()=>{const m=location.hash.match(/^#s=([^&]+)/);if(m){try{sessionStorage.setItem("rx_psession",decodeURIComponent(m[1]))}catch{}history.replaceState(null,"","/me"+(location.hash.includes("chat")?"#chat":""))}})();
let S=(()=>{try{return sessionStorage.getItem("rx_psession")||localStorage.getItem("rx_psession")}catch{return null}})();
const tm=(ms)=>new Date(ms).toLocaleString("en-IN",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"});const inr=(x)=>"₹"+Math.round(x||0).toLocaleString("en-IN");
async function api(p,b={}){const r=await fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session:S,...b})});const j=await r.json();if(r.status===401&&S){try{localStorage.removeItem("rx_psession");sessionStorage.removeItem("rx_psession")}catch{};S=null;login();throw new Error("Please sign in")}if(!r.ok)throw new Error(j.error||"Error");return j}
function login(){$("#app").innerHTML='<div class="logo"><span class="rx">℞</span>Rx Clinic</div><div class="card"><h2 style="margin-top:0">My Patient ID</h2><p class="m">Sign in with your Patient ID, mobile or Aadhaar and your password.</p><input id="l" placeholder="Patient ID, mobile or Aadhaar"><br><br><input id="p" type="password" placeholder="Password"><p class="err" id="e"></p><button id="go">Sign in</button><p class="m">New here? Register in the Rx Clinic app, or ask the reception desk.</p></div>';
 $("#go").onclick=async()=>{try{const r=await fetch("/api/patient/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({login:$("#l").value,password:$("#p").value})});const j=await r.json();if(!r.ok)throw new Error(j.error);S=j.session;try{localStorage.setItem("rx_psession",S)}catch{};show("visits")}catch(err){$("#e").textContent=err.message}}}
let D=null;
async function show(tab){try{D=D||await api("/api/patient/me")}catch(e){return}const p=D.patient;
 $("#app").innerHTML='<div class="id"><small>PATIENT ID</small><b>'+esc(p.id)+'</b>'+esc(p.name)+' · '+esc([p.age?p.age+" y":"",p.sex].filter(Boolean).join(" · "))+'</div><div class="tabs">'+[["visits","Visits & prescriptions"],["bills","Bills"],["chat","Messages"]].map(([k,l])=>'<button data-t="'+k+'" class="'+(tab===k?"on":"")+'">'+l+'</button>').join("")+'<button id="so" style="background:none;color:var(--muted)">Sign out</button></div><div id="pane"></div>';
 document.querySelectorAll("[data-t]").forEach(b=>b.onclick=()=>show(b.dataset.t));$("#so").onclick=()=>{try{localStorage.removeItem("rx_psession");sessionStorage.removeItem("rx_psession")}catch{};S=null;D=null;login()};
 const pane=$("#pane");
 if(tab==="visits")pane.innerHTML=(D.visits.map(v=>'<div class="card"><b>'+esc(v.date)+'</b> · '+esc(v.doctor||"")+'<div>'+esc(v.diagnosis||v.complaint||"")+'</div>'+((v.rx&&v.rx.items)||[]).map(i=>'<div class="m">• '+esc([i.form,i.generic,i.strength,i.dose,i.frequency,i.timing,i.duration].filter(Boolean).join(" "))+'</div>').join("")+(v.reports||[]).filter(r=>r.status==="reported").map(r=>'<div class="m"><b>'+esc(r.test)+':</b> '+esc(r.impression||r.result)+'</div>').join("")+'</div>').join("")||'<div class="card m">No visits yet.</div>');
 else if(tab==="bills")pane.innerHTML=(D.bills.map(b=>'<div class="card"><b>'+esc(b.deptName)+' · '+esc(b.no)+'</b> · '+esc(b.date)+'<div>'+inr(b.total)+(b.balance>0?' · <span class="err">due '+inr(b.balance)+'</span>':' · paid')+'</div></div>').join("")||'<div class="card m">No bills.</div>');
 else{const r=await api("/api/chat/get");pane.innerHTML='<div class="card"><div id="ml" style="max-height:55vh;overflow:auto;display:flex;flex-direction:column">'+(r.messages.map(m=>'<div class="msg" style="align-self:'+(m.from==="patient"?"flex-end":"flex-start")+';background:'+(m.from==="patient"?"var(--soft)":"var(--band)")+'">'+esc(m.text)+'<div class="m">'+(m.from==="patient"?"You":esc(m.by))+' · '+tm(m.at)+'</div></div>').join("")||'<p class="m">Send a message to the clinic. The staff will reply here.</p>')+'</div><br><textarea id="t" rows="2" placeholder="Write a message"></textarea><br><br><button id="s">Send</button></div>';
  const ml=$("#ml");ml.scrollTop=ml.scrollHeight;$("#s").onclick=async()=>{const t=$("#t").value.trim();if(!t)return;try{await api("/api/chat/send",{text:t});show("chat")}catch(e){alert(e.message)}}}}
if(S)show(location.hash==="#chat"?"chat":"visits");else login();
</script></body></html>`;
}
