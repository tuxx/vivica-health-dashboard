# Vivica Dashboard

![Screenshot](https://i.imgur.com/sRoIYMq.png)

A self-hosted web dashboard for logging food with [Vivica Health](https://vivica.health), so you don't have to use the Android app.

It's a small Node.js server that talks to the same API the mobile app uses (`api.vivica.health`), plus a plain HTML/JS frontend for:

- **Calendar** — browse what you've logged by day, with daily totals.
- **Log food** — search the product database and log an item, with quick access to recently and frequently logged items.
- **Build a meal** — combine products into a reusable meal that syncs back to the app.

There's no build step and no external dependencies — just Node's built-in `http` server, `fetch`, and `node:sqlite` for local caching.

## Requirements

- Node.js **22.5+** (needs the built-in `node:sqlite` module)
- A Vivica account (same email/password you use in the app)

## Getting started

```bash
git clone <this repo>
cd vivica-health-dashboard
npm start
```

Then open `http://localhost:4173` and sign in with your Vivica account credentials (2FA is supported if your account has it enabled).

The port can be changed with the `PORT` environment variable:

```bash
PORT=8080 npm start
```

## How it works

- The server proxies requests to the real Vivica API and keeps your session token server-side in `data/session.json` — it never touches your device or Google account, and credentials aren't stored anywhere except that local session file.
- Search results and other slow-changing data (product lookups, item details, supermarket types) are cached locally in a SQLite database at `data/vivica.db`, so the dashboard feels fast and doesn't hammer the upstream API.
- The `data/` directory is gitignored — it's local state, not something you commit.

### Vivica API

See [API_REFERENCE.md](./API_REFERENCE.md)

## Self-hosting

This is meant to run wherever you'd run any small Node app: a home server, a Raspberry Pi, a VPS, etc. Since it holds a live session token for your Vivica account, treat `data/session.json` like a credential and don't expose the server to the open internet without authentication in front of it (a reverse proxy with basic auth, a VPN/Tailscale, etc.).

## Disclaimer

This is an unofficial, independent project and isn't affiliated with or endorsed by Vivica Health. It works by calling the same API the official app uses, which could change at any time and break this dashboard.
