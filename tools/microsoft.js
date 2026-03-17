// tools/microsoft.js — Outlook Mail and Calendar tools via Microsoft Graph API
const { saveOAuthTokens, getOAuthTokens, logActivity } = require("../db");

const MS_AUTH_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH_API = "https://graph.microsoft.com/v1.0";
const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "Mail.Read",
  "Mail.Send",
  "Calendars.ReadWrite",
];

// ─── Generate Microsoft OAuth URL ─────────────────────────────
function getMicrosoftAuthUrl(phone) {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    response_type: "code",
    redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
    scope: SCOPES.join(" "),
    response_mode: "query",
    state: phone,
    prompt: "consent",
  });
  return `${MS_AUTH_ENDPOINT}/authorize?${params.toString()}`;
}

// ─── Exchange code for tokens ─────────────────────────────────
async function exchangeCodeForTokens(code) {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    code,
    redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
    grant_type: "authorization_code",
    scope: SCOPES.join(" "),
  });

  const res = await fetch(`${MS_AUTH_ENDPOINT}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Microsoft token error: ${err.error_description || err.error}`);
  }

  return await res.json();
}

// ─── Refresh access token ─────────────────────────────────────
async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: SCOPES.join(" "),
  });

  const res = await fetch(`${MS_AUTH_ENDPOINT}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Microsoft refresh error: ${err.error_description || err.error}`);
  }

  return await res.json();
}

// ─── Get valid access token (auto-refresh if expired) ─────────
async function getAccessToken(phone) {
  const tokens = getOAuthTokens(phone, "microsoft");
  if (!tokens) return null;

  // Check if token is expired (with 5 min buffer)
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - 5 * 60 * 1000) {
    try {
      const newTokens = await refreshAccessToken(tokens.refresh_token);
      saveOAuthTokens(phone, "microsoft", {
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token || tokens.refresh_token,
        expiry_date: Date.now() + newTokens.expires_in * 1000,
      });
      return newTokens.access_token;
    } catch (err) {
      console.error("Microsoft token refresh failed:", err.message);
      return null;
    }
  }

  return tokens.access_token;
}

// ─── Graph API helper ─────────────────────────────────────────
async function graphRequest(phone, endpoint, method = "GET", body = null) {
  const token = await getAccessToken(phone);
  if (!token) return { error: "Microsoft account not connected." };

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${GRAPH_API}${endpoint}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: `Microsoft API error: ${err.error?.message || res.statusText}` };
  }
  return await res.json();
}

// ─── Outlook Mail Tools ───────────────────────────────────────

async function listOutlookEmails(phone, filter = "isRead eq false", maxResults = 10) {
  const result = await graphRequest(
    phone,
    `/me/messages?$filter=${encodeURIComponent(filter)}&$top=${maxResults}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`
  );
  if (result.error) return result;

  const emails = (result.value || []).map((m) => ({
    id: m.id,
    from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "Unknown",
    fromEmail: m.from?.emailAddress?.address || "",
    subject: m.subject || "(No subject)",
    date: m.receivedDateTime,
    snippet: m.bodyPreview || "",
  }));

  logActivity(phone, "read_outlook_emails", `Listed ${emails.length} emails`);
  return { emails };
}

async function readOutlookEmail(phone, emailId) {
  const result = await graphRequest(phone, `/me/messages/${emailId}?$select=id,subject,from,receivedDateTime,body`);
  if (result.error) return result;

  logActivity(phone, "read_outlook_email_detail", result.subject);
  return {
    from: result.from?.emailAddress?.name || result.from?.emailAddress?.address || "Unknown",
    subject: result.subject || "(No subject)",
    date: result.receivedDateTime,
    body: (result.body?.content || "").replace(/<[^>]*>/g, "").slice(0, 2000),
  };
}

async function draftOutlookReply(phone, emailId, replyText) {
  // First get the original message
  const original = await graphRequest(phone, `/me/messages/${emailId}?$select=id,subject,from`);
  if (original.error) return original;

  const result = await graphRequest(phone, `/me/messages/${emailId}/createReply`, "POST");
  if (result.error) return result;

  // Update the draft with our reply text
  const updated = await graphRequest(phone, `/me/messages/${result.id}`, "PATCH", {
    body: { contentType: "text", content: replyText },
  });

  logActivity(phone, "draft_outlook_reply", `Reply to: ${original.from?.emailAddress?.address}`);
  return {
    success: true,
    draftId: result.id,
    to: original.from?.emailAddress?.address,
    subject: original.subject,
  };
}

async function sendOutlookDraft(phone, draftId) {
  const result = await graphRequest(phone, `/me/messages/${draftId}/send`, "POST");
  if (result.error) return result;
  logActivity(phone, "send_outlook_email", `Sent draft ${draftId}`);
  return { success: true };
}

// ─── Outlook Calendar Tools ───────────────────────────────────

async function listOutlookEvents(phone, timeMin = null, timeMax = null, maxResults = 10) {
  const now = new Date();
  const start = timeMin || now.toISOString();
  const end = timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const result = await graphRequest(
    phone,
    `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=${maxResults}&$orderby=start/dateTime&$select=id,subject,start,end,location,bodyPreview`
  );
  if (result.error) return result;

  const events = (result.value || []).map((e) => ({
    id: e.id,
    summary: e.subject || "(No title)",
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    location: e.location?.displayName || null,
    description: e.bodyPreview ? e.bodyPreview.slice(0, 200) : null,
  }));

  logActivity(phone, "list_outlook_events", `Listed ${events.length} events`);
  return { events };
}

async function createOutlookEvent(phone, { summary, startTime, endTime, description, location }) {
  const result = await graphRequest(phone, "/me/events", "POST", {
    subject: summary,
    start: { dateTime: startTime, timeZone: "UTC" },
    end: {
      dateTime: endTime || new Date(new Date(startTime).getTime() + 60 * 60 * 1000).toISOString(),
      timeZone: "UTC",
    },
    body: description ? { contentType: "text", content: description } : undefined,
    location: location ? { displayName: location } : undefined,
  });

  if (result.error) return result;
  logActivity(phone, "create_outlook_event", summary);
  return { success: true, eventId: result.id, link: result.webLink };
}

module.exports = {
  getMicrosoftAuthUrl,
  exchangeCodeForTokens,
  listOutlookEmails,
  readOutlookEmail,
  draftOutlookReply,
  sendOutlookDraft,
  listOutlookEvents,
  createOutlookEvent,
};
