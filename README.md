# EVTOL News Web Service

A web service for importing news from multiple EVTOL companies (Joby Aviation, Archer Aviation, etc.) using Puppeteer. Designed to be called by **Supabase Cron Jobs** and hosted on **Render Web Service** (free tier).

## Architecture

```
Supabase Cron Job (FREE)
    ↓ HTTP POST
Render Web Service (FREE - 750 hrs/month)
    ↓ Puppeteer (heavy work)
Joby/Archer/Beta websites
    ↓
Supabase Database
```

## Features

- ✅ **Express web service** - HTTP API endpoints
- ✅ **Supabase Cron integration** - Free cron jobs call the service
- ✅ **Render Web Service** - Free tier hosting (750 hours/month)
- ✅ **API security** - Secret key authentication
- ✅ **Multi-service support** - Joby, Archer, and more
- ✅ **Health checks** - Monitoring endpoints

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Build:**
   ```bash
   npm run build
   ```

4. **Test locally:**
   ```bash
   npm run dev:server
   ```

## Environment Variables

Required:
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key (bypasses RLS)
- `VOYAGEAI_API_KEY` - VoyageAI API key for embeddings
- `VOYAGEAI_EMBEDDING_MODEL` - Model name (default: `voyage-large-2`)

Optional:
- `PORT` - Server port (default: 3000, automatically set by Render)
- `API_SECRET` or `SUPABASE_CRON_SECRET` - Secret key for API authentication
- `DEBUG` - Set to `true` for debug logging

**Automatically Set by Render:**
- `RENDER_EXTERNAL_URL` - Your service's public URL (e.g., `https://evtol-news-service.onrender.com`)
  - ✅ **You don't need to set this** - Render provides it automatically
  - Available at runtime: `process.env.RENDER_EXTERNAL_URL`
  - Used by the server to show correct URLs in logs

## API Endpoints

### Health Check
```bash
GET /health
```

### List Services
```bash
GET /api/services
```

### Run Specific Service
```bash
POST /api/run/:service
Headers:
  X-API-Secret: YOUR_API_SECRET
Body:
  {
    "service": "joby"  # or "archer"
  }
```

### Run All Services
```bash
POST /api/run-all
Headers:
  X-API-Secret: YOUR_API_SECRET
```

## Deployment on Render

### Step 1: Deploy Web Service

1. Go to Render Dashboard → New → Web Service
2. Connect your repository
3. Configure:
   - **Name:** `evtol-news-service`
   - **Environment:** Docker
   - **Dockerfile Path:** `./Dockerfile`
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `node dist/server.js`
   - **Plan:** Free

4. Add environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `VOYAGEAI_API_KEY`
   - `API_SECRET` (generate a random secret)
   - `VOYAGEAI_EMBEDDING_MODEL` (optional)

5. Deploy and note your service URL: `https://your-service.onrender.com`

### Step 2: Set Up Supabase Cron Jobs

1. Go to Supabase Dashboard → SQL Editor
2. Run the SQL from `supabase/cron-jobs.sql`
3. Replace placeholders:
   - `YOUR_RENDER_SERVICE_URL` → Your Render service URL
   - `YOUR_API_SECRET` → The same `API_SECRET` from Render

4. The cron jobs will now call your Render service automatically!

## Supabase Cron Job Setup

### Prerequisites

Enable `pg_cron` extension in Supabase:

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;
```

### Create Cron Jobs

See `supabase/cron-jobs.sql` for complete examples.

**Example: Joby Aviation (Daily at 2 AM UTC)**
```sql
SELECT cron.schedule(
  'joby-aviation-daily',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://your-service.onrender.com/api/run/joby',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-API-Secret', 'your-secret-here'
    )
  ) AS request_id;
  $$
);
```

## Testing

### Test Health Endpoint
```bash
curl http://localhost:3000/health
```

### Test Service Endpoint
```bash
curl -X POST http://localhost:3000/api/run/joby \
  -H "Content-Type: application/json" \
  -H "X-API-Secret: your-secret" \
  -d '{"service": "joby"}'
```

### Test from Supabase (after deployment)
```sql
-- Test the HTTP call
SELECT net.http_post(
  url := 'https://your-service.onrender.com/api/run/joby',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'X-API-Secret', 'your-secret'
  )
) AS request_id;
```

## Cost Analysis

### Free Tier Usage

- **Supabase Cron Jobs:** FREE (unlimited)
- **Render Web Service:** FREE (750 hours/month)
- **Estimated usage:**
  - Each service run: ~5-10 minutes
  - Daily runs: ~10-20 minutes/day
  - Monthly: ~5-10 hours/month
  - **Well within free tier!** ✅

## Project Structure

```
render-cron/
├── src/
│   ├── services/
│   │   ├── jobyAviationService.ts
│   │   └── archerAviationService.ts
│   ├── config/
│   │   ├── database.ts
│   │   └── embedding.ts
│   ├── utils/
│   │   └── logger.ts
│   ├── server.ts              # Express web server
│   └── index.ts               # Backward compatibility
├── supabase/
│   └── cron-jobs.sql          # Supabase cron job SQL
├── Dockerfile
├── package.json
└── README.md
```

## Security

The API uses a secret key for authentication. Set `API_SECRET` in both:
1. **Render environment variables**
2. **Supabase cron job headers** (`X-API-Secret`)

Generate a strong secret:
```bash
# Generate random secret
openssl rand -hex 32
```

## Monitoring

### Check Cron Job Status
```sql
-- View all cron jobs
SELECT * FROM cron.job;

-- View cron job history
SELECT * FROM cron.job_run_details 
ORDER BY start_time DESC 
LIMIT 10;
```

### Check Service Logs
- Render Dashboard → Your Service → Logs
- View real-time logs from the web service

## Troubleshooting

### Cron job not running
- Check if `pg_cron` extension is enabled
- Verify cron job is scheduled: `SELECT * FROM cron.job;`
- Check Supabase logs for errors

### Service returns 401
- Verify `API_SECRET` matches in both Render and Supabase
- Check request headers include `X-API-Secret`

### Service timeout
- Render free tier has request timeout limits
- Consider running services separately instead of all at once
- Check Render logs for timeout errors

## License

MIT
