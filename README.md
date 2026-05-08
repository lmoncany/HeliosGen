# HeliosGen

A visual workflow builder for AI image and video generation. Connect nodes on a canvas to chain prompts, reference images, and generation models into automated pipelines.

---

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- A [Supabase](https://supabase.com/) project (free tier works)
- A [Cloudflare R2](https://www.cloudflare.com/developer-platform/r2/) bucket
- A [Kie.ai](https://kie.ai) account with API access

---

## 1. Clone & Install

```bash
git clone <your-repo-url>
cd AIUI
npm install
```

---

## 2. Environment Variables

Create a `.env.local` file at the project root:

```env
# ── Supabase ──────────────────────────────────────────────────────────────────
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# ── Cloudflare R2 ─────────────────────────────────────────────────────────────
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_BUCKET_NAME=your_bucket_name
# Public CDN URL for the bucket (enable public access in R2 dashboard)
R2_PUBLIC_URL=https://pub-xxxxxxxxxxxx.r2.dev

# ── Kie.ai ────────────────────────────────────────────────────────────────────
# Public URL where kie.ai will POST generation results (webhook).
# Must be reachable from the internet. Use ngrok or similar for local dev.
CALLBACK_BASE_URL=https://your-public-url.com
# Optional server-side fallback key. Users can also set their own via Settings UI.
KIE_API_TOKEN=your_kie_api_token

# ── Replicate (optional) ──────────────────────────────────────────────────────
# Required only if you use Replicate-backed image generation nodes.
REPLICATE_API_TOKEN=your_replicate_api_token

# ── Azure OpenAI (optional) ───────────────────────────────────────────────────
# Required only if you route image models through Azure AI Foundry.
AZURE_API_KEY=your_azure_api_key
```

---

## 3. Supabase Setup

### 3.1 Create a project

Go to [supabase.com](https://supabase.com), create a new project, then copy the **Project URL**, **anon key**, and **service role key** from **Settings → API** into your `.env.local`.

### 3.2 Enable Email Auth

Go to **Authentication → Providers → Email** and make sure it is enabled.

### 3.3 Run the SQL schema

Open the **SQL Editor** in your Supabase dashboard and run the contents of [`supabase-setup.sql`](./supabase-setup.sql).

This creates four tables:

| Table | Purpose |
|---|---|
| `spaces` | Workflow canvases — nodes, edges, viewport per user |
| `generations` | Job history (images & videos created) |
| `user_uploads` | Gallery of files uploaded to R2 |
| `user_settings` | Per-user Kie.ai API token (server-side only) |

---

## 4. Cloudflare R2 Setup

R2 stores all uploaded and generated assets (images, videos, reference frames) via the S3-compatible API.

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com) and open **R2 Object Storage**.
2. Create a new bucket (e.g. `heliosgen-assets`).
3. **Enable public access**: open the bucket → **Settings → Public Access** → allow public access. Copy the public URL (e.g. `https://pub-xxxx.r2.dev`) into `R2_PUBLIC_URL`.
4. Create an **API token**: go to **R2 → Manage R2 API Tokens → Create API Token**. Grant **Object Read & Write** on your bucket. Copy the **Access Key ID** and **Secret Access Key**.
5. Find your **Account ID** in the Cloudflare dashboard sidebar.

The app organises objects under these prefixes automatically:

| Prefix | Contents |
|---|---|
| `uploads/` | User-uploaded files |
| `references/` | Reference images mirrored before sending to the API |
| `generated/` | Generated images |
| `videos/` | Generated videos |

---

## 5. Kie.ai Setup

[Kie.ai](https://kie.ai) is the primary backend for all AI generation (images and videos).

There are two ways to provide a Kie.ai key:

- **Per-user (recommended):** each user creates an account at [kie.ai](https://kie.ai), generates an API token at [kie.ai/api-key](https://kie.ai/api-key), then pastes it in **Settings → API Keys** inside the app. Keys are stored server-side in Supabase and never exposed to the browser.
- **Shared fallback:** set `KIE_API_TOKEN` in `.env.local`. This is used when a user has not set their own key.

### Webhook (CALLBACK_BASE_URL)

Kie.ai POSTs job results to `{CALLBACK_BASE_URL}/api/callback` when a generation finishes. This URL must be publicly reachable:

- **Local dev:** run `ngrok http 3000` and set `CALLBACK_BASE_URL` to the HTTPS URL ngrok gives you.
- **Production:** set it to your deployed domain (e.g. `https://your-app.vercel.app`).

**Supported generation models via Kie.ai:**
- **Images:** Seedream, Z-Image, Grok Imagine (X), GPT-4o, Nano Banana, and more
- **Videos:** Kling 3.0, Kling 2.6 (motion-control), Seedance 2, Grok Imagine (X)

Credits are consumed per generation from each user's own Kie.ai balance. Users can check their balance inside the app via the credit indicator in the top bar.

---

## 6. Run the Project

```bash
# Development
npm run dev

# Production build
npm run build
npm start
```

The app runs on [http://localhost:3000](http://localhost:3000) by default.

---

## Deployment

The app is a standard Next.js app and deploys to any Node.js-capable platform:

- **Vercel** (recommended): import the repo, add all env vars in project settings, and deploy. Set `CALLBACK_BASE_URL` to your Vercel deployment URL.
- **Railway / Render / Fly.io**: set the same env vars and run `npm run build && npm start`.

Make sure `CALLBACK_BASE_URL` always points to the live public URL so Kie.ai webhooks reach your `/api/callback` route.
