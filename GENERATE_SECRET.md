# How to Generate API_SECRET

## Option 1: PowerShell (Windows)

```powershell
# Generate 32-byte random hex string
-join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object {[char]$_})
```

Or simpler:
```powershell
# Generate random hex string
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

## Option 2: Online Generator

Visit: https://www.random.org/strings/
- Length: 64 characters
- Character set: Hexadecimal (0-9, a-f)
- Generate and copy

## Option 3: Node.js

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Option 4: Python

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

## Example Output

```
a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456
```

## Where to Use It

1. **Render Environment Variables:**
   - Go to Render Dashboard → Your Service → Environment
   - Add: `API_SECRET` = (your generated secret)

2. **Supabase Cron Job SQL:**
   - Open `supabase/cron-jobs.sql`
   - Replace `YOUR_API_SECRET` with your generated secret
   - Use the same secret in both places!

