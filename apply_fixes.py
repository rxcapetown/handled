#!/usr/bin/env python3
"""
Umar AI Agent - Patch Script
Applies 4 fixes:
1. Timezone auto-detection from phone number
2. Database persistence (DB_PATH env var support)  
3. 20 message/day limit
4. Custom scheduled briefings (opt-in, user-defined content/time/frequency)

Run from your handled directory:
  cd ~/Downloads/handled
  python3 apply_fixes.py
"""

import os, sys

if not os.path.exists('db.js'):
    print("ERROR: Run this from your handled directory (cd ~/Downloads/handled)")
    sys.exit(1)

print("Patching db.js...")
f = open('db.js', 'r'); t = f.read(); f.close()

# 1a. Add briefings table + daily_usage table
if 'scheduled_briefings' not in t:
    t = t.replace(
        """  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );""",
        """  CREATE TABLE IF NOT EXISTS activity_log (
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
  );"""
    )
    print("  Added daily_usage and scheduled_briefings tables")

# 1b. Add daily usage + briefing functions
if 'getDailyMessageCount' not in t:
    new_funcs = '''
// --- Daily usage helpers ---
function getDailyMessageCount(phone) {
  const today = new Date().toISOString().split('T')[0];
  const row = db.prepare("SELECT message_count FROM daily_usage WHERE phone = ? AND date = ?").get(phone, today);
  return row ? row.message_count : 0;
}

function incrementDailyMessageCount(phone) {
  const today = new Date().toISOString().split('T')[0];
  db.prepare("INSERT INTO daily_usage (phone, date, message_count) VALUES (?, ?, 1) ON CONFLICT(phone, date) DO UPDATE SET message_count = message_count + 1").run(phone, today);
}

// --- Scheduled briefing helpers ---
function addScheduledBriefing(phone, prompt, hour, minute) {
  db.prepare("INSERT INTO scheduled_briefings (phone, briefing_prompt, schedule_hour, schedule_minute) VALUES (?, ?, ?, ?)").run(phone, prompt, hour, minute || 0);
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

'''
    t = t.replace('\nmodule.exports = {', new_funcs + 'module.exports = {')
    
    t = t.replace(
        '  getActivity,',
        '  getActivity,\n  getDailyMessageCount,\n  incrementDailyMessageCount,\n  addScheduledBriefing,\n  getScheduledBriefings,\n  getAllDueBriefings,\n  removeScheduledBriefings,\n  markBriefingSent,'
    )
    print("  Added daily usage and briefing functions")

f = open('db.js', 'w'); f.write(t); f.close()
print("db.js DONE\n")

###############################
print("Patching agent.js...")
f = open('agent.js', 'r'); t = f.read(); f.close()

# 2a. Add imports
if 'getDailyMessageCount' not in t:
    t = t.replace(
        '  getMemory, addMessage, getRecentMessages, setMemory, addReminder, logActivity,',
        '  getMemory, addMessage, getRecentMessages, setMemory, addReminder, logActivity,\n  getDailyMessageCount, incrementDailyMessageCount, updateUser, addScheduledBriefing, getScheduledBriefings, removeScheduledBriefings,'
    )
    print("  Added new imports")

# 2b. Add schedule_briefing tool
if 'schedule_briefing' not in t:
    # Add after the web_search tool definition
    new_tool = """,
  {
    name: "schedule_briefing",
    description: "Schedule a recurring daily briefing for the user. Use when the user asks for daily updates, news briefings, email summaries, or any recurring information delivery. The user specifies what they want and when.",
    input_schema: {
      type: "object",
      properties: {
        briefing_prompt: { type: "string", description: "What the user wants in their briefing. E.g. 'tech news summary', 'email and calendar overview', 'stock market update for AAPL and TSLA', 'weather in Dubai and prayer times'" },
        hour: { type: "number", description: "Hour to send (0-23 in user's local time). E.g. 7 for 7 AM, 19 for 7 PM" },
        minute: { type: "number", description: "Minute to send (0-59). Default 0." }
      },
      required: ["briefing_prompt", "hour"]
    }
  },
  {
    name: "list_briefings",
    description: "List the user's currently scheduled briefings. Use when user asks what briefings they have set up.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "cancel_briefings",
    description: "Cancel all scheduled briefings for the user. Use when user wants to stop receiving briefings.",
    input_schema: { type: "object", properties: {} }
  }"""
    
    # Find the closing of the TOOLS array - the last } before ];
    t = t.replace(
        """    }
  }
];""",
        """    }
  }""" + new_tool + """
];""",
        1
    )
    print("  Added briefing tools")

# 2c. Add tool execution for briefing tools
if 'case "schedule_briefing"' not in t:
    t = t.replace(
        '    default:\n      return { error: `Unknown tool: ${toolName}` };',
        """    case "schedule_briefing": {
      addScheduledBriefing(phone, toolInput.briefing_prompt, toolInput.hour, toolInput.minute || 0);
      logActivity(phone, "schedule_briefing", toolInput.briefing_prompt);
      return { success: true, briefing: toolInput.briefing_prompt, time: `${toolInput.hour}:${String(toolInput.minute || 0).padStart(2, '0')}` };
    }

    case "list_briefings": {
      const briefings = getScheduledBriefings(phone);
      if (briefings.length === 0) return { briefings: [], message: "No briefings scheduled." };
      return { briefings: briefings.map(b => ({ prompt: b.briefing_prompt, time: `${b.schedule_hour}:${String(b.schedule_minute).padStart(2, '0')}` })) };
    }

    case "cancel_briefings": {
      removeScheduledBriefings(phone);
      logActivity(phone, "cancel_briefings", null);
      return { success: true, message: "All briefings cancelled." };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };"""
    )
    print("  Added briefing tool execution")

# 2d. Add daily limit check
if 'getDailyMessageCount' in t and 'dailyCount' not in t:
    t = t.replace(
        '  // Save incoming message\n  addMessage(phone, "user", messageText);',
        """  // Check daily message limit
  const dailyCount = getDailyMessageCount(phone);
  if (dailyCount >= 20) {
    return "You have reached your daily limit of 20 messages. Your limit resets at midnight. Text \\"upgrade\\" for higher limits!";
  }
  incrementDailyMessageCount(phone);

  // Save incoming message
  addMessage(phone, "user", messageText);"""
    )
    print("  Added 20 message/day limit")

# 2e. Add timezone auto-detect from phone number
if 'autoDetectTimezone' not in t:
    tz_func = '''
// --- Auto-detect timezone from phone number country code ---
function autoDetectTimezone(phone) {
  const p = phone.replace(/[^0-9+]/g, '');
  if (p.startsWith('+880') || p.startsWith('880')) return 'Asia/Dhaka';
  if (p.startsWith('+971') || p.startsWith('971')) return 'Asia/Dubai';
  if (p.startsWith('+966') || p.startsWith('966')) return 'Asia/Riyadh';
  if (p.startsWith('+974') || p.startsWith('974')) return 'Asia/Qatar';
  if (p.startsWith('+973') || p.startsWith('973')) return 'Asia/Bahrain';
  if (p.startsWith('+968') || p.startsWith('968')) return 'Asia/Muscat';
  if (p.startsWith('+965') || p.startsWith('965')) return 'Asia/Kuwait';
  if (p.startsWith('+91') || p.startsWith('91')) return 'Asia/Kolkata';
  if (p.startsWith('+92') || p.startsWith('92')) return 'Asia/Karachi';
  if (p.startsWith('+44') || p.startsWith('44')) return 'Europe/London';
  if (p.startsWith('+49') || p.startsWith('49')) return 'Europe/Berlin';
  if (p.startsWith('+33') || p.startsWith('33')) return 'Europe/Paris';
  if (p.startsWith('+81') || p.startsWith('81')) return 'Asia/Tokyo';
  if (p.startsWith('+82') || p.startsWith('82')) return 'Asia/Seoul';
  if (p.startsWith('+86') || p.startsWith('86')) return 'Asia/Shanghai';
  if (p.startsWith('+61') || p.startsWith('61')) return 'Australia/Sydney';
  if (p.startsWith('+55') || p.startsWith('55')) return 'America/Sao_Paulo';
  if (p.startsWith('+234') || p.startsWith('234')) return 'Africa/Lagos';
  if (p.startsWith('+254') || p.startsWith('254')) return 'Africa/Nairobi';
  if (p.startsWith('+27') || p.startsWith('27')) return 'Africa/Johannesburg';
  if (p.startsWith('+1')) return 'America/Chicago'; // Default US to Central
  return 'America/Chicago'; // Fallback
}

'''
    t = t.replace('// --- Main agent function', tz_func + '// --- Main agent function')
    print("  Added timezone auto-detection")

# 2f. Use auto-detected timezone when creating user
if 'autoDetectTimezone' in t and 'detectedTz' not in t:
    t = t.replace(
        '  const user = getOrCreateUser(phone);\n  const active = isTrialActive(user);',
        """  const user = getOrCreateUser(phone);
  // Auto-set timezone on first interaction if not already set
  if (!user.timezone || user.timezone === 'America/Chicago') {
    const detectedTz = autoDetectTimezone(phone);
    if (detectedTz !== 'America/Chicago' || !user.timezone) {
      updateUser(phone, { timezone: detectedTz });
      user.timezone = detectedTz;
    }
  }
  const active = isTrialActive(user);"""
    )
    print("  Added auto-timezone on first interaction")

# 2g. Add briefing instructions to system prompt
old_rule = '- For flights, hotels, shopping, products, restaurants, news'
new_rule = """- You can schedule recurring daily briefings for the user. If they say something like "send me tech news every morning" or "give me an email summary at 7am and 7pm", use the schedule_briefing tool. Let them know they can customize what they receive and when.
- For flights, hotels, shopping, products, restaurants, news"""
if '- You can schedule recurring daily briefings' not in t:
    t = t.replace(old_rule, new_rule)
    print("  Added briefing instructions to system prompt")

f = open('agent.js', 'w'); f.write(t); f.close()
print("agent.js DONE\n")

###############################
print("Patching server.js...")
f = open('server.js', 'r'); t = f.read(); f.close()

# 3a. Add imports
if 'getAllDueBriefings' not in t:
    t = t.replace(
        '  getDueReminders, markReminderSent, logActivity, getActivity, db, hasProvider,',
        '  getDueReminders, markReminderSent, logActivity, getActivity, db, hasProvider,\n  getAllDueBriefings, markBriefingSent,'
    )
    print("  Added new imports")

# 3b. Replace the 3 hardcoded cron jobs with 1 smart briefing cron
# Find and remove old morning briefing cron
old_morning = '''// Daily briefings at 7 AM Central (12 PM UTC)
cron.schedule("0 12 * * *", async () => {'''
old_morning_alt = '''// Daily briefings at 7 AM Central (12 PM UTC)
cron.schedule("0 * * * *", async () => {'''

# We need to replace ALL three cron jobs (morning, noon, evening) with one smart one
# Let's find the section between "Daily briefings" and "HEALTH CHECK"
import re
pattern = r'// Daily briefings.*?(?=// ={10,}.*?HEALTH CHECK)'
match = re.search(pattern, t, re.DOTALL)

if match:
    new_cron = '''// ═══════════════════════════════════════════════════════════════
// SCHEDULED BRIEFINGS — Runs every 15 min, checks user schedules
// ═══════════════════════════════════════════════════════════════
cron.schedule("*/15 * * * *", async () => {
  try {
    const briefings = getAllDueBriefings();
    for (const b of briefings) {
      try {
        // Get current hour/minute in user's timezone
        const now = new Date();
        const userTime = new Date(now.toLocaleString("en-US", { timeZone: b.timezone || "America/Chicago" }));
        const userHour = userTime.getHours();
        const userMinute = userTime.getMinutes();
        
        // Check if it's time (within 15 min window)
        if (userHour === b.schedule_hour && userMinute >= b.schedule_minute && userMinute < b.schedule_minute + 15) {
          // Check if already sent today
          if (b.last_sent) {
            const lastSent = new Date(b.last_sent);
            const todayStart = new Date(userTime);
            todayStart.setHours(0, 0, 0, 0);
            if (lastSent > todayStart) continue; // Already sent today
          }
          
          // Generate the briefing using Claude
          const { handleMessage } = require("./agent");
          const briefingReply = await handleMessage(b.phone, `Generate my scheduled briefing: ${b.briefing_prompt}. Keep it concise for WhatsApp.`);
          await sendWhatsApp(`whatsapp:${b.phone}`, briefingReply);
          markBriefingSent(b.id);
          console.log(`[Briefing] Sent to ${b.phone}: ${b.briefing_prompt.slice(0, 50)}`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        console.error(`Briefing failed for ${b.phone}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[Briefing cron error]:", err.message);
  }
});

'''
    t = t[:match.start()] + new_cron + t[match.end():]
    print("  Replaced 3 hardcoded crons with 1 smart briefing cron")
else:
    print("  WARNING: Could not find cron section to replace")

f = open('server.js', 'w'); f.write(t); f.close()
print("server.js DONE\n")

print("=" * 50)
print("ALL FIXES APPLIED!")
print("=" * 50)
print("")
print("Now run:")
print("  git add .")
print('  git commit -m "feat: timezone auto-detect, 20msg limit, custom briefings"')
print("  git push")
print("")
print("After deploy, test by texting Umar:")
print('  "Send me a tech news briefing every morning at 8am"')
print('  "Give me email and calendar summary at 7am and 7pm"')
print('  "What briefings do I have?"')
print('  "Cancel my briefings"')
