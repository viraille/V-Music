# V Music

A custom Electron desktop client for [YouTube Music](https://music.youtube.com), with network-level ad blocking and a restyled interface. Not affiliated with YouTube/Google — it's just a wrapper around the official site with some quality-of-life features bolted on.

## Features

- 🚫 **Ad blocking** — blocks ad-related network requests (built-in rules + regularly refreshed public filter lists), strips ad data from YouTube responses, and skips any ad that still reaches the player
- 🎨 **Restyled UI** — custom CSS with smooth animations (toggleable)
- 🦈 **Launch animation** — a short shark animation shown inside the app while YouTube Music loads (toggleable)
- 📊 **Taskbar progress bar** — current track progress shown directly on the Windows taskbar icon
- 🆕 **New interface (beta)** — an optional, fully custom UI (home, search, library, full-screen player with colours taken from the album art). Playback runs through a hidden YouTube Music page, so sign-in and ad blocking work the same. Switch in Settings → Interface
- 🪟 **No more stuck-open window** — fixes the native "leave site?" prompt that used to block the app from closing while music was playing
- 🖥️ **OBS overlay** — a local Browser Source URL that shows the current track (artwork, title, artist, progress) live in your stream
- 👥 **Listening dashboard** (optional) — see what track each instance of the app is playing in real time, via [Supabase](https://supabase.com). **Enabled by default** and togglable anytime in Settings. When on, it sends only: a display name (defaults to your Windows username, editable in Settings), a random per-install client ID, the current track title/artist, and play/pause state — nothing tied to your Google account
- ⚙️ **Settings window** — toggle every feature above without touching a config file, persisted across restarts

## Download

Grab the latest build from the [Releases page](../../releases):
- `V Music Setup *.exe` — installer (recommended)
- `V Music *.exe` — portable, no install needed

Sign-in uses your own Google account session, exactly like the official site — nothing is shared with anyone else.

## Development

```bash
npm install
npm start
```

## Build

```bash
npm run dist:win
```

Outputs an installer and a portable `.exe` to `release/`.

## Project structure

```
main.js              Electron main process: windows, ad block, settings, overlay server, dashboard reporting
preload.js            Bridge exposed to the renderer (settings, progress, reporting)
neo/                  New interface: YouTube Music data access + parsing
renderer/
  neo/                  New interface UI (HTML/CSS/JS)
  inject.js           Injected into music.youtube.com: playback detection, UI hooks
  base.css             Base restyle
  animations.css        Optional animation layer
  settings.html/.js    Settings window
  overlay.html          OBS Browser Source page (served locally)
assets/icon.ico         App icon
```

## OBS overlay setup

1. Open Settings in the app and enable **Overlay OBS**
2. Copy the URL shown (defaults to `http://localhost:47811`)
3. In OBS, add a **Browser Source** and paste that URL

## Listening dashboard

Each install gets a random client ID on first launch. When enabled, it posts the current track + play state to a shared Supabase table roughly once every few seconds — used to power a small real-time dashboard showing who's listening to what. Can be disabled at any time from Settings; when disabled, nothing is sent at all.
