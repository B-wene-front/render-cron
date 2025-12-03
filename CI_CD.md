# CI/CD Setup Guide

This project uses **GitHub Actions** for Continuous Integration and Continuous Deployment to Render.

## Overview

```
┌─────────────┐
│   GitHub    │
│   Push/PR   │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│  GitHub Actions │
│  ┌───────────┐  │
│  │   Test    │  │ ← Type check, build
│  │   Build   │  │ ← Docker build test
│  └───────────┘  │
└──────┬──────────┘
       │
       ▼
┌─────────────┐
│    Render    │
│  Auto-Deploy │
└─────────────┘
```

## Workflows

### 1. **CI Pipeline** (`.github/workflows/ci.yml`)
Runs on every push and pull request:
- ✅ Type checking
- ✅ Build verification
- ✅ Docker build test
- ✅ Health check test

### 2. **Docker Build & Push** (`.github/workflows/docker-build.yml`)
Builds and pushes Docker images to GitHub Container Registry:
- Runs on tags (v*) and main branch
- Pushes to `ghcr.io/your-username/repo/evtol-news-service`

### 3. **Render Deploy** (`.github/workflows/render-deploy.yml`)
Triggers Render deployment:
- Runs on main/master branch pushes
- Can use Render API (optional) or rely on Git auto-deploy

## Setup Instructions

### Step 1: Enable GitHub Actions

1. Go to your GitHub repository
2. Settings → Actions → General
3. Enable "Allow all actions and reusable workflows"
4. Save

### Step 2: Configure GitHub Secrets (Optional but Recommended)

Go to: **Settings → Secrets and variables → Actions**

Add these secrets for full CI/CD:

```
SUPABASE_URL              # For Docker build tests
SUPABASE_SERVICE_ROLE_KEY  # For Docker build tests
VOYAGEAI_API_KEY          # For Docker build tests
RENDER_API_KEY            # For API-based deployment (optional)
RENDER_SERVICE_ID         # Your Render service ID (optional)
```

**How to get Render API Key:**
1. Go to Render Dashboard
2. Account Settings → API Keys
3. Create new API key
4. Copy and add to GitHub secrets

**How to get Render Service ID:**
1. Go to your Render service
2. URL will be: `https://dashboard.render.com/web/your-service-id`
3. Copy the service ID from URL

### Step 3: Connect Render to GitHub

1. Go to Render Dashboard
2. Your Service → Settings
3. Under "Build & Deploy":
   - **Auto-Deploy:** Enabled
   - **Branch:** `main` or `master`
   - **Root Directory:** `render-cron` (if monorepo)

### Step 4: Test the Pipeline

```bash
# Make a change and push
git add .
git commit -m "test: CI/CD setup"
git push origin main
```

Check GitHub Actions tab to see the workflow run!

## Workflow Details

### CI Pipeline Steps

1. **Test Job:**
   - Checks out code
   - Sets up Node.js 22
   - Installs dependencies
   - Runs type check
   - Builds TypeScript

2. **Docker Build Job:**
   - Builds Docker image
   - Runs container
   - Tests health endpoint
   - Cleans up

3. **Deploy Job:**
   - Only runs on main/master
   - Triggers Render deployment

## Manual Deployment

If you need to manually trigger deployment:

```bash
# Via GitHub Actions UI
1. Go to Actions tab
2. Select "Deploy to Render" workflow
3. Click "Run workflow"

# Via Render Dashboard
1. Go to your service
2. Click "Manual Deploy"
3. Select branch/commit
```

## Troubleshooting

### CI Fails on Type Check
```bash
# Fix locally first
cd render-cron
npm run type-check
npm run build
```

### Docker Build Fails
```bash
# Test locally
docker-compose build
docker-compose up
```

### Render Not Auto-Deploying
1. Check Render service settings
2. Verify branch is `main` or `master`
3. Check Render logs for errors
4. Ensure GitHub integration is connected

### GitHub Actions Not Running
1. Check repository Settings → Actions
2. Verify workflows are in `.github/workflows/`
3. Check Actions tab for errors

## Best Practices

1. **Always test locally before pushing:**
   ```bash
   npm run type-check
   npm run build
   docker-compose build
   ```

2. **Use feature branches:**
   - Create PR → CI runs → Review → Merge → Deploy

3. **Monitor deployments:**
   - Check GitHub Actions for CI status
   - Check Render logs for deployment status

4. **Use semantic versioning:**
   - Tag releases: `git tag v1.0.0`
   - Pushes Docker image to registry

## Environment Variables

Render environment variables are set in Render Dashboard, not in GitHub Actions (for security).

GitHub Actions only uses secrets for:
- Testing Docker builds
- Optional API-based deployment

## Cost

- **GitHub Actions:** Free for public repos, 2000 minutes/month for private
- **Render:** Free tier (750 hours/month)
- **Total:** FREE ✅







