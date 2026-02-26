# Timing Analytics Feature

## Overview
Help users understand WHEN their network is most active so they can optimize post timing for maximum engagement.

## Concept
Since we don't have geographic data on followers, we use **activity patterns as a proxy for timezone distribution**. By analyzing when followers and following post/engage, we can infer "zones of maximum participation."

## Data Requirements

### New Database Schema
We need to track activity timestamps for:
1. **Follower activity** - when people following the user post
2. **Following activity** - when people the user follows post
3. **Engagement activity** - when people interact with user's posts

### New Tables

```sql
-- Activity timeline (hourly buckets in GMT)
CREATE TABLE IF NOT EXISTS network_activity (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  activity_type TEXT CHECK (activity_type IN ('follower_post', 'following_post', 'engagement')),
  hour_gmt INTEGER CHECK (hour_gmt >= 0 AND hour_gmt < 24),
  activity_count INTEGER DEFAULT 1,
  window_start DATE NOT NULL, -- For filtering by time period
  UNIQUE(user_id, activity_type, hour_gmt, window_start)
);

CREATE INDEX idx_network_activity_user ON network_activity(user_id);
CREATE INDEX idx_network_activity_type ON network_activity(activity_type);
CREATE INDEX idx_network_activity_window ON network_activity(window_start DESC);
```

## API Endpoints

### GET /metrics/timing/network-activity
Get hourly activity distribution for followers/following

**Query params:**
- `type` - 'followers' | 'following' | 'engagement' | 'all' (default: all)
- `period` - '24h' | '7d' | '30d' | '6m' (default: 30d)

**Response:**
```json
{
  "period": "30d",
  "current_time_gmt": "2026-02-26T15:00:00Z",
  "followers": {
    "hourly_distribution": [
      { "hour_gmt": 0, "activity_count": 45 },
      { "hour_gmt": 1, "activity_count": 32 },
      ...
    ],
    "peak_hours": [14, 15, 16],
    "zone_of_max_participation": {
      "start_hour_gmt": 13,
      "end_hour_gmt": 18,
      "total_activity": 1234,
      "percentage_of_total": 45.2
    }
  },
  "following": { ... },
  "engagement": { ... }
}
```

### GET /insights/best-posting-times
Get actionable recommendations

**Query params:**
- `period` - '24h' | '7d' | '30d' | '6m' (default: 30d)

**Response:**
```json
{
  "recommendations": [
    {
      "time_gmt": "14:00",
      "score": 95,
      "reason": "Peak activity from followers (45% of daily engagement)",
      "expected_reach": "high"
    },
    {
      "time_gmt": "18:00",
      "score": 87,
      "reason": "High follower activity, moderate engagement history",
      "expected_reach": "medium-high"
    }
  ],
  "zone_of_max_participation": {
    "start_hour_gmt": 13,
    "end_hour_gmt": 18,
    "description": "Your network is most active between 1:00 PM - 6:00 PM GMT"
  },
  "analysis": {
    "total_data_points": 15234,
    "period_analyzed": "30d",
    "confidence": "high"
  }
}
```

## Frontend Components

### Interactive Graph Features
1. **24-hour timeline** (0-23 GMT)
2. **Toggle between**:
   - Followers activity
   - Following activity
   - Engagement activity
   - All combined
3. **Time period selector**: 24h / 7d / 30d / 6m
4. **Current time indicator** (dotted line in GMT)
5. **Highlighted zone** showing max participation window
6. **Tooltip** on hover showing exact counts

### UI Mockup
```
┌─────────────────────────────────────────────────────┐
│ Network Activity Timeline                    [30d ▼]│
├─────────────────────────────────────────────────────┤
│                                                      │
│ ○ Followers  ○ Following  ○ Engagement  ● All      │
│                                                      │
│    │                                                │
│ 500│     ╱╲                                         │
│    │    ╱  ╲        ╱╲                              │
│ 400│   ╱    ╲      ╱  ╲                             │
│    │  ╱      ╲    ╱    ╲      [ZONE]               │
│ 300│ ╱        ╲  ╱      ╲    ╱│    │╲              │
│    │╱          ╲╱        ╲  ╱ │    │ ╲             │
│ 200│                      ╲╱  │    │  ╲            │
│    │                          │    │               │
│ 100│                          │ ·  │               │
│    │                          │ ·  │               │
│  0 └──────────────────────────┼────┼───────────────┤
│     0  2  4  6  8 10 12 14 16 18 20 22            │
│                    GMT Hour                         │
│                                                      │
│ Zone of Max Participation: 13:00 - 18:00 GMT       │
│ 📊 45% of network activity occurs in this window    │
│ 💡 Recommendation: Post between 2-5 PM GMT for     │
│    maximum reach                                    │
└─────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Backend (Data Collection)
1. ✅ Schema design (done above)
2. Add migration for new table
3. Update relay-listener to track activity timestamps
4. Background job to aggregate hourly data
5. Calculate zones of max participation

### Phase 2: Backend (API)
1. `/metrics/timing/network-activity` endpoint
2. `/insights/best-posting-times` endpoint
3. Add to existing `/metrics/summary` for quick view

### Phase 3: Frontend
1. Interactive chart component (Chart.js or Recharts)
2. Time period selector
3. Activity type toggle
4. Zone highlighting
5. Recommendations panel

### Phase 4: Persistent API Access
1. Move from environment-based to database-stored API tokens
2. Generate long-lived tokens for Sebastian's access
3. Token management UI (optional for v1)

## Questions for Willie
1. Should we track activity for ALL followers/following, or just recent (e.g., active in last 30d)?
2. What's the minimum data threshold before showing recommendations? (e.g., need 100+ data points)
3. Should we factor in user's own past post performance by time?
4. Any specific chart library preference? (Chart.js, Recharts, D3, etc.)
