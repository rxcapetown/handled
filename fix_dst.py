with open("agent.js", "r") as f:
    content = f.read()

old = '    "+1": "America/Chicago",'
new = '    "+1": "America/Chicago", // Note: currently CDT (UTC-5) not CST (UTC-6) due to daylight saving time'

content = content.replace(old, new)

# The real fix - add DST note to system prompt
old2 = 'Current UTC time: ${currentUTC}.'
new2 = 'Current UTC time: ${currentUTC}. IMPORTANT: Use this exact UTC time as your reference for all time calculations. Do NOT manually calculate UTC offsets - always use the timezone name provided and the current UTC time above to determine correct due_at values.'

content = content.replace(old2, new2)
with open("agent.js", "w") as f:
    f.write(content)
print("Done!")
