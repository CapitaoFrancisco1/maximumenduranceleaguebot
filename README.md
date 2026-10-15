# Race Control Discord bot

Posts the race status from your Roblox game into a Discord channel.

```
Roblox game (script "DiscordRelay")  --HTTPS-->  this bot  -->  your race control channel
```

What shows up in the channel:

| When race control... | The bot posts |
|---|---|
| presses FCY | `🟡 FCY ACTIVE - Full Course Yellow - slow down, no overtaking.` (and "Race control: name") |
| presses Yellow / Double yellow / Slow zone on a sector | `🟡 YELLOW FLAG - Yellow flag in sector 2` |
| presses **Delayed** (start lights) | `🔴 DELAYED START - all five red lights stay on, stand by` (also shown in the live status while it is up). Start sequence, lights out, abort and "delay over" get a line too. |
| presses Safety Car, Red, Green, Pit exit closed, Last lap, Chequered, SS / RS ... | one line each, colour coded |
| starts / ends a session | `🏁 RACE STARTED - Session length: 1:30:00` |
| changes the pit exit lights | `🚦 PIT EXIT LIGHTS` |
| sends a message / issues a penalty / opens an investigation | `📢` / `⚖️` / `🔍` lines (optional, can go to another channel) |

Plus ONE live message that is edited all the time: session (with a countdown), track status, the three sectors and the pit exit.
The `/status` command shows the same thing on demand.

## 1. Create the bot in Discord

1. https://discord.com/developers/applications -> **New Application**.
2. **Bot** tab -> **Reset Token** -> copy it (this is `DISCORD_TOKEN`). You do NOT need any "privileged intents".
3. **OAuth2 -> URL Generator**: scopes `bot` and `applications.commands`; bot permissions **View Channel, Send Messages, Embed Links, Read Message History** (and **Manage Messages** if you want the live message pinned).
4. Open the generated link and add the bot to your server. Make sure the bot may see and write in the race control channel.
5. In Discord: Settings -> Advanced -> **Developer Mode** on. Right click the race control channel -> **Copy Channel ID** (`CHANNEL_ID`). Right click your server icon -> Copy Server ID (`GUILD_ID`, only for `/status`).

## 2. Run the bot (it has to be online all the time)

Needs Node.js 18 or newer. Any host works: Railway, Render, Fly.io, a VPS... It needs a **public https address** (Roblox cannot call `localhost`).

```
npm install
cp .env.example .env      # then fill in .env   (on Railway / Render type the same names as environment variables instead)
npm start
```

`API_KEY` is a password you invent (long and random, for example 40 letters). Roblox must send the same one.

Try it without Discord: `DRY_RUN=true API_KEY=test npm start` prints the messages in the console instead of sending them.

Check it from a terminal (replace the address and the key):

```
curl -X POST https://YOUR-BOT-ADDRESS/event -H "x-api-key: YOUR_KEY" -H "content-type: application/json" -d '{"type":"test"}'
```

### Running it on your own computer first (to check it works)

```
cd race-control-bot-render
npm install               # IMPORTANT: downloads discord.js, express and dotenv. Without this, npm start fails with ERR_MODULE_NOT_FOUND
```
Then create a file called `.env` in that folder (it starts with a dot, so Finder hides it - create it from VS Code) with the lines of `.env.example` filled in, and run `npm start`. To test without Discord: `DRY_RUN=true API_KEY=test npm start`.

### Running it on Render

* Put `index.js`, `format.js`, `package.json` (and `.gitignore`) in the **root** of your repository. Do NOT upload `.env`.
* New **Web Service**, runtime **Node**, Build Command `npm install`, Start Command `npm start` (not `node src/index.js`), Root Directory empty. After changing a setting press **Manual Deploy -> Clear build cache & deploy**.
* **Environment** tab: add `DISCORD_TOKEN`, `CHANNEL_ID`, `API_KEY` (and `GUILD_ID`, `LOG_CHANNEL_ID` if you use them). Render sets `PORT` by itself.
* `package.json` and `.node-version` ask for **Node 22**. If your Render service still shows a different version in the deploy log, add the environment variable `NODE_VERSION` = `22`.
* Open `https://YOUR-BOT-ADDRESS/health`: it must say `"discordReady":true`. `false` means the bot is NOT connected to Discord - read the deploy log: it now prints why.
* The free plan puts the service to sleep after about 15 minutes without web traffic: the bot goes offline and the first message from Roblox waits for it to wake up. For a race night use a paid instance, or keep it awake with an uptime monitor that opens `https://YOUR-BOT-ADDRESS/health` every 5 minutes.

## 3. Roblox side

1. **Game Settings -> Security -> Allow HTTP Requests = ON** (and publish the game).
2. Insert the new `StandingsScript` model (it contains the script **DiscordRelay**).
3. Open **DiscordRelay** and fill in `BOT_URL` (the https address of your bot, no `/event` at the end) and `API_KEY` (same text as in the bot).
4. In Studio nothing is sent unless `SEND_IN_STUDIO = true` (so testing the game does not spam the channel). A real server sends everything.

Keep the key inside that script only. Never put it in a ModuleScript, ReplicatedStorage or an attribute: the players' clients can read those.

## Changing the wording

All the texts, emojis and colours are in `format.js`. Switches in `.env`:
`STATUS_MESSAGE=false` (no live message), `LOG_CHANGES=false` (no line per change), `LOG_CHANNEL_ID` (penalties / messages in another channel).

## Troubleshooting

* Roblox Output says `Http requests are not enabled` -> step 1 of the Roblox part.
* `HTTP 401` -> `API_KEY` differs between the bot and the script.
* `HTTP 404/ timeout` -> wrong `BOT_URL`, or the bot is not running. Open `https://YOUR-BOT-ADDRESS/health` in a browser: it must show `{"ok":true,...}`.
* The bot says `CANNOT USE CHANNEL_ID` -> wrong id, or the bot cannot see that channel.
* After a restart the bot makes a new live message: it finds the old one if it may read the channel history; for a host that keeps no files you can also set `DATA_DIR` to a persistent volume.
