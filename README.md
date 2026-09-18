# The-Hunt-Admin-Finder

Watches a Roblox group rank, checks every member's presence on a loop, and pings a
Discord webhook the moment one of them is in **The Hunt** so you can hop in and get
the in-game item.

Two watchers ship in the config:

| Watcher        | Group                                          | Rank          | Item         |
| -------------- | ---------------------------------------------- | ------------- | ------------ |
| `silver-wings` | [1200769](https://www.roblox.com/share/g/1200769) | `Team Member` | Silver Wings |
| `golden-wings` | [4199740](https://www.roblox.com/share/g/4199740) | `Video Star`  | Golden Wings |

Both run in one process off the same config file. Adding a third is a new entry in
`watchers.json`, not new code.

## Read this before you set it up

This only works as well as Roblox lets it, and the gaps are real:

1. **You need a logged-in cookie.** Group member pages and the presence API both
   reject anonymous requests now. That means putting your `.ROBLOSECURITY` in
   `.env`. Anyone who gets that string is logged into your account. Do not commit it,
   do not paste it in Discord, and use an alt if you have one.
2. **Presence hides the game for a lot of people.** `placeId` / `gameId` come back
   `null` unless that user's privacy settings let you see what they're playing.
   You'll still see "in a game", just not *which* game. Roblox staff and big
   creators very often have this locked down, so expect a chunk of the 2.7k to be
   permanently invisible. Set `notifyOnUnknownGame: true` if you'd rather get a
   noisy "someone is in *something*" ping than miss them.
3. **No server id means no one-click join.** The join link in the webhook needs
   `gameId` (the server job id). Without it you get a link to the experience and
   have to find them yourself.
4. **Rate limits are the real ceiling.** ~2.7k members is ~54 presence calls per
   sweep. The client spaces requests out and backs off on 429s, but if you drop
   `pollIntervalSeconds` to 10 you will get throttled and see *less*, not more.
   90 seconds is a sane floor for a rank this big.
5. **This is automated scraping of Roblox.** Their ToS doesn't love it. Worst
   realistic case is rate limiting or a flagged account. Your call.

## Setup

Node 20 or newer. No dependencies to install.

```bash
cp .env.example .env          # fill in ROBLOX_COOKIE + both webhook urls
cp watchers.example.json watchers.json
```

Getting the cookie: log into roblox.com, DevTools → Application → Cookies →
`https://www.roblox.com` → `.ROBLOSECURITY` → copy the whole value (including the
`_|WARNING:-DO-NOT-SHARE-THIS...` prefix).

Getting a webhook: Discord server → Server Settings → Integrations → Webhooks →
New Webhook → Copy Webhook URL.

### Pin down the game ids

Name matching on `lastLocation` works but is fuzzy. Resolve the real ids once:

```bash
npm run resolve "https://www.roblox.com/share?code=50ed9c732699e543871136655798ba15&type=ExperienceDetails"
```

It prints the `universeId` and `rootPlaceId`; paste them into `target.universeIds`
and `target.placeIds` in `watchers.json`. Do it for both watchers (they point at the
same experience, so the same ids go in both).

Same command checks a group and lists its ranks, so you can confirm the exact rank
spelling and member count:

```bash
npm run resolve "https://www.roblox.com/share/g/1200769"
npm run resolve "https://www.roblox.com/share/g/4199740"
```

## Running it

```bash
npm start                 # both watchers, forever
npm run once              # one sweep, then exit (good for a first smoke test)
npm start -- --only silver-wings
npm start -- --refresh    # force a re-scrape of the member list
LOG_LEVEL=debug npm start
```

First start scrapes the whole rank (27 pages for 2.7k people) and caches it in
`.state/<watcher>.json`. After that it reuses the cache for `memberCacheHours`
(default 6) so each sweep is just the presence calls.

Once notified about a user in a given server, it won't ping again for
`renotifyMinutes` (default 30). If they change servers, that's a new ping.

## Config reference

`watchers.json` — `defaults` applies to every watcher, each entry overrides it.

| Key                   | What it does                                                                 |
| --------------------- | ---------------------------------------------------------------------------- |
| `name`                | Used for the state file and `--only`. Keep it unique.                         |
| `groupId`             | Numeric group id.                                                             |
| `rank`                | Rank name (case/space-insensitive) or the numeric rank value.                 |
| `itemName`            | Shown in the Discord message.                                                 |
| `webhookUrl`          | Discord webhook. `${ENV_VAR}` is expanded from `.env`.                        |
| `target.universeIds`  | Exact match, most reliable. Fill via `npm run resolve`.                        |
| `target.placeIds`     | Exact match on `placeId` / `rootPlaceId`.                                      |
| `target.nameMatch`    | Regex fallback against `lastLocation` when ids are missing.                    |
| `pollIntervalSeconds` | Gap between sweeps. Don't go below ~60 for a rank this size.                   |
| `memberCacheHours`    | How long before the member list is re-scraped.                                 |
| `presenceBatchSize`   | Users per presence call, max 100. 50 is the safe default.                      |
| `renotifyMinutes`     | Cooldown before the same user/server can ping again.                           |
| `notifyOnUnknownGame` | Ping when someone is in a game but the game is hidden. Noisy. Default `false`. |
| `enabled`             | Set `false` to park a watcher without deleting it.                             |

## Layout

```
src/robloxClient.js  auth, CSRF, 429/5xx backoff
src/queue.js         request pacing
src/groups.js        rank lookup + member paging
src/presence.js      batched presence calls
src/matching.js      "is this person in the target game" (pure, unit tested)
src/watcher.js       the loop: scrape -> poll -> dedupe -> notify
src/discord.js       webhook embeds
src/resolve.js       share link -> ids helper
src/index.js         CLI
```

```bash
npm test
```
