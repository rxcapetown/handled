with open("server.js", "r") as f:
    content = f.read()

# Add telegram webhook handler after the WhatsApp webhook
old = '// ═══════════════════════════════════════════════════════════════\n// GOOGLE OAUTH CALLBACK'

new = '''// ═══════════════════════════════════════════════════════════════
// TELEGRAM WEBHOOK
// ═══════════════════════════════════════════════════════════════
app.post("/webhook/telegram", async (req, res) => {
  res.status(200).send("OK");

  const update = req.body;
  if (!update.message) return;

  const chatId = update.message.chat.id;
  const text = (update.message.text || "").trim();
  const voice = update.message.voice;
  const phone = `tg:${chatId}`;

  async function sendTelegram(text) {
    const clean = text.replace(/[*_~`]/g, "").slice(0, 4000);
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: clean })
    });
  }

  // Handle voice notes
  if (voice) {
    try {
      const fileRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${voice.file_id}`);
      const fileData = await fileRes.json();
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`;
      
      const audioRes = await fetch(fileUrl);
      const audioBuffer = await audioRes.buffer();
      const tmpPath = path.join(os.tmpdir(), "tg_voice_" + Date.now() + ".ogg");
      fs.writeFileSync(tmpPath, audioBuffer);

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: "whisper-1",
      });
      fs.unlinkSync(tmpPath);

      const voiceText = (transcription.text || "").trim();
      if (!voiceText) {
        await sendTelegram("I could not understand that voice note. Could you try typing?");
        return;
      }

      const reply = await handleMessage(phone, voiceText);
      await sendTelegram(reply);
      return;
    } catch(err) {
      console.error("[Telegram Voice Error]", err.message);
      await sendTelegram("I had trouble with your voice note. Could you type instead?");
      return;
    }
  }

  if (!text) return;

  try {
    const reply = await handleMessage(phone, text);
    await sendTelegram(reply);
  } catch(err) {
    console.error("[Telegram Error]", err.message);
    await sendTelegram("Sorry, I hit a temporary issue. Try again!");
  }
});

// ═══════════════════════════════════════════════════════════════
// GOOGLE OAUTH CALLBACK'''

content = content.replace(old, new)
print("Telegram webhook:", "✅" if old not in content else "❌ not found")

with open("server.js", "w") as f:
    f.write(content)

# Add telegram setup at server start
with open("server.js", "r") as f:
    content = f.read()

old2 = '''app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   UMAR is running on :${PORT}     ║
  ║   WhatsApp AI Agent ready            ║
  ╚══════════════════════════════════════╝
  `);
});'''

new2 = '''app.listen(PORT, async () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   UMAR is running on :${PORT}     ║
  ║   WhatsApp AI Agent ready            ║
  ╚══════════════════════════════════════╝
  `);

  // Register Telegram webhook
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.BASE_URL) {
    try {
      const webhookUrl = `${process.env.BASE_URL}/webhook/telegram`;
      const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
      const data = await res.json();
      console.log("[Telegram] Webhook set:", data.description);
    } catch(e) {
      console.error("[Telegram] Webhook setup failed:", e.message);
    }
  }
});'''

content = content.replace(old2, new2)
print("Telegram setup:", "✅" if old2 not in content else "❌ not found")

with open("server.js", "w") as f:
    f.write(content)
print("Done!")
