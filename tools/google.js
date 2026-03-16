// tools/google.js — Gmail and Calendar tools via OAuth
const { google } = require("googleapis");
const { getOAuthTokens, saveOAuthTokens, logActivity } = require("../db");

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthenticatedClient(phone) {
  const tokens = getOAuthTokens(phone, "google");
  if (!tokens) return null;

  const client = getOAuth2Client();
  client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  });

  // Auto-refresh tokens when they expire
  client.on("tokens", (newTokens) => {
    saveOAuthTokens(phone, "google", {
      access_token: newTokens.access_token,
      refresh_token: newTokens.refresh_token || tokens.refresh_token,
      expiry_date: newTokens.expiry_date,
    });
  });

  return client;
}

// ─── Gmail Tools ──────────────────────────────────────────────

async function listEmails(phone, query = "is:unread", maxResults = 10) {
  const auth = getAuthenticatedClient(phone);
  if (!auth) return { error: "Gmail not connected. Ask user to connect Gmail first." };

  try {
    const gmail = google.gmail({ version: "v1", auth });
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults,
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      return { emails: [], message: "No emails found matching that query." };
    }

    const emails = [];
    for (const msg of res.data.messages.slice(0, maxResults)) {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });
      const headers = detail.data.payload.headers;
      const getHeader = (name) => headers.find((h) => h.name === name)?.value || "";
      emails.push({
        id: msg.id,
        from: getHeader("From"),
        subject: getHeader("Subject"),
        date: getHeader("Date"),
        snippet: detail.data.snippet,
      });
    }

    logActivity(phone, "read_emails", `Listed ${emails.length} emails`);
    return { emails };
  } catch (err) {
    console.error("Gmail list error:", err.message);
    return { error: `Gmail error: ${err.message}` };
  }
}

async function readEmail(phone, emailId) {
  const auth = getAuthenticatedClient(phone);
  if (!auth) return { error: "Gmail not connected." };

  try {
    const gmail = google.gmail({ version: "v1", auth });
    const res = await gmail.users.messages.get({
      userId: "me",
      id: emailId,
      format: "full",
    });

    // Extract plain text body
    let body = "";
    const payload = res.data.payload;
    if (payload.body && payload.body.data) {
      body = Buffer.from(payload.body.data, "base64").toString("utf-8");
    } else if (payload.parts) {
      const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
      if (textPart && textPart.body && textPart.body.data) {
        body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
      }
    }

    const headers = payload.headers;
    const getHeader = (name) => headers.find((h) => h.name === name)?.value || "";

    logActivity(phone, "read_email_detail", getHeader("Subject"));
    return {
      from: getHeader("From"),
      subject: getHeader("Subject"),
      date: getHeader("Date"),
      body: body.slice(0, 2000), // Limit to save tokens
    };
  } catch (err) {
    return { error: `Gmail error: ${err.message}` };
  }
}

async function draftReply(phone, emailId, replyText) {
  const auth = getAuthenticatedClient(phone);
  if (!auth) return { error: "Gmail not connected." };

  try {
    const gmail = google.gmail({ version: "v1", auth });
    const original = await gmail.users.messages.get({
      userId: "me",
      id: emailId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Message-ID"],
    });

    const headers = original.data.payload.headers;
    const getHeader = (name) => headers.find((h) => h.name === name)?.value || "";
    const to = getHeader("From");
    const subject = getHeader("Subject").startsWith("Re:") ? getHeader("Subject") : `Re: ${getHeader("Subject")}`;
    const messageId = getHeader("Message-ID");

    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nIn-Reply-To: ${messageId}\r\nReferences: ${messageId}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${replyText}`
    ).toString("base64url");

    const draft = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw, threadId: original.data.threadId } },
    });

    logActivity(phone, "draft_reply", `Draft reply to: ${to}`);
    return { success: true, draftId: draft.data.id, to, subject };
  } catch (err) {
    return { error: `Gmail error: ${err.message}` };
  }
}

async function sendDraft(phone, draftId) {
  const auth = getAuthenticatedClient(phone);
  if (!auth) return { error: "Gmail not connected." };

  try {
    const gmail = google.gmail({ version: "v1", auth });
    await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
    logActivity(phone, "send_email", `Sent draft ${draftId}`);
    return { success: true };
  } catch (err) {
    return { error: `Gmail error: ${err.message}` };
  }
}

// ─── Calendar Tools ───────────────────────────────────────────

async function listEvents(phone, timeMin = null, timeMax = null, maxResults = 10) {
  const auth = getAuthenticatedClient(phone);
  if (!auth) return { error: "Google Calendar not connected." };

  try {
    const calendar = google.calendar({ version: "v3", auth });
    const now = new Date();
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: timeMin || now.toISOString(),
      timeMax: timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = (res.data.items || []).map((e) => ({
      id: e.id,
      summary: e.summary || "(No title)",
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
      location: e.location || null,
      description: e.description ? e.description.slice(0, 200) : null,
    }));

    logActivity(phone, "list_events", `Listed ${events.length} events`);
    return { events };
  } catch (err) {
    return { error: `Calendar error: ${err.message}` };
  }
}

async function createEvent(phone, { summary, startTime, endTime, description, location }) {
  const auth = getAuthenticatedClient(phone);
  if (!auth) return { error: "Google Calendar not connected." };

  try {
    const calendar = google.calendar({ version: "v3", auth });
    const event = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        start: { dateTime: startTime },
        end: { dateTime: endTime || new Date(new Date(startTime).getTime() + 60 * 60 * 1000).toISOString() },
        description: description || "",
        location: location || "",
      },
    });

    logActivity(phone, "create_event", summary);
    return { success: true, eventId: event.data.id, link: event.data.htmlLink };
  } catch (err) {
    return { error: `Calendar error: ${err.message}` };
  }
}

// ─── Generate OAuth URL ───────────────────────────────────────

function getGoogleAuthUrl(phone) {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/calendar.events",
    ],
    state: phone, // Pass phone number through OAuth flow
  });
}

module.exports = {
  getOAuth2Client,
  getGoogleAuthUrl,
  listEmails,
  readEmail,
  draftReply,
  sendDraft,
  listEvents,
  createEvent,
};
