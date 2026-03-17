// server.js — Main Express server for Handled
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const twilio = require("twilio");
const path = require("path");
const {
  getOrCreateUser, updateUser, saveOAuthTokens, isTrialActive,
  getDueReminders, markReminderSent, logActivity, getActivity, db, hasProvider,
} = require("./db");
const { handleMessage, generateBriefing } = require("./agent");
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
  try {
    await twilioClient.messages.create({
      body,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
    });
  } catch (err) {
    console.error(`Failed to send WhatsApp to ${to}:`, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// WHATSAPP WEBHOOK — Receives incoming messages from Twilio
// ═══════════════════════════════════════════════════════════════
app.post("/webhook/whatsapp", async (req, res) => {
  // Respond immediately so Twilio doesn't retry
  res.status(200).send("<Response></Response>");

  const from = req.body.From; // whatsapp:+1234567890
  const body = (req.body.Body || "").trim();
  const phone = from.replace("whatsapp:", "");

  if (!body) return;

  console.log(`[WhatsApp] ${phone}: ${body}`);

  try {
    // Handle quick commands
    if (body.toLowerCase() === "upgrade" || body.toLowerCase() === "subscribe") {
      const subUrl = `${process.env.BASE_URL}/subscribe?phone=${encodeURIComponent(phone)}`;
      await sendWhatsApp(from, `Here's your subscription link! Tap to subscribe for $9.99/month:\n${subUrl}`);
      return;
    }

    if (body.toLowerCase() === "connect" || body.toLowerCase() === "connect email" || body.toLowerCase() === "connect google") {
      const connectUrl = `${process.env.BASE_URL}/connect?phone=${encodeURIComponent(phone)}`;
      await sendWhatsApp(from, `🔗 *Connect your accounts:*\n\n📧 Google (Gmail + Calendar):\n${connectUrl}\n\nTap the link → Sign in with Google → Done! 10 seconds.\n\n🔒 Uses Google's official sign-in. Your password is never shared.`);
      return;
    }

    if (body.toLowerCase() === "menu" || body.toLowerCase() === "help" || body.toLowerCase() === "?") {
      await sendWhatsApp(from, `Hey! Here's what I can do:\n\n📧 *Email* — "Check my email" or "Any emails from [name]?"\n📅 *Calendar* — "What's on today?" or "Schedule a meeting Friday at 2pm"\n⏰ *Reminders* — "Remind me to call mom at 5pm"\n✈️ *Travel* — "Find flights to London in July"\n🛍️ *Shopping* — "Find me AirPods Pro deals"\n🔍 *Research* — "What's the weather tomorrow?" or any question\n📰 *News* — "What's happening in tech today?"\n\n💡 *Quick commands:*\nconnect — Link your Gmail/Calendar\nstatus — Check your plan\nmenu — See this list again\n\nJust text me naturally — I understand! 🤙`);
      return;
    }

    if (body.toLowerCase() === "status") {
      const user = getOrCreateUser(phone);
      const active = isTrialActive(user);
      const status = user.is_paid ? "Pro subscriber ✅" : active ? `Free trial (${require("./db").trialDaysLeft(user)} days left)` : "Trial expired";
      await sendWhatsApp(from, `📊 *Your status:* ${status}\n\n💡 *Commands:*\nconnect — Link Gmail/Calendar\nupgrade — Subscribe\nmenu — See what I can do`);
      return;
    }

    // Process through AI agent
    const reply = await handleMessage(phone, body);

    // WhatsApp has a 1600 char limit per message — split if needed
    if (reply.length <= 1600) {
      await sendWhatsApp(from, reply);
    } else {
      const chunks = reply.match(/.{1,1500}/gs) || [reply];
      for (const chunk of chunks) {
        await sendWhatsApp(from, chunk);
        await new Promise((r) => setTimeout(r, 500)); // Small delay between chunks
      }
    }
  } catch (err) {
    console.error(`[Agent Error] ${phone}:`, err);
    await sendWhatsApp(from, "Sorry, I hit a temporary issue. Try again in a moment! 🙏");
  }
});

// ═══════════════════════════════════════════════════════════════
// GOOGLE OAUTH CALLBACK — Handles the OAuth redirect from Google
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

    // Send confirmation via WhatsApp
    const from = `whatsapp:${phone}`;
    await sendWhatsApp(from, "✅ Gmail and Calendar connected! I can now read your emails and manage your schedule.\n\nTry: \"Check my email\" or \"What's on my calendar today?\"");

    // Send a nice confirmation page
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
// MICROSOFT OAUTH CALLBACK
// ═══════════════════════════════════════════════════════════════
app.get("/auth/microsoft/callback", async (req, res) => {
  const { code, state: phone } = req.query;

  if (!code || !phone) {
    return res.status(400).send("Missing authorization code. Please try again from WhatsApp.");
  }

  try {
    const microsoft = require("./tools/microsoft");
    const tokens = await microsoft.exchangeCodeForTokens(code);

    saveOAuthTokens(phone, "microsoft", {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope,
    });

    logActivity(phone, "connected_microsoft", "Outlook and Calendar connected");

    await sendWhatsApp(`whatsapp:${phone}`, "✅ Microsoft Outlook and Calendar connected! I can now manage your email and schedule.\n\nTry: \"Check my email\" or \"What's on my calendar today?\"");

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
        <h1>Microsoft Connected!</h1>
        <p>Outlook and Calendar are now linked to Umar. Go back to WhatsApp and try: <strong>"Check my email"</strong></p>
      </div></body></html>
    `);
  } catch (err) {
    console.error("Microsoft OAuth error:", err);
    res.status(500).send("Something went wrong connecting Microsoft. Please try again from WhatsApp by typing 'connect'.");
  }
});

// ═══════════════════════════════════════════════════════════════
// CONNECT PAGE — Web page for managing connections
// ═══════════════════════════════════════════════════════════════
app.get("/connect", (req, res) => {
  const phone = req.query.phone || "";
  const googleAuthUrl = getGoogleAuthUrl(phone);
  const msAuthUrl = process.env.MICROSOFT_CLIENT_ID 
    ? require("./tools/microsoft").getMicrosoftAuthUrl(phone)
    : null;

  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Connect Your Accounts — Umar</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fff; }
      .card { text-align: center; padding: 2.5rem; max-width: 420px; background: #1a1a1a; border-radius: 20px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
      h1 { font-size: 1.6rem; margin-bottom: 0.5rem; }
      .sub { color: #888; margin-bottom: 2rem; font-size: 0.95rem; }
      .btn { display: flex; align-items: center; justify-content: center; gap: 0.75rem; padding: 1rem 1.5rem; margin: 0.75rem auto; text-decoration: none; border-radius: 14px; font-size: 1.05rem; font-weight: 600; width: 100%; transition: transform 0.2s, opacity 0.2s; }
      .btn:hover { transform: translateY(-2px); opacity: 0.9; }
      .btn-google { background: #4285f4; color: white; }
      .btn-microsoft { background: #00a4ef; color: white; }
      .divider { color: #555; margin: 1.5rem 0; font-size: 0.85rem; }
      .secure { font-size: 0.8rem; color: #666; margin-top: 2rem; line-height: 1.5; }
      .emoji { font-size: 1.3rem; }
    </style></head>
    <body><div class="card">
      <h1>🤖 Connect to Umar</h1>
      <p class="sub">Link your email and calendar so Umar can manage them for you.</p>
      
      <a href="${googleAuthUrl}" class="btn btn-google">
        <span class="emoji">📧</span> Connect Google (Gmail + Calendar)
      </a>
      
      ${msAuthUrl ? `
      <div class="divider">— or —</div>
      <a href="${msAuthUrl}" class="btn btn-microsoft">
        <span class="emoji">📬</span> Connect Microsoft (Outlook + Calendar)
      </a>
      ` : ''}
      
      <p class="secure">🔒 Uses official sign-in from Google/Microsoft.<br>Your password is never shared. You can disconnect anytime.</p>
    </div></body></html>
  `);
});

// ═══════════════════════════════════════════════════════════════
// SUBSCRIBE PAGE — Redirect to Stripe Checkout
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
    await sendWhatsApp(`whatsapp:${phone}`, "🎉 You're subscribed! Full access is back on. What would you like me to handle?");
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
// STRIPE WEBHOOK — Handles payment confirmations
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
      console.log(`[Stripe] ✅ User ${phone} subscribed`);
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    // Find user by Stripe customer ID
    const user = db.prepare("SELECT phone FROM users WHERE stripe_customer_id = ?").get(sub.customer);
    if (user) {
      updateUser(user.phone, { is_paid: 0, plan: "cancelled" });
      logActivity(user.phone, "subscription_cancelled", null);
      await sendWhatsApp(`whatsapp:${user.phone}`, "Your subscription has been cancelled. I'll still send you a morning briefing. Text \"upgrade\" anytime to resubscribe! 👋");
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
        <p class="sub">Text him. He manages your email, calendar, reminders, and research. No app. No setup. No tech skills. Just add the number and start delegating.</p>
        <a href="https://wa.me/${waNumber}?text=Hi" class="cta">💬 Message on WhatsApp</a>

        <div class="features">
          <div class="feat"><h3>📧 Email</h3><p>Summarizes your inbox. Drafts replies. Flags what matters.</p></div>
          <div class="feat"><h3>📅 Calendar</h3><p>Shows your schedule. Books meetings. Finds free time.</p></div>
          <div class="feat"><h3>⏰ Reminders</h3><p>"Remind me to call Dr. Patel Thursday" — done.</p></div>
          <div class="feat"><h3>🔍 Research</h3><p>"Find cheap flights to Dhaka in June" — answers in seconds.</p></div>
          <div class="feat"><h3>☀️ Daily Briefing</h3><p>Every morning: your emails, schedule, and reminders in one text.</p></div>
          <div class="feat"><h3>🌍 Any Language</h3><p>Text in English, Bangla, Hindi, Spanish, Arabic — it responds in yours.</p></div>
        </div>

        <div class="how">
          <h2>How it works</h2>
          <div class="step"><div class="step-num">1</div><div class="step-text"><h4>Add the number</h4><p>Save it to your contacts or tap the button above.</p></div></div>
          <div class="step"><div class="step-num">2</div><div class="step-text"><h4>Connect your email</h4><p>Tap one link to securely connect Gmail. Uses Google's official sign-in.</p></div></div>
          <div class="step"><div class="step-num">3</div><div class="step-text"><h4>Start delegating</h4><p>"Check my email." "What's on my calendar?" "Remind me to..." — it handles it.</p></div></div>
        </div>

        <p class="footer">Free 7-day trial. Then $9.99/month. Cancel anytime.<br><a href="/privacy" style="color:#888">Privacy Policy</a> · <a href="/terms" style="color:#888">Terms</a><br>Your data is encrypted. You can disconnect anytime.</p>
      </div>
    </body></html>
  `);
});

// ═══════════════════════════════════════════════════════════════
// CRON JOBS — Daily briefings and reminders
// ═══════════════════════════════════════════════════════════════

// Check for due reminders every 5 minutes
cron.schedule("*/5 * * * *", async () => {
  const reminders = getDueReminders();
  for (const r of reminders) {
    try {
      await sendWhatsApp(`whatsapp:${r.phone}`, `⏰ Reminder: ${r.task}`);
      markReminderSent(r.id);
      logActivity(r.phone, "reminder_sent", r.task);
    } catch (err) {
      console.error(`Failed to send reminder ${r.id}:`, err.message);
    }
  }
});

// Daily briefings at 7 AM Central (12 PM UTC)
cron.schedule("0 12 * * *", async () => {
  console.log("[Cron] Sending morning briefings...");
  const users = db.prepare("SELECT phone FROM users WHERE is_paid = 1 OR trial_start > datetime('now', '-7 days')").all();
  for (const user of users) {
    try {
      const briefing = await generateBriefing(user.phone);
      await sendWhatsApp(`whatsapp:${user.phone}`, briefing);
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.error(`Morning briefing failed for ${user.phone}:`, err.message);
    }
  }
});

// Noon check-in at 12 PM Central (5 PM UTC)
cron.schedule("0 17 * * *", async () => {
  console.log("[Cron] Sending noon check-ins...");
  const users = db.prepare("SELECT phone FROM users WHERE is_paid = 1 OR trial_start > datetime('now', '-7 days')").all();
  for (const user of users) {
    try {
      const { getOrCreateUser } = require("./db");
      const userData = getOrCreateUser(user.phone);
      const parts = [];
      const name = userData.name || "";
      parts.push(`☀️ Midday check-in${name ? `, ${name}` : ""}!\n`);

      if (hasProvider(user.phone, "google")) {
        try {
          const emailResult = await googleTools.listEmails(user.phone, "is:unread newer_than:4h", 5);
          if (emailResult.emails && emailResult.emails.length > 0) {
            parts.push(`📧 *${emailResult.emails.length} new emails since this morning:*`);
            emailResult.emails.forEach((e, i) => {
              parts.push(`${i + 1}. ${e.from.split("<")[0].trim()} — ${e.subject}`);
            });
          } else {
            parts.push("📧 No new emails since this morning.");
          }
        } catch (e) { /* skip */ }

        try {
          const now = new Date();
          const endOfDay = new Date(now);
          endOfDay.setHours(23, 59, 59);
          const eventResult = await googleTools.listEvents(user.phone, now.toISOString(), endOfDay.toISOString());
          if (eventResult.events && eventResult.events.length > 0) {
            parts.push(`\n📅 *Rest of today:*`);
            eventResult.events.forEach((e) => {
              const time = new Date(e.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
              parts.push(`• ${time} — ${e.summary}`);
            });
          } else {
            parts.push("\n📅 Nothing else on the calendar today.");
          }
        } catch (e) { /* skip */ }
      }

      parts.push("\nNeed me to handle anything?");
      await sendWhatsApp(`whatsapp:${user.phone}`, parts.join("\n"));
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.error(`Noon check-in failed for ${user.phone}:`, err.message);
    }
  }
});

// Evening wrap-up at 7 PM Central (12 AM UTC next day = 0 UTC)
cron.schedule("0 0 * * *", async () => {
  console.log("[Cron] Sending evening wrap-ups...");
  const users = db.prepare("SELECT phone FROM users WHERE is_paid = 1 OR trial_start > datetime('now', '-7 days')").all();
  for (const user of users) {
    try {
      const { getOrCreateUser } = require("./db");
      const userData = getOrCreateUser(user.phone);
      const parts = [];
      const name = userData.name || "";
      parts.push(`🌙 Evening wrap-up${name ? `, ${name}` : ""}!\n`);

      if (hasProvider(user.phone, "google")) {
        try {
          const emailResult = await googleTools.listEmails(user.phone, "is:unread", 3);
          if (emailResult.emails && emailResult.emails.length > 0) {
            parts.push(`📧 *${emailResult.emails.length} unread emails to deal with:*`);
            emailResult.emails.forEach((e, i) => {
              parts.push(`${i + 1}. ${e.from.split("<")[0].trim()} — ${e.subject}`);
            });
          } else {
            parts.push("📧 Inbox clear! Nice work today.");
          }
        } catch (e) { /* skip */ }

        try {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(0, 0, 0, 0);
          const tomorrowEnd = new Date(tomorrow);
          tomorrowEnd.setHours(23, 59, 59);
          const eventResult = await googleTools.listEvents(user.phone, tomorrow.toISOString(), tomorrowEnd.toISOString());
          if (eventResult.events && eventResult.events.length > 0) {
            parts.push(`\n📅 *Tomorrow's schedule:*`);
            eventResult.events.forEach((e) => {
              const time = new Date(e.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
              parts.push(`• ${time} — ${e.summary}`);
            });
          } else {
            parts.push("\n📅 Nothing on tomorrow's calendar. Rest up!");
          }
        } catch (e) { /* skip */ }
      }

      const { getDueReminders } = require("./db");
      const allReminders = db.prepare("SELECT * FROM reminders WHERE phone = ? AND sent = 0").all(user.phone);
      if (allReminders.length > 0) {
        parts.push(`\n⏰ *Pending reminders:*`);
        allReminders.forEach((r) => parts.push(`• ${r.task}`));
      }

      parts.push("\nGoodnight! I'll have your briefing ready in the morning. 💤");
      await sendWhatsApp(`whatsapp:${user.phone}`, parts.join("\n"));
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.error(`Evening wrap-up failed for ${user.phone}:`, err.message);
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════
app.get("/privacy", (req, res) => { res.send("<html><head><title>Privacy Policy - Umar</title><style>body{font-family:-apple-system,sans-serif;max-width:700px;margin:2rem auto;padding:1rem;color:#333}h1{color:#1a1a2e}</style></head><body><h1>Privacy Policy</h1><p>Last updated: March 2026</p><p>Umar is a WhatsApp-based AI assistant. We take your privacy seriously.</p><p><strong>What we access:</strong> Only the Gmail and Calendar data you explicitly authorize through Google OAuth. We never see your password.</p><p><strong>How we store data:</strong> OAuth tokens are encrypted with AES-256. Your conversations and memory are stored on secure servers.</p><p><strong>What we never do:</strong> We never sell your data, share it with third parties, or use it for advertising.</p><p><strong>Data deletion:</strong> Text us anytime to delete all your data.</p><p>Contact: mashruf@gmail.com</p></body></html>"); });
app.get("/terms", (req, res) => { res.send("<html><head><title>Terms of Service - Umar</title><style>body{font-family:-apple-system,sans-serif;max-width:700px;margin:2rem auto;padding:1rem;color:#333}h1{color:#1a1a2e}</style></head><body><h1>Terms of Service</h1><p>Last updated: March 2026</p><p>By using Umar, you agree to these terms.</p><p><strong>Service:</strong> Umar is an AI assistant accessed via WhatsApp. Features may change as we improve the product.</p><p><strong>Your data:</strong> You own your data. We access Gmail and Calendar only with your permission.</p><p><strong>Acceptable use:</strong> Do not use Umar for illegal activities or to harm others.</p><p><strong>Liability:</strong> Umar is provided as-is. We are not responsible for actions taken based on AI recommendations.</p><p>Contact: mashruf@gmail.com</p></body></html>"); });
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
  ║   🤖 UMAR is running on :${PORT}     ║
  ║   Your AI Agent Umar is ready            ║
  ╚══════════════════════════════════════╝
  `);
});
