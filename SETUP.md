# Quick Setup Guide

## Architecture Overview

```
Supabase Cron Job (FREE) 
    ↓ HTTP POST
Render Web Service (FREE - 750 hrs/month)
    ↓ Puppeteer (heavy work)
Joby/Archer/Beta websites
    ↓
Supabase Database
```

## Step-by-Step Setup

### Step 1: Deploy Render Web Service

1. **Push code to GitHub** (if not already)
   ```bash
   git add .
   git commit -m "Add Express web service for Supabase cron"
   git push
   ```

2. **Go to Render Dashboard**
   - Visit: https://dashboard.render.com
   - Click: **New → Web Service**

3. **Connect Repository**
   - Select your GitHub repository
   - Choose the `render-cron` directory (or root if it's a monorepo)

4. **Configure Service**
   - **Name:** `evtol-news-service`
   - **Environment:** `Docker`
   - **Dockerfile Path:** `./Dockerfile`
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `node dist/server.js`
   - **Plan:** `Free`

5. **Add Environment Variables**
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
   VOYAGEAI_API_KEY=your_voyageai_key
   VOYAGEAI_EMBEDDING_MODEL=voyage-large-2
   API_SECRET=<generate-random-secret>
   ```

6. **Generate API Secret**
   ```bash
   # Generate a secure random secret
   openssl rand -hex 32
   ```
   Copy this value and use it for `API_SECRET`

7. **Deploy**
   - Click "Create Web Service"
   - Wait for deployment to complete
   - Note your service URL: `https://evtol-news-service.onrender.com`

### Step 2: Test the Service

1. **Test Health Endpoint**
   ```bash
   curl https://evtol-news-service.onrender.com/health
   ```

2. **Test Service Endpoint** (with API secret)
   ```bash
   curl -X POST https://evtol-news-service.onrender.com/api/run/joby \
     -H "Content-Type: application/json" \
     -H "X-API-Secret: YOUR_API_SECRET" \
     -d '{"service": "joby"}'
   ```

### Step 3: Set Up Supabase Cron Jobs

1. **Go to Supabase Dashboard**
   - Visit: https://supabase.com/dashboard
   - Select your project
   - Go to: **SQL Editor**

2. **Enable Extensions**
   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_cron;
   CREATE EXTENSION IF NOT EXISTS pg_net;
   ```

3. **Create Cron Jobs**
   - Open `supabase/cron-jobs.sql`
   - Replace placeholders:
     - `YOUR_RENDER_SERVICE_URL` → Your Render service URL
     - `YOUR_API_SECRET` → The same API_SECRET from Render
   - Copy and paste into SQL Editor
   - Execute

4. **Verify Cron Jobs**
   ```sql
   -- View all scheduled jobs
   SELECT * FROM cron.job;
   ```

### Step 4: Monitor

1. **Check Cron Job History**
   ```sql
   SELECT * FROM cron.job_run_details 
   ORDER BY start_time DESC 
   LIMIT 10;
   ```

2. **Check Render Logs**
   - Go to Render Dashboard → Your Service → Logs
   - View real-time execution logs

3. **Check Supabase Database**
   - Verify new records in `news_duplicate` table

## Troubleshooting

### Service returns 401 Unauthorized
- Verify `API_SECRET` matches in both Render and Supabase
- Check header name: `X-API-Secret` (case-sensitive)

### Cron job not running
- Verify extensions are enabled: `SELECT * FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net');`
- Check cron job is scheduled: `SELECT * FROM cron.job;`
- Check Supabase logs for errors

### Service timeout
- Render free tier has request timeout limits (~30 seconds)
- Consider running services separately instead of all at once
- Check Render logs for timeout errors

## Cost Analysis

- **Supabase Cron Jobs:** FREE ✅
- **Render Web Service:** FREE (750 hours/month) ✅
- **Estimated usage:**
  - Each service: ~5-10 minutes
  - Daily runs: ~10-20 minutes/day
  - Monthly: ~5-10 hours/month
  - **Well within free tier!** ✅

## Next Steps

1. Add more services (Beta Technologies, etc.)
2. Set up monitoring/alerting
3. Add retry logic for failed requests
4. Implement webhook notifications

