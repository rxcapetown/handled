with open("agent.js", "r") as f:
    content = f.read()

# Fix 1: tool description
old1 = 'description: "Set a reminder for the user. The agent will send a WhatsApp message when the reminder is due.",'
new1 = 'description: "Set a reminder for the user. Umar will send them a WhatsApp message at the exact date and time. If the user does not specify a clear date AND time, ask them to confirm before setting. ALWAYS use this tool when user asks to be reminded about anything.",'
content = content.replace(old1, new1)
print("Fix 1:", "✅" if old1 not in content else "❌ not found")

# Fix 2: due_at description
old2 = 'due_at: { type: "string", description: "ISO 8601 datetime for when to send the reminder" }'
new2 = 'due_at: { type: "string", description: "ISO 8601 datetime in UTC. MUST convert from user local time to UTC using their timezone in the system prompt. E.g. timezone America/Chicago (UTC-5), user says 9am = 14:00 UTC. Asia/Tokyo (UTC+9), user says 6pm = 09:00 UTC. Asia/Dubai (UTC+4), user says 9am = 05:00 UTC. Always end with Z e.g. 2026-04-01T14:00:00.000Z" }'
content = content.replace(old2, new2)
print("Fix 2:", "✅" if old2 not in content else "❌ not found")

# Fix 3: reminder rule in system prompt
old3 = '- REMINDERS: When calling set_reminder, ALWAYS convert the user\'s local time to UTC. The user\'s timezone is ${user.timezone || "America/Chicago"}. For example if user says "remind me at 7pm" and timezone is America/Chicago (UTC-5), store due_at as the UTC equivalent (midnight UTC). Always calculate today\'s date correctly when the user says "tonight", "tomorrow", etc.'
new3 = '- REMINDERS: Always use set_reminder tool when user wants a reminder. Convert their local time to UTC using their timezone shown above. If date or time is unclear, ask: "Just to make sure I remind you at the right time - could you confirm the exact date and time?" Always confirm back in local time e.g. "Done! I will remind you to call Matthew on Wed Apr 1 at 9:00 AM."'
content = content.replace(old3, new3)
print("Fix 3:", "✅" if old3 not in content else "❌ not found")

with open("agent.js", "w") as f:
    f.write(content)

# Fix 4: cron every minute
with open("server.js", "r") as f:
    server = f.read()

old4 = 'cron.schedule("*/5 * * * *", async () => {'
new4 = 'cron.schedule("* * * * *", async () => {'
server = server.replace(old4, new4)
print("Fix 4:", "✅" if old4 not in server else "❌ not found")

with open("server.js", "w") as f:
    f.write(server)

print("\nDone!")
