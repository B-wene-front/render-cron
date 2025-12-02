# Environment Variables Guide

## How to Get Environment Variable Values

### 1. **RENDER_EXTERNAL_URL** (Automatic - No Action Needed)

**What it is:**
- Automatically set by Render for all web services
- Contains your service's public URL (e.g., `https://evtol-news-service.onrender.com`)

**How to access:**
- In your code: `process.env.RENDER_EXTERNAL_URL`
- In Render Dashboard: Go to your service → Environment → It's listed automatically
- In logs: The server will automatically detect and use it

**You don't need to:**
- ❌ Set it manually in Render
- ❌ Add it to your `.env` file
- ❌ Configure it anywhere

**Example:**
```javascript
// In your code (server.ts)
const renderUrl = process.env.RENDER_EXTERNAL_URL;
// On Render: "https://evtol-news-service.onrender.com"
// Locally: undefined (falls back to localhost)
```

---

### 2. **PORT** (Automatic on Render, Optional Locally)

**On Render:**
- ✅ Automatically set by Render
- You don't need to configure it
- Usually `10000` or similar

**Locally:**
- Defaults to `3000` if not set
- Can override: `PORT=8080 npm run dev:server`

**How to see it:**
- Render Dashboard → Your Service → Environment → `PORT`
- Or check logs: `🚀 EVTOL News Service running on port 10000`

---

### 3. **API_SECRET** (You Must Generate and Set)

**Step 1: Generate a secret**
```powershell
# Windows PowerShell
-join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object {[char]$_})
```

Or use Node.js:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Step 2: Set in Render**
1. Go to Render Dashboard → Your Service → Environment
2. Click "Add Environment Variable"
3. Key: `API_SECRET`
4. Value: (paste your generated secret)
5. Save

**Step 3: Use in Supabase**
- Open `supabase/cron-jobs.sql`
- Replace `YOUR_API_SECRET` with the same secret
- Run the SQL in Supabase

**See also:** `GENERATE_SECRET.md`

---

### 4. **SUPABASE_URL** (From Supabase Dashboard)

**How to get:**
1. Go to Supabase Dashboard → Your Project
2. Go to Settings → API
3. Copy "Project URL"
4. Example: `https://abcdefgh.supabase.co`

**Set in Render:**
- Key: `SUPABASE_URL`
- Value: `https://your-project.supabase.co`

---

### 5. **SUPABASE_SERVICE_ROLE_KEY** (From Supabase Dashboard)

**How to get:**
1. Go to Supabase Dashboard → Your Project
2. Go to Settings → API
3. Find "service_role" key (⚠️ Keep this secret!)
4. Click "Reveal" and copy

**Set in Render:**
- Key: `SUPABASE_SERVICE_ROLE_KEY`
- Value: (paste the service_role key)

**⚠️ Important:** This key bypasses Row-Level Security (RLS). Keep it secret!

---

### 6. **VOYAGEAI_API_KEY** (From VoyageAI Dashboard)

**How to get:**
1. Go to https://www.voyageai.com/
2. Sign up / Log in
3. Go to API Keys section
4. Copy your API key

**Set in Render:**
- Key: `VOYAGEAI_API_KEY`
- Value: (paste your API key)

---

### 7. **VOYAGEAI_EMBEDDING_MODEL** (Optional)

**Default:** `voyage-large-2`

**Other options:**
- `voyage-large-2` (recommended)
- `voyage-code-2` (for code)
- `voyage-2` (older version)

**Set in Render (optional):**
- Key: `VOYAGEAI_EMBEDDING_MODEL`
- Value: `voyage-large-2`

---

## Quick Reference: All Variables

| Variable | Source | Required | Auto-Set by Render |
|----------|--------|----------|-------------------|
| `RENDER_EXTERNAL_URL` | Render | No | ✅ Yes |
| `PORT` | Render | No | ✅ Yes |
| `API_SECRET` | You generate | ✅ Yes | ❌ No |
| `SUPABASE_URL` | Supabase | ✅ Yes | ❌ No |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | ✅ Yes | ❌ No |
| `VOYAGEAI_API_KEY` | VoyageAI | ✅ Yes | ❌ No |
| `VOYAGEAI_EMBEDDING_MODEL` | You choose | No | ❌ No |
| `DEBUG` | You set | No | ❌ No |

---

## Viewing Environment Variables

### In Render Dashboard:
1. Go to your service
2. Click "Environment" tab
3. See all variables (including auto-set ones)

### In Your Code:
```javascript
// Log all environment variables (for debugging)
console.log('RENDER_EXTERNAL_URL:', process.env.RENDER_EXTERNAL_URL);
console.log('PORT:', process.env.PORT);
console.log('API_SECRET:', process.env.API_SECRET ? '***configured***' : 'NOT SET');
```

### In Logs:
Check Render service logs to see what values are being used at runtime.




