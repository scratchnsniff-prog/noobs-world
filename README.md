# Noob World

A small Club Penguin-style multiplayer world. Everyone is the noob from the NPC code. You pick a name, walk around The Iron Café, jump, chat, and use emotes.

| Key | What it does |
| --- | --- |
| W A S D | Walk (W goes away from the screen, S comes toward it) |
| Space | Jump |
| 1 | Drink |
| 2 | Cheeseburger |
| 3 | Dance (with music) |
| Enter | Open the chat box. Press Enter again to send. |

Walking cancels an emote. Background music (`public/audio.mp3`) starts when someone joins, and there is a mute button in the top right.

## Try it on your own computer

1. Install Node.js (version 18 or newer) from nodejs.org.
2. Open a terminal in this folder and run:
   ```
   node server.js
   ```
3. Open http://localhost:3000 in your browser. Open it in a second tab with a different name to see two players.

Nothing needs installing with `npm`. The server has no packages.

## Put it online so other people can join

The game needs a real server running somewhere, because the page and the multiplayer connection come from the same place. Google Sites cannot run it. It can only show it (see the last section).

### Render (has a free option)

1. Put this folder in a GitHub repository.
2. On render.com, choose **New**, then **Web Service**, and pick your repository.
3. Use these settings:
   - Language: **Node**
   - Build command: `npm install` (the default is fine, there is nothing to install)
   - Start command: `node server.js`
   - Instance type: **Free** (or a paid one, see below)
4. Deploy. Render gives you an address like `https://your-name.onrender.com`. That is the game link you share.

About Render's free plan, as of early 2026: a free service goes to sleep after 15 minutes with no web requests or incoming WebSocket messages, and takes about a minute to wake up when the next visitor arrives. While someone is playing, the game sends a message about twice a second, which counts as activity. Free services can also be restarted at any time. The game reconnects people automatically when that happens, but a paid instance avoids the sleeping and restarting altogether. Check Render's current docs for the latest limits, since these change.

Other hosts that run a Node server with WebSockets (Railway, Fly.io, a small VPS) work the same way: upload the folder and run `node server.js`. The server reads the `PORT` setting from the host automatically.

## Change things

**Walkable area, jump, speed, size:** the `CONFIG` block at the top of the script in `public/index.html`. If you change the ground limits (`GROUND_MIN_Y`, `GROUND_MAX_Y`), change `WORLD` near the top of `server.js` to match.

**Background music:** replace `public/audio.mp3` with your own file. It loops. The file that comes with the project is 3 seconds of silence so nothing shows a missing-file error.

**Background picture:** replace `public/background.webp`. The page assumes a 1000 x 588 picture. If yours is a different size, change `WORLD_W` and `WORLD_H`, and set the ground limits to where the floor is.

**Sounds and pictures:** the `ASSETS` and `SOUNDS` blocks in `public/index.html`. The Walk picture still comes from postimg and has not been lined up with the others yet. If you upload the Walk GIF, it can be put on the same canvas and saved into `public/assets`.

**Word filter:** add lowercase words to `BLOCKED_WORDS` near the top of `server.js`. They show up as asterisks in chat. This is only a basic filter.

## Things to know

- **No accounts.** Anyone can pick any name that is not already taken. Names are free again when a player leaves.
- **Chat is open to everyone.** The server limits message length and speed, and removes `<` and `>`, but it does not moderate. If younger people will play, plan for moderation (a stronger filter, reports, or a way to mute players) before sharing the link widely.
- **The server trusts players' positions,** only keeping them inside the walkable area. That is fine for a hangout, but it is not cheat-proof.
- **Up to 60 players** at once, set by `MAX_PLAYERS` in `server.js`.
- **A keyboard is needed.** There are no on-screen controls for phones yet.

## Showing it inside a Google Site

Once the game is online at an `https` address, in the Google Sites editor choose **Insert**, then **Embed**, then the **By URL** tab, and paste the game's address. Make the box large. Click inside the game once so the keyboard works there.
