# EVTOL News Cron Job

A unified cron job project for importing news from multiple EVTOL companies (Joby Aviation, Archer Aviation, Beta Technologies, etc.) using Puppeteer.

## Features

- ✅ **Multi-service support** - Run specific service or all services via `SERVICE_NAME` environment variable
- ✅ Uses Puppeteer for full browser automation
- ✅ Handles JavaScript-rendered content
- ✅ Extracts content from various website structures
- ✅ Generates embeddings using VoyageAI
- ✅ Stores data in Supabase `news_duplicate` table
- ✅ Minimal dependencies (~5 packages)
- ✅ Docker-ready for Render deployment
- ✅ **Option B**: Run specific service via environment variable

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
   # Run Joby Aviation (default)
   npm run dev
   
   # Or run specific service
   npm run dev:joby
   npm run dev:archer
   npm run dev:beta
   npm run dev:all  # Run all services
   ```

## Environment Variables

Required:
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key (bypasses RLS) or `SUPABASE_ANON_KEY`
- `VOYAGEAI_API_KEY` - VoyageAI API key for embeddings
- `VOYAGEAI_EMBEDDING_MODEL` - Model name (default: `voyage-large-2`)

Optional:
- `SERVICE_NAME` - Which service to run: `joby`, `archer`, `beta`, or `all` (default: `joby`)
- `DEBUG` - Set to `true` for debug logging

## Deployment on Render

### Option B: Run Specific Service via Environment Variable (Recommended)

You can create multiple cron jobs, each running a different service:

#### Cron Job 1: Joby Aviation
1. Go to Render Dashboard → New → Cron Job
2. Connect your repository
3. Configure:
   - **Name:** `joby-aviation-cron`
   - **Environment:** Docker
   - **Dockerfile Path:** `./Dockerfile`
   - **Schedule:** `0 2 * * *` (Daily at 2 AM UTC)
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `node dist/index.js`
4. Add environment variables:
   - `SERVICE_NAME=joby`
   - `SUPABASE_URL=...`
   - `SUPABASE_SERVICE_ROLE_KEY=...`
   - `VOYAGEAI_API_KEY=...`

#### Cron Job 2: Archer Aviation
- Same as above, but:
  - **Name:** `archer-aviation-cron`
  - **Schedule:** `0 3 * * *` (Daily at 3 AM UTC)
  - **Environment Variable:** `SERVICE_NAME=archer`

#### Cron Job 3: All Services
- Same as above, but:
  - **Name:** `evtol-news-all-cron`
  - **Schedule:** `0 4 * * *` (Daily at 4 AM UTC)
  - **Environment Variable:** `SERVICE_NAME=all`

### Available Services

- `joby` - Joby Aviation news
- `archer` - Archer Aviation news
- `beta` - Beta Technologies (when implemented)
- `all` - Run all services sequentially

## Project Structure

```
evtol-news-cron/
├── src/
│   ├── services/
│   │   ├── jobyAviationService.ts    # Joby Aviation service
│   │   ├── archerAviationService.ts  # Archer Aviation service
│   │   └── ... (other services)
│   ├── config/
│   │   ├── database.ts               # Supabase client
│   │   └── embedding.ts              # VoyageAI client
│   ├── utils/
│   │   └── logger.ts                 # Simple logger
│   └── index.ts                      # Entry point (supports SERVICE_NAME)
├── Dockerfile
├── package.json
├── tsconfig.json
└── README.md
```

## How It Works

### Service Selection

The cron job uses the `SERVICE_NAME` environment variable to determine which service to run:

- **`SERVICE_NAME=joby`** → Runs only Joby Aviation service
- **`SERVICE_NAME=archer`** → Runs only Archer Aviation service
- **`SERVICE_NAME=beta`** → Runs only Beta Technologies service (when implemented)
- **`SERVICE_NAME=all`** → Runs all services sequentially

### What Each Service Does

**Joby Aviation:**
1. Initializes Puppeteer browser
2. Navigates to Joby Aviation news page
3. Handles cookie consent
4. Clicks category tabs (Press Releases, Blog Posts)
5. Clicks "Load More" to load all articles
6. Extracts article links
7. For each article: fetches content, generates embedding, stores in database

**Archer Aviation:**
1. Initializes Puppeteer browser
2. Navigates to Archer news page
3. Clicks "More News" to load all articles
4. Extracts article links from `#news_content`
5. For each article: fetches content, generates embedding, stores in database

## Quick Reference

### Running Services

```bash
# Set SERVICE_NAME environment variable
export SERVICE_NAME=joby    # Run Joby only
export SERVICE_NAME=archer  # Run Archer only
export SERVICE_NAME=all     # Run all services

# Then run
npm run dev
```

### Render Deployment Examples

**Cron Job for Joby (Daily at 2 AM):**
- Schedule: `0 2 * * *`
- Environment: `SERVICE_NAME=joby`

**Cron Job for Archer (Daily at 3 AM):**
- Schedule: `0 3 * * *`
- Environment: `SERVICE_NAME=archer`

**Cron Job for All Services (Daily at 4 AM):**
- Schedule: `0 4 * * *`
- Environment: `SERVICE_NAME=all`

## Cost

- **Render Free Tier:** 750 hours/month
- **Estimated usage:** ~5-10 minutes per service per run
- **Daily runs:** ~5-10 hours/month (well within free tier)

## Troubleshooting

### Browser fails to launch
- Ensure Chromium dependencies are installed (handled by Dockerfile)
- Check `PUPPETEER_EXECUTABLE_PATH` environment variable

### No content extracted
- Check if Joby website structure changed
- Verify `.rich-text` selectors are still valid
- Enable `DEBUG=true` for detailed logs

### Rate limit errors
- VoyageAI free tier: 3 requests per minute
- The service includes automatic delays and retries

## License

MIT

