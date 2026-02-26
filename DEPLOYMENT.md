# Deep Claw Analytics - Deployment Guide

## Current Status

**Backend code:** ✅ Complete (multi-user SaaS architecture)
**Database:** ⚠️ Requires PostgreSQL (not yet installed on Mac mini)

## What's Built

1. **API Server** (`src/server.js`)
   - User registration
   - Authentication (Bearer tokens)
   - Rate limiting by tier
   - Metrics endpoints
   - Multi-user isolated

2. **Relay Listener** (`src/relay-listener.js`)
   - Monitors Nostr relays for all registered users
   - Tracks mentions, followers, zaps
   - Stores events in database

3. **Webhook Sender** (`src/webhook-sender.js`)
   - Sends real-time events to user OpenClaw instances
   - HMAC signature verification
   - Retry logic

4. **Database Schema** (`sql/schema.sql`)
   - Multi-user tables
   - Events, metrics, followers, engagers
   - Webhook logs, API usage tracking

5. **Signup Page** (`public/index.html`)
   - Beautiful web UI for registration
   - Returns API token + webhook secret

## Quick Deploy (Mac mini)

### Option 1: PostgreSQL (Full Production)

```bash
# Install PostgreSQL
brew install postgresql@14

# Start PostgreSQL
brew services start postgresql@14

# Create database
/opt/homebrew/opt/postgresql@14/bin/createdb deepclaw_analytics

# Run migrations
cd analytics-backend
npm run db:migrate

# Start services
npm start &                # API server
npm run relay:start &      # Relay listener

# Open http://localhost:3000
```

### Option 2: Deploy to VPS (Recommended for Production)

**Providers:**
- DigitalOcean ($10/mo droplet)
- Hetzner ($5/mo VPS)
- Linode ($10/mo)

**Steps:**
1. Provision Ubuntu 22.04 VPS
2. Install Node.js, PostgreSQL, Nginx
3. Clone repo, configure .env
4. Run migrations
5. Start with PM2
6. Configure Nginx reverse proxy + SSL

See `README.md` for detailed deployment instructions.

### Option 3: Managed Database (Easy)

Use a hosted PostgreSQL instance:
- **Supabase** (free tier available)
- **Neon** (free tier, serverless Postgres)
- **Railway** (free $5 credit/month)

Just update `DATABASE_URL` in `.env` and deploy!

## Willie's Next Steps

**Immediate (to test locally):**
1. Install PostgreSQL: `brew install postgresql@14`
2. Start it: `brew services start postgresql@14`
3. Create DB & run migrations (see setup.sh)
4. Start API server
5. Sign up with @deepclaw npub

**Production (when ready to go live):**
1. Deploy to VPS or use managed database
2. Get a domain (e.g., analytics.deepclaw.io)
3. Configure SSL
4. Update NOSTR_RELAYS if needed
5. Share signup link with OpenClaw users!

## Current Limitation

The backend is **fully built** but needs PostgreSQL to run. Two paths forward:

1. **Install Postgres now** (30 min) → test locally with @deepclaw
2. **Deploy to VPS** (1-2 hours) → go straight to production

Either way, the code is ready!

---

Willie: Which approach do you want me to take?
- Install Postgres on Mac mini now?
- Deploy to a VPS instead?
- Use a managed database service?

Let me know and I'll execute!
