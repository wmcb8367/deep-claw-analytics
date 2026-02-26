# Deep Claw Analytics - Multi-User Architecture

## Vision

**Deep Claw Analytics is a SaaS platform** that lets any OpenClaw user track their Nostr profile performance and get real-time notifications via webhooks.

**Value Prop:**
- "Plug your OpenClaw agent into Deep Claw Analytics and start tracking your Nostr growth"
- One-line setup: provide your npub + webhook URL
- Your agent gets real-time notifications (mentions, followers, zaps)
- Access metrics via API or web dashboard
- Free tier + premium features

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│              Deep Claw Analytics                     │
│                  (Centralized Backend)               │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────────┐       ┌──────────────┐           │
│  │ Relay        │       │ PostgreSQL   │           │
│  │ Listener     │──────▶│ Database     │           │
│  │ (Multi-npub) │       │ (Multi-user) │           │
│  └──────────────┘       └──────────────┘           │
│         │                        │                  │
│         │                        ▼                  │
│         │              ┌──────────────┐            │
│         │              │ API Server   │            │
│         │              │ (Express)    │            │
│         │              └──────────────┘            │
│         │                        │                  │
│         ▼                        │                  │
│  ┌──────────────┐                │                  │
│  │ Webhook      │◀───────────────┘                  │
│  │ Dispatcher   │                                   │
│  └──────────────┘                                   │
│         │                                            │
└─────────┼────────────────────────────────────────────┘
          │
          │ Webhooks
          ▼
┌─────────────────────────────────────────────────────┐
│              User OpenClaw Instances                 │
├─────────────────────────────────────────────────────┤
│                                                      │
│  User 1 (Willie)         User 2 (Alice)            │
│  ┌─────────────┐         ┌─────────────┐           │
│  │ OpenClaw    │         │ OpenClaw    │           │
│  │ @deepclaw   │         │ @alice      │           │
│  └─────────────┘         └─────────────┘           │
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## User Flow

### 1. Registration (Web UI or API)

**User provides:**
- Nostr npub (public key)
- OpenClaw webhook URL (e.g., `https://gateway.example.com/webhooks/deep-claw`)
- OpenClaw webhook secret (for signature validation)

**System generates:**
- API token (for querying metrics)
- User ID

**System starts:**
- Tracking that npub's events
- Sending webhooks to their OpenClaw instance

---

### 2. Event Collection (Backend)

**Relay Listener:**
- Connects to multiple Nostr relays
- Subscribes to events for ALL registered npubs
- Filters: mentions, replies, followers, zaps
- Stores events in PostgreSQL with `user_id`

---

### 3. Webhook Notifications (Real-time)

**When event occurs:**
1. Relay listener captures event
2. Identifies which user(s) it belongs to
3. Webhook dispatcher sends to each user's OpenClaw endpoint
4. Uses user's webhook secret for HMAC signature

**Example:** Alice gets zapped
- Relay listener sees zap event for Alice's npub
- Webhook dispatcher sends to Alice's OpenClaw webhook
- Alice's OpenClaw agent receives notification, thanks the zapper

---

### 4. API Access (On-demand)

**Users query their own metrics:**
```bash
curl -H "Authorization: Bearer USER_API_TOKEN" \
  https://analytics.deepclaw.io/api/v1/metrics/summary
```

**Returns:**
```json
{
  "followers": 169,
  "posts": 156,
  "zaps_sats": 425000,
  ...
}
```

**Multi-user isolation:** Each user can only access their own data

---

## Database Schema

### users
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  npub TEXT UNIQUE NOT NULL,
  webhook_url TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  api_token TEXT UNIQUE NOT NULL,
  tier TEXT DEFAULT 'free', -- free, premium
  created_at TIMESTAMP DEFAULT NOW(),
  last_active TIMESTAMP
);
```

### events (raw Nostr events)
```sql
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL, -- mention, reply, follow, zap
  author_npub TEXT NOT NULL,
  content TEXT,
  metadata JSONB, -- full event data
  created_at TIMESTAMP NOT NULL
);
```

### metrics (calculated stats)
```sql
CREATE TABLE metrics (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  metric_type TEXT NOT NULL, -- followers, engagement_rate, etc.
  value NUMERIC NOT NULL,
  calculated_at TIMESTAMP DEFAULT NOW()
);
```

### posts (user's own posts with engagement)
```sql
CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  note_id TEXT UNIQUE NOT NULL,
  content TEXT,
  likes INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  zaps_count INTEGER DEFAULT 0,
  zaps_sats INTEGER DEFAULT 0,
  posted_at TIMESTAMP NOT NULL
);
```

---

## API Endpoints (Multi-user)

### Authentication
All endpoints require: `Authorization: Bearer <user_api_token>`

### User Management
- `POST /auth/register` - Register new user (npub + webhook)
- `GET /auth/me` - Get current user info
- `PUT /auth/webhook` - Update webhook URL/secret
- `DELETE /auth/account` - Delete account

### Metrics (user-scoped)
- `GET /metrics/summary` - Current stats for authenticated user
- `GET /metrics/followers?period=7d` - Follower growth for user
- `GET /metrics/posts` - User's posts with engagement
- `GET /network/top-engagers` - Who engages with user

### Actions (user-scoped)
- `POST /posts/create` - Post as user (requires Nostr private key or NIP-07)
- `POST /actions/follow` - Follow account
- `POST /actions/zap` - Send zap

---

## Webhook Events (User-scoped)

Each user receives webhooks ONLY for their own events.

**Example:** Willie gets mentioned on Nostr
1. Relay listener captures mention of @deepclaw
2. Looks up Willie's user_id from npub
3. Sends webhook to Willie's OpenClaw endpoint
4. Willie's OpenClaw receives, processes, responds

---

## Monetization (Built-in)

### Free Tier
- Basic metrics (followers, engagement)
- Webhooks (mentions, followers)
- API access (rate limited)
- Web dashboard

### Premium Tier ($5-10/month in sats)
- Historical trends & predictions
- Content recommendations
- Optimal posting times
- Advanced analytics
- Higher API rate limits
- Priority webhook delivery

**Payment:** Lightning Network (automatic, instant)

---

## Deployment Architecture

### MVP (Phase 1) - Single VPS
```
VPS (DigitalOcean/Hetzner $10/mo)
├── Node.js relay listener
├── PostgreSQL database
├── Express API server
├── Nginx reverse proxy (SSL)
└── Web dashboard (static HTML)
```

### Scale (Phase 2) - Distributed
```
- Multiple relay listeners (load balanced)
- PostgreSQL (managed service)
- API servers (horizontal scaling)
- Redis (caching)
- Cloudflare (CDN + DDoS protection)
```

---

## OpenClaw Integration (User Side)

### Setup Steps (from user perspective)

1. **User signs up** at analytics.deepclaw.io
   - Enters their npub
   - Gets webhook URL to configure in OpenClaw
   - Gets API token

2. **User configures OpenClaw**
   - Adds webhook endpoint (already built - `hooks/deep-claw-webhook.js`)
   - Sets `DEEP_CLAW_WEBHOOK_SECRET`
   - Adds API token to `TOOLS.md`

3. **Start receiving analytics**
   - Webhooks start flowing in
   - OpenClaw agent can query metrics
   - Agent can respond to mentions, track growth

**Zero code required from user** - just configuration!

---

## Development Phases

### Phase 1: Single-User MVP (This Week)
- Build for @deepclaw only
- Prove the concept works
- JSON file storage (simple)

### Phase 2: Multi-User Backend (Week 2)
- PostgreSQL multi-user schema
- User registration API
- API token authentication
- Webhook dispatcher (multi-tenant)

### Phase 3: Production Deploy (Week 3)
- VPS deployment
- SSL/domain setup
- Web dashboard for signup
- Documentation & onboarding

### Phase 4: Premium Features (Week 4+)
- Lightning payments
- Advanced analytics
- Content recommendations
- Marketing & growth

---

## Business Model

**Free tier attracts users** → **Premium features convert to paid** → **API access for power users**

**Target users:**
- OpenClaw users tracking personal Nostr
- Brands/companies on Nostr
- Content creators
- Developers building Nostr apps

**Projected revenue:** (conservative)
- 100 free users
- 10 premium users ($5/mo) = $50/mo
- 5 API power users ($20/mo) = $100/mo
- **Total: $150/mo** (covers infrastructure + profit)

---

## Competitive Advantage

**No one else is doing this:**
- Most Nostr analytics are client-side only
- No webhook notifications to AI agents
- No multi-user SaaS platform

**We're first to market** with AI-integrated Nostr analytics.

---

## Next Steps

**Today:** Build single-user MVP for @deepclaw (prove it works)

**This week:** Migrate to multi-user architecture

**Next week:** Deploy publicly, onboard first users

**Month 1:** 10 users, $50 MRR

**Month 3:** 100 users, $500 MRR

---

Willie: This is WAY bigger than just tracking our own account. This could be a real product.

Should I:
1. Build single-user MVP first (just for us, faster)
2. Build multi-user from day 1 (slower, but production-ready)

What's your call?
