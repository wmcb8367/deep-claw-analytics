# Deep Claw Analytics Backend - Implementation Plan

## Current State

We have **specs and integration docs** for how OpenClaw will interface with Deep Claw Analytics, but the analytics backend **doesn't exist yet**.

**What exists:**
- Integration specs (webhook events, API endpoints)
- OpenClaw webhook handler (ready to receive events)
- Posting strategy
- Nostr scripts for manual engagement

**What needs building:**
- The actual analytics backend
- Relay listener to collect Nostr events
- Database to store metrics
- API server to expose data
- Webhook sender to notify OpenClaw

---

## Architecture

```
Nostr Relays
    ↓
Relay Listener (Node.js)
    ↓
PostgreSQL Database
    ↓
API Server (Express)
    ↓
Webhook Sender → OpenClaw
```

---

## Phase 1: Minimal Viable Analytics (This Week)

### 1. Relay Listener
**Purpose:** Listen to Nostr events for @deepclaw account

**Tech:** Node.js + nostr-tools

**Events to track:**
- Mentions of @deepclaw (kind 1)
- Replies to our posts
- New followers (kind 3)
- Zaps (kind 9735)

**Storage:** Write to JSON files first, PostgreSQL later

**File:** `analytics-backend/relay-listener.js`

---

### 2. Metrics Calculator
**Purpose:** Process collected events into metrics

**Metrics:**
- Follower count
- Post engagement (likes, replies, reposts)
- Zaps received (count + sats)
- Top engagers
- Content performance

**File:** `analytics-backend/calculate-metrics.js`

**Run:** Every hour via cron

---

### 3. Simple API Server
**Purpose:** Expose metrics for OpenClaw to query

**Endpoints (MVP):**
- `GET /metrics/summary` - Current stats
- `GET /metrics/posts` - Recent posts with engagement
- `GET /network/top-engagers` - Who interacts most

**File:** `analytics-backend/api-server.js`

**Port:** 3000 (local only for now)

---

### 4. Webhook Sender
**Purpose:** Push important events to OpenClaw in real-time

**Events to send:**
- New mention/reply (immediate)
- New follower (if influential >1k followers)
- Zap received (if >1000 sats)
- Daily summary (8 AM PST)

**File:** `analytics-backend/webhook-sender.js`

---

## Phase 2: Production Ready (Next Week)

- PostgreSQL database instead of JSON files
- Web dashboard (simple HTML/JS)
- Authentication for API
- Deploy to VPS or cloud
- SSL/HTTPS
- Better error handling
- Logging and monitoring

---

## Phase 3: Premium Features (Week 3+)

- Historical trends
- Content recommendations
- Optimal posting times
- Competitor analysis
- Multi-user support
- Lightning payments for premium

---

## Immediate Next Steps (Today)

1. **Create relay listener** that tracks @deepclaw events
2. **Store in JSON** for now (easy to migrate to DB later)
3. **Build simple API** to expose current metrics
4. **Test webhook** to OpenClaw
5. **Automate** via cron/systemd

---

## Tech Stack (MVP)

- **Node.js** - Runtime
- **nostr-tools** - Nostr protocol library
- **Express** - API server
- **node-cron** - Scheduled tasks
- **JSON files** - Data storage (phase 1)
- **PostgreSQL** - Database (phase 2)

---

## File Structure

```
analytics-backend/
├── relay-listener.js      # Listen to Nostr events
├── calculate-metrics.js   # Process events into metrics
├── api-server.js          # Expose metrics API
├── webhook-sender.js      # Push events to OpenClaw
├── config.js              # Configuration
├── data/                  # JSON storage (temp)
│   ├── events/            # Raw Nostr events
│   ├── metrics/           # Calculated metrics
│   └── state/             # Listener state
└── package.json           # Dependencies
```

---

## Development Plan (Today)

**Step 1:** Create `relay-listener.js`
- Connect to popular relays
- Filter for events mentioning @deepclaw
- Store raw events to `data/events/`

**Step 2:** Create `calculate-metrics.js`
- Read events from `data/events/`
- Calculate current metrics
- Save to `data/metrics/summary.json`

**Step 3:** Create `api-server.js`
- Read from `data/metrics/`
- Serve via Express
- Test with curl

**Step 4:** Create `webhook-sender.js`
- Read events
- Send to OpenClaw webhook endpoint
- Handle retries

**Step 5:** Test end-to-end
- Mention @deepclaw on Nostr
- Verify event captured
- Verify metrics updated
- Verify webhook sent to OpenClaw
- Verify OpenClaw logs event

---

## Timeline

- **Today:** Relay listener + basic metrics + API (4-6 hours)
- **Tomorrow:** Webhook sender + testing (2-3 hours)
- **This week:** Polish, error handling, cron automation
- **Next week:** PostgreSQL migration, web dashboard
- **Week 3:** Premium features, monetization

---

Willie: Want me to start building this now? I can have the MVP (relay listener + metrics + API) ready today.

Or should I wait for you to review the plan first?
