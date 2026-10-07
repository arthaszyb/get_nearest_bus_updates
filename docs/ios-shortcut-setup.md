# iOS Shortcut setup

Assumes you've already deployed the Cloudflare Worker per the main [README](../README.md) and
have its URL, e.g. `https://your-worker.your-subdomain.workers.dev`.

## Steps

1. Open the **Shortcuts** app → tap **+** to create a new Shortcut
2. Add action: **Get Current Location**
3. Add action: **URL**, set its content to:

   ```
   https://your-worker-url/?lat=
   ```

   With the cursor at the end, tap the variable-insert icon above the keyboard and insert the
   result of "Get Current Location". Tap that inserted variable again — a property list pops up —
   choose **Latitude**.
   Then type `&lon=` and insert "Get Current Location" again, this time choosing **Longitude**.
   Finally type `&token=your-access-token`.

4. Add action: **Get Contents of URL** — it automatically picks up the URL from the previous step
5. Add action: **Show Result** (or **Quick Look**), with content set to the result of "Get
   Contents of URL"

   > Don't use **Show Notification** — iOS notification banners only display the first couple of
   > lines and truncate anything longer. **Show Result** / **Quick Look** display the full text.

6. Tap the ▶️ play button to test. It should immediately show arrival times for the nearest stops
   — no stop-picking list, no confirmation dialog.

## Styled view (recommended)

The steps above show the plain-text version in iOS's built-in result sheet. For the styled page
(stop cards, colour-coded crowding, dark mode, auto-refresh every 30s):

1. In step 3, add `&format=html` to the end of the URL
2. Delete **Get Contents of URL** and **Show Result**, and add **Show Web Page** in their place —
   it opens the URL from step 3 in an in-app Safari sheet

Don't use **Quick Look** for this — it doesn't reliably render HTML pages.

## Sharing the Shortcut with customers

If you sell access with per-customer tokens (see the main README), share one Shortcut and have
iOS ask each person for their own token when they add it:

1. Add a **Text** action at the very top of the Shortcut containing just the token. In the **URL**
   action, delete the token after `&token=` and insert the Text action's output there instead.
2. Open the Shortcut's details (ⓘ) → **Setup** → **Add Question**, pick the Text action, and set
   the prompt to something like "Paste your access token".
3. **Clear your own token out of the Text action** (leave a placeholder like `paste-token-here`) —
   whatever is in it when you share becomes the default answer everyone sees.
4. Share → **Copy iCloud Link**, and send that link along with each customer's token. If you sell
   through Stripe, set it as the Worker's `SHORTCUT_URL` and the welcome page hands it out for you.

Renewing a customer (`extend`) keeps their token, so they never need to touch the Shortcut again.
Only `rotate` gives them a new token to paste in.

## Troubleshooting

- **"No valid file provider found" / prompted for Face ID**: this means whichever Shortcut you're
  running depends on a local file cache (Files app / iCloud Drive), and Files access is locked.
  This project's Worker approach doesn't touch local files at all, so it won't hit this — if
  you're seeing it, you're likely running a different, file-caching Shortcut instead.
- **Only 2 lines shown / content cut off**: you're using "Show Notification". Switch to "Show
  Result" or "Quick Look" per step 5 above.

## Add to Home Screen / Lock Screen

Once it's working, add the Shortcut as a Home Screen or Lock Screen widget for a true one-tap
experience.
