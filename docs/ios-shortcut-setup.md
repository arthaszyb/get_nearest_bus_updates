# Building and sharing the BusBoard Shortcut

This is the owner's guide: how to build the one Shortcut every customer installs, and how to
publish it. Customers never follow these steps — they tap one link and they're set up (their guide
is the website's `/install` page). The Shortcut is the iPhone extra: most people use the web app
at `/app`, and the Shortcut adds Siri, widgets and the Action button.

The finished Shortcut:

- works for free with no setup (4 checks a day per device),
- uses a paid token if the customer pasted one when adding it,
- shows the styled arrivals page for the 3 stops nearest them.

Everything below happens in the **Shortcuts** app on an iPhone. Throughout, `WORKER` means
`https://busnearby.arthas-zyb.workers.dev` (or your own domain, once you have one).

## 1. Build it

Create a new Shortcut, name it **BusBoard**, and add these actions in this order.

| # | Action | Set it up like this |
| --- | --- | --- |
| 1 | **Text** | Leave it **empty**. This holds the customer's token; step 3 turns it into the install-time question. |
| 2 | **Get Device Details** | Detail: **Device Name** |
| 3 | **Get Device Details** | Detail: **Device Model** |
| 4 | **Get Device Details** | Detail: **System Version** |
| 5 | **Get Device Details** | Detail: **Screen Width** |
| 6 | **Get Device Details** | Detail: **Screen Height** |
| 7 | **Text** | Insert the results of actions 2–6 as variables, separated by `\|`:<br>`Device Name\|Device Model\|System Version\|Screen Width\|Screen Height` |
| 8 | **URL Encode** | Mode: **Encode**, input: the Text from action 7 |
| 9 | **Get Current Location** | — |
| 10 | **URL** | `WORKER/?lat=` **Current Location › Latitude** `&lon=` **Current Location › Longitude** `&format=html` |
| 11 | **Get Contents of URL** | Input: the URL from action 10. Tap **Show More** › **Headers** › add two: `Authorization` = `Bearer ` followed by **Text (action 1)**, and `X-Device` = **URL Encoded Text (action 8)** |
| 12 | **Set Name** | Input: **Contents of URL**, name: `BusBoard.html` |
| 13 | **Quick Look** | Input: **Renamed Item** |

How to insert a variable: put the cursor where it goes, tap the variable bar above the keyboard,
and pick the action's output. For Latitude and Longitude, insert **Current Location**, tap the
inserted variable, and choose the property.

Why each piece is there:

- **Action 1 (token)** — empty means "free plan"; the Worker ignores an empty `token`. A pasted
  token always takes precedence over the free plan.
- **Actions 2–8 (device)** — iOS gives Shortcuts no stable device ID, so the free plan's daily
  count is keyed on a one-way hash of these details. Only the hash is stored. URL-encoding keeps
  names with spaces, apostrophes or non-Latin characters intact (headers must be plain ASCII).
- **Headers, not the URL** — the token and device details travel as headers so they never appear
  in request logs. An empty token (`Bearer ` with nothing after it) means the free plan. Older
  Shortcuts that put `&token=` and `&device=` in the URL still work.
- **`format=html` + Quick Look (actions 11–13)** — the styled page with stop cards and crowding
  colours, shown as a full-screen sheet with no address bar or browser toolbar. Naming the result
  `.html` is what makes Quick Look render it as a page. Quick Look doesn't reload the page, so to
  refresh, close it and run the Shortcut again. (**Show Web Page** also works and auto-refreshes,
  but shows Safari's address bar and toolbar. For plain text, drop `&format=html` and use
  **Show Result** instead of actions 12–13.)

Tap ▶︎ to test. Allow location and the connection to the Worker when asked. You should see the
nearest 3 stops; a fifth run in one day should say you've used today's 4 free checks.

## 2. Make it ask for the token on install

1. In the Shortcut editor, tap the name at the top (or ⓘ) › **Setup** (labelled **Import
   Questions** on some iOS versions) › **Add Question**.
2. Pick action 1's **Text** field.
3. Question: `Paste your BusBoard token, or leave this empty to use the free plan.`
4. Default answer: leave it **empty**.

## 3. Check before sharing

- [ ] Action 1 is **empty** — never share with your own `ACCESS_TOKEN` in it. It has no limit and
      never expires; anyone with the Shortcut would have it.
- [ ] The URL points at `WORKER` and has `&format=html`; action 11 has the `Authorization` and
      `X-Device` headers.
- [ ] A test run works, and a run with a customer token works.

## 4. Share it

1. Touch and hold **BusBoard** › **Share** › **Copy iCloud Link**. The link looks like
   `https://www.icloud.com/shortcuts/…`.
2. In the Cloudflare dashboard, set it as the Worker variable **`SHORTCUT_URL`** on `busnearby`
   (Settings › Variables and Secrets). From then on:
   - `/install` has an **Add the BusBoard Shortcut** button (the landing page's buttons open the
     web app, which works on every phone),
   - after paying, **Copy token & open the Shortcut** copies the customer's token and opens it, so
     they tap **Replace** and paste.
3. Post the **website link**, not the iCloud link, in communities (RoutineHub, r/shortcuts,
   r/singapore, HardwareZone, Telegram groups) — the site explains the product, shows pricing and
   installs the Shortcut.

## 5. Updating the Shortcut later

Edit it on your iPhone, then **Share › Copy iCloud Link** again. Each share makes a new link, so
update `SHORTCUT_URL` to the new one. People who already installed it keep their copy until they
re-add it from the new link (choosing **Replace**).

## Troubleshooting

- **"No valid file provider found" / Face ID prompts** — that Shortcut reads files; this one
  doesn't. Make sure you're running BusBoard.
- **Nothing shows / "Missing access token."** — action 11 is missing the `X-Device` header.
- **Free checks run out unexpectedly** — the device details aren't reaching the Worker (check
  actions 7–8 and the `&device=` variable), or another device has exactly the same details.
