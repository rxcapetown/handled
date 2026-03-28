with open("agent.js", "r") as f:
    content = f.read()

old = 'Today is ${today}. Current time: ${currentTime} (${user.timezone || "America/Chicago"}). Current UTC time: ${currentUTC}.'
new = 'Today is ${today}. Current time: ${currentTime} (${user.timezone || "America/Chicago"}). Current UTC time: ${currentUTC}. CRITICAL FOR REMINDERS: Always use the Current UTC time above as your base. For relative times like "in 5 minutes", add to current UTC. For absolute times like "9am", convert using the IANA timezone name (e.g. America/Chicago automatically handles daylight saving time - it is currently UTC-5 not UTC-6). Never hardcode UTC offsets.'

content = content.replace(old, new)
print("Fix:", "✅" if old not in content else "❌ not found")

with open("agent.js", "w") as f:
    f.write(content)
print("Done!")
