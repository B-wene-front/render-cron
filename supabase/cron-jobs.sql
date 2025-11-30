-- Supabase Cron Jobs for EVTOL News Service
-- These cron jobs call the Render web service via HTTP

-- ============================================
-- Setup: Enable required extensions
-- ============================================
-- Run this first in Supabase SQL Editor:
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================
-- IMPORTANT: Replace placeholders before running!
-- ============================================
-- 1. YOUR_RENDER_SERVICE_URL -> Your Render service URL
--    Example: https://evtol-news-service.onrender.com
-- 2. YOUR_API_SECRET -> Your API secret (same as in Render)
--    Generate with: openssl rand -hex 32

-- ============================================
-- Job 1: Joby Aviation (Daily at 2 AM UTC)
-- ============================================
SELECT cron.schedule(
  'joby-aviation-daily',
  '0 2 * * *',  -- Daily at 2 AM UTC
  $$
  SELECT
    net.http_post(
      url := 'YOUR_RENDER_SERVICE_URL/api/run/joby',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-API-Secret', 'YOUR_API_SECRET'
      ),
      body := jsonb_build_object(
        'service', 'joby'
      )
    ) AS request_id;
  $$
);

-- ============================================
-- Job 2: Archer Aviation (Daily at 3 AM UTC)
-- ============================================
SELECT cron.schedule(
  'archer-aviation-daily',
  '0 3 * * *',  -- Daily at 3 AM UTC
  $$
  SELECT
    net.http_post(
      url := 'YOUR_RENDER_SERVICE_URL/api/run/archer',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-API-Secret', 'YOUR_API_SECRET'
      ),
      body := jsonb_build_object(
        'service', 'archer'
      )
    ) AS request_id;
  $$
);

-- ============================================
-- Job 3: All Services (Daily at 4 AM UTC)
-- ============================================
-- Optional: Run all services at once
SELECT cron.schedule(
  'evtol-news-all-daily',
  '0 4 * * *',  -- Daily at 4 AM UTC
  $$
  SELECT
    net.http_post(
      url := 'YOUR_RENDER_SERVICE_URL/api/run-all',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-API-Secret', 'YOUR_API_SECRET'
      ),
      body := jsonb_build_object()
    ) AS request_id;
  $$
);

-- ============================================
-- View all scheduled cron jobs
-- ============================================
-- SELECT * FROM cron.job;

-- ============================================
-- View cron job execution history
-- ============================================
-- SELECT * FROM cron.job_run_details 
-- ORDER BY start_time DESC 
-- LIMIT 10;

-- ============================================
-- Unschedule a job (if needed)
-- ============================================
-- SELECT cron.unschedule('joby-aviation-daily');
-- SELECT cron.unschedule('archer-aviation-daily');
-- SELECT cron.unschedule('evtol-news-all-daily');
