// db.js — SQLite database setup and helpers
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "handled.db");
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma("journal_mode = WAL");

// ─── Migrations ───────────────────────────────────────────────
const existingCols = db.pragma("table_info(daily_usage)").map(c => c.name);
if (!existingCols.includes("voice_count")) {
  db.exec("ALTER TABLE daily_usage ADD COLUMN voice_count INTEGER DEFAULT 0");
  console.log("[Migration] Added voice_count column");
}

// ─── Schema ───────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    timezone TEXT DEFAULT 'America/Chicago',
    briefing_hour INTEGER DEFAULT 7,
    trial_start TEXT,
    is_paid INTEGER DEFAULT 0,
    stripe_customer_id TEXT,
    plan TEXT DEFAULT 'trial',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    provider TEXT NOT NULL,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT,
    token_expiry TEXT,
    scopes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(phone, provider)
  );

  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(phone, key)
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    task TEXT NOT NULL,
    due_at TEXT NOT NULL,
    sent INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    date TEXT NOT NULL,
    message_count INTEGER DEFAULT 0,
    voice_count INTEGER DEFAULT 0,
    UNIQUE(phone, date)
  );

  CREATE TABLE IF NOT EXISTS scheduled_briefings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    briefing_prompt TEXT NOT NULL,
    schedule_hour INTEGER NOT NULL,
    schedule_minute INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    last_sent TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Encryption helpers for OAuth tokens ──────────────────────
const ALGO = "aes-256-gcm";
const KEY = Buffer.from(process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex"), "hex");

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

function decrypt(data) {
  const [ivHex, tagHex, encrypted] = data.split(":");
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ─── User helpers ─────────────────────────────────────────────
function getOrCreateUser(phone) {
  let user = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone);
  if (!user) {
    db.prepare(
      "INSERT INTO users (phone, trial_start) VALUES (?, datetime('now'))"
    ).run(phone);
    user = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone);
  }
  return user;
}

function updateUser(phone, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const vals = keys.map((k) => fields[k]);
  db.prepare(`UPDATE users SET ${sets}, updated_at = datetime('now') WHERE phone = ?`).run(
    ...vals,
    phone
  );
}

function isTrialActive(user) {
  if (user.is_paid) return true;
  if (!user.trial_start) return false;
  const trialDays = 999999;
  const start = new Date(user.trial_start);
  const now = new Date();
  const diffDays = (now - start) / (1000 * 60 * 60 * 24);
  return diffDays <= trialDays;
}

function trialDaysLeft(user) {
  const trialDays = 999999;
  const start = new Date(user.trial_start);
  const now = new Date();
  const diffDays = (now - start) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.ceil(trialDays - diffDays));
}

// ─── OAuth token helpers ──────────────────────────────────────
function saveOAuthTokens(phone, provider, tokens) {
  const accessEnc = encrypt(tokens.access_token);
  const refreshEnc = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
  db.prepare(`
    INSERT INTO oauth_tokens (phone, provider, access_token_enc, refresh_token_enc, token_expiry, scopes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone, provider) DO UPDATE SET
      access_token_enc = excluded.access_token_enc,
      refresh_token_enc = COALESCE(excluded.refresh_token_enc, oauth_tokens.refresh_token_enc),
      token_expiry = excluded.token_expiry,
      updated_at = datetime('now')
  `).run(
    phone,
    provider,
    accessEnc,
    refreshEnc,
    tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    tokens.scope || null
  );
}

function getOAuthTokens(phone, provider) {
  const row = db.prepare(
    "SELECT * FROM oauth_tokens WHERE phone = ? AND provider = ?"
  ).get(phone, provider);
  if (!row) return null;
  return {
    access_token: decrypt(row.access_token_enc),
    refresh_token: row.refresh_token_enc ? decrypt(row.refresh_token_enc) : null,
    expiry_date: row.token_expiry ? new Date(row.token_expiry).getTime() : null,
  };
}

function hasProvider(phone, provider) {
  return !!db.prepare(
    "SELECT 1 FROM oauth_tokens WHERE phone = ? AND provider = ?"
  ).get(phone, provider);
}

// ─── Memory helpers ───────────────────────────────────────────
function setMemory(phone, key, value) {
  db.prepare(`
    INSERT INTO memory (phone, key, value) VALUES (?, ?, ?)
    ON CONFLICT(phone, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(phone, key, value);
}

function getMemory(phone) {
  return db.prepare("SELECT key, value FROM memory WHERE phone = ?").all(phone);
}

// ─── Conversation helpers ─────────────────────────────────────
function addMessage(phone, role, content) {
  db.prepare(
    "INSERT INTO conversations (phone, role, content) VALUES (?, ?, ?)"
  ).run(phone, role, content);
}

function getRecentMessages(phone, limit = 20) {
  return db
    .prepare(
      "SELECT role, content FROM conversations WHERE phone = ? ORDER BY id DESC LIMIT ?"
    )
    .all(phone, limit)
    .reverse();
}

// ─── Reminder helpers ─────────────────────────────────────────
function addReminder(phone, task, dueAt) {
  db.prepare(
    "INSERT INTO reminders (phone, task, due_at) VALUES (?, ?, ?)"
  ).run(phone, task, dueAt);
}

function getDueReminders() {
  // Get all unsent reminders and check in JavaScript (SQLite string comparison fails with mixed ISO formats)
  const all = db.prepare("SELECT * FROM reminders WHERE sent = 0").all();
  const now = Date.now();
  return all.filter(r => {
    try {
      const dueTime = new Date(r.due_at).getTime();
      return dueTime <= now;
    } catch (e) {
      return false;
    }
  });
}

function markReminderSent(id) {
  db.prepare("UPDATE reminders SET sent = 1 WHERE id = ?").run(id);
}

// ─── Activity log ─────────────────────────────────────────────
function logActivity(phone, action, detail = null) {
  db.prepare(
    "INSERT INTO activity_log (phone, action, detail) VALUES (?, ?, ?)"
  ).run(phone, action, detail);
}

function getActivity(phone, limit = 50) {
  return db
    .prepare(
      "SELECT action, detail, created_at FROM activity_log WHERE phone = ? ORDER BY id DESC LIMIT ?"
    )
    .all(phone, limit);
}

// --- Daily usage helpers ---
function getDailyMessageCount(phone) {
  const today = new Date().toISOString().split('T')[0];
  const row = db.prepare("SELECT message_count FROM daily_usage WHERE phone = ? AND date = ?").get(phone, today);
  return row ? row.message_count : 0;
}

function getDailyVoiceCount(phone) {
  const today = new Date().toISOString().split("T")[0];
  const row = db.prepare("SELECT voice_count FROM daily_usage WHERE phone = ? AND date = ?").get(phone, today);
  return row ? row.voice_count : 0;
}

function incrementDailyVoiceCount(phone) {
  const today = new Date().toISOString().split("T")[0];
  db.prepare("INSERT INTO daily_usage (phone, date, voice_count) VALUES (?, ?, 1) ON CONFLICT(phone, date) DO UPDATE SET voice_count = voice_count + 1").run(phone, today);
}

function incrementDailyMessageCount(phone) {
  const today = new Date().toISOString().split('T')[0];
  db.prepare("INSERT INTO daily_usage (phone, date, message_count) VALUES (?, ?, 1) ON CONFLICT(phone, date) DO UPDATE SET message_count = message_count + 1").run(phone, today);
}

// --- Scheduled briefing helpers ---
function addScheduledBriefing(phone, prompt, hour, minute) {
  db.prepare("INSERT INTO scheduled_briefings (phone, briefing_prompt, schedule_hour, schedule_minute) VALUES (?, ?, ?, ?)").run(phone, prompt, hour, minute || 0);
}

function getAllScheduledBriefings() {
  return db.prepare("SELECT sb.*, u.timezone, u.phone, u.name FROM scheduled_briefings sb JOIN users u ON sb.phone = u.phone WHERE sb.enabled = 1").all();
}

function getScheduledBriefings(phone) {
  return db.prepare("SELECT * FROM scheduled_briefings WHERE phone = ? AND enabled = 1").all(phone);
}

function getAllDueBriefings() {
  return db.prepare("SELECT sb.*, u.timezone, u.phone, u.name FROM scheduled_briefings sb JOIN users u ON sb.phone = u.phone WHERE sb.enabled = 1").all();
}

function removeScheduledBriefings(phone) {
  db.prepare("DELETE FROM scheduled_briefings WHERE phone = ?").run(phone);
}

function markBriefingSent(id) {
  db.prepare("UPDATE scheduled_briefings SET last_sent = datetime('now') WHERE id = ?").run(id);
}

module.exports = {
  db,
  encrypt,
  decrypt,
  getOrCreateUser,
  updateUser,
  isTrialActive,
  trialDaysLeft,
  saveOAuthTokens,
  getOAuthTokens,
  hasProvider,
  setMemory,
  getMemory,
  addMessage,
  getRecentMessages,
  addReminder,
  getDueReminders,
  markReminderSent,
  logActivity,
  getActivity,
  getDailyMessageCount,
  incrementDailyMessageCount,
  getDailyVoiceCount,
  incrementDailyVoiceCount,
  addScheduledBriefing,
  getScheduledBriefings,
  getAllScheduledBriefings,
  getAllDueBriefings,
  removeScheduledBriefings,
  markBriefingSent,
};
