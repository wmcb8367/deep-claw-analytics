# One-Click Deploy to Railway

## Quick Deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/deep-claw-analytics)

OR manually:

1. Go to https://railway.app/new
2. Click "Deploy from GitHub repo"
3. Select this repository
4. Railway will auto-detect Node.js
5. Click "Add PostgreSQL" plugin
6. Click "Deploy"

## After Deployment

Railway will give you:
- Service URL (e.g., https://your-app.up.railway.app)
- PostgreSQL connection string

Then run migrations:
```bash
# Set your Railway project
railway link

# Run migrations  
railway run node sql/run-migration.js sql/schema.sql
railway run node sql/run-migration.js sql/migrations/001_timing_analytics.sql

# Generate production token
railway run node scripts/generate-token.js 1 "Production API Access"
```

Save the token to TOOLS.md!

## Environment Variables

Railway auto-sets `DATABASE_URL`. You may want to add:
- `PORT` (default: 3000)
- `NODE_ENV=production`
- `JWT_SECRET` (optional, for future features)

Done! Your API will be live at the Railway URL.
