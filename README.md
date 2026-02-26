# Deep Claw Analytics Backend

Multi-user Nostr analytics platform for OpenClaw users.

## Features

- 🦞 **Multi-user SaaS** - Any OpenClaw user can track their Nostr profile
- ⚡ **Real-time webhooks** - Instant notifications (mentions, followers, zaps)
- 📊 **Analytics API** - Query metrics, follower growth, engagement
- 🔐 **Secure** - API tokens, webhook signatures, rate limiting
- 💰 **Monetizable** - Free tier + premium features

## Quick Start

### Prerequisites

- PostgreSQL (local or hosted)
- Node.js 18+
- Nostr npub

### Installation

```bash
cd analytics-backend
npm install
```

### Configuration

1. Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

2. Edit `.env` with your database URL and settings

### Database Setup

```bash
npm run db:migrate
```

### Start Services

**API Server:**
```bash
npm start
# or for development with auto-reload:
npm run dev
```

**Relay Listener:**
```bash
npm run relay:start
```

### Register First User

Open `http://localhost:3000` in your browser and sign up with:
- Your Nostr npub
- Your OpenClaw webhook URL (e.g., `http://localhost:18789/webhooks/deep-claw`)

Save the API token and webhook secret!

## Architecture

```
Nostr Relays
    ↓
Relay Listener (monitors events for all users)
    ↓
PostgreSQL (multi-user database)
    ↓
API Server (Express)
    ↓
Webhook Dispatcher → User OpenClaw instances
```

## API Endpoints

### Public
- `POST /auth/register` - Register new user

### Authenticated (require Bearer token)
- `GET /auth/me` - Get current user info
- `PUT /auth/webhook` - Update webhook config
- `GET /metrics/summary` - Current stats
- `GET /metrics/followers?period=7d` - Follower growth
- `GET /metrics/posts?limit=10` - Recent posts
- `GET /network/top-engagers` - Top engagers

See `ARCHITECTURE.md` for full API reference.

## OpenClaw Integration

### User Setup (OpenClaw side)

1. Sign up at Deep Claw Analytics
2. Get API token + webhook secret
3. Configure OpenClaw:
   - Webhook handler already exists at `~/.openclaw/workspace/hooks/deep-claw-webhook.js`
   - Add secret to `.env`: `DEEP_CLAW_WEBHOOK_SECRET=your-secret`
   - Add API token to `TOOLS.md`

4. Start receiving real-time notifications!

### Webhook Events

Your OpenClaw agent will receive:
- `mention` - Someone mentioned you
- `new_follower` - New follower
- `zap` - Received a zap
- `daily_summary` - Daily stats (8 AM PST)

## Development

### Project Structure

```
analytics-backend/
├── src/
│   ├── server.js          # API server
│   ├── relay-listener.js  # Nostr event monitor
│   ├── webhook-sender.js  # Send webhooks to users
│   ├── auth.js            # Authentication & rate limiting
│   ├── db.js              # Database connection
│   └── config.js          # Configuration
├── sql/
│   ├── schema.sql         # Database schema
│   └── migrate.js         # Migration script
├── public/
│   └── index.html         # Signup page
└── package.json
```

### Adding Features

1. Add database tables in `sql/schema.sql`
2. Run migration: `npm run db:migrate`
3. Add API endpoint in `src/server.js`
4. Add relay listener logic in `src/relay-listener.js`
5. Add webhook event in `src/webhook-sender.js`

## Deployment

### Single VPS (MVP)

```bash
# Install PostgreSQL
sudo apt install postgresql

# Create database
sudo -u postgres createdb deepclaw_analytics

# Clone repo
git clone https://github.com/deepclaw/analytics-backend
cd analytics-backend

# Install dependencies
npm install

# Configure .env
cp .env.example .env
nano .env

# Run migration
npm run db:migrate

# Start with PM2
npm install -g pm2
pm2 start src/server.js --name deepclaw-api
pm2 start src/relay-listener.js --name deepclaw-relay

# Setup Nginx reverse proxy
# (configure SSL, domain, etc.)
```

## Monetization

### Free Tier
- Basic metrics
- Webhooks (mentions, followers)
- API access (100 req/hour)

### Premium Tier ($5-10/month in sats)
- Historical trends
- Content recommendations
- 1000 req/hour
- Priority webhooks

### Implementation
- Lightning Network payments
- Automatic tier upgrade on payment
- See `ARCHITECTURE.md` for details

## License

MIT

## Support

- GitHub Issues: https://github.com/deepclaw/analytics/issues
- Nostr: @deepclaw
- Email: willie@mcbrideracing.com

---

Built with 🦞 by Deep Claw
