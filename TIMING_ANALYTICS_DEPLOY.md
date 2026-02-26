# Timing Analytics Deployment Guide

## Overview
This guide walks through deploying the new timing analytics features to production.

## 1. Run Database Migration

First, apply the schema changes:

```bash
cd ~/.openclaw/workspace/projects/deep-claw/analytics-backend

# Run migration
node sql/run-migration.js sql/migrations/001_timing_analytics.sql
```

This creates:
- `network_activity` - Aggregated hourly activity data
- `post_activity` - Raw post timestamps for analysis
- `following` - Track who user follows
- `insights` - Cached recommendations
- `api_tokens` - Long-lived API tokens (for Sebastian)

## 2. Generate Long-Lived API Token (for Sebastian)

```bash
cd ~/.openclaw/workspace/projects/deep-claw/analytics-backend

# Get your user ID first
# psql $DATABASE_URL -c "SELECT id, npub FROM users WHERE npub = 'YOUR_NPUB';"

# Generate token (replace USER_ID with actual ID)
node scripts/generate-token.js 1 "Sebastian OpenClaw Access" "read:metrics,read:events,read:insights"
```

Save the generated token to `~/.openclaw/workspace/TOOLS.md` under "Deep Claw Analytics".

## 3. Deploy to Production

### Option A: Railway (if using Railway)

```bash
# Push to main branch
git add .
git commit -m "Add timing analytics feature"
git push origin main

# Railway will auto-deploy
```

### Option B: Manual Deployment

```bash
# SSH into production server
ssh your-server

# Pull latest code
cd /path/to/analytics-backend
git pull

# Install dependencies
npm install

# Run migration
node sql/run-migration.js sql/migrations/001_timing_analytics.sql

# Restart service
pm2 restart deep-claw-api
# or
systemctl restart deep-claw-api
```

## 4. Test the New Endpoints

### Test Authentication
```bash
export API_TOKEN="your_new_token_here"
export API_BASE="https://your-api-url.com"

# Test basic auth
curl -H "Authorization: Bearer $API_TOKEN" \
  $API_BASE/auth/me
```

### Test Network Activity Endpoint
```bash
# Get all activity types for last 30 days
curl -H "Authorization: Bearer $API_TOKEN" \
  "$API_BASE/metrics/timing/network-activity?type=all&period=30d" | jq

# Get only follower activity for last 7 days
curl -H "Authorization: Bearer $API_TOKEN" \
  "$API_BASE/metrics/timing/network-activity?type=followers&period=7d" | jq
```

### Test Best Posting Times
```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  "$API_BASE/insights/best-posting-times?period=30d" | jq
```

### Manually Trigger Activity Aggregation
```bash
curl -X POST \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"period": "30d"}' \
  "$API_BASE/admin/aggregate-activity"
```

## 5. Populate Initial Data

Since this is a new feature, you'll need to populate historical data:

### Option A: Backfill from existing events
Create a script to process existing events in the database and populate `post_activity` table.

### Option B: Start fresh
Let the relay listener populate data going forward. Activity will accumulate over the next 7-30 days.

### Recommended: Hybrid approach
1. Start collecting new data immediately (relay listener)
2. Backfill last 7 days from events table
3. Run initial aggregation

```bash
# After backfill, run aggregation
curl -X POST \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"period": "30d"}' \
  "$API_BASE/admin/aggregate-activity"
```

## 6. Update TOOLS.md

Add the new API token to your workspace:

```markdown
## Deep Claw Analytics
- API Token: dc_<your_long_token>_<checksum>
- Base URL: https://nostr-analytics-app.vercel.app/api
- Added: 2026-02-26 (timing analytics token)
- Scopes: read:metrics, read:events, read:insights
- Endpoints:
  - GET /metrics/timing/network-activity - Hourly activity distribution
  - GET /insights/best-posting-times - Posting recommendations
  - POST /admin/aggregate-activity - Manual aggregation trigger
```

## 7. Next Steps

### Backend
- [ ] Create backfill script for historical data
- [ ] Add cron job for daily aggregation
- [ ] Implement relay listener integration (track follower/following posts)
- [ ] Add more insight types (content analysis, growth predictions)

### Frontend
- [ ] Build interactive chart component
- [ ] Add time zone selector UI
- [ ] Create recommendations dashboard
- [ ] Mobile-responsive design

### Data Collection
- [ ] Update relay-listener.js to track post_activity
- [ ] Track who user follows (populate `following` table)
- [ ] Implement engagement tracking by hour

## Troubleshooting

### "No data available"
- Run manual aggregation: `POST /admin/aggregate-activity`
- Check if `post_activity` table has data
- Verify relay listener is running and tracking posts

### "Low confidence" in recommendations
- Need at least 500 data points for medium confidence
- Need 1000+ for high confidence
- Let data accumulate for 7-14 days

### Token not working
- Verify token in database: `SELECT * FROM api_tokens WHERE token = 'YOUR_TOKEN';`
- Check if revoked or expired
- Ensure Authorization header format: `Bearer <token>`

### Rate limiting issues
- Long-lived tokens use same rate limits as user tokens
- Upgrade to premium tier if needed
- Check X-RateLimit-* headers in response

## Environment Variables

Ensure these are set in production:

```env
DATABASE_URL=postgresql://user:pass@host:5432/dbname
PORT=3000
NODE_ENV=production
JWT_SECRET=your-jwt-secret-here
RATE_LIMIT_FREE=100
RATE_LIMIT_PREMIUM=1000
```

## Monitoring

Add logging for new endpoints:
- Track aggregation run times
- Monitor cache hit rates
- Alert on failed aggregations
- Track API usage by endpoint

## Cost Considerations

The new tables will grow over time:
- `post_activity`: ~1KB per post, ~30MB for 30K posts
- `network_activity`: ~100 bytes per hour bucket, minimal
- `insights`: ~5KB per cached insight, negligible

Estimated storage: < 50MB for first month, scales linearly with post volume.
