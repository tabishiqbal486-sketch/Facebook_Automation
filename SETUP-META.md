# Connecting to Facebook (official Meta methods only)

You need: a Facebook account that administers your Page, a free Meta developer account, and a public https address for this software.

## 1. Public address
Facebook must reach your software over **https**. Use a small hosting service (VPS) with an https reverse proxy, or a tunnelling service for testing. Put that address in `.env` as `BASE_URL` (no slash at the end). Never expose the plain http port to the internet.

## 2. Create the Meta app
1. developers.facebook.com > My Apps > Create App (type: Business).
2. Add the products **Facebook Login** (or Facebook Login for Business) and **Messenger**.
3. Copy the App ID and App Secret into `.env` as `APP_ID` and `APP_SECRET`.
4. Set `GRAPH_VERSION` to the newest version shown in your app dashboard.
5. Invent a long random text and put it in `.env` as `VERIFY_TOKEN`.
6. Facebook Login settings: add `BASE_URL/auth/facebook/callback` as a valid OAuth redirect URI.
7. Roles: add anyone else who must use the app (Administrator, Developer or Tester).

## 3. Webhook
1. Messenger/Webhooks settings: callback URL = `BASE_URL/webhook`, verify token = your `VERIFY_TOKEN`.
2. Subscribe the Page object to **feed** and **messages**.

## 4. Permissions used
`pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `pages_manage_engagement`, `pages_read_user_content`, `pages_messaging`.
For your own Pages, development mode with you as the app admin is normally enough. For other people's Pages, or if Meta blocks an action, you need Meta App Review. The software shows the real error message from Meta in **Monitor** and **History**.

## 5. Connect and test safely
1. Start the software, open **Settings > Connect Facebook**, log in on Facebook and tick your Pages. The software never sees your password; Page tokens are stored encrypted.
2. In **Monitor** press *Test connection*.
3. Keep **DRY-RUN** on. Comment on one of your posts from another account and check **Chat**, **Needs me** and **History**.
4. In **Catalogue**, link each Facebook post ID to its product (posts created in *New Post* are linked automatically).
5. Only then switch **Live mode** on in **Auto-Pilot**.

## Rules the software follows
- One private reply per comment, within 7 days of the comment.
- Direct messages only within 24 hours of the customer's last message.
- It stops messaging customers who ask it to stop.
- When a token has expired, sending stops and Monitor tells you to reconnect the Page.
