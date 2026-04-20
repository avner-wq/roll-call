# Roll Call — GitHub Actions Setup

Daily cloud-hosted cron that checks Shapes.co for who's out today and posts a summary to Slack `#roll-call`. Runs on GitHub's servers — your computer does not need to be on.

## How it works

Every weekday at 09:00 Israel time:

1. GitHub Actions fires the `roll-call` workflow.
2. The workflow exchanges the stored Shapes refresh token for a fresh access token (Shapes access tokens only live ~15 minutes, so we always refresh).
3. It queries the Shapes GraphQL API for all time-away bookings, employees, and reason types.
4. It filters to approved bookings that overlap today and formats a message.
5. It POSTs that message to a Slack incoming webhook.
6. If Shapes returned a new refresh token (rotation), the workflow writes it back to the `SHAPES_REFRESH_TOKEN` repo secret so next run keeps working.

No computer, no servers, no Zapier account.

---

## What you need

- A GitHub account
- A fresh Shapes.co **refresh token** (from My settings → API tokens)
- A Slack **incoming webhook URL** pointed at `#roll-call` (create one at https://api.slack.com/apps → Your App → Incoming Webhooks)
- A GitHub **personal access token (PAT)** with `repo` scope — needed so the workflow can rotate its own refresh-token secret. Create one at https://github.com/settings/tokens

---

## Setup — one-time

### 1. Create a private repo

1. On GitHub, click **New repository**.
2. Name it something like `roll-call` (private).
3. Don't initialise with a README — you'll push these files.

### 2. Copy these files into the repo

Keep the folder layout exactly as-is:

```
.
├── .github/
│   └── workflows/
│       └── roll-call.yml
├── scripts/
│   └── roll-call.js
├── package.json
└── README.md
```

Commit and push to `main`.

### 3. Add the three repo secrets

In the repo, go to **Settings → Secrets and variables → Actions → New repository secret**. Add:

| Name | Value |
|---|---|
| `SHAPES_REFRESH_TOKEN` | The current refresh token from Shapes (starts with `eyJ…`) |
| `SLACK_WEBHOOK_URL` | The Slack incoming webhook URL (starts with `https://hooks.slack.com/services/…`) |
| `GH_PAT` | Your GitHub PAT with `repo` scope (only needed for self-healing refresh) |

### 4. Test it manually

1. Go to the **Actions** tab.
2. If Actions is disabled, click **I understand my workflows, go ahead and enable them**.
3. Pick **Roll Call** in the left sidebar.
4. Click **Run workflow** (top right) → **Run workflow**.
5. Watch the run. A green check means `#roll-call` has a fresh post.

From then on, it runs automatically Mon–Fri at 09:00 Israel time.

---

## Schedule

The cron is set in `.github/workflows/roll-call.yml`:

```yaml
- cron: '0 6 * * 1-5'
```

That is **06:00 UTC, Mon–Fri** — which is 09:00 Israel time **during DST (Apr–Oct)**. During Israeli standard time (Oct–Apr), you'll want `'0 7 * * 1-5'` to keep 09:00 local. GitHub Actions cron always runs in UTC — there's no timezone option — so adjusting this YAML line twice a year is the trade-off for running on their free tier.

If your team is not in Israel, change the `TZ` constant in `scripts/roll-call.js` to your IANA timezone (e.g. `'America/New_York'`) and update the cron accordingly.

---

## Token rotation & long-term health

Shapes refresh tokens last ~7 days. The workflow calls `refreshToken` on every run (daily), which returns a new access token plus (if rotation is enabled) a new refresh token. If the refresh token rotated, the workflow updates the `SHAPES_REFRESH_TOKEN` secret via the GitHub CLI — so the system keeps itself alive indefinitely with no manual work.

**If the workflow fails with an auth error:** your refresh token probably expired. Log in to Shapes, copy a fresh refresh token from **My settings → API tokens**, and paste it into the `SHAPES_REFRESH_TOKEN` secret (Settings → Secrets and variables → Actions → update). The next scheduled run will resume normally.

---

## Customising the message

Edit `scripts/roll-call.js`:

- **Emoji mapping** — `emojiFor()` function. Add/remove reason-to-emoji mappings.
- **Message format** — `buildMessage()` function. The `body` template at the bottom controls the Slack message.
- **Timezone** — `TZ` constant at the top of the file.

---

## Why not use the server-side date filter?

The `DateInterval` filter on `timeAwayBookings` has a boundary-case bug — same-day bookings (e.g. someone booking a sick day today) don't always come back. Tested against the live API with ~80 total bookings: querying everything and filtering in JS is reliable and well under any payload limit.

---

## Turning off the Cowork scheduled task

Once this runs reliably, disable the Cowork scheduled task `daily-roll-call` so you don't get duplicate posts.

