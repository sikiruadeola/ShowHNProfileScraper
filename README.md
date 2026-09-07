# Show HN Profile Scraper

Walks Show HN chronologically, starting from Hacker News's own launch day by
default, and collects every unique poster's profile information. Does not
save the posts themselves, only the people behind them.

## What it saves

For every unique username found posting to Show HN:

- `username`
- `profileLink` — direct link to their Hacker News profile
- `bio` — their About text, with HTML stripped to plain readable text
- `links` — every link found inside that bio, including bare mentions like
  `twitter.com/example` as well as full `https://` links

## How it works

Uses the public, keyless Algolia Hacker News Search API, the same one that
powers the search box on news.ycombinator.com. No login, no browser, no
proxy needed.

The archive is walked forward in fixed size time windows (30 days by
default). For each window, it collects the unique authors of every Show HN
post in that slice of time, then looks up each new username's profile once.
Progress is saved after every window, so a run that stops partway through
never repeats work, and the next run picks up exactly where the last one
left off.

## Input

| Field | Description | Default |
|---|---|---|
| `windowDays` | Days of history scanned per step | `30` |
| `maxNewUsers` | Stop the run after saving this many new profiles, `0` for unlimited | `200` |
| `maxWindows` | Stop the run after scanning this many windows, `0` for unlimited | `0` |
| `startTimestamp` | Unix timestamp to start from, first run only | Hacker News's launch day |

## Notes

Progress (the current time cursor and the full set of usernames already
seen) is stored in the actor's key-value store under `SHOW_HN_STATE`, so
repeated runs continue the walk rather than starting over.
