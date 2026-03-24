# DataLens — Deployment Guide
## Supabase + Railway (or Render)

---

## Overview

| Layer | Service | What it stores |
|-------|---------|----------------|
| **Database** | Supabase Postgres | Users, dashboards, datasets metadata, widgets |
| **File storage** | Supabase Storage | Uploaded `.xlsx` / `.csv` files |
| **App hosting** | Railway **or** Render | Flask app (stateless) |

---

## Part 1 — Supabase Setup

### 1.1 Create a Supabase project

1. Go to **[supabase.com](https://supabase.com)** → **New project**
2. Choose a region close to your users
3. Set a strong database password → **Save it somewhere safe**
4. Wait ~2 minutes for the project to provision

---

### 1.2 Get your credentials

In the Supabase Dashboard:

#### Project URL & Service Role Key
**Project Settings → API**

| Variable | Where to find it |
|----------|-----------------|
| `SUPABASE_URL` | "Project URL" |
| `SUPABASE_SERVICE_KEY` | "service_role" key (click reveal) |

> ⚠️ Use the **service_role** key (not anon). It's needed for Storage uploads.
> Keep it secret — never commit to git.

#### Database URL
**Project Settings → Database → Connection string → URI**

Use the **Transaction pooler** URL (port **6543**) — it works on Railway/Render:
```
postgresql://postgres.PROJECTREF:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

> Replace `PASSWORD` with your database password from Step 1.3.

---

### 1.3 Create the Storage bucket

1. In Supabase Dashboard → **Storage** → **New bucket**
2. Name: `datalens-uploads`
3. **Public bucket**: ❌ OFF (keep private — the app uses service key to access files)
4. Click **Create bucket**

---

### 1.4 Database tables (auto-created)

The app creates all tables automatically on first startup via `DB.init()`.
You don't need to run any SQL manually.

To verify after first deploy, go to **Table Editor** — you should see:
`users`, `dashboards`, `datasets`, `widgets`

---

## Part 2 — Deploy on Railway (Recommended)

Railway gives you a free tier with $5/month credit and auto-deploys from GitHub.

### 2.1 Push your code to GitHub

```bash
cd your-datalens-folder
git init
git add .
git commit -m "Initial commit"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/datalens.git
git push -u origin main
```

### 2.2 Create Railway project

1. Go to **[railway.app](https://railway.app)** → **New Project**
2. Choose **Deploy from GitHub repo**
3. Select your `datalens` repository
4. Railway auto-detects Python and uses `railway.toml`

### 2.3 Set environment variables

In Railway → your service → **Variables** tab, add:

```
SUPABASE_URL          = https://xxxx.supabase.co
SUPABASE_SERVICE_KEY  = eyJhbGci...
DATABASE_URL          = postgresql://postgres.xxxx:PASSWORD@aws-0-...pooler.supabase.com:6543/postgres
SUPABASE_BUCKET       = datalens-uploads
SECRET_KEY            = (generate: python -c "import secrets; print(secrets.token_hex(32))")
```

### 2.4 Deploy

Railway deploys automatically when you push to `main`.
Click **View Logs** to watch the build. First startup will print:
```
Default user created: admin / admin
```

Your app is live at the Railway-provided URL (e.g. `https://datalens-production.up.railway.app`).

---

## Part 3 — Deploy on Render (Alternative)

### 3.1 Create Web Service

1. Go to **[render.com](https://render.com)** → **New Web Service**
2. Connect your GitHub repo
3. Render auto-detects `render.yaml`

### 3.2 Set environment variables

In Render → your service → **Environment**:

```
SUPABASE_URL          = https://xxxx.supabase.co
SUPABASE_SERVICE_KEY  = eyJhbGci...
DATABASE_URL          = postgresql://postgres.xxxx:PASSWORD@aws-0-...pooler.supabase.com:6543/postgres
SUPABASE_BUCKET       = datalens-uploads
SECRET_KEY            = (generate a random string)
```

### 3.3 Deploy

Click **Create Web Service** — Render builds and deploys automatically.

> **Free tier note:** Render free tier spins down after 15 min inactivity.
> First request after sleep takes ~30 sec. Upgrade to Starter ($7/mo) to avoid this.

---

## Part 4 — Local Development

You can still run locally with SQLite (no Supabase needed):

```bash
# Install deps
pip install -r requirements.txt

# Run without Supabase env vars → uses SQLite + local uploads/
python app.py
```

To test with Supabase locally:

```bash
# Copy env template
cp .env.example .env
# Fill in your values, then:
pip install python-dotenv
# Add to top of app.py: from dotenv import load_dotenv; load_dotenv()
python app.py
```

---

## Part 5 — Default Login

On first startup the app seeds one user:

| Username | Password |
|----------|----------|
| `admin`  | `admin`  |

**Change this immediately** via the Register page or by updating the database.

---

## Troubleshooting

### `psycopg2` install fails
```bash
pip install psycopg2-binary  # not psycopg2
```

### Supabase Storage upload fails
- Verify the bucket name matches `SUPABASE_BUCKET`
- Confirm you're using the **service_role** key, not the anon key
- Check the bucket exists in Supabase Storage

### `relation "users" does not exist`
The DB hasn't been initialised. Make sure `DB.init()` runs on startup.
Check Railway/Render build logs for errors.

### Database connection timeout on Railway
Use the **Transaction pooler** URL (port `6543`), not the direct connection (port `5432`).
Direct connections don't work well on serverless platforms.

### Files don't persist between deploys on Railway/Render
This is expected — file system is ephemeral. Files must go to Supabase Storage.
Confirm `USE_SUPABASE` evaluates to `True` (it does whenever `DATABASE_URL` is set).

---

## Architecture Diagram

```
Browser
   │
   ▼
Railway / Render
   [Flask + Gunicorn]
   │              │
   ▼              ▼
Supabase       Supabase
Postgres       Storage
(metadata)     (.xlsx/.csv files)
```

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | ✅ | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | ✅ | Service role key (secret) |
| `DATABASE_URL` | ✅ | Postgres connection string |
| `SUPABASE_BUCKET` | ✅ | Storage bucket name |
| `SECRET_KEY` | ✅ | Flask session secret (random string) |
| `PORT` | auto | Injected by Railway/Render |

---
## Note on dashboard.html and dashboard.js
These two files are large (~1500 lines each) and are **completely unchanged** from your original repo.
When setting up your deployment repo, simply copy them from your existing repo:
```bash
cp original_repo/templates/dashboard.html new_repo/templates/dashboard.html
cp original_repo/static/js/dashboard.js   new_repo/static/js/dashboard.js
```

