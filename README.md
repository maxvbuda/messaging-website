# Rally

Self-hosted team chat: **rooms**, direct messages, threads, reactions, lightweight video, and optional D&D session tools—not a Slack skin. UI and language deliberately use “rooms,” a teal-forward palette, Syne/DM Sans typography, and the ◇ marker instead of hashtag channels.

- **Frontend:** static `index.html`, `styles.css`, `app.js`; GitHub Pages deploys from `public/`.
- **Backend:** `server.js` (Express + Socket.IO + MongoDB). Default DB name stays `slackflow` unless you override `MONGODB_DB`; localStorage keys remain `sf_*` for painless upgrades.

Set `ADMIN_PASSWORD` in production. Rename and extend as you ship.
