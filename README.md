# sgapi kiosk

A web-managed TV kiosk for the Raspberry Pi. Drop in images, videos, and web
URLs through an admin panel and they rotate fullscreen on the TV.

## Architecture

```
┌──────────────────┐         ┌─────────────────────────┐
│  Your laptop     │  HTTP   │  sgapi.local:8080       │
│  (admin panel)   │────────▶│  ┌───────────────────┐  │
└──────────────────┘         │  │ Node/Express API  │  │
                             │  │ SQLite DB         │  │
                             │  │ /content uploads  │  │
                             │  └───────────────────┘  │
┌──────────────────┐         │          ▲              │
│  TV (Chromium)   │──HTTP──▶│   /kiosk │              │
│  localhost:8080  │◀────────│   page   │              │
└──────────────────┘         └─────────────────────────┘
```

## One-time install on the Pi

```bash
cd ~
# (copy this whole folder to ~/sgapi-kiosk first, see below)
cd sgapi-kiosk
chmod +x install.sh
./install.sh
sudo reboot
```

After reboot, the TV shows the kiosk and the admin panel is at:
- `http://sgapi.local:8080/` (if mDNS works on your network)
- `http://<pi-ip>:8080/` (always works)

## Usage

**Admin panel** (`http://sgapi.local:8080/`):
- Drop one file or a dozen onto the upload zone — each gets its own progress bar
- Add a web page URL; the panel checks first whether the site allows embedding
- Drag slides to reorder (on a phone, use the ▲▼ buttons)
- Click a slide's name to rename it
- Toggle the switch to hide a slide without deleting it
- Edit the duration inline
- "Live on the TV" mirrors exactly what the Pi is showing right now

Every change reaches the TV **immediately** over an event stream — no waiting
for a refresh cycle. The panel's status dot turns red if that connection drops.

### How slides are framed

The TV is landscape, but posters usually aren't. Rather than crop them or pad
them with black bars, each slide is framed on its own:

- Roughly screen-shaped (within 15% of the TV's aspect) → fills edge to edge
- Anything else (portrait flyers, 4:3 scans) → shown whole, centred, over a
  blurred wash of its own colours

The next slide is fully downloaded *and decoded* while the current one is still
up, so switches are a clean crossfade instead of a flash of black.

### Web page slides

Many sites refuse to be displayed inside a frame (`X-Frame-Options` /
`frame-ancestors`) — Google, most social media, most logged-in dashboards.
Nothing can embed those; a browser just shows a broken-page icon.

The admin panel probes the URL when you enter it and warns you, and the kiosk
skips such a slide rather than putting a broken icon on the TV. If a site is
blocked, look for its "embed", "publish to web", or "share → embed" link — that
variant is usually allowed.

You can type `elon.edu`; `https://` is filled in for you.

A page on your own network (`http://192.168.1.50:3000/dashboard`) works too —
the TV's browser loads it directly. The server deliberately won't fetch private
addresses itself, so such a slide is shown without the embedding check rather
than being verified first.

### Calendar slides

A calendar slide pulls straight from a public Google Calendar and renders the
SGA board — headline on the left, the next four events on the right.

To add one: **Calendar** tab → paste the calendar's iCal address → *Add
calendar slide*. In Google Calendar that address is under Settings → the
calendar → *Integrate calendar* → **Public address in iCal format**. The
calendar has to be public; a private feed will be rejected with an error rather
than silently showing nothing.

Nothing else needs maintaining. The feed is re-fetched every 10 minutes, the
page re-renders every minute so dates roll over at midnight, and events are
sorted soonest-first with anything already finished dropped.

What it understands: all-day events, timed events in any time zone, repeating
events (`RRULE`), cancelled occurrences (`EXDATE` — fall break and Thanksgiving
already drop out of the weekly Business Meeting), and single occurrences that
were edited or renamed (`RECURRENCE-ID`). Times are shown in the calendar's own
time zone, so they stay right regardless of how the Pi's clock is configured.

The one gap: "third Thursday of the month" style rules (`BYSETPOS`) expand as if
the ordinal weren't there. Swap `ical.js` for the `node-ical` package if that
ever comes up — see the note at the top of that file.

## How to push content from your Mac without the admin panel

Files live in `~/sgapi-kiosk/content/` on the Pi, but you should add them
through the admin panel so they get registered in the database.

For bulk uploads you can `curl` the API directly:

```bash
curl -F "file=@photo.jpg" -F "duration=10" -F "label=My photo" \
  http://sgapi.local:8080/api/slides/upload
```

## Useful commands (on the Pi)

```bash
# Check service status
sudo systemctl status sgapi-kiosk

# View logs
journalctl -u sgapi-kiosk -f

# Restart the backend (e.g. after editing server.js)
sudo systemctl restart sgapi-kiosk

# Kill/relaunch Chromium without a reboot
pkill chromium
# then it won't auto-relaunch; easiest fix is `sudo reboot` or re-run the
# autostart command manually
```

## Files

- `server.js` — Express + SQLite backend, `/api/events` live update stream
- `ical.js` — iCalendar reader for calendar slides (`node ical.js` self-checks)
- `public/calendar.html` — the live SGA events board
- `public/admin.html` — admin UI
- `public/kiosk.html` — fullscreen slideshow
- `sgapi-kiosk.service` — systemd unit
- `install.sh` — one-shot setup
- `update.sh` — pull + restart, run on the Pi

## Deploying changes to the Pi

Pushing to GitHub only updates GitHub. Nothing on the Pi is watching that repo,
so the Pi has to pull. From your Mac:

```bash
git push
```

Then on the Pi:

```bash
ssh pi@sgapi.local        # or ssh pi@<pi-ip>
cd ~/sgapi-kiosk
./update.sh
```

`update.sh` pulls, reinstalls dependencies only if `package.json` actually
changed (`better-sqlite3` compiles from source and takes a few minutes, so it's
skipped otherwise), and restarts the service. The TV reloads itself a few
seconds later — the kiosk page notices the backend is a new process and
refreshes, so you never need to touch Chromium.

**Uploaded slides and the database are never touched by a pull.** `content/`
and `kiosk.db` are gitignored — they live only on the Pi.

### If `git pull` fails on the Pi

The original install said to *copy* the folder over, so the Pi may not be a git
clone at all. Convert it once, keeping the uploaded content in place:

```bash
cd ~
mv sgapi-kiosk sgapi-kiosk.old
git clone git@github.com:tymastrangelo/sgapi-kiosk.git
cd sgapi-kiosk
cp -r ../sgapi-kiosk.old/content/. content/     # your slides
cp ../sgapi-kiosk.old/kiosk.db .                # the playlist
npm install --omit=dev
sudo systemctl restart sgapi-kiosk
```

Once that works, `./update.sh` is all you need from then on.

### One-time: Chromium GPU flags

`install.sh` now launches Chromium with GPU rasterization enabled, which is
most of the difference between smooth and stuttery on Pi hardware. An existing
install won't pick that up from a `git pull` — the autostart file was written
during setup. Re-run `./install.sh`, or edit
`~/.config/autostart/sgapi-kiosk.desktop` by hand, then reboot.
