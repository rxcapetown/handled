# 🤖 Handled — Your AI Agent on WhatsApp

An AI personal agent that lives in WhatsApp. Users text it, it manages their email, calendar, reminders, and research. No app download. No technical setup. Just a phone number.

## Architecture

```
User (WhatsApp) → Twilio → Express Server → Claude AI → Tools (Gmail, Calendar, Web) → Response → Twilio → User
```

## Quick Start (48 hours to live)

### 1. Prerequisites
- Node.js 22+
- A DigitalOcean Droplet (2 vCPU, 4GB RAM, Ubuntu 24)
- Domain name pointed to your server

### 2. Service Accounts (create all of these first)
- **Twilio**: Sign up → Messaging → Try WhatsApp Sandbox
- **Anthropic**: Get API key at console.anthropic.com
- **Google Cloud**: Create project → Enable Gmail API + Calendar API → Create OAuth credentials
- **Stripe**: Create account → Add products ($9.99/mo Standard, $19.99/mo Pro) → Get webhook secret

### 3. Server Setup
```bash
# SSH into your Droplet
ssh root@your-server-ip

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Clone your code (or scp it)
mkdir -p /opt/handled
cd /opt/handled
# ... copy your files here ...

# Install dependencies
npm install

# Set up environment
cp .env.example .env
nano .env  # Fill in all values

# Generate encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Copy the output into .env as ENCRYPTION_KEY

# Start the server
npm start

# For production, use pm2:
npm install -g pm2
pm2 start server.js --name handled
pm2 save
pm2 startup  # Auto-start on reboot
```

### 4. Nginx Reverse Proxy + SSL
```bash
apt install nginx certbot python3-certbot-nginx -y

# Create nginx config
cat > /etc/nginx/sites-available/handled << 'EOF'
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

ln -s /etc/nginx/sites-available/handled /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# Get SSL certificate
certbot --nginx -d yourdomain.com
```

### 5. Configure Twilio Webhook
In Twilio Console → Messaging → WhatsApp Sandbox:
- Set webhook URL to: `https://yourdomain.com/webhook/whatsapp`
- Method: POST

### 6. Configure Stripe Webhook
In Stripe Dashboard → Developers → Webhooks:
- Add endpoint: `https://yourdomain.com/webhook/stripe`
- Events: `checkout.session.completed`, `customer.subscription.deleted`

### 7. Test It
Text your Twilio sandbox number on WhatsApp. Say "hi". 🎉

## File Structure
```
handled/
├── server.js          # Main Express server (routes, webhooks, cron jobs)
├── agent.js           # AI agent brain (Claude + tool use loop)
├── db.js              # SQLite database + encryption + helpers
├── tools/
│   └── google.js      # Gmail + Calendar OAuth tools
├── public/            # Static files (if needed)
├── package.json
├── .env.example       # Environment variables template
└── README.md
```

## Key Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/webhook/whatsapp` | POST | Receives WhatsApp messages from Twilio |
| `/webhook/stripe` | POST | Receives payment events from Stripe |
| `/auth/google/callback` | GET | OAuth callback from Google |
| `/connect?phone=X` | GET | Web page to connect Gmail/Calendar |
| `/subscribe?phone=X` | GET | Redirects to Stripe Checkout |
| `/health` | GET | Health check + user stats |
| `/` | GET | Landing page |

## WhatsApp Commands
| Command | What it does |
|---------|-------------|
| `connect` | Sends OAuth link to connect Gmail/Calendar |
| `upgrade` / `subscribe` | Sends Stripe payment link |
| `status` | Shows trial/subscription status |
| Any other text | Processed by AI agent |

## Cost Estimates (per user per month)
| Component | Cost |
|-----------|------|
| Claude API (Sonnet) | $3-8/mo per active user |
| Twilio WhatsApp | $0.50-2/mo per active user |
| Server (shared across users) | $24/mo total |
| **Total per user** | **~$4-10/mo** |

## Adding Voice (Week 3+)
1. Voice notes IN: Download audio from Twilio → Whisper API → text → process normally
2. Voice notes OUT: Generate TTS response → send as audio message via Twilio
3. Live calls (Month 2): Twilio Voice + Deepgram streaming STT + ElevenLabs TTS

## Security
- OAuth tokens encrypted with AES-256-GCM at rest
- No passwords stored — Google/Microsoft handle auth
- Stripe handles all payment data (PCI compliant)
- Per-user data isolation in database
- All traffic over HTTPS via Let's Encrypt
