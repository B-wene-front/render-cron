-- Test Supabase Cron Job Query
-- Use this to test if your cron job query will work before scheduling it

-- ============================================
-- Test 1: Test the HTTP call directly (without scheduling)
-- ============================================
SELECT net.http_post(
  url := 'https://render-cron-1tio.onrender.com/api/run/joby',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'X-API-Secret', 'uuDFOLMH82vfXg0x4KWPNr7MT9Dl9SrZTvoEGYjssrw='
  ),
  body := jsonb_build_object(
    'service', 'joby'
  )
) AS request_id;

-- ============================================
-- Test 2: Check the response (run this after Test 1)
-- ============================================
-- Replace REQUEST_ID with the request_id from Test 1
-- SELECT * FROM net.http_response WHERE id = REQUEST_ID;

-- ============================================
-- Optimized Version (without unnecessary body)
-- ============================================
-- The body is not needed since service comes from URL path
-- But including it won't hurt either
SELECT net.http_post(
  url := 'https://render-cron-1tio.onrender.com/api/run/joby',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'X-API-Secret', 'uuDFOLMH82vfXg0x4KWPNr7MT9Dl9SrZTvoEGYjssrw='
  )
) AS request_id;

