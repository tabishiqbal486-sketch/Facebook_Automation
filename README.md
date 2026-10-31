# Furniture Sales Assistant (UK)

An AI-assisted sales helper for a UK furniture business on Facebook: sofas, beds, wardrobes, dining tables and any category you add.
It answers comments and messages with **verified catalogue facts only**, and when it is not sure it **asks you and remembers your answer**.

No third-party packages are needed. It needs only Node.js 20 or newer.

## Start on Windows
1. Install Node.js 20+ from https://nodejs.org
2. Copy `.env.example` to `.env` (you can leave it empty for the first test).
3. Double-click `start.bat`. Open http://localhost:3000
4. The access key is in `.env` (ADMIN_KEY) or, if empty, in `data\admin.key`.

The software starts in **DRY-RUN mode**: it records what it would send but sends nothing to customers.
Use **Chat > Try a test message** to try it safely. Turn on **Live mode** (Auto-Pilot) only when your catalogue and business details are correct and Facebook is connected.

## Hosting status
This project includes a Vercel Functions API adapter and Supabase persistence. The dashboard remains the existing static JavaScript app; converting it to Next.js is not required. Do not enable Live mode until the hosted API, database, image storage, and scheduled job processing have been tested.

## Vercel + Supabase deployment

You can keep the existing GitHub repository and Vercel project. Commit and push these project changes to the branch already connected to Vercel; its normal deployment will include the API functions.

1. Create a Supabase project. In **SQL Editor**, run the complete [`supabase/schema.sql`](./supabase/schema.sql) script. It creates the app's record tables, safe database functions, and public product-image bucket.
2. In Supabase **Project Settings → API**, copy the **Project URL** and the **service role/secret server key**. Never use that privileged key in browser code or share it in chat.
3. In the existing Vercel project's **Settings → Environment Variables**, set:
   - `SUPABASE_URL` — Supabase Project URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase's server-side service role/secret key.
   - `SUPABASE_STORAGE_BUCKET` — `product-images`.
   - `ADMIN_KEY` — your existing dashboard key or a new private key, at least 12 characters.
   - `SECRET_KEY` — keep the exact value currently used by the local app (usually `data\secret.key`) if migrating existing Facebook Page connections; otherwise generate a long random secret.
   - Meta settings when connecting Facebook: `APP_ID`, `APP_SECRET`, `GRAPH_VERSION`, `VERIFY_TOKEN`, and `BASE_URL` (the deployed HTTPS URL). `CONFIG_ID` is only needed for Facebook Login for Business.
   - `CRON_SECRET` — a new long random secret for protecting scheduled processing.
   The local import script needs only these two values in `.env.local`:
   ```
   SUPABASE_URL=
   SUPABASE_SERVICE_ROLE_KEY=
   ```
   Do not send this file to anyone or commit it.
4. To migrate the local app data and product images, make a private backup of the `data` folder, put the Supabase URL and server key in a local `.env.local` file (it is git-ignored), then run:
   ```
   node scripts\import-supabase.js
   ```
   The import stops if the Supabase database already contains app records. The local database includes private customer/business data and encrypted Facebook tokens; keep its backup and `.env.local` private.
5. Push the changes to the branch connected to your existing Vercel project. Confirm the deployment includes `/api/` functions and test the login and dashboard before connecting a Facebook webhook.
6. For live scheduled processing, first use a Vercel plan that supports per-minute Cron Jobs. Add this to the top level of `vercel.json`, then redeploy:
   ```
   "crons": [{ "path": "/api/cron", "schedule": "* * * * *" }]
   ```
   Vercel sends the configured `CRON_SECRET` to the protected endpoint. Set the Meta webhook to `BASE_URL/webhook` and use the same `VERIFY_TOKEN`.

**Plan limits matter:** Vercel Hobby is restricted to personal, non-commercial use, and its Cron Jobs can run only once per day. This app's business use and queued messages need frequent scheduled processing, so use a plan and schedule that permit the intended use before enabling Live mode. Supabase Free has storage/database limits and may pause projects after inactivity; check its current plan details. Neither service is an unlimited $0 production guarantee.

## What is inside
| Part | What it does |
|---|---|
| `src/brain.js` | Decides what to do with a message. Understands spelling mistakes and informal wording. Never guesses. |
| `src/engine.js` | Customers, leads, quotes, orders, follow-ups, a saved send queue with delays, retries and safety limits, and the ask-me-and-remember logic. |
| `src/meta.js` | Official Meta Graph API client and webhook parsing/signature check. |
| `src/db.js` | Database file with atomic saves, hourly backups, migrations and crash recovery. |
| `src/server.js` | Web server, dashboard API, Facebook login and webhook. |
| `public/` | The dashboard (Dashboard, Needs me, Chat, Monitor, Auto-Pilot, Skills & Log, New Post, Business, Catalogue, Reviews, Leads, Orders, Groups, Settings, History). |
| `tests/` | `run-tests.js` (22 end-to-end tests with a fake Meta server) and `ui-test.py` (browser test). |

## How it behaves
- **Catalogue is the source of truth.** Prices, photos, stock, descriptions, FAQs and Facebook post links come from the Catalogue. Change a price and the next reply uses it.
- **Needs me.** Unclear messages, uncertain products, missing information, complaints and suspicious messages are never answered by guessing. They appear in *Needs me* with the message, context, post, what the assistant thinks and what it needs.
- **It remembers.** Tick "Save my answer as approved knowledge" and the answer is stored in the database (it survives restarts). You can see, edit, disable or delete it in *Skills & Log*. Customer messages never become knowledge by themselves.
- **Product matching.** Facebook post to product link first, then the words in the message, then your approved corrections. If it is uncertain it asks you and sends no price or photo.
- **Safe sending.** Calm random delays, hourly and daily limits, 24-hour and 7-day Meta rules, one private reply per comment, duplicate event protection, retries, and real error messages. Failed sends show the actual error with Retry.
- **Payments and dispatch** are never marked automatically. You confirm them yourself with a note.

## Build an .exe (optional)
Double-click `build-exe.bat` on Windows (internet needed the first time). It creates `release\FurnitureAssistant.exe`. Put `.env` next to it. Data is stored in a `data` folder next to the exe.

## Run the tests
```
npm test
```
(`python tests\ui-test.py` runs the browser test; it needs Python with Playwright and a running server, see the top of the file.)

## Honest limitations
- The reply engine is rule-based with fuzzy matching, not a large language model. That is deliberate: it cannot invent prices or promises. It does not read images and does not use post captions for matching (only your post-to-product links).
- Real Facebook sending was tested only against a fake Meta server. The first live test must be on your own Page and your own account. Meta app review or permissions may be needed (see SETUP-META.md).
- Facebook does not allow apps to post into groups. *Groups* is a checklist for manual posting.
- Facebook only allows automatic messages within 24 hours of the customer's last message. Later follow-ups become tasks for you.
- There is one access key (no separate staff accounts). Keep the computer and the key private.
- Pending replies are saved, so a restart does not lose them. The software must be running (and reachable on the internet) to receive Facebook events.
