with open("agent.js", "r") as f:
    content = f.read()

# Force Claude to use set_reminder tool when reminder keywords detected
old = '''  try {
    // Call Claude with tools
    let response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      tools: availableTools.length > 0 ? availableTools : undefined,
      messages,
    });'''

new = '''  // Detect if user is asking for a reminder
  const isReminderRequest = /remind|reminder|alert|notify|don.t forget|remember to/i.test(messageText);

  try {
    // Call Claude with tools
    let response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      tools: availableTools.length > 0 ? availableTools : undefined,
      tool_choice: isReminderRequest ? { type: "any" } : { type: "auto" },
      messages,
    });'''

content = content.replace(old, new)
print("Fix:", "✅" if old not in content else "❌ not found")

with open("agent.js", "w") as f:
    f.write(content)
print("Done!")
