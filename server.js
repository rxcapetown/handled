// server.js — Main Express server for Umar
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const twilio = require("twilio");
const path = require("path");
const {
  getOrCreateUser, updateUser, saveOAuthTokens, isTrialActive,
  getDueReminders, markReminderSent, logActivity, getActivity, db, hasProvider,
  getDailyMessageCount, incrementDailyMessageCount, getDailyVoiceCount, incrementDailyVoiceCount,
} = require("./db");
const { handleMessage, generateBriefing } = require("./agent");
const OpenAI = require("openai");
const fs = require("fs");
const os = require("os");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const googleTools = require("./tools/google");
const { getOAuth2Client, getGoogleAuthUrl } = googleTools;

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe needs raw body for webhooks
app.use("/webhook/stripe", express.raw({ type: "application/json" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// Twilio client for sending messages
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function sendWhatsApp(to, body) {
  const dest = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  // Strip markdown formatting for WhatsApp Business API compatibility
  const clean = body.replace(/[*_~`]/g, "").slice(0, 1500);
  try {
    await twilioClient.messages.create({
      body: clean,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID, from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: dest,
    });
    console.log(`[Send OK] ${dest}`);
  } catch (err) {
    console.error(`[Send FAILED] ${dest}: ${err.message} code=${err.code}`);
    // Fallback: send approved welcome template instead of nothing
    try {
      await twilioClient.messages.create({
        contentSid: "HX025047a1fdcf2e472314db56db67f705",
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID, from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: dest,
      });
      console.log(`[Template OK] ${dest}`);
    } catch (err2) {
      console.error(`[Template FAILED] ${dest}: ${err2.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// WHATSAPP WEBHOOK — Receives incoming messages from Twilio
// ═══════════════════════════════════════════════════════════════
app.post("/webhook/whatsapp", async (req, res) => {
  // Respond immediately so Twilio doesn't retry
  res.status(200).send("<Response></Response>");

  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  const phone = from.replace("whatsapp:", "");
  const numMedia = parseInt(req.body.NumMedia || "0", 10);
  const mediaType = req.body.MediaContentType0 || "";
  const mediaUrl = req.body.MediaUrl0 || "";

  // Handle voice notes
  if (numMedia > 0 && mediaType.startsWith("audio/")) {
    console.log(`[WhatsApp] ${phone}: [Voice Note]`);

    try {
      const fetch = require("node-fetch");
      const audioRes = await fetch(mediaUrl, {
        headers: { Authorization: "Basic " + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ":" + process.env.TWILIO_AUTH_TOKEN).toString("base64") }
      });
      const audioBuffer = await audioRes.buffer();
      const tmpPath = path.join(os.tmpdir(), "voice_" + Date.now() + ".ogg");
      fs.writeFileSync(tmpPath, audioBuffer);

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: "whisper-1",
      });
      fs.unlinkSync(tmpPath);

      const voiceText = (transcription.text || "").trim();
      console.log(`[Voice] ${phone}: ${voiceText}`);

      if (!voiceText) {
        await sendWhatsApp(from, "I could not understand that voice note. Could you try again or type your message?");
        return;
      }

      const reply = await handleMessage(phone, voiceText);
      if (reply.length <= 1600) {
        await sendWhatsApp(from, reply);
      } else {
        const chunks = reply.match(/.{1,1500}/gs) || [reply];
        for (const chunk of chunks) {
          await sendWhatsApp(from, chunk);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      return;
    } catch (err) {
      console.error(`[Voice Error] ${phone}:`, err.message);
      await sendWhatsApp(from, "I had trouble with your voice note. Could you type your message instead?");
      return;
    }
  }

  if (!body) return;

  console.log(`[WhatsApp] ${phone}: ${body}`);



  try {
    // Handle quick commands
    if (body.toLowerCase() === "upgrade" || body.toLowerCase() === "subscribe") {
      await sendWhatsApp(from, "Umar is currently free! No subscription needed. Just keep using me.");
      return;
    }

    if (body.toLowerCase() === "connect" || body.toLowerCase() === "connect email" || body.toLowerCase() === "connect google") {
      const connectUrl = `${process.env.BASE_URL}/connect?phone=${encodeURIComponent(phone)}`;
      await sendWhatsApp(from, `Connect your accounts:\n\nGoogle (Gmail + Calendar):\n${connectUrl}\n\nTap the link above, sign in with Google, done! Takes 10 seconds.\n\nWe use Google's official sign-in. Your password is never shared with us.`);
      return;
    }

    if (body.toLowerCase() === "status") {
      const user = getOrCreateUser(phone);
      const active = isTrialActive(user);
      const status = user.is_paid ? "Pro subscriber" : active ? `Free trial (${require("./db").trialDaysLeft(user)} days left)` : "Trial expired";
      await sendWhatsApp(from, `Your status: ${status}\n\nType "connect" to link Gmail/Calendar\nType "menu" to see what I can do`);
      return;
    }

    // Process through AI agent
    const reply = await handleMessage(phone, body);

    // WhatsApp has a 1600 char limit per message
    if (reply.length <= 1600) {
      await sendWhatsApp(from, reply);
    } else {
      const chunks = reply.match(/.{1,1500}/gs) || [reply];
      for (const chunk of chunks) {
        await sendWhatsApp(from, chunk);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch (err) {
    console.error(`[Agent Error] ${phone}:`, err);
    await sendWhatsApp(from, "Sorry, I hit a temporary issue. Try again in a moment!");
  }
});

// ═══════════════════════════════════════════════════════════════
// GOOGLE OAUTH CALLBACK
// ═══════════════════════════════════════════════════════════════
app.get("/auth/google/callback", async (req, res) => {
  const { code, state: phone } = req.query;

  if (!code || !phone) {
    return res.status(400).send("Missing authorization code or phone number. Please try again from WhatsApp.");
  }

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    saveOAuthTokens(phone, "google", {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      scope: tokens.scope,
    });

    logActivity(phone, "connected_google", "Gmail and Calendar connected");

    const from = `whatsapp:${phone}`;
    await sendWhatsApp(from, "Gmail and Calendar connected! I can now read your emails and manage your schedule.\n\nTry: \"Check my email\" or \"What's on my calendar today?\"");

    res.send(`
      <!DOCTYPE html>
      <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Connected!</title>
      <style>
        body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f0fdf4; }
        .card { text-align: center; padding: 3rem; max-width: 400px; }
        h1 { color: #16a34a; font-size: 2rem; }
        p { color: #666; font-size: 1.1rem; line-height: 1.6; }
        .check { font-size: 4rem; margin-bottom: 1rem; }
      </style></head>
      <body><div class="card">
        <div class="check">✅</div>
        <h1>You're connected!</h1>
        <p>Gmail and Calendar are now linked to your AI agent. Go back to WhatsApp and try: <strong>"Check my email"</strong></p>
      </div></body></html>
    `);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("Something went wrong connecting your account. Please try again from WhatsApp by typing 'connect'.");
  }
});

// ═══════════════════════════════════════════════════════════════
// CONNECT PAGE
// ═══════════════════════════════════════════════════════════════
app.get("/connect", (req, res) => {
  const phone = req.query.phone || "";
  const authUrl = getGoogleAuthUrl(phone);

  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Connect Your Accounts</title>
    <style>
      body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #fafafa; }
      .card { text-align: center; padding: 2rem; max-width: 420px; background: white; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
      h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
      p { color: #666; margin-bottom: 2rem; }
      .btn { display: block; padding: 1rem 2rem; margin: 1rem auto; background: #4285f4; color: white; text-decoration: none; border-radius: 12px; font-size: 1.1rem; font-weight: 600; width: 80%; }
      .btn:hover { background: #3367d6; }
      .secure { font-size: 0.85rem; color: #999; margin-top: 2rem; }
    </style></head>
    <body><div class="card">
      <h1>Connect Your Accounts</h1>
      <p>Link your Gmail and Calendar so your AI agent can manage them.</p>
      <a href="${authUrl}" class="btn">Connect with Google</a>
      <p class="secure">We use Google's official sign-in. Your password is never shared with us. You can disconnect anytime.</p>
    </div></body></html>
  `);
});

// ═══════════════════════════════════════════════════════════════
// SUBSCRIBE PAGE
// ═══════════════════════════════════════════════════════════════
app.get("/subscribe", async (req, res) => {
  const phone = req.query.phone || "";
  const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_STANDARD, quantity: 1 }],
      success_url: `${process.env.BASE_URL}/subscribe/success?phone=${encodeURIComponent(phone)}`,
      cancel_url: `${process.env.BASE_URL}/subscribe/cancel`,
      metadata: { phone },
      allow_promotion_codes: true,
    });
    res.redirect(session.url);
  } catch (err) {
    console.error("Stripe session error:", err);
    res.status(500).send("Payment setup failed. Please try again.");
  }
});

app.get("/subscribe/success", async (req, res) => {
  const phone = req.query.phone;
  if (phone) {
    updateUser(phone, { is_paid: 1, plan: "standard" });
    logActivity(phone, "subscribed", "standard plan");
    await sendWhatsApp(`whatsapp:${phone}`, "You're subscribed! Full access is back on. What would you like me to handle?");
  }
  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Subscribed!</title>
    <style>
      body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f0fdf4; }
      .card { text-align: center; padding: 3rem; }
      h1 { color: #16a34a; }
    </style></head>
    <body><div class="card">
      <div style="font-size:4rem">🎉</div>
      <h1>You're subscribed!</h1>
      <p>Go back to WhatsApp — your AI agent is ready to work.</p>
    </div></body></html>
  `);
});

app.get("/subscribe/cancel", (req, res) => {
  res.send(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Cancelled</title>
    <style>body{font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}.card{text-align:center;padding:3rem}</style></head>
    <body><div class="card"><h1>No worries!</h1><p>You can subscribe anytime by texting "upgrade" on WhatsApp.</p></div></body></html>
  `);
});

// ═══════════════════════════════════════════════════════════════
// STRIPE WEBHOOK
// ═══════════════════════════════════════════════════════════════
app.post("/webhook/stripe", async (req, res) => {
  const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const phone = session.metadata?.phone;
    if (phone) {
      updateUser(phone, {
        is_paid: 1,
        plan: "standard",
        stripe_customer_id: session.customer,
      });
      logActivity(phone, "payment_confirmed", `Stripe session ${session.id}`);
      console.log(`[Stripe] User ${phone} subscribed`);
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const user = db.prepare("SELECT phone FROM users WHERE stripe_customer_id = ?").get(sub.customer);
    if (user) {
      updateUser(user.phone, { is_paid: 0, plan: "cancelled" });
      logActivity(user.phone, "subscription_cancelled", null);
      await sendWhatsApp(`whatsapp:${user.phone}`, "Your subscription has been cancelled. Text \"upgrade\" anytime to resubscribe!");
    }
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════
// LANDING PAGE
// ═══════════════════════════════════════════════════════════════
app.get("/", (req, res) => {
  const waNumber = (process.env.TWILIO_WHATSAPP_NUMBER || "").replace("whatsapp:", "").replace("+", "");
  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Umar — Your AI Agent on WhatsApp</title>
    <meta name="description" content="An AI personal agent that lives in WhatsApp. It manages your email, calendar, and life. No app. No setup. Just text.">
    <style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; }
      .hero { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; padding:2rem; text-align:center; }
      h1 { font-size: clamp(2.5rem, 6vw, 4.5rem); font-weight:800; letter-spacing:-0.03em; margin-bottom:1rem; line-height:1.1; }
      h1 span { color: #25D366; }
      .sub { font-size:1.25rem; color:#999; max-width:500px; margin-bottom:2.5rem; line-height:1.6; }
      .cta { display:inline-flex; align-items:center; gap:0.75rem; background:#25D366; color:#fff; padding:1.1rem 2.5rem; border-radius:60px; text-decoration:none; font-size:1.2rem; font-weight:700; transition:transform 0.2s, box-shadow 0.2s; }
      .cta:hover { transform:translateY(-2px); box-shadow:0 8px 30px rgba(37,211,102,0.3); }
      .features { display:flex; gap:2rem; margin-top:4rem; flex-wrap:wrap; justify-content:center; max-width:700px; }
      .feat { background:#1a1a1a; padding:1.5rem; border-radius:16px; width:200px; text-align:left; }
      .feat h3 { font-size:1rem; margin-bottom:0.5rem; }
      .feat p { font-size:0.85rem; color:#888; line-height:1.5; }
      .how { margin-top:4rem; max-width:500px; text-align:left; }
      .how h2 { font-size:1.5rem; margin-bottom:1.5rem; text-align:center; }
      .step { display:flex; gap:1rem; margin-bottom:1.5rem; align-items:flex-start; }
      .step-num { background:#25D366; color:#000; width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:800; flex-shrink:0; }
      .step-text h4 { margin-bottom:0.25rem; }
      .step-text p { font-size:0.9rem; color:#888; }
      .footer { margin-top:4rem; color:#555; font-size:0.85rem; }
    </style></head>
    <body>
      <div class="hero">
        <h1>Your AI agent<br>lives in <span>WhatsApp</span></h1>
        <p class="sub">Text it. It manages your email, calendar, reminders, and research. No app. No setup. No tech skills. Just add the number and start delegating.</p>
        <a href="https://wa.me/${waNumber}?text=Hi" class="cta">Message on WhatsApp</a>

        <div class="features">
          <div class="feat"><h3>Email</h3><p>Summarizes your inbox. Drafts replies. Flags what matters.</p></div>
          <div class="feat"><h3>Calendar</h3><p>Shows your schedule. Books meetings. Finds free time.</p></div>
          <div class="feat"><h3>Reminders</h3><p>"Remind me to call Dr. Patel Thursday" - done.</p></div>
          <div class="feat"><h3>Research</h3><p>"Find cheap flights to Dhaka in June" - answers in seconds.</p></div>
          <div class="feat"><h3>Daily Briefing</h3><p>Every morning: your emails, schedule, and reminders in one text.</p></div>
          <div class="feat"><h3>Any Language</h3><p>Text in English, Bangla, Hindi, Spanish, Arabic - it responds in yours.</p></div>
        </div>

        <div class="how">
          <h2>How it works</h2>
          <div class="step"><div class="step-num">1</div><div class="step-text"><h4>Add the number</h4><p>Save it to your contacts or tap the button above.</p></div></div>
          <div class="step"><div class="step-num">2</div><div class="step-text"><h4>Connect your email</h4><p>Tap one link to securely connect Gmail. Uses Google's official sign-in.</p></div></div>
          <div class="step"><div class="step-num">3</div><div class="step-text"><h4>Start delegating</h4><p>"Check my email." "What's on my calendar?" "Remind me to..." - it handles it.</p></div></div>
        </div>

        <p class="footer">Free 7-day trial. Then $9.99/month. Cancel anytime.<br>Your data is encrypted. You can disconnect anytime.</p>
      </div>
    </body></html>
  `);
});

// ═══════════════════════════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════════════════════════

// Check for due reminders every 5 minutes
cron.schedule("* * * * *", async () => {
  const reminders = getDueReminders();
  console.log(`[Reminders] Checking... found ${reminders.length} due reminders at ${new Date().toISOString()}`);
  for (const r of reminders) {
    try {
      await sendWhatsApp(`whatsapp:${r.phone}`, `Reminder: ${r.task}`);
      markReminderSent(r.id);
      logActivity(r.phone, "reminder_sent", r.task);
    } catch (err) {
      console.error(`Failed to send reminder ${r.id}:`, err.message);
    }
  }
});

// Scheduled briefings - runs every 15 minutes, checks each user's opted-in briefings
// Users opt in by texting Umar: "Send me a morning briefing at 7am"
// Respects each user's timezone
cron.schedule("*/15 * * * *", async () => {
  try {
    const { getAllScheduledBriefings, markBriefingSent } = require("./db");
    const allBriefings = getAllScheduledBriefings();
    
    for (const briefing of allBriefings) {
      try {
        const tz = briefing.timezone || "America/Chicago";
        const now = new Date();
        const userTime = new Date(now.toLocaleString("en-US", { timeZone: tz }));
        const userHour = userTime.getHours();
        const userMinute = userTime.getMinutes();
        
        // Check if it is time for this briefing (within 15 min window)
        if (userHour === briefing.schedule_hour && userMinute >= (briefing.schedule_minute || 0) && userMinute < (briefing.schedule_minute || 0) + 15) {
          // Check if already sent today
          const today = now.toISOString().split("T")[0];
          if (briefing.last_sent && briefing.last_sent.startsWith(today)) continue;
          
          console.log(`[Briefing] Sending to ${briefing.phone} (${tz}, ${userHour}:${userMinute})`);
          
          // Generate briefing based on what user requested
          const content = await generateBriefing(briefing.phone);
          await sendWhatsApp(`whatsapp:${briefing.phone}`, content);
          markBriefingSent(briefing.id);
          
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        console.error(`Briefing failed for ${briefing.phone}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[Cron] Briefing scheduler error:", err.message);
  }
});

// ═══════════════════════════════════════════════════════════════

// Admin: list all users (protected by simple secret)
app.get("/admin/users", (req, res) => {
  if (req.query.key !== process.env.SESSION_SECRET) return res.status(403).json({error: "unauthorized"});
  const users = db.prepare("SELECT phone, name, timezone, created_at FROM users ORDER BY created_at DESC").all();
  res.json(users);
});


// Admin: list all users (protected by simple secret)
app.get("/admin/users", (req, res) => {
  if (req.query.key !== process.env.SESSION_SECRET) return res.status(403).json({error: "unauthorized"});
  const users = db.prepare("SELECT phone, name, timezone, created_at FROM users ORDER BY created_at DESC").all();
  res.json(users);
});


// PRIVACY POLICY
app.get("/privacy", (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy - Umar AI</title><style>body{font-family:-apple-system,sans-serif;max-width:700px;margin:0 auto;padding:2rem 1.5rem;color:#333;line-height:1.8}h1{font-size:2rem}h2{font-size:1.3rem;margin-top:2rem;color:#128C7E}.updated{color:#999;font-size:0.9rem;margin-bottom:2rem}a{color:#128C7E}</style></head><body><h1>Privacy Policy</h1><p class="updated">Last updated: March 2026</p><h2>What is Umar?</h2><p>Umar is an AI personal assistant that operates through WhatsApp. Umar can help you manage your email, calendar, reminders, and perform web searches.</p><h2>Information we collect</h2><p>When you use Umar, we collect your phone number (provided via WhatsApp), conversation history with Umar, and if you choose to connect your accounts: email metadata (sender, subject, date) and calendar events from your Google account.</p><h2>How we use your information</h2><p>We use your information solely to provide the Umar AI assistant service. This includes responding to your messages, reading and summarizing your emails when requested, managing your calendar when requested, setting reminders, and sending daily briefings you have opted into.</p><h2>Google Account Access</h2><p>If you connect your Google account, Umar accesses your Gmail and Google Calendar through Google official OAuth 2.0 protocol. We request only the permissions needed to read your email, send emails on your behalf when you ask, and read and create calendar events. Your Google password is never shared with us. You can revoke access at any time through your Google account settings at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p><h2>Data storage and security</h2><p>Your OAuth tokens (used to access your email and calendar) are encrypted using AES-256 encryption. Your conversation history is stored to provide context for better responses. We do not sell, share, or transfer your personal data to third parties.</p><h2>Data retention</h2><p>Your data is retained as long as you have an active account. You can request deletion of all your data at any time by texting "delete my data" to Umar on WhatsApp.</p><h2>Third-party services</h2><p>Umar uses the following third-party services: Anthropic (Claude AI) for language processing, Twilio for WhatsApp messaging, Google APIs for Gmail and Calendar access, OpenAI for voice note transcription, and Stripe for payment processing.</p><h2>Children privacy</h2><p>Umar is not intended for use by children under 13. We do not knowingly collect information from children under 13.</p><h2>Changes to this policy</h2><p>We may update this privacy policy from time to time. We will notify you of any changes by posting the new policy on this page.</p><h2>Contact us</h2><p>If you have questions about this privacy policy, please contact us by texting Umar on WhatsApp.</p></body></html>`);
});

// TERMS OF SERVICE
app.get("/terms", (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terms of Service - Umar AI</title><style>body{font-family:-apple-system,sans-serif;max-width:700px;margin:0 auto;padding:2rem 1.5rem;color:#333;line-height:1.8}h1{font-size:2rem}h2{font-size:1.3rem;margin-top:2rem;color:#128C7E}.updated{color:#999;font-size:0.9rem;margin-bottom:2rem}</style></head><body><h1>Terms of Service</h1><p class="updated">Last updated: March 2026</p><h2>Acceptance of terms</h2><p>By using Umar, you agree to these terms. If you do not agree, please stop using the service.</p><h2>Description of service</h2><p>Umar is an AI-powered personal assistant accessible through WhatsApp. Umar can help manage your email, calendar, reminders, and perform research tasks.</p><h2>Account and access</h2><p>You access Umar by sending a WhatsApp message. You may optionally connect your Google account to enable email and calendar features. You are responsible for maintaining the security of your connected accounts.</p><h2>Acceptable use</h2><p>You agree not to use Umar for any unlawful purpose, to send spam or unsolicited messages through Umar, to attempt to gain unauthorized access to other users data, or to interfere with or disrupt the service.</p><h2>AI limitations</h2><p>Umar is powered by artificial intelligence and may occasionally provide inaccurate information. You should verify important information independently. Umar is not a substitute for professional advice (legal, medical, financial, etc.).</p><h2>Data and privacy</h2><p>Your use of Umar is also governed by our <a href="/privacy">Privacy Policy</a>. By using Umar, you consent to the collection and use of information as described in the Privacy Policy.</p><h2>Service availability</h2><p>We strive to keep Umar available 24/7, but we do not guarantee uninterrupted service. We may modify or discontinue features with or without notice.</p><h2>Limitation of liability</h2><p>Umar is provided as is without warranties of any kind. We are not liable for any damages arising from your use of the service.</p><h2>Changes to terms</h2><p>We reserve the right to modify these terms at any time. Continued use of Umar after changes constitutes acceptance of the new terms.</p><h2>Contact</h2><p>For questions about these terms, please contact us by texting Umar on WhatsApp.</p></body></html>`);
});


// Debug: see pending reminders
app.get("/debug/reminders", (req, res) => {
  const pending = db.prepare("SELECT * FROM reminders ORDER BY id DESC LIMIT 20").all();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const checked = pending.map(r => ({
    ...r,
    due_at_parsed: new Date(r.due_at).toISOString(),
    due_at_ms: new Date(r.due_at).getTime(),
    now_ms: nowMs,
    is_due: new Date(r.due_at).getTime() <= nowMs,
    diff_minutes: Math.round((new Date(r.due_at).getTime() - nowMs) / 60000)
  }));
  res.json({ server_time: now, reminders: checked });
});


// Debug: see scheduled briefings
app.get("/debug/briefings", (req, res) => {
  const briefings = db.prepare("SELECT sb.*, u.timezone, u.name FROM scheduled_briefings sb JOIN users u ON sb.phone = u.phone").all();
  res.json({ count: briefings.length, briefings });
});

// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════
app.get("/health", (req, res) => {
  const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get().count;
  const paidCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE is_paid = 1").get().count;
  res.json({ status: "ok", users: userCount, paid: paidCount, uptime: process.uptime() });
});

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   UMAR is running on :${PORT}     ║
  ║   WhatsApp AI Agent ready            ║
  ╚══════════════════════════════════════╝
  `);
});
