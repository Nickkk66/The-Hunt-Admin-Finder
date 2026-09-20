# The-Hunt-Admin-Finder

Watches a Roblox group rank - or a named list of specific people - checks everyone's
presence on a loop, and pings a Discord webhook the moment one of them is in **The Hunt**
so you can hop in and get the in-game item.

Three watchers ship in the config:

| Watcher          | Watches                                                        | Item          |
| ---------------- | -------------------------------------------------------------- | ------------- |
| `silver-wings`   | group [1200769](https://www.roblox.com/share/g/1200769), rank `Team Member` | Silver Wings  |
| `golden-wings`   | group [4199740](https://www.roblox.com/share/g/4199740), rank `Video Star`  | Golden Wings  |
| `obsidian-wings` | a named list of people (see below)                              | Obsidian Wings |

They all run in one process off the same config file. Adding a fourth is a new entry in
`watchers.json`, not new code.

## Obsidian wings, and watch lists in general

Obsidian isn't handed out through a group rank, it's handed out by whoever is running a
launcher server. So a watcher can now watch **a list of specific people** instead of a rank:
give it `users` instead of `groupId` and `rank`, and everything downstream (presence sweeps,
follow probing, dedupe, Discord alerts) works exactly the same.

```json
{
  "name": "obsidian-wings",
  "itemName": "Obsidian Wings",
  "users": [
    { "userId": 2204301, "username": "Fangwing", "note": "Zarc's alt account" },
    { "userId": null, "username": "SomeoneUnverified", "enabled": false, "note": "id not confirmed" }
  ],
  "webhookUrl": "${DISCORD_WEBHOOK_OBSIDIAN_WINGS}",
  "target": { "universeIds": [], "placeIds": [], "nameMatch": "The Hunt" }
}
```

Each entry can be a bare id (`2204301`), a username (`"Fangwing"`), a profile link, or an
object with `userId`, `username`, `note` and `enabled`. The `note` shows up in the Discord
embed, so you know why that person is on the list when the ping lands at 3am.

The list that ships in `watchers.example.json`:

| Person                | Roblox id  | Status                                                    |
| --------------------- | ---------- | --------------------------------------------------------- |
| WaffleTrades          | 2672900117 | watched                                                   |
| WeirdBlox             | 431900130  | watched                                                   |
| Zarcyn                | 65141229   | watched                                                   |
| Fangwing              | 2204301    | watched (Zarc's alt, used for the launcher streams)       |
| javie12               | 38805399   | watched                                                   |
| 0kkAleks              | unknown    | **parked** (`enabled: false`)                              |
| Kirbyyum              | unknown    | **parked** (`enabled: false`)                              |
| Neatzo                | unknown    | **parked** (`enabled: false`)                              |

Those ids came off a stream round-up, not out of the Roblox API, and nothing in this repo has
checked them against a live account. The five that are on carry an id, so worst case you watch
a wrong-but-real account and get no pings. The three parked ones had no confirmed profile at
all, and Roblox re-issues freed-up usernames, so resolving them by name could park you on a
stranger. Confirm the id and flip `enabled` yourself:

```bash
npm run resolve "0kkAleks"                                  # username -> id
npm run resolve "https://www.roblox.com/users/2204301/profile"   # link -> id
```

That prints the profile link next to every id it finds. Open it, check it's the person whose
stream you were watching, then paste the id into `watchers.json`.

A watcher is one thing or the other: `users` **or** `groupId`/`rank`. Setting both is a config
error rather than a silent pick.

## Read this before you set it up

This only works as well as Roblox lets it, and the gaps are real:

1. **You need a logged-in cookie.** Group member pages, presence and follows all
   reject anonymous requests. That means putting your `.ROBLOSECURITY` in `.env`.
   Anyone who gets that string is logged into your account. Do not commit it, do
   not paste it in Discord, and use an alt if you have one.
2. **Presence hides the game for a lot of people.** `placeId` / `gameId` come back
   `null` unless that user's privacy lets you see what they're playing. Follow
   probing (below) opens up the subset who set joins to **Followers**. Anyone on
   **Friends** or **No one** stays invisible no matter what you do.
3. **Rate limits are the real ceiling.** ~2.7k members is ~54 presence calls per
   sweep. The client spaces requests and backs off on 429s, but dropping
   `pollIntervalSeconds` to 10 gets you throttled and shows you *less*, not more.
   90 seconds is a sane floor for a rank this big.
4. **This is automated scraping, plus automated follows, on your own account.**
   Roblox's ToS doesn't love it. Worst realistic case is rate limiting, a captcha
   wall, or a flagged account. Your call.

## Web interface

There's a single page that works two ways. Each watcher card has a **Watch** dropdown:
a group rank, or a named list of people (one per line, `#` parks a line).

**On GitHub Pages** (`https://nickkk66.github.io/The-Hunt-Admin-Finder/`) it is a config
builder. You fill in group ids, ranks, webhooks and probe settings, and it generates your
`watchers.json` and `.env` with copy and download buttons. It validates as you type and can
fire a test message at a Discord webhook. **Nothing is saved** - no localStorage, no cookies,
no server. Reload the page and it's blank again.

It cannot run the watcher, and neither can any other browser page:

- Roblox's API sends no CORS headers, so `fetch` from `github.io` to `presence.roblox.com`
  is blocked before it leaves your browser.
- `.ROBLOSECURITY` is httpOnly on roblox.com, so page JavaScript cannot read or attach it.
- The only way around that is a CORS proxy, which means handing your session cookie to
  somebody else's server. That is an account takeover waiting to happen. Don't.

**Locally** the same page gets a working start button:

```bash
npm run ui                    # opens http://127.0.0.1:8787
npm run ui -- --port 9000
npm run ui -- --no-open       # don't launch a browser
```

That serves `docs/index.html` from the watcher process itself, so it's same-origin and the
Node side does the Roblox calls. You get a start/stop button, per-watcher live status
(members, last sweep, hidden count, active follows) and a log tail. It binds to 127.0.0.1
only and writes nothing to disk: the cookie and webhook urls stay in memory until you stop
the process.

**Publishing the Pages version requires a public repo.** GitHub Pages on a *private*
repo is a paid feature (Pro/Team/Enterprise). If this repo is private on a free account,
the deploy workflow fails before it runs a single step — no runner, no logs, nothing to
debug. Make the repo public (Settings → General → Danger Zone → Change visibility), or
skip Pages entirely and just run it locally, which is what you want anyway.

Once the repo is public, `.github/workflows/pages.yml` deploys `docs/` on every push that
touches it. It passes `enablement: true` to `configure-pages`, so the Pages site is created
on the first run — you do **not** need to set Settings → Pages → Source by hand. Trigger
the first deploy from the Actions tab ("Deploy config builder to Pages" → Run workflow).

Nothing secret ships in `docs/`: the page is static, and `.env`, `watchers.json` and
`.state/` are all gitignored.

## Setup

Node 20 or newer (`node -v` to check; get it from <https://nodejs.org>). No dependencies
to install — there is no `npm install` step, the project has zero deps.

```bash
git clone https://github.com/Nickkk66/The-Hunt-Admin-Finder.git
cd The-Hunt-Admin-Finder
npm run setup                 # creates .env and watchers.json from the examples
```

`npm run setup` never overwrites a file you already have, so re-running it is safe. It
prints which values in `.env` are still blank. Fill those in, then:

```bash
npm run ui                    # opens http://127.0.0.1:8787 in your browser
```

Works the same on Windows, macOS and Linux. Use `npm run ui -- --no-open` if you'd rather
open the tab yourself, and `npm run ui -- --port 9000` to move it off 8787.

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

The same command checks a group and lists its ranks, so you can confirm the exact
rank spelling and member count:

```bash
npm run resolve "https://www.roblox.com/share/g/1200769"
npm run resolve "https://www.roblox.com/share/g/4199740"
```

And it turns a username or a profile link into the numeric id a watch list wants:

```bash
npm run resolve "Fangwing"
npm run resolve "https://www.roblox.com/users/2204301/profile"
```

## Running it

```bash
npm start                 # every enabled watcher, forever
npm run once              # one sweep, then exit (good for a first smoke test)
npm start -- --only silver-wings
npm start -- --only obsidian-wings
npm start -- --refresh    # force a re-scrape of the member list / re-resolve of the watch list
npm start -- --unfollow-all   # undo every follow the probe made, then exit
npm run ui                    # the web dashboard on localhost
LOG_LEVEL=debug npm start
```

First start scrapes the whole rank (27 pages for 2.7k people) and caches it in
`.state/<watcher>.json`. After that it reuses the cache for `memberCacheHours`
(default 6) so each sweep is just the presence calls. A watch list is cached the same
way, and re-resolved whenever you edit the list.

Once notified about a user in a given server, it won't ping again for
`renotifyMinutes` (default 30). If they change servers, that's a new ping.

## Follow probing (the people hiding their game)

Roblox's "who can join me" setting has a **Followers** option, and presence hides
the game from anyone who isn't allowed to join. So for that group, following them
makes their server visible. That's what probing does.

Per sweep, for users who are in *something* we can't see:

1. Check which of them you already follow (those are left alone entirely).
2. Follow up to `maxPerCycle` of the rest, slowly.
3. Wait `settleMs`, re-check presence.
4. In The Hunt → notify. Different game → no ping. Still hidden → unfollow now and
   don't touch them again for `opaqueBackoffHours`.

### Two things about this that you asked for and shouldn't have

**Unfollowing right after the check would break the thing you're trying to do.**
Their joins are follower-only. Unfollow and you're not a follower, so you can't
join the server you just found. The tool keeps the follow while they're in the
target game plus `targetGraceMinutes` (default 20), and only then drops it. If you
really want the follow-check-unfollow behaviour, set `targetGraceMinutes: 0` and
`keepFollowMinutes: 0` and accept that the alert is just trivia.

**Follow/unfollow churn is the fastest way to get your account captcha-walled.**
Probe every hidden user every 90 seconds and you're doing thousands of writes an
hour, which looks exactly like a follow bot. So:

- a user who *reveals* on follow stays followed for `keepFollowMinutes` (default
  60). You then watch them through the normal cheap presence sweep instead of
  re-following them every cycle.
- a user who stays hidden after a follow is written off for `opaqueBackoffHours`.
- hard caps: `maxPerCycle` per sweep, `maxActiveFollows` outstanding overall,
  `minIntervalMs` between follow calls.
- a captcha or 429 on the follow endpoint pauses all probing for
  `pauseOnErrorMinutes`, it does not retry into the wall.
- pre-existing follows are recorded and never unfollowed. The tool only undoes its
  own follows.
- `probe.dryRun: true` logs who it would follow and follows nobody. **Run this
  first.**

On ctrl-c it unfollows what it added, except people still in the target game.
`--unfollow-all` forces a full cleanup.

Probing is `enabled: true` for both watchers in the example config. Set it to
`false` if you'd rather not touch the follow API at all.

## Config reference

`watchers.json` — `defaults` applies to every watcher, each entry overrides it.

| Key                   | What it does                                                                 |
| --------------------- | ---------------------------------------------------------------------------- |
| `name`                | Used for the state file and `--only`. Keep it unique.                         |
| `groupId`             | Numeric group id. Leave it out if you're using `users`.                       |
| `rank`                | Rank name (case/space-insensitive) or the numeric rank value.                 |
| `users`               | A list of specific people to watch *instead of* a group rank. See above.      |
| `sourceLabel`         | What to call the list in logs and the Discord footer. Optional.               |
| `itemName`            | Shown in the Discord message.                                                 |
| `webhookUrl`          | Discord webhook. `${ENV_VAR}` is expanded from `.env`.                        |
| `target.universeIds`  | Exact match, most reliable. Fill via `npm run resolve`.                        |
| `target.placeIds`     | Exact match on `placeId` / `rootPlaceId`.                                      |
| `target.nameMatch`    | Regex fallback against `lastLocation` when ids are missing.                    |
| `pollIntervalSeconds` | Gap between sweeps. Don't go below ~60 for a rank this size.                   |
| `memberCacheHours`    | How long before the member list is re-scraped.                                 |
| `presenceBatchSize`   | Users per presence call, max 100. 50 is the safe default.                      |
| `renotifyMinutes`     | Cooldown before the same user/server can ping again.                           |
| `notifyOnUnknownGame` | Ping on "in a game, no idea which". Noisy, and skips probing. Default `false`. |
| `enabled`             | Set `false` to park a watcher without deleting it.                             |

Probe settings (`probe`):

| Key                   | Default | What it does                                                    |
| --------------------- | ------- | --------------------------------------------------------------- |
| `enabled`             | `false` | Turn follow probing on. The example config enables it per watcher. |
| `dryRun`              | `false` | Log intended follows, perform none.                               |
| `maxPerCycle`         | `10`    | Most users followed in one sweep. Config rejects >25.             |
| `maxActiveFollows`    | `60`    | Ceiling on outstanding probe follows.                             |
| `minIntervalMs`       | `1500`  | Gap between follow calls.                                         |
| `settleMs`            | `4000`  | Wait before re-checking presence (their cache needs a moment).    |
| `recheckAttempts`     | `2`     | Presence re-checks before writing someone off as hidden.          |
| `keepFollowMinutes`   | `60`    | How long a revealed user stays followed.                          |
| `targetGraceMinutes`  | `20`    | Extra time to keep the follow after seeing them in the target.    |
| `opaqueBackoffHours`  | `12`    | Cooldown before re-probing someone following didn't reveal.       |
| `pauseOnErrorMinutes` | `30`    | Probe pause after a captcha or 429.                               |
| `unfollowOnExit`      | `true`  | Clean up probe follows on ctrl-c.                                 |

## Layout

```
src/robloxClient.js  auth, CSRF, captcha detection, 429/5xx backoff
src/queue.js         request pacing
src/groups.js        rank lookup + member paging
src/users.js         watch lists: username -> id, id -> display name
src/presence.js      batched presence calls
src/follows.js       follow / unfollow / following-exists
src/matching.js      "is this person in the target game" (pure, unit tested)
src/watcher.js       the loop: scrape -> poll -> probe -> dedupe -> notify -> unfollow
src/discord.js       webhook embeds
src/resolve.js       share link -> ids helper
src/server.js        localhost dashboard + start/stop api
src/setup.js         one-command local scaffolding (npm run setup)
src/index.js         CLI
src/ui.js            npm run ui entry point
docs/index.html      the page, served by Pages and by src/server.js
```

```bash
npm test
```

The test suite fakes the Roblox API end to end, including the probe paths (reveal,
no-reveal, pre-existing follow, dry run, captcha pause) and the watch-list paths
(name resolution, unknown names, a dead username lookup, renames). It has never been run
against the live API from this repo's CI — first real run is your smoke test.
