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
