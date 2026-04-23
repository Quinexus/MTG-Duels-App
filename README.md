# MTG Duels

## AI-Generated Project Notice

**This entire app was made with AI, from the ground up.**

**Only user prompting was used.**

That means the codebase, structure, features, and implementation were generated through AI-assisted development driven by prompts rather than written manually in the traditional way.

## Live App

The app is live at [www.mtgduels.com](https://www.mtgduels.com).

Deployment is split across:

- **Vercel** for the web app and serverless API behavior used by the project
- **Render** for the multiplayer relay server used by online play

## What This Project Is

MTG Duels is a browser-based Magic: The Gathering playtest app built with React, TypeScript, and Vite. It supports solo playtesting, multiplayer syncing, deck importing, and limited-format tooling.

## Local Development

Install dependencies:

```bash
npm install
```

Run the frontend locally:

```bash
npm run dev
```

Run the multiplayer relay locally:

```bash
npm run relay
```

Build the app:

```bash
npm run build
```

## Repo Notes

- `src/` contains the React app
- `api/` contains serverless API routes
- `scripts/multiplayer-relay.mjs` contains the Node/WebSocket relay server
- `vercel.json` contains the Vercel rewrite configuration
