# SlackFlow 2 — Team Messaging Website

Server uses **MongoDB** by default on database `slackflow2`. Set `MONGODB_URI` on the host; override the database name with `MONGODB_DB` if needed (e.g. keep data in `slackflow`).

A Slack-inspired messaging web app built with pure HTML, CSS, and JavaScript — no frameworks or dependencies.

## Features

- **Channels** — Browse, create, and switch between channels with topic descriptions
- **Direct Messages** — Click any user to open a DM conversation
- **Threaded Replies** — Open threads on any message, reply inline
- **Reactions** — Add emoji reactions to messages, toggle your own
- **Emoji Picker** — Search and insert emojis in messages or as reactions
- **Search** — Full-text search across all channels and threads
- **Member Panel** — View online/offline status and roles
- **Typing Indicators** — Simulated typing animation when bots respond
- **Simulated Responses** — Other "users" reply automatically to keep the conversation going
- **Unread Badges** — Channels accumulate unread counts with simulated background activity
- **Profile Editing** — Change your display name from the profile modal
- **Mobile Responsive** — Sidebar collapses into a hamburger menu on small screens
- **Dark Theme** — Modern dark UI with accent colors and smooth transitions

## Getting Started

Just open `index.html` in a browser:

```bash
open index.html
```

Or serve it locally:

```bash
npx serve .
```

No build step. No dependencies. Pure vanilla web.
