with open("agent.js", "r") as f:
    content = f.read()

old = '- REMINDERS: Always use set_reminder tool when user wants a reminder. Convert their local time to UTC using their timezone shown above. If date or time is unclear, ask: "Just to make sure I remind you at the right time - could you confirm the exact date and time?" Always confirm back in local time e.g. "Done! I will remind you to call Matthew on Wed Apr 1 at 9:00 AM."'

new = '- REMINDERS: Always use set_reminder tool when user wants a reminder. The current UTC time is shown in the system prompt. For RELATIVE times like "in 5 minutes" or "in 2 hours", add that duration to the CURRENT UTC time shown above to get due_at. For ABSOLUTE times like "at 9am" or "March 25 at 3pm", convert from the user timezone to UTC. If date or time is unclear, ask: "Just to make sure I remind you at the right time - could you confirm the exact date and time?" Always confirm back in local time e.g. "Done! I will remind you to call Matthew on Wed Apr 1 at 9:00 AM."'

content = content.replace(old, new)
print("Fix:", "✅" if old not in content else "❌ not found")

# Also update the system prompt to include current UTC time explicitly
old2 = '  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });'
new2 = '  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });'
# Add UTC time to system prompt
old3 = '  const currentTime = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: user.timezone || "America/Chicago" });'
new3 = '  const currentTime = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: user.timezone || "America/Chicago" });\n  const currentUTC = new Date().toISOString();'

content = content.replace(old3, new3)
print("Fix UTC time:", "✅" if old3 not in content else "❌ not found")

old4 = 'Today is ${today}. Current time: ${currentTime} (${user.timezone || "America/Chicago"}).'
new4 = 'Today is ${today}. Current time: ${currentTime} (${user.timezone || "America/Chicago"}). Current UTC time: ${currentUTC}.'

content = content.replace(old4, new4)
print("Fix system prompt:", "✅" if old4 not in content else "❌ not found")

with open("agent.js", "w") as f:
    f.write(content)
print("Done!")
