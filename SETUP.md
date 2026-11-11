# Renamer — Setup

Google Apps Script that watches an **Open** folder you choose anywhere in
Drive, matches video files against TMDb, renames them — including any
paired subtitle — to `Title (Year) [tmdbid-ID] [tag1] [tag2]...` (the
Jellyfin-recognized TMDb provider-id format), and sorts the
result into a **Done** folder (also anywhere in Drive) or a `RenamerReview`
folder it auto-creates inside Open.

`[tag1] [tag2]...` is filtered to a standard whitelist (resolution, source,
codec, audio, language, and visual/edition tags only) — file size,
release-group/site noise, soft-subtitle markers, and anything else not on
that list is dropped from the renamed name.

Runs entirely on Google's infrastructure — nothing installed on any
server, no RAM/CPU cost anywhere but Google's.

**Changed 2026-11-01 — Open and Done are now two independent folders, and
you get Start/Stop + an optional Settings Sheet.** See "Folder structure",
"Start/Stop", and "Settings Sheet" below. If you're upgrading from the
older single-`RENAMER_FOLDER_ID` setup, see **Migrating from the old single
folder** near the bottom — nothing has to physically move.

**Changed 2026-11-10 — duplicates now show file sizes and get Keep
OLD/Keep NEW buttons (movies AND TV), and Undo cleans up empty folders it
leaves behind.** A Done-folder collision — at scan time, or discovered
after you tap a multi-candidate button — no longer just sits there as a
dead-end text message; it offers a resolution. See "Folder structure",
"Resolving a RenamerReview item", and "TV Shows" below.

## Folder structure

Pick (or create) **two separate folders anywhere in Drive** — they don't
need to be near each other, share a parent, or be named anything in
particular:

- **Open** — where you drop files to be renamed. The script watches only
  this one.
- **Done** — where successfully renamed `Title (Year)/` folders land.

A third folder, `RenamerReview`, is auto-created **inside your Open
folder** the first time it's needed — not as a separate property, so it
automatically comes along if you ever repoint the Open folder somewhere
else:

```
<your Open folder>/
  RenamerReview/        <- ambiguous files land here, original names untouched
    Empty/              <- folders that turned out to have no video/subtitle
    Already Exist/      <- the file you chose NOT to keep, from a duplicate decision
  <your other files, untouched>

<your Done folder>/
  "Title (Year)/"  <- the finished, renamed files
```

Only video files, and subtitle files that pair with a video file present in
the same run, are ever touched. Anything else sitting in Open (nfo files,
samples, stray images, partial downloads) is left exactly as is.

**Subfolders inside Open are scanned too, any depth** — useful if
AllDebrid/rclone drops each release into its own folder instead of flat
files. But a folder's fate is handled differently from a loose file's:

- **A successful match always extracts just that one video** (+ its own
  paired subtitle) individually into Done, exactly like a top-level file —
  folder or not, a success is pulled out on its own.
- **A folder containing a video that couldn't be confidently matched**
  (TV episode, no/ambiguous match, duplicate, or a failed rename/move)
  gets the **whole folder** moved into `RenamerReview` — not just that one
  file — carrying along whatever's left inside it.
- **A folder with no video or subtitle inside it at all** moves whole into
  `RenamerReview/Empty` for cleanup, with a short Telegram note.
- A **top-level, loose file** (sitting directly in Open, no folder) keeps
  the exact original per-file behavior: a problem moves just that file
  (+ its paired subtitle) into `RenamerReview` directly.
- A folder hit by a genuine **TMDb API failure** (outage, rate limit) is
  left completely alone for that run — retried fresh next run.

To fix a review item that came back as a whole folder: fix the filename(s)
inside the moved folder (in `RenamerReview`, inside your Open folder), then
drag the whole folder back into Open to retry.

A **movie** file goes to `RenamerReview` instead of Done, with a Telegram
message explaining why, when:
- the title can't be pinned to one confident TMDb match, even after also
  trying it with a leading "A"/"An"/"The" added or removed
- it WAS matched confidently, but a `Title (Year)` folder for that movie
  already exists in Done — the Telegram message lists the existing file(s)
  with their size next to the incoming file's size, and gives you
  **📦 Keep OLD (existing)** / **🆕 Keep NEW (incoming)** buttons instead of
  guessing for you. Whichever one you *don't* keep goes to
  `RenamerReview/Already Exist`, not deleted. This needs the tap-to-resolve
  webhook from step 8 below to be set up; see that step.
- there's **no year in the filename**, and TMDb has a plausible, confident
  match on *both* sides — a real movie AND a real TV series with that
  title. Rather than silently guessing movie, it's flagged ambiguous;
  add a season/episode marker (`S01E05`) and resubmit if it's really an
  episode.

A file that looks like a **TV episode** (`S01E02`, `1x05`, "Season 2",
"Episode 4") is matched and filed separately — see **TV Shows** below — and
only lands in `RenamerReview` when it genuinely needs a manual look (no
precise episode number found, no confident series match, a Season 00
special, or a duplicate — which gets the same Keep OLD/Keep NEW buttons as
a movie duplicate).

A subtitle with no matching video in a given run, sitting loose at the top
level of Open, is left untouched there (not moved), but you get a one-time
Telegram notice about it.

## 1. Create the script

1. Go to script.google.com → **New project**.
2. Rename the project (top left) to something like `Drive Renamer`.
3. Delete the placeholder `Code.gs` content and paste in the full contents
   of `Code.gs` (sent alongside this file).

## 2. Get a TMDb API key

1. themoviedb.org → create a free account → Settings → API → request a key
   (type: **Developer**). You want the plain **API Key (v3 auth)**.
2. Takes a few minutes, no approval wait for personal use.

## 3. Get your Telegram bot token + chat ID

1. Message **@BotFather** on Telegram → `/newbot` → follow the prompts →
   copy the token it gives you (looks like `123456789:AAH...`).
2. Message your new bot anything (e.g. "hi") so it has a chat with you.
3. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser
   and find `"chat":{"id":123456789,...}` in the response — that number is
   your `TELEGRAM_CHAT_ID`.

## 4. Get your Open and Done folder IDs

1. Open your chosen **Open** folder in Drive, in a browser. The URL looks
   like `drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp...` — the part
   after `/folders/` is the folder ID. This is `RENAMER_OPEN_FOLDER_ID`.
2. Do the same for your chosen **Done** folder → `RENAMER_DONE_FOLDER_ID`.
   It can be any folder, anywhere — it does not need to be related to the
   Open folder in any way.
3. **If you also want TV episodes handled** (see **TV Shows** below), pick
   a third, separate folder for finished TV episodes → its ID is
   `RENAMER_TV_DONE_FOLDER_ID`. Keep it separate from your movies Done
   folder — Jellyfin wants Movies and TV Shows as two different libraries
   anyway. Skip this if you only ever process movies.

## 5. Set Script Properties

In the Apps Script editor: **Project Settings** (gear icon, left sidebar) →
scroll to **Script Properties** → **Add script property**, one at a time:

| Property | Value |
|---|---|
| `RENAMER_OPEN_FOLDER_ID` | folder ID from step 4 |
| `RENAMER_DONE_FOLDER_ID` | folder ID from step 4 |
| `RENAMER_TV_DONE_FOLDER_ID` | folder ID from step 4 (optional — only if you want TV episodes handled) |
| `TMDB_API_KEY` | key from step 2 |
| `TELEGRAM_BOT_TOKEN` | token from step 3 |
| `TELEGRAM_CHAT_ID` | chat ID from step 3 |
| `DRY_RUN` | `true` |

`SCHEDULER_PAUSED` doesn't need to be set here — it defaults to "running"
when unset, and from here on you manage it with Start/Stop (below) or the
Settings Sheet, not by hand.

Don't use the `setupPropertiesTemplate()` function in the code for real
values — that's a convenience stub only; type real secrets directly into
Project Settings so they never end up pasted anywhere else.

## 6. Authorize and test

1. Function dropdown (top toolbar) → select `testTelegram` → **Run**. First
   run asks you to authorize — approve it (it'll warn "Google hasn't
   verified this app," expected for a personal script → Advanced → go to
   project anyway).
2. Check Telegram — you should get the test message.
3. Drop a couple of real video files (and a subtitle or two) into your Open
   folder.
4. Select `processRenamerFolder` → **Run**. Check **Executions** (clock
   icon, left sidebar) or **View → Logs** for what it *would* have done.
   `DRY_RUN` is still `true`, so nothing in Drive moves yet — no Telegram
   messages are sent in dry run either, only log lines.
5. Check the log for correct title/year parsing and subtitle pairing before
   trusting it on your real backlog.

## 7. Go live

1. Once the dry-run log looks right, set `DRY_RUN` to `false` in Script
   Properties.
2. Select `installTrigger` from the dropdown → **Run** once. This schedules
   `scheduledRenamerRun_` (a thin wrapper around `processRenamerFolder`
   that respects Start/Stop, see below) to run automatically every 15
   minutes from then on. **This step is manual and one-time — it is not
   automatic just because you deployed the script.** Check it worked via
   the **Triggers** page (clock icon, left sidebar): you should see a
   `scheduledRenamerRun_` row with Type = Time-driven, Every 15 minutes.
3. **Large existing backlog?** Each run only gets ~5 minutes (`MAX_RUN_MS`)
   before it stops and picks up where it left off next run. For hundreds of
   folders, expect it to take several trigger cycles (or several manual
   Run clicks back-to-back, which is faster than waiting on the 15-min
   trigger) to work through them all.
4. Drop files into your Open folder — they either land organized in Done
   with a Telegram success message, or land untouched-but-moved in
   `RenamerReview` (inside Open) with a Telegram message naming the file
   and the TMDb candidates.

## Start / Stop

**⚠️ One-time requirement: re-run `installTrigger` once if your trigger was
installed before this feature existed (i.e. you went through "7. Go live"
before reading this section).** Start/Stop works by gating a function
called `scheduledRenamerRun_`, not `processRenamerFolder` directly —
`processRenamerFolder` is deliberately the "always works manually, ignores
Stop" entry point. If your 15-min trigger is still pointed at the old
`processRenamerFolder` name from before, Stop will correctly send the
Telegram message and correctly set the flag, but **nothing on your actual
schedule is reading that flag**, so the automatic runs won't actually
pause. Re-running `installTrigger` fixes this (it cleans up either name
before creating a fresh trigger, so it's safe to run even if unsure). To
check which one you currently have: **Triggers** page (clock icon) →
look at the function name in the row — it should say `scheduledRenamerRun_`,
not `processRenamerFolder`.

Two functions, run the same way as any other manual function (function
dropdown → select → **Run**):

- **`stopAutoRenamer`** — pauses the automatic 15-minute scan AND Telegram
  button-tap resolution (tapping a candidate button on a pending review
  message). `processRenamerFolder` run manually is **never** affected —
  it always works, stopped or not. If a run (scheduled, manual, or a
  button-tap resolution) happens to be in progress at the exact moment you
  click Run, `stopAutoRenamer` refuses outright (throws an error you'll see
  in the execution log) rather than letting the pause take effect
  mid-run — just click Run again once it's done.
- **`startAutoRenamer`** — resumes both.

Each sends a Telegram message the moment it takes effect ("stopping" /
"started"), so you have a record even if you're not watching the Apps
Script editor.

Internally both just flip the `SCHEDULER_PAUSED` Script Property — you can
also set it directly in Project Settings (`true`/`false`), but prefer the
two functions (or the Settings Sheet below) since they're what carry the
in-progress guard and the Telegram notice.

## Settings Sheet (optional — recommended if someone non-technical needs to manage this)

Instead of the Apps Script editor's Project Settings page, you get a
proper little control-panel Sheet:

1. Function dropdown → select `setupSettingsSheet` → **Run**.
2. Check **Executions** → the log line gives you the Sheet's URL (it also
   opens as a new file in your Drive named "Renamer Settings" — look
   there if you don't want to dig through execution logs).
3. Open it. Top to bottom:
   - **🎬 Banner** — just a header.
   - **📊 STATUS** — two live, color-coded rows: **Scheduler** shows
     ▶ RUNNING (green) or ⏸ PAUSED (amber), and **Mode** shows
     🟢 LIVE (green) or 🧪 TEST/dry run (amber) — both update automatically,
     they're formulas, not something you edit directly.
   - **⚡ QUICK ACTIONS** — a dropdown cell. Pick **▶️ Run Now**,
     **⏸️ Stop Scheduler**, or **▶️ Start Scheduler** and it fires
     immediately, then the cell resets itself back to the placeholder —
     it behaves like a button, not a setting.
   - **📁 FOLDERS**, **🔑 API & TELEGRAM**, **⚙️ BEHAVIOR** — the actual
     properties, one row each, with the **Value** column editable.
     `DRY_RUN` and `SCHEDULER_PAUSED` are real checkboxes (amber when
     checked, green when unchecked); everything else is a text cell.
4. Edit any Value cell (or tick/untick a checkbox, or pick a Quick Action)
   and it's saved/run immediately — no Apps Script editor needed from here
   on.
5. The `SCHEDULER_PAUSED` checkbox (and the Stop/Start quick actions) run
   through the exact same logic as `stopAutoRenamer`/`startAutoRenamer` —
   same Telegram notice, same refusal (the checkbox unticks itself again
   and an in-sheet pop-up explains why) if a run happens to be in progress
   at that moment.

Re-run `setupSettingsSheet` any time to rebuild the sheet from whatever the
Script Properties currently are (e.g. if the sheet gets deleted, drifts out
of sync, or you want to pick up a design change after updating the code) —
it's safe to run again, it won't create a duplicate sheet or duplicate
triggers, and it fully rebuilds the layout/styling each time.

## Resolving a RenamerReview item

Fix the filename yourself (correct the year or the title spelling) and move
it from `RenamerReview` (inside your Open folder) back into Open directly.
It'll be picked up and re-evaluated on the next run.

**Exception:** two situations skip the drag-it-back-into-Open fix entirely
and give you Telegram buttons instead — covered in step 8 below:
- TMDb genuinely found 2+ different real movies with the same title/year
  (not a parsing mistake — just a title collision) → candidate-pick buttons
  plus a "None of these" button. **Movies only** — see **TV Shows** below
  for why TV ambiguous-match reviews stay text-only.
- The file (movie or TV episode) matched fine, but the Done folder already
  has it → **Keep OLD / Keep NEW** buttons, with both files' sizes shown.
  This one also fires *after* you tap a candidate-pick button, if the
  candidate you chose turns out to already exist in Done — you'll get a
  second message with Keep OLD/Keep NEW instead of an error.

Fixing/resubmitting the filename won't help either case since the parse was
already correct; the buttons are the fix.

## TV Shows (optional, added 2026-11-02)

A file that looks like a TV episode (`S01E02`, `1x05`, "Season N", "Episode
N") is matched against TMDb's **TV** catalog and filed into its own folder
tree — completely separate from movies:

```
<your TV Done folder>/
  Series Name (Year) [tmdbid-ID]/
    Season 01/
      Series Name S01E01 Episode Title [tag1] [tag2]....ext
      Series Name S01E02-E03 [tag1]....ext   <- multi-episode files kept as
                                                 one file, never split, and
                                                 the episode title is left
                                                 off (there isn't one single
                                                 title that fits a range)
```

**Setup:** set `RENAMER_TV_DONE_FOLDER_ID` (see steps 4–5 above). That's
it — no other setup needed; the same Open folder, same trigger, same
Telegram bot handle both movies and TV automatically.

**How matching differs from movies, on purpose:**
- Only the **series** is matched against TMDb (one search + one details
  call per unique series per run, not per episode file — a whole season
  dropped in together costs the same one API round trip). The season and
  episode numbers always come straight from the filename's `SxxEyy` (or
  legacy `NxNN`) marker, never from TMDb.
- A file that merely *looks* like TV (a bare "Season 2" or "Complete
  Series" dump, no precise `SxxEyy`) but carries no specific episode
  number is sent to `RenamerReview` rather than guessed at.
- **Season 00 (specials) always go to `RenamerReview` for a manual look,
  never auto-filed** — specials are named too inconsistently across
  releases (recaps, behind-the-scenes clips, OVAs) to trust blindly. File
  them in yourself once you've checked them.
- An existing series or season folder already in your TV Done folder is
  the **normal** case (more episodes of a show you're already collecting),
  not a duplicate flag. Only a file with the exact same final episode name
  already present in that season folder is a duplicate — and that **does**
  get the same Keep OLD/Keep NEW Telegram buttons a movie duplicate gets
  (file sizes included), not a plain text notice. Whichever one you don't
  keep goes to `RenamerReview/Already Exist`.
- Ambiguous series matches (TMDb genuinely returns 2+ real shows, or no
  confident match at all) stay **text-only** in `RenamerReview` — the
  candidate-*pick* buttons (step 8 below) are movie-only and don't apply to
  TV. This is a different button type from the Keep OLD/Keep NEW duplicate
  buttons above, which do apply to TV — "no buttons for TV" is **not**
  true across the board, only for this one ambiguous-candidate case.
- Same-titled series from different years (e.g. two unrelated shows both
  called "Mahabharat") are told apart using the year in the filename, when
  present, same idea as movie year-disambiguation.

If you process TV without ever setting `RENAMER_TV_DONE_FOLDER_ID`, nothing
breaks for your movies — the property is only read the moment a TV episode
is actually encountered. If that happens before you've set it, that one
file reports the missing property via Telegram and stays put in the Open
folder (same as any other per-file error) until you set it and it's picked
up on the next run.

## 8. (Optional) Enable tap-to-resolve buttons

Two different situations get Telegram buttons instead of a plain text
message, and both need this same one-time setup:
- **Multi-candidate reviews (movies only):** when TMDb turns up multiple
  real candidates for the same title and year (e.g. two unrelated movies
  both titled "Paradise" released in 2026), the message includes one
  button per candidate plus a "None of these" button, instead of just a
  text list.
- **Duplicate decisions (movies and TV):** when the file already exists in
  Done, the message includes **📦 Keep OLD (existing)** and **🆕 Keep NEW
  (incoming)** buttons, with both files' sizes shown.

Tapping a button — any time later, minutes or days — resolves it
immediately: files, renames, and moves whatever that choice implies.
Button-tap resolution is paused along with the scheduler by
`stopAutoRenamer` — see "Start / Stop" above.

This needs a one-time setup step, because Apps Script can't "listen" for a
button tap on its own — Telegram has to be told where to send it:

1. In the Apps Script editor: **Deploy** → **New deployment** → gear icon →
   type **Web app**.
2. Execute as: **Me**. Who has access: **Anyone**. Click **Deploy**, approve
   permissions if prompted.
3. Copy the Web app URL it gives you (looks like
   `https://script.google.com/macros/s/AKfycb.../exec`).
4. Open it directly in a browser — you should see `Renamer webhook is
   alive.`. If you don't, the deployment isn't set up right; fix that before
   continuing.
5. Register it with Telegram (replace both placeholders):
   ```
   curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=<YOUR_WEB_APP_URL>"
   ```
   A successful response looks like `{"ok":true,"result":true,"description":"Webhook was set"}`.
6. That's it — no new Script Property needed. Next time a multi-candidate
   review comes up, you'll see buttons instead of a plain list.

**Important — this is the single most common source of confusing bugs with
this script.** Saving or pasting updated code into the Apps Script editor
takes effect *immediately* for `processRenamerFolder` (manual runs and the
scheduled trigger) — but it does **not** touch the Web app at all. The Web
app that Telegram sends button taps to is frozen to whatever code was live
the last time you explicitly deployed it, and keeps serving that old
version — silently, with no warning — until you deploy again. This is why
"the scheduler renames things correctly but button taps create wrong
folders / use the old naming / don't do things I just fixed" almost always
means the Web app is stale, not that the new code doesn't work.

**Whenever you update `Code.gs` and you use buttons, push the update to the
Web app too:**
1. **Deploy** → **Manage deployments**.
2. Click the pencil (✏️) icon next to the existing deployment (not "New
   deployment" — that creates a second, different deployment with its own
   new URL, which would break the webhook Telegram already has).
3. Next to "Version," choose **New version**.
4. Click **Deploy**.

This keeps the exact same Web app URL, so you do **not** need to re-run
`setWebhook` — Telegram keeps working with no extra step. Only if you
deliberately use **Deploy → New deployment** (a genuinely new, separate
deployment) do you get a new URL, and only then do you need to re-run the
`setWebhook` curl command above with it.

## Migrating from the old single folder

If you set this up before 2026-11-01, you had one `RENAMER_FOLDER_ID`
pointing at a `Renamer` folder with `RenamerOpen`/`RenamerReview`/
`RenamerDone` subfolders inside it. Nothing needs to physically move:

1. Open your existing `RenamerOpen` subfolder itself in Drive, grab its own
   folder ID from the URL → set as `RENAMER_OPEN_FOLDER_ID`.
2. Do the same for your existing `RenamerDone` subfolder → set as
   `RENAMER_DONE_FOLDER_ID`.
3. Delete the old `RENAMER_FOLDER_ID` Script Property (optional — it's
   simply unused now, so leaving it there is harmless, just clutter).
4. A fresh `RenamerReview` subfolder will be auto-created inside your
   (now-repointed) Open folder the next time it's needed. **Anything
   already sitting in your *old* `RenamerReview` folder won't be found
   automatically** — if you still have unresolved items there, move them
   into the new Open folder yourself (or directly into the new
   `RenamerReview` once it's created) to get them picked up again.
5. Re-run `installTrigger` once — it now installs on `scheduledRenamerRun_`
   instead of `processRenamerFolder` directly; the old trigger (if still
   pointed at `processRenamerFolder`) is left alone and harmless, but you
   can delete it from the **Triggers** page if you want to tidy up.

## Notes / limits worth knowing

- **Subtitle pairing** matches on filename, not file content: a subtitle
  pairs with a video if its name (minus bracket tags and extension) either
  exactly matches the video's, or matches it plus a short trailing language
  code (`Movie.2020.en.srt`, `Movie.2020.English.srt`). A subtitle named
  completely differently from its video (e.g. a generic `subtitle.srt`)
  won't be recognized — rename it closer to the video's name first.
- **Confidence requires text similarity, not just a same-year hit.** TMDb's
  search is a fuzzy word match: searching "Dorothy" or "Paradise" happily
  returns every same-year title that merely contains that word. Every
  same-year result is scored against the parsed title with normalized
  token-overlap, and only scores of 0.65+ count as real candidates. If
  exactly one clears that bar, it auto-accepts. If 2+ clear it, that's a
  genuine collision (see the buttons feature). If none do, it's "no good
  match" — text-only, fix the filename and resubmit.
- **Message-before-action, always.** Every rename/move, and every
  Start/Stop toggle, sends its Telegram message FIRST, then performs the
  actual change. If a Drive operation then fails, you get a second,
  distinct "FAILED" message.
- **Duplicate detection is name-based, not content-based.** It checks
  whether `Title (Year)` (movies) or the exact final episode filename
  (TV) already exists in Done — not whether the actual file bytes are
  the same. The Keep OLD/Keep NEW buttons show you each file's size so
  you can judge for yourself (a much smaller or much larger file is a
  strong hint it's a different release, not a true duplicate), but the
  decision is still yours, not an automatic content check.
- **Series detection is pattern-based, not exhaustive.** It catches the
  common `S01E02` / `1x05` / "Season N" / "Episode N" patterns, and only
  `S01E02`/`1x05` carry a precise enough episode number to auto-file — a
  bare "Season N"/"Episode N"/"Complete Series" label goes to
  `RenamerReview` instead of being guessed at. See **TV Shows** above.
- **Timing/reliability built in:** a lock prevents two runs overlapping;
  the main loop checks elapsed time and stops cleanly before Apps Script's
  ~6-minute execution cap; Telegram sends are paced and retry once on
  failure; TMDb calls are paced and throw an error instead of silently
  returning "no results" on a genuine API outage — the file is left alone
  and retried automatically next run.
- **Undoing a rename cleans up empty folders it leaves behind.** If
  reverting a TV episode (or a movie) empties out its Season and/or
  Series folder in the Done library, those now-empty folders are swept
  into `RenamerReview/Empty` too, instead of sitting there empty under
  Done forever. The Undo's History-sheet note and Telegram message say
  which folder(s), if any, got swept.
- **Dropping more files in while a run is in progress is always safe.**
  Each run snapshots Open once at the start; files added mid-run are
  picked up cleanly by the next one.
- **Two source-filename styles are both supported, and they can mix** —
  `[bracket] [tag]` style and dash-separated releases with no brackets
  (`www.1TamilMV.solar - Baththa (2026) Tamil HDRip - 1080p - ...`), as
  well as a year sitting inside `[brackets]` instead of `(parens)`.
- **Standard-tags-only whitelist.** Every tag, bracket or dash-sourced, is
  checked against a fixed reference list (resolution, source, codec,
  audio, language, visual/edition) and only matching pieces survive —
  file size, release-group/site noise, and anything else not on the list
  is dropped.
- **Every button type (candidate-pick, Keep OLD/Keep NEW) is a pending
  choice stored in Script Properties**, not tied to a particular file ID
  in Drive, so it survives however long you wait to tap — and survives a
  second button flow being created in between (e.g. tapping a candidate
  that turns out to collide in Done, which replaces that pending entry
  with a fresh Keep OLD/Keep NEW one rather than losing it).
- **Pairing is scoped per-folder, not global.**
- **Folder name collisions in `RenamerReview` are not merged** — Drive
  allows two folders with identical names to coexist there; rename one if
  it bothers you, nothing breaks either way.
- **TMDb free tier**: no practical rate limit for personal-scale use.
- **Apps Script quotas** (consumer account): 6 min max execution per run,
  90 min/day total trigger runtime, 20,000 `UrlFetchApp` calls/day — all
  comfortably more than this needs unless you bulk-drop hundreds of files
  at once. For a big batch, run `processRenamerFolder` manually a few times
  rather than waiting on the 15-min trigger.
- **To stop the automation permanently** (not just pause it): Apps Script
  editor → **Triggers** (clock icon) → delete the `scheduledRenamerRun_`
  trigger. For a temporary pause you can resume later, prefer
  `stopAutoRenamer` / the Settings Sheet instead — deleting the trigger
  means re-running `installTrigger` to bring automation back, whereas
  Stop/Start is just a flag flip.
