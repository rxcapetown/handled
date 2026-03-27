// agent.js — The AI agent brain powered by Claude
const Anthropic = require("@anthropic-ai/sdk");
const {
  getOrCreateUser, isTrialActive, trialDaysLeft, hasProvider,
  getMemory, addMessage, getRecentMessages, setMemory, addReminder, logActivity,
  getDailyMessageCount, incrementDailyMessageCount, updateUser, addScheduledBriefing, getScheduledBriefings, removeScheduledBriefings,
} = require("./db");
const google = require("./tools/google");

const client = new Anthropic();

// ─── Tool definitions for Claude ──────────────────────────────
const TOOLS = [
  {
    name: "list_emails",
    description: "List the user's recent or unread emails from Gmail. Use this when the user asks to check email, see what's new, or look for specific emails.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query. Default: 'is:unread'. Examples: 'from:boss@company.com', 'subject:invoice', 'is:important'" },
        max_results: { type: "number", description: "Number of emails to return. Default: 5, max: 10." }
      }
    }
  },
  {
    name: "read_email",
    description: "Read the full content of a specific email by its ID. Use after listing emails when the user wants to see the full content.",
    input_schema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "The email ID from list_emails results" }
      },
      required: ["email_id"]
    }
  },
  {
    name: "draft_reply",
    description: "Draft a reply to an email. Returns the draft for user approval before sending.",
    input_schema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "The email ID to reply to" },
        reply_text: { type: "string", description: "The reply message body" }
      },
      required: ["email_id", "reply_text"]
    }
  },
  {
    name: "list_events",
    description: "List upcoming calendar events. Use when user asks about their schedule, today's meetings, or upcoming events.",
    input_schema: {
      type: "object",
      properties: {
        days_ahead: { type: "number", description: "Number of days ahead to look. Default: 7" }
      }
    }
  },
  {
    name: "create_event",
    description: "Create a new calendar event. Use when user wants to schedule something.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title" },
        start_time: { type: "string", description: "ISO 8601 start time" },
        end_time: { type: "string", description: "ISO 8601 end time (optional, defaults to 1 hour after start)" },
        description: { type: "string", description: "Event description (optional)" },
        location: { type: "string", description: "Event location (optional)" }
      },
      required: ["summary", "start_time"]
    }
  },
  {
    name: "set_reminder",
    description: "Set a reminder for the user. The agent will send a WhatsApp message when the reminder is due.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What to remind the user about" },
        due_at: { type: "string", description: "ISO 8601 datetime for when to send the reminder" }
      },
      required: ["task", "due_at"]
    }
  },
  {
    name: "remember",
    description: "Store a fact about the user for future reference. Use when the user shares personal info, preferences, or important context.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Short label like 'dentist_name', 'kids_ages', 'preferred_airline'" },
        value: { type: "string", description: "The information to remember" }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "web_search",
    description: "Search the web for current information. Use for flights, hotels, shopping, product prices, news, restaurants, weather, or any question requiring up-to-date info. Always use this when user asks to find, search, look up, or compare things.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query. Be specific. E.g. 'cheap flights Dallas to Dhaka June 2026', 'AirPods Pro price comparison', 'best Italian restaurant Fort Worth'" }
      },
      required: ["query"]
    }
  },
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
  }
];

// ─── Execute tool calls ───────────────────────────────────────
async function executeTool(phone, toolName, toolInput) {
  switch (toolName) {
    case "list_emails":
      return await google.listEmails(phone, toolInput.query || "is:unread", toolInput.max_results || 5);

    case "read_email":
      return await google.readEmail(phone, toolInput.email_id);

    case "draft_reply":
      return await google.draftReply(phone, toolInput.email_id, toolInput.reply_text);

    case "list_events": {
      const now = new Date();
      const daysAhead = toolInput.days_ahead || 7;
      const timeMax = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
      return await google.listEvents(phone, now.toISOString(), timeMax);
    }

    case "create_event":
      return await google.createEvent(phone, {
        summary: toolInput.summary,
        startTime: toolInput.start_time,
        endTime: toolInput.end_time,
        description: toolInput.description,
        location: toolInput.location,
      });

    case "set_reminder": {
      // Get user timezone for correct time conversion
      const reminderUser = getOrCreateUser(phone);
      const userTz = reminderUser.timezone || "America/Chicago";
      
      // Parse the due_at and ensure it is stored correctly
      let dueDate = new Date(toolInput.due_at);
      
      // If the date seems invalid, try to interpret it
      if (isNaN(dueDate.getTime())) {
        return { error: "Could not understand the date/time. Please use a format like: 2026-03-27T14:00:00" };
      }
      
      const dueAtISO = dueDate.toISOString();
      addReminder(phone, toolInput.task, dueAtISO);
      logActivity(phone, "set_reminder", toolInput.task);
      return { success: true, task: toolInput.task, due_at: dueAtISO, timezone: userTz };
    }

    case "remember":
      setMemory(phone, toolInput.key, toolInput.value);
      return { success: true, remembered: `${toolInput.key}: ${toolInput.value}` };

    case "web_search": {
      try {
        // Use Claude with web search tool to get real-time results
        const searchResponse = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: `Search the web for: ${toolInput.query}. Return a concise summary of the top results with specific details like prices, dates, links, and ratings where available.` }],
        });
        // Extract all text from the response
        const searchText = searchResponse.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        logActivity(phone, "web_search", toolInput.query);
        return { results: searchText || "No results found." };
      } catch (err) {
        console.error("Web search error:", err.message);
        return { error: `Search failed: ${err.message}` };
      }
    }

    case "schedule_briefing": {
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
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ─── Auto-detect timezone from phone number ──────────────────
function detectTimezone(phone) {
  const tzMap = {
    "+880": "Asia/Dhaka",
    "+971": "Asia/Dubai",
    "+966": "Asia/Riyadh",
    "+974": "Asia/Qatar",
    "+973": "Asia/Bahrain",
    "+968": "Asia/Muscat",
    "+965": "Asia/Kuwait",
    "+44": "Europe/London",
    "+91": "Asia/Kolkata",
    "+92": "Asia/Karachi",
    "+234": "Africa/Lagos",
    "+254": "Africa/Nairobi",
    "+55": "America/Sao_Paulo",
    "+49": "Europe/Berlin",
    "+33": "Europe/Paris",
    "+61": "Australia/Sydney",
    "+81": "Asia/Tokyo",
    "+86": "Asia/Shanghai",
    "+82": "Asia/Seoul",
    "+63": "Asia/Manila",
    "+60": "Asia/Kuala_Lumpur",
    "+62": "Asia/Jakarta",
    "+20": "Africa/Cairo",
    "+27": "Africa/Johannesburg",
    "+52": "America/Mexico_City",
    "+1": "America/Chicago",
  };
  for (const [prefix, tz] of Object.entries(tzMap).sort((a, b) => b[0].length - a[0].length)) {
    if (phone.startsWith(prefix)) return tz;
  }
  return "America/Chicago";
}

// ─── Build system prompt ──────────────────────────────────────
function buildSystemPrompt(user, memories, hasGmail, hasCalendar) {
  const memoryBlock = memories.length > 0
    ? `\n\nThings you remember about this user:\n${memories.map((m) => `- ${m.key}: ${m.value}`).join("\n")}`
    : "";

  const connectionStatus = [];
  if (hasGmail) connectionStatus.push("Gmail is connected — you can read and manage their email.");
  else connectionStatus.push("Gmail is NOT connected. If they ask about email, tell them to connect it first.");
  if (hasCalendar) connectionStatus.push("Google Calendar is connected — you can read and create events.");
  else connectionStatus.push("Google Calendar is NOT connected via the same Google auth. If Gmail is connected, Calendar is too.");

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const currentTime = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: user.timezone || "America/Chicago" });

  return `You are Umar, a personal AI agent. You communicate via WhatsApp. You are helpful, concise, and action-oriented. You don't just answer questions — you DO things for the user.

Today is ${today}. Current time: ${currentTime} (${user.timezone || "America/Chicago"}).

The user's name is ${user.name || "unknown (ask them)"}.
Their phone number is ${user.phone}.
Connect page URL: ${process.env.BASE_URL}/connect?phone=${encodeURIComponent(user.phone)}

${connectionStatus.join("\n")}
${memoryBlock}

IMPORTANT RULES:
- Keep responses SHORT. This is WhatsApp, not email. 2-4 sentences max unless listing emails/events.
- Use emoji sparingly but naturally. You're a helpful assistant, not a robot.
- When you learn something new about the user (name, preferences, contacts), use the 'remember' tool.
- For email actions that send messages, ALWAYS draft first and ask for confirmation before sending.
- If the user asks to do something that requires a connection you don't have, give them the connect page URL (not a raw OAuth link). Say something like "To connect your email, tap here: [connect URL]"
- Be proactive: if you notice something important (urgent email, upcoming meeting), mention it.
- Speak the user's language. If they text in Bangla, respond in Bangla. If Spanish, respond in Spanish.
- Never mention that you're powered by Claude, OpenClaw, or any technical details. You are "Umar."
- You CAN listen to and understand voice notes. If a user sends a voice note, you will receive the transcribed text automatically. If asked, tell users "Yes, I can listen to voice notes! Just send me one and I'll respond."
- You can schedule recurring daily briefings for the user. If they say something like "send me tech news every morning" or "give me an email summary at 7am and 7pm", use the schedule_briefing tool. Let them know they can customize what they receive and when.
- For flights, hotels, shopping, products, restaurants, news — use the web_search tool. ALWAYS include direct clickable URLs so the user can tap and buy or book immediately. Format each link on its own line so they are tappable in WhatsApp.
- When a NEW user says "hi" or "hello" for the first time (no name in memory), introduce yourself warmly and ask their name. Then offer to connect their accounts using the connect page URL.

GREETING BEHAVIOR (ALWAYS use this EXACT format when user says hi/hello/hey or similar greeting):
"Hi I am Umar, your super powered assistant! Here's what I can help you with:

Shopping and finding the best deals
Flight tickets and travel bookings
Hotels and holiday planning
Stock and crypto research
Daily news and updates
Check emails and calendars
Business ideas and recommendations

And much more!

Would you like to receive daily or customized briefings? (Y/N)"

BRIEFING OPT-IN FLOW:
- If user responds YES/Y/yes/yep/sure/yeah after the greeting:
  Ask: "Great! Would you like:
  1. Daily Briefing (Top news, stocks, weather, etc.)
  2. Customized Briefing (You choose topics)
  Reply with 1 or 2"

- If user responds NO/N/no/nope/nah:
  Save briefing preference as disabled using the remember tool (key: "briefings_enabled", value: "false")
  Respond: "No problem! I won't send any briefings. Just text me whenever you need help!"

- If user selects 1 (Daily Briefing):
  Use the remember tool to save: briefings_enabled=true, briefing_type=daily
  Respond: "You're all set! You'll receive daily briefings."

- If user selects 2 (Customized Briefing):
  Ask: "What would you like included? (Examples: stocks, crypto, travel deals, news, shopping, etc.)"
  Then save their topics using remember tool: briefings_enabled=true, briefing_type=custom, briefing_topics=[their topics]
  Respond: "Got it! Your customized briefings are set."

- If user says "stop briefing" or "cancel briefing" or "unsubscribe":
  Save briefings_enabled=false using remember tool
  Respond: "You're unsubscribed from briefings."

- If user says "change briefing" or "update briefing":
  Restart from "Great! Would you like: 1. Daily Briefing 2. Customized Briefing"

CRITICAL RULES:
- NEVER send briefings to users who have not opted in
- If briefings_enabled is false or not set in memory, do NOT mention briefings proactively
- Accept flexible YES/NO variations
- Keep messages short and WhatsApp-friendly
- When a NEW user greets (no name in memory), use the EXACT greeting format above, then ask their name after the briefing flow`;
};

// ─── Main agent function ──────────────────────────────────────
async function handleMessage(phone, messageText) {
  const user = getOrCreateUser(phone);
  
  // Auto-detect timezone from phone number if still default
  if (!user.timezone || user.timezone === "America/Chicago") {
    const detected = detectTimezone(phone);
    if (detected !== "America/Chicago" || phone.startsWith("+1")) {
      const { updateUser } = require("./db");
      updateUser(phone, { timezone: detected });
      user.timezone = detected;
    }
  }
  const active = isTrialActive(user);

  // If trial expired and not paid — send conversion message
  if (!active) {
    const connectUrl = `${process.env.BASE_URL}/connect?phone=${encodeURIComponent(phone)}`;
    logActivity(phone, "trial_expired_message", null);
    return `Your 7-day free trial has ended. I handled a lot of tasks for you this week! 💪

To keep your AI agent working for you, subscribe for just $9.99/month (cancel anytime):
${process.env.BASE_URL}/subscribe?phone=${encodeURIComponent(phone)}

I'll still send you a morning briefing for free — but I can't manage your email or calendar until you subscribe. Just text "upgrade" whenever you're ready!`;
  }

  // Check daily message limit
  const dailyCount = getDailyMessageCount(phone);
  if (dailyCount >= 20) {
    return "You have reached your daily limit of 20 messages. Your limit resets at midnight. Text \"upgrade\" for higher limits!";
  }
  incrementDailyMessageCount(phone);

  // Save incoming message
  addMessage(phone, "user", messageText);

  // Load context
  const memories = getMemory(phone);
  const hasGmail = hasProvider(phone, "google");
  const hasCalendar = hasGmail; // Same OAuth scope
  const recentMessages = getRecentMessages(phone, 20);
  const systemPrompt = buildSystemPrompt(user, memories, hasGmail, hasCalendar);

  // Determine available tools (only offer email/calendar tools if connected)
  const availableTools = TOOLS.filter((t) => {
    if (["list_emails", "read_email", "draft_reply"].includes(t.name) && !hasGmail) return false;
    if (["list_events", "create_event"].includes(t.name) && !hasCalendar) return false;
    return true;
  });

  // Build messages array
  const messages = recentMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  try {
    // Call Claude with tools
    let response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      tools: availableTools.length > 0 ? availableTools : undefined,
      messages,
    });

    // Handle tool use loop (Claude may call multiple tools)
    let loopCount = 0;
    while (response.stop_reason === "tool_use" && loopCount < 5) {
      loopCount++;
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        const result = await executeTool(phone, toolUse.name, toolUse.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      // Continue conversation with tool results
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

      response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: systemPrompt,
        tools: availableTools,
        messages,
      });
    }

    // Extract final text response
    const textBlocks = response.content.filter((b) => b.type === "text");
    const reply = textBlocks.map((b) => b.text).join("\n") || "I processed your request but don't have a text response. Could you try asking differently?";

    // Save assistant message
    addMessage(phone, "assistant", reply);
    logActivity(phone, "agent_response", reply.slice(0, 100));

    // Check if Gmail not connected and user seems to want email or calendar
    if (!hasGmail && /email|inbox|mail|gmail|calendar|schedule|meeting/i.test(messageText)) {
      const connectUrl = `${process.env.BASE_URL}/connect?phone=${encodeURIComponent(phone)}`;
      return `${reply}\n\n📧 Connect your accounts here:\n${connectUrl}`;
    }

    return reply;
  } catch (err) {
    console.error("Agent error:", err);
    logActivity(phone, "agent_error", err.message);
    return "Sorry, I hit a temporary issue. Could you try that again? 🙏";
  }
}

// ─── Generate daily briefing ──────────────────────────────────
async function generateBriefing(phone) {
  const user = getOrCreateUser(phone);
  if (!isTrialActive(user) && !user.is_paid) {
    // Free briefing for expired trial users (minimal cost)
    return `☀️ Good morning${user.name ? `, ${user.name}` : ""}!\n\nYour free daily briefing: Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}.\n\nTo get your full briefing with email summaries, calendar events, and reminders, subscribe for $9.99/month:\n${process.env.BASE_URL}/subscribe?phone=${encodeURIComponent(phone)}`;
  }

  const parts = [];
  const memories = getMemory(phone);
  const userName = user.name || "";

  parts.push(`☀️ Good morning${userName ? `, ${userName}` : ""}! Here's your daily briefing:\n`);

  // Email summary
  if (hasProvider(phone, "google")) {
    try {
      const emailResult = await google.listEmails(phone, "is:unread", 5);
      if (emailResult.emails && emailResult.emails.length > 0) {
        parts.push(`📧 *${emailResult.emails.length} unread emails:*`);
        emailResult.emails.forEach((e, i) => {
          parts.push(`${i + 1}. ${e.from.split("<")[0].trim()} — ${e.subject}`);
        });
      } else {
        parts.push("📧 Inbox clear! No unread emails.");
      }
    } catch (e) {
      parts.push("📧 Couldn't check email — may need to reconnect.");
    }

    // Calendar
    try {
      const now = new Date();
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59);
      const eventResult = await google.listEvents(phone, now.toISOString(), endOfDay.toISOString());
      if (eventResult.events && eventResult.events.length > 0) {
        parts.push(`\n📅 *Today's schedule:*`);
        eventResult.events.forEach((e) => {
          const time = new Date(e.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
          parts.push(`• ${time} — ${e.summary}`);
        });
      } else {
        parts.push("\n📅 No events today. Wide open!");
      }
    } catch (e) {
      parts.push("\n📅 Couldn't check calendar.");
    }
  }

  // Pending reminders
  const { getDueReminders } = require("./db");
  const dueToday = getDueReminders();
  const userReminders = dueToday.filter((r) => r.phone === phone);
  if (userReminders.length > 0) {
    parts.push(`\n⏰ *Reminders due:*`);
    userReminders.forEach((r) => parts.push(`• ${r.task}`));
  }

  parts.push("\nWhat would you like me to handle today?");

  logActivity(phone, "daily_briefing", "sent");
  return parts.join("\n");
}

module.exports = { handleMessage, generateBriefing };
