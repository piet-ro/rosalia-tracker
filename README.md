# ROSALÍA Tracker

A small static site that tracks how much ROSALÍA Pietro listens to on Spotify: the current daily streak, the longest streak, the biggest single day, the latest track played, and a calendar of listening history.

There is no server. GitHub Actions does the data work, GitHub Pages hosts the site, and the data lives in two JSON files committed to this repo.

## How it flows

```
cron-job.org (every 15 min)
        │  POST /repos/piet-ro/rosalia-tracker/dispatches  {"event_type": "check_spotify"}
        ▼
GitHub Actions: .github/workflows/tracker.yml
        │  1. refresh Spotify access token
        │  2. fetch last 50 played tracks (retried on transient errors)
        │  3. keep only ROSALÍA plays, count the new ones
        │     └─ none new and heartbeat already written today? stop here
        │  4. recompute streaks + peak day
        ▼
last_played.json + history.json  ──(committed back to main)──►  GitHub Pages
                                                                   │
                                                                   ▼
                                                     index.html reads both JSON files
```

## Files

### `.github/workflows/tracker.yml` — the engine
The only place where data is produced. It runs when cron-job.org sends a `repository_dispatch` event of type `check_spotify`, or when started by hand from the Actions tab (`workflow_dispatch`). There is deliberately no GitHub `schedule:` trigger, because cron-job.org already handles timing and is more reliable.

The job runs an inline Node.js script that:

1. Exchanges `SPOTIFY_REFRESH_TOKEN` for an access token (using `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`).
2. Calls Spotify's *recently played* endpoint (last 50 tracks).
3. Keeps tracks where ROSALÍA (artist ID `7ltDVBr6mKbRvohxheJ9h1`) is one of the artists.
4. For each play whose timestamp it has not seen before, adds 1 to that day in `history.json`. Days use the **Europe/Rome** timezone.
5. Updates the latest track, current/longest streak, peak day and the daily heartbeat in `last_played.json`.
6. Commits the two JSON files back to the repo, only if something changed.

**Early exit.** If there are no new ROSALÍA plays and the daily heartbeat has already been written today, the script stops after step 4 and the commit step is skipped: nothing is recomputed, written or pushed. The first run of each day always goes through, which refreshes the heartbeat and lets a broken streak drop to 0.

**Retries.** Spotify sometimes returns an empty body or a 5xx/429 for a moment. Each Spotify call is retried up to 2 more times (after 5s, then 15s) and the HTTP status is logged. Other errors, such as an expired refresh token, fail straight away. If all attempts fail, the job fails (red in the Actions tab) and nothing is overwritten.

### `history.json` — the permanent record
Plays per day, newest first:

```json
{ "2026-10-14": 14, "2026-10-12": 46 }
```

This file is only ever **added to**, never rebuilt, so it keeps the full history. The calendar, streaks and peak day are all derived from it.

### `last_played.json` — current state
| Field | Meaning |
|---|---|
| `current_streak` | Consecutive days with at least one play, ending today or yesterday (0 if broken) |
| `active_streak` | `start_date` / `end_date` of that streak, or `null` |
| `longest_streak` | Record streak: `count`, `start_date`, `end_date` |
| `peak_volume` | Biggest single day: `count`, `date` |
| `latest_track` | Most recent ROSALÍA play: name, album, cover art, Spotify links, timestamp |
| `streak_tracks` | Every ROSALÍA play of the active streak, oldest first: `played_at`, `track_name`, `album_name`, `album_art`, `spotify_url`. Emptied when the streak breaks. Only plays seen after this field was added are included |
| `last_successful_run` | Heartbeat, updated once per day so the site can warn when syncing has stopped |
| `tracked_timestamps` | The newest 300 play timestamps already counted. Used only to avoid counting the same play twice, since consecutive runs see overlapping plays. Spotify returns at most 50 plays, so 300 is plenty |

### `index.html` — the site
A single self-contained page (HTML, CSS and JS inline) served by GitHub Pages. On load it fetches both JSON files with a cache-busting query string, then shows:

- the headline streak message, with the latest album art as a blurred background
- record cards for the longest streak and the peak day
- the latest track, linking to Spotify
- a history modal with a calendar view built from `history.json`
- a "sync delayed" banner if `last_successful_run` is more than 36 hours old

It also resets the streak shown to 0 if `active_streak` ended more than a day ago, in case the workflow has stopped running.

### `peel-stack.js` — the cover stack
During an active streak the cover becomes a pile of every cover played in the streak (`streak_tracks`). Tapping it peels the covers off one by one and throws them like confetti. Each cover is a thin 3D card that can bend, and covers in the air collide as solid boxes. All motion settings live in `DEFAULTS` at the top of the file. For now it only runs in test mode.

### `test/` — test mode
`/test` opens the site with `?test`, which keeps the real content but pretends a 3-day streak is on and that the last 14 plays all used the latest cover, so the cover stack can be tried. A yellow "Test data" badge marks it.

### `favicon.png`
The browser tab icon.

## Setup

**Repository secrets** (Settings → Secrets and variables → Actions):

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REFRESH_TOKEN`: obtained once through Spotify's authorization flow with the `user-read-recently-played` scope

**Workflow permissions:** the workflow needs write access to push commits (it requests `contents: write`).

**cron-job.org:** a job every 15 minutes that sends:

```
POST https://api.github.com/repos/piet-ro/rosalia-tracker/dispatches
Authorization: Bearer <GitHub token with repo / Actions write access>
Accept: application/vnd.github+json

{"event_type": "check_spotify"}
```

**GitHub Pages:** serve from the `main` branch, root folder.

## Manual run
Actions tab → *Rosalía Spotify Tracker* → *Run workflow*.
