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
- Drag a file onto the upload zone, set duration, it appears in the list
- Add a URL (Grafana, Notion public page, etc.) with "Add web slide"
- Drag slides in the list to reorder
- Toggle the switch to disable a slide without deleting it
- Edit the duration inline

Changes show up on the TV on the next cycle (within 30 seconds).

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

- `server.js` — Express + SQLite backend
- `public/admin.html` — admin UI
- `public/kiosk.html` — fullscreen slideshow
- `sgapi-kiosk.service` — systemd unit
- `install.sh` — one-shot setup
