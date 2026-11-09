/**
 * Renamer — Google Apps Script
 *
 * Folder layout — fully portable (added 2026-11-01): the Open and Done
 * folders are two INDEPENDENT Drive folders, picked by you via
 * RENAMER_OPEN_FOLDER_ID / RENAMER_DONE_FOLDER_ID — they don't need to
 * share a parent, or live anywhere near each other, or be named any
 * particular thing. Review is NOT its own property; it's always a
 * subfolder auto-created (if missing) INSIDE whichever folder is currently
 * the Open folder, so it travels with the Open folder if you ever repoint
 * RENAMER_OPEN_FOLDER_ID somewhere else:
 *   <your Open folder>/
 *     RenamerReview/  <- anything it can't confidently finish, original names kept
 *       Empty/        <- folders moved here had no video/subtitle in them at all
 *     <your other files, if any — left alone>
 *   <your Done folder>/
 *     "Title (Year)/" folders with the renamed video (+ subtitle)
 *
 * Only video files, and subtitle files that pair with a video file present in
 * the SAME run, are ever touched. Everything else in the Open folder is left
 * alone — not renamed, not moved, not logged as a problem.
 *
 * The Open folder is scanned RECURSIVELY — files inside subfolders (e.g. an
 * AllDebrid/rclone drop that kept each release in its own folder) are found
 * too, any depth. A successful match ALWAYS extracts just that video (+ its
 * own paired subtitle) individually into the Done folder, folder or not — but
 * an unresolved video's FOLDER (not just the file) is what moves:
 *   - a folder with no video/subtitle in it at all (from the start, or
 *     because everything inside it was successfully extracted) moves
 *     whole into RenamerReview/Empty
 *   - a folder containing a video that couldn't be confidently matched
 *     (TV episode, no/ambiguous match, duplicate, or a failed rename/move)
 *     moves whole into RenamerReview, carrying whatever's left inside it
 *     (the problem video, any of its subtitles, any genuinely unpaired
 *     subtitle) — fix things inside the moved folder, then drag the whole
 *     folder back into the Open folder to retry
 *   - a folder hit by a genuine TMDb API failure (see TIMING below) is left
 *     completely alone for that run — never moved on the strength of an
 *     outage, tried again fresh next run
 * A top-level, loose file (sitting directly in the Open folder, no folder)
 * keeps the original per-file behavior: a problem moves just that file
 * (+ its paired subtitle) into RenamerReview directly, no folder involved.
 *
 * MESSAGE-THEN-ACT ORDERING (deliberate): for every rename/move, the Telegram
 * message describing the intended action is sent FIRST, then the Drive
 * operation is attempted. If the Drive operation then fails, a SEPARATE
 * follow-up Telegram message reports the failure. This means you always know
 * what the script was about to do even if the move itself errors out
 * partway — nothing silently fails with no trace.
 *
 * A file lands in RenamerReview, with a Telegram message explaining why, when:
 *   - the filename looks like a TV episode (out of scope — movies only)
 *   - the title can't be pinned to a single confident TMDb match — checked
 *     with/without a leading "A"/"An"/"The", AND against a token-overlap
 *     similarity score (see SIMILARITY_THRESHOLD) so a same-year "unique"
 *     hit whose title doesn't actually resemble the parsed title is no
 *     longer auto-trusted
 *   - it WAS matched confidently, but a "Title (Year)" folder for that movie
 *     already exists in the Done folder (possible duplicate/second rip)
 * A subtitle with no matching video in a given run is left in the Open folder
 * untouched, but triggers a one-time Telegram heads-up.
 *
 * MULTI-CANDIDATE REVIEW (buttons): when TMDb genuinely returns 2+ distinct
 * same-year movies for a title (e.g. two unrelated films both called
 * "Paradise" the same year) — as opposed to one weak/low-similarity match,
 * which stays text-only/manual on purpose — the Telegram message includes a
 * tap-to-resolve button per candidate plus a "None of these" button. Tapping
 * one (any time later — minutes or days) renames and files it immediately,
 * via a Telegram webhook (doPost). This needs a one-time deployment step
 * (deploy as Web App, register the URL with Telegram) — see SETUP.md.
 *
 * TIMING / RELIABILITY (Apps Script-specific):
 *   - LockService prevents two overlapping runs (e.g. a slow run still going
 *     when the next 15-min trigger fires, or a button tap landing mid-run)
 *     from touching files concurrently.
 *   - The main loop checks elapsed time and stops early, cleanly, before
 *     Apps Script's ~6-minute hard execution limit — any files not reached
 *     are simply picked up on the next run, nothing is left half-done.
 *   - Dropping more files into the Open folder while a run is already in
 *     progress is always safe: that run already took its snapshot of what
 *     to process, so new files are simply invisible to it and get picked up
 *     cleanly by the next run (trigger or manual) — no race, no double work.
 *   - Telegram sends are paced with a short sleep (and get one retry on a
 *     non-200 response) to avoid flood-control throttling and reduce the
 *     chance of silently losing a notification on a run that sends several.
 *   - TMDb calls are also paced (TMDB_PACING_MS), and now THROW rather than
 *     silently return "no results" after exhausting a retry — an API outage
 *     is not the same fact as "TMDb genuinely has no match," so it's treated
 *     as an error: the file is left untouched in the Open folder and naturally
 *     retried on the next run, rather than being wrongly shipped off to
 *     RenamerReview as an unmatched movie.
 *
 * Output name: {Title} ({Year}) [tmdbid-ID] [tag1] [tag2] ... .ext
 *
 * START/STOP (added 2026-11-01): the periodic auto-run AND Telegram
 * button-tap resolution are both gated by the SCHEDULER_PAUSED Script
 * Property. processRenamerFolder() itself never checks it — running it
 * manually from the editor always works, paused or not. The installed
 * time-based trigger instead points at scheduledRenamerRun_(), a thin
 * wrapper that checks the flag first. Flip it with the stopAutoRenamer()
 * / startAutoRenamer() functions (or the Settings Sheet, see below) rather
 * than editing the property directly — those two functions also guard
 * against stopping mid-run and send a Telegram notice before the change
 * takes effect, same MESSAGE-THEN-ACT convention as everything else here.
 *
 * SETTINGS SHEET (added 2026-11-01, optional but recommended for
 * non-technical editing): run setupSettingsSheet() once to build a styled
 * "control panel" Google Sheet — a banner, a color-coded live STATUS
 * dashboard (Scheduler: RUNNING/green or PAUSED/amber; Mode: LIVE/green or
 * TEST/amber, both driven by formulas off the real checkboxes below), a
 * QUICK ACTIONS dropdown that behaves like a momentary button (Run Now /
 * Stop / Start — picking one fires immediately and the cell resets
 * itself), and the properties themselves grouped into sections with real
 * Sheets checkboxes for DRY_RUN/SCHEDULER_PAUSED. No Apps Script editor
 * needed for day-to-day changes. Field identity is tracked with named
 * ranges (one per property, named after the property key, plus
 * RENAMER_ACTION_CELL for the dropdown) rather than row position, so the
 * onEdit handler can't mistake a decorative row for an editable one.
 * Checking the SCHEDULER_PAUSED box gets the exact same in-progress guard
 * and Telegram notice as calling stopAutoRenamer() directly; a stop
 * attempted while a run is in progress unchecks the box again and shows an
 * in-sheet toast instead. Re-run setupSettingsSheet() any time to rebuild
 * the sheet from current Script Property values (e.g. after recreating
 * it, or to pick up a design change).
 *
 * TV SHOWS (added 2026-11-02): a file matching a TV episode pattern (see
 * SERIES_PATTERNS / detectSeriesPattern_) is no longer automatically
 * rejected to RenamerReview as "out of scope" — it's matched against
 * TMDb's TV catalog and filed into its OWN folder tree, completely
 * separate from the movies Done folder:
 *   <your TV Done folder>/
 *     Series Name (Year) [tmdbid-ID]/
 *       Season 01/
 *         Series Name (Year) S01E01 Episode Title [tag1] [tag2] ... .ext
 *         Series Name (Year) S01E02-E03 Episode Title [tag1] ... .ext
 *                                                   <- multi-episode files
 *                                                      kept as one file,
 *                                                      never split; episode
 *                                                      title is the FIRST
 *                                                      episode's only
 * Episode title (added 2026-11-03) comes from one extra, lightweight TMDb
 * details call per episode file — NOT per series, so this does add real
 * API calls on a large multi-episode batch (a 20-episode season costs 1
 * series call + 20 episode-title calls, not just 1) — a deliberate
 * tradeoff against the "fewer API calls" choice made when TV support was
 * first scoped. If a given episode's title can't be fetched for any reason
 * (not yet aired, a TMDb data gap, a transient error), the file is still
 * renamed and filed correctly — it just has no title segment that one time.
 * Differences from the movie path, deliberately:
 *   - Only the SERIES is matched against TMDb (one search + one details
 *     call, cached per run so a 20-episode season costs ONE API round
 *     trip, not twenty) — season/episode numbers come straight from the
 *     filename's "SxxEyy" (or legacy "NxNN") marker, never from TMDb.
 *   - A file that merely LOOKS like TV (a bare "Season 2" or "Complete
 *     Series" dump, no SxxEyy) but has no precise episode number is sent
 *     to RenamerReview rather than guessed at — same "don't guess"
 *     principle as an unparseable movie title.
 *   - Season 00 (specials) are ALWAYS sent to RenamerReview for a manual
 *     look, never auto-filed — specials are named too inconsistently
 *     across releases (recaps, behind-the-scenes, OVAs) to trust blindly.
 *   - An existing SERIES or SEASON folder in the TV Done folder is the
 *       NORMAL case (more episodes of a show already underway), not a
 *       duplicate flag. Only an existing file with the exact same final
 *       episode name is treated as a possible duplicate.
 *   - Ambiguous series matches (2+ TMDb hits, or no confident match) stay
 *     text-only in RenamerReview — the Telegram tap-to-resolve BUTTON flow
 *     is movie-specific and intentionally not extended to TV here.
 *   - RENAMER_TV_DONE_FOLDER_ID is read lazily, only when a TV episode is
 *     actually encountered — a movie-only setup that never sets it is
 *     completely unaffected; if a TV file does show up without it set,
 *     that one file reports the missing property via Telegram and stays
 *     untouched in the Open folder (same as any other per-file error).
 *
 * SETUP: see SETUP.md. Required Script Properties (Project Settings -> gear
 * icon -> Script Properties, or the Settings Sheet above):
 *   RENAMER_OPEN_FOLDER_ID  - Drive folder ID to watch (any folder, anywhere)
 *   RENAMER_DONE_FOLDER_ID  - Drive folder ID for finished movie renames (any folder)
 *   RENAMER_TV_DONE_FOLDER_ID - Drive folder ID for finished TV renames (any
 *                             folder; only needed if you process TV episodes)
 *   TMDB_API_KEY            - TMDb v3 API key
 *   TELEGRAM_BOT_TOKEN      - from @BotFather
 *   TELEGRAM_CHAT_ID        - your chat id
 *   DRY_RUN                 - "true" while testing, "false" to go live
 *   SCHEDULER_PAUSED         - set automatically by start/stop; "false"/unset = running
 */

var REVIEW_SUBFOLDER = 'RenamerReview';

// Every Script Property the Settings Sheet manages, grouped into sections
// for display. Not an exhaustive list of every property the script reads
// (e.g. SETTINGS_SHEET_ID is internal bookkeeping and deliberately left
// off this sheet) — just the ones a person, technical or not, should be
// able to see and edit. type:'checkbox' fields get an actual Sheets
// checkbox (true/false) instead of a free-text cell.
var SETTINGS_FIELDS_ = [
  { key: 'RENAMER_OPEN_FOLDER_ID', label: 'Movie TVShow Renamer Folder ID', section: 'FOLDERS', type: 'text', note: 'Drive folder ID to watch for new files (any folder, anywhere in Drive). Open the folder in a browser; the ID is the part of the URL after /folders/.' },
  { key: 'RENAMER_DONE_FOLDER_ID', label: 'Renamed Movie Folder ID', section: 'FOLDERS', type: 'text', note: 'Drive folder ID where successfully renamed movies are filed (any folder, independent of the Open folder above).' },
  { key: 'RENAMER_TV_DONE_FOLDER_ID', label: 'Renamed TVShow Folder ID', section: 'FOLDERS', type: 'text', note: 'Drive folder ID where successfully renamed TV episodes are filed (separate from the movies Done folder above, since Jellyfin wants Movies and TV Shows as separate libraries). Only needed if you process TV episodes — leave blank for movies-only use.' },
  { key: 'TMDB_API_KEY', section: 'API', type: 'text', note: 'TMDb v3 API key.' },
  { key: 'TELEGRAM_BOT_TOKEN', section: 'API', type: 'text', note: 'Telegram bot token from @BotFather.' },
  { key: 'TELEGRAM_CHAT_ID', section: 'API', type: 'text', note: 'Your Telegram chat ID.' },
  { key: 'DRY_RUN', section: 'BEHAVIOR', type: 'checkbox', note: 'Checked = log only, nothing moves, no Telegram messages. Unchecked = live.' },
  { key: 'SCHEDULER_PAUSED', section: 'BEHAVIOR', type: 'checkbox', note: 'Checked = automatic 15-min runs AND Telegram button-tap resolution are both paused (processRenamerFolder still works manually). Unchecked = running normally. Checking this box runs the same checks as stopAutoRenamer() — refused, and the box unchecks itself again, if a run is currently in progress.' }
];
var SETTINGS_SECTION_LABELS_ = { FOLDERS: '📁  FOLDERS', API: '🔑  API & TELEGRAM', BEHAVIOR: '⚙️  BEHAVIOR' };

// Quick Actions dropdown (see setupSettingsSheet()) — one momentary
// "button" cell: picking an action runs it immediately via
// onSettingsSheetEdit_ and the cell resets itself back to the placeholder
// right after, so it behaves like a button tap rather than a persistent
// setting.
var ACTION_PLACEHOLDER_ = '— choose an action —';
var ACTION_RUN_NOW_ = '▶️ Run Now';
var ACTION_STOP_ = '⏸️ Stop Scheduler';
var ACTION_START_ = '▶️ Start Scheduler';

var VIDEO_EXTENSIONS = ['mkv', 'mp4', 'avi', 'mov', 'wmv', 'm4v', 'ts', 'webm'];
var SUBTITLE_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt'];

// A subtitle that matches a video by name but is at/under this size is
// treated as suspect (empty, truncated, or a placeholder file) rather than
// a real subtitle - requested 2026-10-28. It is NOT renamed/filed with its
// video; it's routed to RenamerReview instead so it gets a human look.
var MIN_SUBTITLE_BYTES = 1024; // 1 KB

var SERIES_PATTERNS = [
  // Fixed 2026-11-03: was /S\d{1,2}E\d{1,3}/ - required "S01E08" packed
  // tight with no space and no "P". Release names like 1TamilMV's
  // "S01 EP 08" (space before E, "EP" not "E", space before the episode
  // number) didn't match, so detectSeriesPattern_ returned null and the
  // file silently fell through to the MOVIE matcher instead of the TV
  // one - it then searched TMDb's movie DB for the bare title and could
  // only ever find an unrelated movie, never the real TV show (which may
  // well have been TMDb's #1 TV result the whole time - the code just
  // never looked there). \s*EP?\s* is a strict superset of the old "E"-
  // only, no-space form, so every filename that matched before still
  // matches exactly the same way.
  // Extended 2026-11-03: also allow a space right after "S" ("S 01 E 01"),
  // on top of the space-before-E/EP fix above - still a strict superset.
  { re: /S\s*\d{1,2}\s*EP?\s*\d{1,3}/i, label: '"SxxEyy" episode pattern' },
  { re: /\b\d{1,2}x\d{1,3}\b/, label: '"NxNN" episode pattern' },
  { re: /\bSeason\s?\d{1,2}\b/i, label: '"Season N"' },
  { re: /\bEpisode\s?\d{1,3}\b/i, label: '"Episode N"' },
  { re: /\bComplete\s+Series\b/i, label: '"Complete Series"' }
];

var SIMILARITY_THRESHOLD = 0.65; // normalized token-overlap (Jaccard), 0-1
var MAX_RUN_MS = 5 * 60 * 1000;  // stop starting new files after this long (leaves buffer under the 6-min cap)
var TELEGRAM_PACING_MS = 1000;   // delay after each real Telegram send
var TMDB_PACING_MS = 300;        // delay after every TMDb call (~3/sec, under TMDb's short-burst limit)

var g_runStartedAt = 0;

// Per-run cache of TV series lookups, keyed by normalizeTitle_(seriesTitle)
// — reset at the top of every processRenamerFolder() call (see there).
// Means a season's worth of episodes dropped in together costs exactly ONE
// TMDb search + one TMDb details call for the whole run, not one pair per
// episode file.
var g_tvSeriesCache = {};

// Per-run cache of individual episode titles, keyed "<seriesId>_S<season>E<ep>"
// — separate from g_tvSeriesCache above (which caches the SERIES match
// itself, not per-episode data). Reset alongside it at the top of every
// processRenamerFolder() run.
var g_tvEpisodeNameCache = {};

// ---------- folder resolution (RENAMER_OPEN_FOLDER_ID / RENAMER_DONE_FOLDER_ID) ----------
//
// Open and Done are two independent, user-chosen Drive folders — neither is
// "auto-created" the way it used to be under a shared RENAMER_FOLDER_ID
// root; they're resolved directly by ID and must already exist (any folder
// you point these two properties at works, named whatever you like).
// Review is the one thing still auto-created, but now always as a
// subfolder INSIDE the current Open folder rather than a sibling of it —
// so it moves automatically if you ever repoint RENAMER_OPEN_FOLDER_ID
// somewhere else, and "move the file along with whatever's already in
// Review" is just Drive's ordinary moveTo() behavior into an existing
// folder — it merges with existing contents, nothing is overwritten or
// deleted.
function getOpenFolder_() {
  return DriveApp.getFolderById(requireProp_('RENAMER_OPEN_FOLDER_ID'));
}
function getDoneFolder_() {
  return DriveApp.getFolderById(requireProp_('RENAMER_DONE_FOLDER_ID'));
}
function getReviewFolder_(openFolder) {
  return getOrCreateFolder_(openFolder, REVIEW_SUBFOLDER);
}
// Deliberately NOT called eagerly alongside getOpenFolder_/getDoneFolder_ at
// the top of processRenamerFolder() — see the TV SHOWS header comment.
// Called lazily, only from inside processTvEpisode_, exactly when a TV
// episode is actually about to be filed, so a movies-only setup that never
// configured this property is completely unaffected.
function getTvDoneFolder_() {
  return DriveApp.getFolderById(requireProp_('RENAMER_TV_DONE_FOLDER_ID'));
}

// ---------- entry points ----------
//
// processRenamerFolder() is the manual entry point — select it from the
// function dropdown and click Run any time, regardless of SCHEDULER_PAUSED.
// It never checks that flag itself; pausing only ever stops the AUTOMATIC
// path. scheduledRenamerRun_() is what the installed time-based trigger
// actually points at — it's the one and only place that flag is checked
// before a scan runs, which is what lets "manual always works, scheduled
// respects Stop" coexist using the exact same underlying function.
function scheduledRenamerRun_() {
  if (getProp_('SCHEDULER_PAUSED') === 'true') {
    Logger.log('Scheduler is paused (SCHEDULER_PAUSED=true) — skipping this automatic run. Run processRenamerFolder manually any time, or startAutoRenamer() to resume automatic runs.');
    return;
  }
  processRenamerFolder();
}

function processRenamerFolder() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Another run is already in progress — skipping this run.');
    return;
  }

  try {
    g_runStartedAt = Date.now();
    g_tvSeriesCache = {};
    g_tvEpisodeNameCache = {};

    var openFolder = getOpenFolder_();
    var doneFolder = getDoneFolder_();
    var reviewFolder = getReviewFolder_(openFolder);
    var dryRun = getProp_('DRY_RUN') === 'true';

    // ---- 1) loose, top-level files — a single, cheap, non-recursive
    // listing of the Open folder's direct children only (no subfolder walk).
    var topVideos = [];
    var topSubtitles = [];
    var topFilesIter = openFolder.getFiles();
    while (topFilesIter.hasNext()) {
      var tf = topFilesIter.next();
      var tfName = tf.getName();
      var tfExt = getExtension_(tfName);
      var tfEntry = { type: null, file: tf, name: tfName, ext: tfExt, core: coreName_(tfName), parentFolder: openFolder, topLevel: true };
      if (VIDEO_EXTENSIONS.indexOf(tfExt) !== -1) { tfEntry.type = 'video'; topVideos.push(tfEntry); }
      else if (SUBTITLE_EXTENSIONS.indexOf(tfExt) !== -1) { tfEntry.type = 'subtitle'; topSubtitles.push(tfEntry); }
    }
    var usedTopSubtitleIds = {};

    Logger.log('Open folder top-level scan: ' + topVideos.length + ' video file(s), '
      + topSubtitles.length + ' subtitle file(s)' + (dryRun ? ' (DRY RUN)' : ''));

    var stoppedEarly = false;
    for (var i = 0; i < topVideos.length; i++) {
      if (timeRunningOut_()) {
        Logger.log('Approaching the execution time limit — stopping early. '
          + (topVideos.length - i) + ' top-level file(s) left for the next run.');
        stoppedEarly = true;
        break;
      }
      var video = topVideos[i];
      try {
        var pairResult = findPairedSubtitles_(video, topSubtitles, usedTopSubtitleIds);
        pairResult.matched.forEach(function (s) { usedTopSubtitleIds[s.file.getId()] = true; });
        pairResult.undersized.forEach(function (s) { usedTopSubtitleIds[s.file.getId()] = true; });
        processVideo_(video, pairResult.matched, reviewFolder, doneFolder, dryRun);
        moveUndersizedSubtitlesToReview_(pairResult.undersized, reviewFolder, dryRun);
      } catch (e) {
        sendTelegram_('⚠️ Renamer error on "' + video.name + '": ' + e.message, dryRun);
        Logger.log('Error on ' + video.name + ': ' + e.message + '\n' + e.stack);
      }
    }

    // ---- 2) subfolders — walked and processed ONE TOP-LEVEL SUBFOLDER AT
    // A TIME, interleaved with the time check, instead of recursively
    // scanning the ENTIRE tree up front before processing anything.
    //
    // Fixed 2026-10-27, found on a real 363-subfolder backlog: the old
    // design called listMediaEntries_/collectMediaEntries_ once, on
    // openFolder, to recursively walk every subfolder at every depth into
    // one big in-memory list, THEN started processing. With 363 real
    // subfolders that upfront walk alone (each subfolder costs at least a
    // getFiles() + a getFolders() Drive API round-trip) ate the ENTIRE
    // MAX_RUN_MS budget by itself — confirmed from a real run's own log:
    // the scan-complete line and the "stopping early, 363 left" line were
    // 13 seconds apart, meaning literally zero folders got processed in a
    // 5min43s run. Worse, nothing had moved yet, so the next run re-walked
    // the same 363 folders from scratch and hit the same wall — permanent
    // zero progress, not slow progress, for as long as the backlog stayed
    // that large.
    //
    // Fix: only the cheap, non-recursive listing of the Open folder's direct
    // subfolder names happens up front (one getFolders() call). The
    // expensive recursive per-subfolder walk (collectMediaEntries_) now
    // happens one top-level subfolder at a time, immediately followed by
    // processing that subfolder's own group(s), with a time check before
    // starting each new top-level subfolder AND before each nested group
    // inside it. Whatever completes in a run is already moved out of
    // the Open folder for good, so every run — however much time it gets —
    // makes permanent, cumulative progress instead of restarting from zero.
    if (!stoppedEarly) {
      var topSubfolders = [];
      var topSubfoldersIter = openFolder.getFolders();
      while (topSubfoldersIter.hasNext()) topSubfolders.push(topSubfoldersIter.next());

      // Fixed 2026-11-01: RenamerReview now lives INSIDE the Open folder
      // (see the folder-resolution comment near getReviewFolder_ above),
      // so it shows up in this very listing — openFolder.getFolders()
      // can't tell "a release folder you dropped" apart from "the review
      // folder the script itself manages" by looking at getFolders()
      // alone. Left unfiltered, the scanner walked INTO RenamerReview as
      // if it were an ordinary release folder, decided it had no
      // video/subtitle sitting directly in it, and tried to move the
      // WHOLE RenamerReview folder into RenamerReview/Empty — a subfolder
      // of itself. Drive correctly rejects moving a folder into its own
      // descendant ("Invalid argument"), confirmed on a real run. Filtering
      // it out by ID (not by name, so a same-named unrelated user folder —
      // vanishingly unlikely, but cheap to get right — is never falsely
      // excluded) keeps the review folder itself off-limits to the scanner
      // entirely, exactly like it always was back when Review/Open were
      // separate sibling folders.
      var reviewFolderId = reviewFolder.getId();
      topSubfolders = topSubfolders.filter(function (f) { return f.getId() !== reviewFolderId; });

      var subfoldersStoppedEarly = false;
      var subfoldersCompleted = 0;
      for (var si = 0; si < topSubfolders.length; si++) {
        if (timeRunningOut_()) {
          Logger.log('Approaching the execution time limit — stopping before scanning "'
            + topSubfolders[si].getName() + '". ' + (topSubfolders.length - si)
            + ' top-level subfolder(s) (not yet scanned) left for the next run.');
          subfoldersStoppedEarly = true;
          break;
        }

        var topSub = topSubfolders[si];
        var groupStoppedEarly = false;
        // Wrapped 2026-11-02: everything from the recursive walk through
        // every group inside this one top-level subfolder used to run
        // completely unguarded. A single uncaught exception anywhere in
        // here (a transient Drive hiccup during collectMediaEntries_, or
        // anything processFolderGroup_ does outside its own already-guarded
        // per-video loop, like folderIsNowEmptyOfMedia_) would propagate all
        // the way out of this function and fail the ENTIRE execution —
        // exactly matching a real report: one folder processed fine, then
        // the run just stopped, leaving every remaining folder (which
        // hadn't even been looked at yet) untouched with no "stopping
        // early" log line, because that's what an uncaught throw mid-loop
        // looks like from the outside. Same principle as the per-video
        // try/catch above and inside processFolderGroup_: a problem with
        // ONE top-level subfolder must never stop the rest of the batch.
        try {
          var subEntries = [];
          var subFolders = [topSub]; // topSub itself must be Empty-sweep-eligible too
          collectMediaEntries_(topSub, subEntries, subFolders, false);

          var folderGroups = {};
          subFolders.forEach(function (f) {
            folderGroups[f.getId()] = { folder: f, videos: [], subtitles: [] };
          });
          subEntries.forEach(function (e) {
            var fid = e.parentFolder.getId();
            if (!folderGroups[fid]) folderGroups[fid] = { folder: e.parentFolder, videos: [], subtitles: [] };
            if (e.type === 'video') folderGroups[fid].videos.push(e);
            else folderGroups[fid].subtitles.push(e);
          });

          var folderIds = Object.keys(folderGroups);
          for (var fi = 0; fi < folderIds.length; fi++) {
            if (timeRunningOut_()) {
              Logger.log('Approaching the execution time limit — stopping mid-tree inside "'
                + topSub.getName() + '". ' + (folderIds.length - fi) + ' folder(s) left inside it for the next run.');
              subfoldersStoppedEarly = true;
              groupStoppedEarly = true;
              break;
            }
            processFolderGroup_(folderGroups[folderIds[fi]], reviewFolder, doneFolder, dryRun);
          }
        } catch (e) {
          sendTelegram_('⚠️ Renamer error while scanning top-level folder "' + topSub.getName() + '": ' + e.message
            + '\nThis folder is being left alone this run — will retry automatically next run. The rest of the batch continues normally.', dryRun);
          Logger.log('Error scanning top-level subfolder ' + topSub.getName() + ': ' + e.message + '\n' + e.stack);
          groupStoppedEarly = true; // don't count a crashed folder as "fully completed"
        }
        if (!groupStoppedEarly) subfoldersCompleted++;
        if (subfoldersStoppedEarly) break;
      }
      Logger.log('Subfolder pass: fully completed ' + subfoldersCompleted + ' of ' + topSubfolders.length
        + ' top-level subfolder(s) this run' + (subfoldersStoppedEarly ? ' (stopped early — remainder picked up next run).' : '.'));
    }

    // ---- 3) orphan subtitles — scoped to TOP-LEVEL loose subtitles only.
    // A folder-sourced subtitle that never pairs with a video simply stays
    // in its folder and rides along whenever that folder is moved to
    // RenamerReview (or RenamerReview/Empty if the folder has no video at
    // all) — no separate notice needed for those.
    handleOrphanSubtitles_(topSubtitles, usedTopSubtitleIds, dryRun);
  } finally {
    lock.releaseLock();
  }
}

// ---------- folder-group processing ----------

// One folder's worth of work: match/rename/move each video in it exactly
// like a top-level file would be (successes always extract individually
// into the Done folder, folder or not) — but anything that would normally move
// an individual file to RenamerReview instead just gets decided and left
// in place. Once every video's fate is known:
//   - any genuine TMDb API failure anywhere in the folder -> leave the
//     WHOLE folder untouched this run, no move at all (same principle as
//     the top-level path: an outage is never grounds for a decision).
//   - otherwise, any issue (TV/no-match/ambiguous/duplicate/failed-move),
//     OR any subtitle left unpaired -> move the whole folder to
//     RenamerReview.
//   - otherwise (everything matched, nothing left over) -> if the folder
//     is now empty of video/subtitle content, move it to
//     RenamerReview/Empty for cleanup. A folder that had zero video AND
//     zero subtitle to begin with takes this same path immediately.
function processFolderGroup_(group, reviewFolder, doneFolder, dryRun) {
  var folder = group.folder;
  var videos = group.videos;
  var subtitles = group.subtitles;

  if (videos.length === 0 && subtitles.length === 0) {
    moveFolderToEmpty_(folder, dryRun);
    return;
  }

  var usedSubtitleIds = {};
  var undersizedSubs = [];
  var anyIssue = false;
  var anyError = false;

  for (var i = 0; i < videos.length; i++) {
    var video = videos[i];
    try {
      var pairResult;
      if (videos.length === 1 && subtitles.length === 1) {
        // Unambiguous-FOLDER case, requested 2026-10-28, then narrowed the
        // same day: exactly one video and one subtitle in this folder, so
        // name-matching's usual job (disambiguating between candidates)
        // doesn't apply - but rather than pairing them completely
        // unconditionally, only the TITLE and YEAR have to line up
        // (release tags/quality info are deliberately ignored entirely).
        // Year must be present on both sides and equal, or this doesn't
        // fire at all. Title only needs ONE whole word in common (or the
        // title's words glued together with no separator) - see
        // titleWordsAppearIn_ for exactly what counts. The
        // MIN_SUBTITLE_BYTES size gate below still applies even when this
        // fires - a too-small lone subtitle still gets held back rather
        // than force-paired.
        var onlySub = subtitles[0];
        var videoParsedForCheck = parseFilename_(video.name);
        var subYearForCheck = extractYearFromName_(onlySub.name);
        var yearOk = !!(videoParsedForCheck.year && subYearForCheck && videoParsedForCheck.year === subYearForCheck);
        var titleOk = titleWordsAppearIn_(videoParsedForCheck.title, onlySub.name);

        if (yearOk && titleOk) {
          var forcedEntry = { file: onlySub.file, name: onlySub.name, ext: onlySub.ext, langSuffix: null };
          pairResult = (onlySub.file.getSize() > MIN_SUBTITLE_BYTES)
            ? { matched: [forcedEntry], undersized: [] }
            : { matched: [], undersized: [forcedEntry] };
        } else {
          // No year on one/both sides, years don't match, or the subtitle
          // shares nothing with the video's title at all - don't force
          // anything. Fall through to the normal name-matching check,
          // which is a STRICTER test than this one and will almost always
          // also fail here, correctly leaving the subtitle unpaired so the
          // folder goes to RenamerReview instead of guessing.
          pairResult = findPairedSubtitles_(video, subtitles, usedSubtitleIds);
        }
      } else {
        pairResult = findPairedSubtitles_(video, subtitles, usedSubtitleIds);
      }
      pairResult.matched.forEach(function (s) { usedSubtitleIds[s.file.getId()] = true; });
      // Mark undersized subs "used" too (not left for the leftoverSubs/
      // "unpaired" check below) - they DID match by name, they just failed
      // the size gate, so they get their own distinct message instead of
      // being lumped in with genuinely no-name-match subtitles.
      pairResult.undersized.forEach(function (s) { usedSubtitleIds[s.file.getId()] = true; });
      undersizedSubs = undersizedSubs.concat(pairResult.undersized);
      var outcome = processVideo_(video, pairResult.matched, reviewFolder, doneFolder, dryRun);
      if (outcome !== 'success') anyIssue = true;
    } catch (e) {
      anyError = true;
      sendTelegram_('⚠️ Renamer error on "' + video.name + '" (inside folder "' + folder.getName() + '"): ' + e.message
        + '\nThe whole folder is being left alone this run — will retry automatically next run.', dryRun);
      Logger.log('Error on ' + video.name + ' in folder ' + folder.getName() + ': ' + e.message + '\n' + e.stack);
    }
  }

  if (anyError) {
    Logger.log('Folder "' + folder.getName() + '" had a TMDb/API error on at least one file — leaving the whole folder untouched this run.');
    return;
  }

  if (undersizedSubs.length > 0) {
    anyIssue = true;
    if (!dryRun) {
      sendTelegram_('⚠️ Undersized subtitle(s) in folder "' + folder.getName() + '"\n'
        + undersizedSubs.map(function (s) { return s.name + ' (' + (s.file.getSize() / 1024).toFixed(1) + ' KB)'; }).join('\n')
        + '\nAt or under the ' + (MIN_SUBTITLE_BYTES / 1024) + ' KB minimum — likely empty, truncated, or a placeholder rather than a real subtitle. Staying with the folder when it moves to RenamerReview.', false);
    } else {
      Logger.log('[DRY RUN] Undersized subtitle(s) in folder "' + folder.getName() + '": '
        + undersizedSubs.map(function (s) { return s.name; }).join(', '));
    }
  }

  var leftoverSubs = subtitles.filter(function (s) { return !usedSubtitleIds[s.file.getId()]; });
  if (leftoverSubs.length > 0) {
    anyIssue = true;
    if (!dryRun) {
      sendTelegram_('⚠️ Unpaired subtitle(s) in folder "' + folder.getName() + '"\n'
        + leftoverSubs.map(function (s) { return s.name; }).join('\n')
        + '\nNo matching video for these inside this folder — staying with the folder when it moves to RenamerReview.', false);
    } else {
      Logger.log('[DRY RUN] Unpaired subtitle(s) in folder "' + folder.getName() + '": '
        + leftoverSubs.map(function (s) { return s.name; }).join(', '));
    }
  }

  if (anyIssue) {
    moveFolderToReview_(folder, dryRun);
  } else if (dryRun) {
    Logger.log('[DRY RUN] Folder "' + folder.getName() + '" — everything matched; would check if now empty and move to RenamerReview/Empty if so.');
  } else if (folderIsNowEmptyOfMedia_(folder)) {
    moveFolderToEmpty_(folder, dryRun);
  }
}

function folderIsNowEmptyOfMedia_(folder) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    var ext = getExtension_(files.next().getName());
    if (VIDEO_EXTENSIONS.indexOf(ext) !== -1 || SUBTITLE_EXTENSIONS.indexOf(ext) !== -1) return false;
  }
  return true; // may still contain non-media junk (nfo, jpg, ...) — that still counts as "no media"
}

function moveFolderToEmpty_(folder, dryRun) {
  var name = folder.getName();
  if (dryRun) {
    Logger.log('[DRY RUN] "' + name + '" has no video/subtitle inside -> would move to RenamerReview/Empty');
    return;
  }
  sendTelegram_('📁 Empty folder: "' + name + '"\nNo video or subtitle found inside — moved to RenamerReview/Empty for cleanup.', false);
  try {
    var reviewFolder = getReviewFolder_(getOpenFolder_());
    var emptyFolder = getOrCreateFolder_(reviewFolder, 'Empty');
    folder.moveTo(emptyFolder);
    Logger.log('Moved empty folder to RenamerReview/Empty: ' + name);
  } catch (e) {
    sendTelegram_('⚠️ Move to RenamerReview/Empty FAILED\n"' + name + '"\nError: ' + e.message, false);
    Logger.log('Move to Empty failed for folder ' + name + ': ' + e.message + '\n' + e.stack);
  }
}

function moveFolderToReview_(folder, dryRun) {
  var name = folder.getName();
  if (dryRun) {
    Logger.log('[DRY RUN] Folder "' + name + '" has unresolved issue(s) -> would move the whole folder to RenamerReview');
    return;
  }
  sendTelegram_('📁 Folder needs review: "' + name + '"\nMoved the whole folder to RenamerReview — see the message(s) above for which item(s) inside it had the issue.', false);
  try {
    var reviewFolder = getReviewFolder_(getOpenFolder_());
    folder.moveTo(reviewFolder);
    Logger.log('Moved folder to RenamerReview: ' + name);
  } catch (e) {
    sendTelegram_('⚠️ Move to RenamerReview FAILED\nFolder: "' + name + '"\nError: ' + e.message, false);
    Logger.log('Move to RenamerReview failed for folder ' + name + ': ' + e.message + '\n' + e.stack);
  }
}

function installTrigger() {
  // Points at scheduledRenamerRun_ (the pause-aware wrapper), not
  // processRenamerFolder directly — see the "entry points" comment above.
  // Fixed 2026-11-01: this used to only clean up a trigger already pointed
  // at scheduledRenamerRun_, so anyone who ran installTrigger() BEFORE
  // Start/Stop existed still had their live 15-min trigger pointed
  // directly at processRenamerFolder — which, by design, never checks
  // SCHEDULER_PAUSED (it's the manual entry point that must always work).
  // Confirmed in practice: stopAutoRenamer() correctly sent the Telegram
  // notice and correctly set the flag, but the untouched legacy trigger
  // kept calling processRenamerFolder directly every 15 minutes regardless
  // — Stop had zero effect on the actual schedule. Deleting BOTH possible
  // targets before recreating means re-running this once always leaves
  // exactly one correct trigger, however old the installation is.
  deleteTriggers_('processRenamerFolder');
  deleteTriggers_('scheduledRenamerRun_');
  ScriptApp.newTrigger('scheduledRenamerRun_')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('Trigger installed: scheduledRenamerRun_ every 15 min.');
}

function testTelegram() {
  sendTelegram_('✅ Renamer bot test message — Telegram is wired up correctly.', false);
}

// ---------- start / stop ----------
//
// Both gate the SAME SCHEDULER_PAUSED Script Property that
// scheduledRenamerRun_() and handleCallbackQuery_() check — stopping
// pauses the automatic 15-min scan AND Telegram button-tap resolution
// together; it never pauses a manual processRenamerFolder() run, which
// always works regardless of this flag. The Settings Sheet's
// SCHEDULER_PAUSED checkbox and Quick Actions dropdown (see
// setupSettingsSheet()) both call these same two functions rather than
// duplicating this logic, so every path — editor, checkbox, dropdown —
// stays in sync.

// Mirrors SCHEDULER_PAUSED into the Settings Sheet's checkbox cell, if a
// sheet has been set up — so the dashboard (a formula reading THAT cell,
// not the live property) stays accurate no matter which of the three
// paths above changed the actual property. Silently does nothing if no
// Settings Sheet exists yet; never throws (a sheet-sync hiccup must never
// block the real stop/start from taking effect).
function syncSchedulerCheckbox_(pausedStr) {
  var sheetId = getProp_('SETTINGS_SHEET_ID');
  if (!sheetId) return;
  try {
    var cell = SpreadsheetApp.openById(sheetId).getRangeByName('SCHEDULER_PAUSED');
    if (cell) cell.setValue(pausedStr);
  } catch (e) {
    Logger.log('syncSchedulerCheckbox_ could not update the Settings Sheet: ' + e.message);
  }
}

function stopAutoRenamer() {
  // Deliberately refuses to stop while a run (scheduled, manual, or a
  // button-tap resolution) is currently in progress, rather than letting
  // the pause flag flip underneath it — tryLock(0) returns immediately
  // (no waiting) and is false only if some other execution currently holds
  // the lock.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    var msg = 'Cannot stop — a scheduler run is currently in progress. Try again in a moment.';
    Logger.log('ERROR: ' + msg);
    throw new Error(msg);
  }
  try {
    // Message-then-act, same convention as every rename/move in this
    // script: the Telegram notice goes out BEFORE the flag actually
    // flips, so you always know a stop was requested even if something
    // below somehow failed.
    sendTelegram_('⏸️ Renamer scheduler stopping — automatic 15-min runs and Telegram button-tap resolution are both paused.\nRun processRenamerFolder manually any time; run startAutoRenamer (or flip SCHEDULER_PAUSED back to false in the Settings Sheet) to resume.', false);
    PropertiesService.getScriptProperties().setProperty('SCHEDULER_PAUSED', 'true');
    syncSchedulerCheckbox_('true');
    Logger.log('Scheduler stopped (SCHEDULER_PAUSED=true).');
  } finally {
    lock.releaseLock();
  }
}

function startAutoRenamer() {
  sendTelegram_('▶️ Renamer scheduler started — automatic 15-min runs and Telegram button-tap resolution are active again.', false);
  PropertiesService.getScriptProperties().setProperty('SCHEDULER_PAUSED', 'false');
  syncSchedulerCheckbox_('false');
  Logger.log('Scheduler started (SCHEDULER_PAUSED=false).');
}

// ---------- Settings Sheet (optional, for non-technical editing) ----------
//
// Run setupSettingsSheet() once. It builds a styled "control panel" sheet:
// a banner, a live color-coded status dashboard (Scheduler/Mode), a
// Quick Actions dropdown that behaves like a momentary button, and the
// editable properties grouped into sections with real checkboxes for the
// two booleans. Re-running it later REBUILDS the whole sheet from current
// Script Property values — safe to run any time (e.g. to recreate it if
// deleted, or to pick up a design tweak after a code update).
//
// Field identity is tracked with named ranges (one per property's Value
// cell, named after the property key itself, plus one named
// 'RENAMER_ACTION_CELL' for the dropdown) rather than by row number or by
// reading a label out of column A — so onSettingsSheetEdit_ below keeps
// working correctly even if this layout changes later, and a decorative
// row (a banner/section band/status formula) can never be mistaken for an
// editable field.
function setupSettingsSheet() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SETTINGS_SHEET_ID');
  var ss = null;
  if (sheetId) {
    try {
      ss = SpreadsheetApp.openById(sheetId);
    } catch (e) {
      ss = null; // sheet was deleted/moved out of reach — recreate below
    }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Renamer Settings');
    props.setProperty('SETTINGS_SHEET_ID', ss.getId());
  }

  var sheet = ss.getSheets()[0];
  sheet.setName('Settings');
  sheet.clear();
  sheet.clearConditionalFormatRules();
  // Named ranges are spreadsheet-level, not cleared by sheet.clear() —
  // drop every old one before rebuilding so re-running this never
  // accumulates duplicates or points a name at a now-stale row.
  ss.getNamedRanges().forEach(function (nr) { nr.remove(); });
  sheet.setHiddenGridlines(true);
  sheet.setTabColor('#1A237E');

  var COL_A = 230, COL_B = 300, COL_C = 480;
  sheet.setColumnWidth(1, COL_A);
  sheet.setColumnWidth(2, COL_B);
  sheet.setColumnWidth(3, COL_C);

  var BANNER_BG = '#1A237E', BANNER_FG = '#FFFFFF';
  var BAND_BG = '#37474F', BAND_FG = '#FFFFFF';
  var AMBER_BG = '#FFF3CD', AMBER_FG = '#8A6D00';
  var GREEN_BG = '#D9F2D9', GREEN_FG = '#1B5E20';
  var INPUT_BORDER = '#B0BEC5';
  var condRules = [];
  var row = 1;

  function banner(text, bg, fg, size, height) {
    var r = sheet.getRange(row, 1, 1, 3);
    r.merge().setValue(text).setBackground(bg).setFontColor(fg)
      .setFontWeight('bold').setFontSize(size)
      .setHorizontalAlignment('center').setVerticalAlignment('middle');
    sheet.setRowHeight(row, height);
    row++;
  }
  function spacer() { sheet.setRowHeight(row, 10); row++; }
  function sectionBand(label) { banner(label, BAND_BG, BAND_FG, 11, 26); }

  banner('🎬  Renamer — Control Panel', BANNER_BG, BANNER_FG, 18, 44);
  banner('Edit a Value cell below and it saves immediately — no script editor needed.', '#5C6BC0', '#FFFFFF', 10, 24);
  spacer();

  // ---- Status dashboard (live formulas, filled in once the BEHAVIOR
  // checkboxes' named ranges exist further down) ----
  sectionBand('📊  STATUS');
  sheet.getRange(row, 1).setValue('Scheduler').setFontWeight('bold');
  sheet.getRange(row, 3).setValue('Live — reflects the SCHEDULER_PAUSED checkbox below.').setFontStyle('italic').setFontColor('#607D8B');
  var schedulerStatusRow = row;
  row++;
  sheet.getRange(row, 1).setValue('Mode').setFontWeight('bold');
  sheet.getRange(row, 3).setValue('Live — reflects the DRY_RUN checkbox below.').setFontStyle('italic').setFontColor('#607D8B');
  var modeStatusRow = row;
  row++;
  spacer();

  // ---- Quick Actions (momentary "button" via dropdown + onEdit) ----
  sectionBand('⚡  QUICK ACTIONS');
  sheet.getRange(row, 1).setValue('Run an action').setFontWeight('bold');
  var actionCell = sheet.getRange(row, 2);
  actionCell.setValue(ACTION_PLACEHOLDER_).setBackground('#EDE7F6')
    .setFontWeight('bold').setHorizontalAlignment('center')
    .setBorder(true, true, true, true, false, false, '#7E57C2', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  actionCell.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList([ACTION_PLACEHOLDER_, ACTION_RUN_NOW_, ACTION_STOP_, ACTION_START_], true)
    .setAllowInvalid(false)
    .build());
  ss.setNamedRange('RENAMER_ACTION_CELL', actionCell);
  sheet.getRange(row, 3).setValue('Pick one to run it immediately — resets itself right after, like a button tap.').setFontStyle('italic').setFontColor('#607D8B');
  row++;
  spacer();

  // ---- Property sections ----
  var currentSection = null;
  SETTINGS_FIELDS_.forEach(function (f) {
    if (f.section !== currentSection) {
      sectionBand(SETTINGS_SECTION_LABELS_[f.section] || f.section);
      currentSection = f.section;
    }
    sheet.getRange(row, 1).setValue(f.label || f.key).setFontWeight('bold').setFontColor('#263238');
    var valueCell = sheet.getRange(row, 2);
    var storedValue = props.getProperty(f.key) || (f.type === 'checkbox' ? 'false' : '');
    if (f.type === 'checkbox') {
      valueCell.insertCheckboxes('true', 'false');
      valueCell.setValue(storedValue === 'true' ? 'true' : 'false');
      condRules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo('true').setBackground(AMBER_BG).setFontColor(AMBER_FG)
        .setRanges([valueCell]).build());
      condRules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo('false').setBackground(GREEN_BG).setFontColor(GREEN_FG)
        .setRanges([valueCell]).build());
    } else {
      valueCell.setValue(storedValue)
        .setBorder(true, true, true, true, false, false, INPUT_BORDER, SpreadsheetApp.BorderStyle.SOLID);
    }
    ss.setNamedRange(f.key, valueCell);
    sheet.getRange(row, 3).setValue(f.note).setFontColor('#455A64').setWrap(true);
    row++;
  });

  // ---- Now that SCHEDULER_PAUSED / DRY_RUN named ranges exist, wire the
  // dashboard formulas to them by name (Sheets formulas can reference a
  // named range directly, same as a cell address). ----
  var schedulerCell = sheet.getRange(schedulerStatusRow, 2);
  schedulerCell.setFormula('=IF(SCHEDULER_PAUSED="true","⏸  PAUSED","▶  RUNNING")')
    .setFontWeight('bold').setHorizontalAlignment('center');
  var modeCell = sheet.getRange(modeStatusRow, 2);
  modeCell.setFormula('=IF(DRY_RUN="true","🧪  TEST (dry run)","🟢  LIVE")')
    .setFontWeight('bold').setHorizontalAlignment('center');
  condRules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('PAUSED').setBackground(AMBER_BG).setFontColor(AMBER_FG).setRanges([schedulerCell]).build());
  condRules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('RUNNING').setBackground(GREEN_BG).setFontColor(GREEN_FG).setRanges([schedulerCell]).build());
  condRules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('TEST').setBackground(AMBER_BG).setFontColor(AMBER_FG).setRanges([modeCell]).build());
  condRules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('LIVE').setBackground(GREEN_BG).setFontColor(GREEN_FG).setRanges([modeCell]).build());
  sheet.setConditionalFormatRules(condRules);

  sheet.setRowHeights(1, row, 24);
  sheet.setRowHeight(1, 44);
  sheet.setRowHeight(2, 24);
  sheet.setFrozenRows(2);

  // Re-install fresh each time so running this again after recreating the
  // sheet never leaves a stale or duplicate trigger pointed at an old,
  // now-inaccessible sheet ID.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onSettingsSheetEdit_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onSettingsSheetEdit_')
    .forSpreadsheet(ss.getId())
    .onEdit()
    .create();

  Logger.log('Settings sheet ready: ' + ss.getUrl());
  return ss.getUrl();
}

// Installable onEdit handler for the Settings Sheet. Identifies WHICH
// field was edited by checking the spreadsheet's named ranges for one
// whose range matches the edited cell exactly — not by row number or by
// reading a label out of column A — so a banner/section-band/status-
// formula cell being accidentally edited is simply ignored (it has no
// named range), rather than being written into Script Properties as a
// bogus property.
function onSettingsSheetEdit_(e) {
  try {
    var range = e.range;
    if (range.getSheet().getName() !== 'Settings') return;

    var matchedName = null;
    var namedRanges = e.source.getNamedRanges();
    for (var i = 0; i < namedRanges.length; i++) {
      var nrRange = namedRanges[i].getRange();
      if (nrRange.getSheet().getSheetId() === range.getSheet().getSheetId()
        && nrRange.getRow() === range.getRow() && nrRange.getColumn() === range.getColumn()) {
        matchedName = namedRanges[i].getName();
        break;
      }
    }
    if (!matchedName) return; // not a managed field (banner, section band, status formula, ...) — ignore

    if (matchedName === 'RENAMER_ACTION_CELL') {
      var choice = String(range.getValue());
      if (choice === ACTION_PLACEHOLDER_) return; // the self-reset landing here — nothing to do
      range.setValue(ACTION_PLACEHOLDER_); // reset immediately so it behaves like a momentary button
      if (choice === ACTION_RUN_NOW_) {
        e.source.toast('Running now…', 'Renamer', 5);
        processRenamerFolder();
        e.source.toast('Run finished — check Telegram / Executions for results.', 'Renamer', 5);
      } else if (choice === ACTION_STOP_) {
        try {
          stopAutoRenamer();
          e.source.toast('Scheduler stopped.', 'Renamer', 4);
        } catch (err) {
          e.source.toast(err.message, 'Renamer', 8);
        }
      } else if (choice === ACTION_START_) {
        startAutoRenamer();
        e.source.toast('Scheduler started.', 'Renamer', 4);
      }
      return;
    }

    if (matchedName === 'SCHEDULER_PAUSED') {
      var wantsPaused = String(range.getValue()).trim().toLowerCase() === 'true';
      if (wantsPaused) {
        try {
          stopAutoRenamer(); // throws (and leaves the property untouched) if a run is in progress
        } catch (err) {
          range.setValue(getProp_('SCHEDULER_PAUSED') === 'true' ? 'true' : 'false');
          e.source.toast(err.message, 'Renamer', 8);
          return;
        }
      } else {
        startAutoRenamer();
      }
      e.source.toast(wantsPaused ? 'Scheduler stopped.' : 'Scheduler started.', 'Renamer', 4);
      return;
    }

    // Any other managed property: just mirror the cell into the matching
    // Script Property. Trim always (a stray trailing space breaking a
    // folder ID or API key would be a nasty thing to debug); normalize
    // true/false casing too, in case DRY_RUN's checkbox somehow ends up
    // holding typed text instead of a clicked state.
    var rawValue = String(range.getValue());
    var trimmed = rawValue.trim();
    var normalized = /^(true|false)$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
    PropertiesService.getScriptProperties().setProperty(matchedName, normalized);
    if (normalized !== rawValue) range.setValue(normalized);
    e.source.toast('Saved ' + matchedName + '.', 'Renamer', 4);
  } catch (err) {
    Logger.log('onSettingsSheetEdit_ error: ' + err.message + '\n' + err.stack);
  }
}

function setupPropertiesTemplate() {
  // Convenience only. Prefer setting real values directly in Project
  // Settings -> Script Properties (or the Settings Sheet) rather than
  // pasting secrets into code.
  PropertiesService.getScriptProperties().setProperties({
    RENAMER_OPEN_FOLDER_ID: 'PASTE_OPEN_FOLDER_ID_HERE',
    RENAMER_DONE_FOLDER_ID: 'PASTE_DONE_FOLDER_ID_HERE',
    TMDB_API_KEY: 'PASTE_TMDB_KEY_HERE',
    TELEGRAM_BOT_TOKEN: 'PASTE_BOT_TOKEN_HERE',
    TELEGRAM_CHAT_ID: 'PASTE_CHAT_ID_HERE',
    DRY_RUN: 'true',
    SCHEDULER_PAUSED: 'false'
  }, true);
  Logger.log('Properties set (placeholders) — go edit real values in Project Settings.');
}

// ---------- Undo History (added 2026-11-03) ----------
//
// Every successful rename (movie or TV, auto-matched or button-resolved)
// logs one row to a separate "Renamer History" Sheet — fully automatic, no
// setup required; the Sheet (and its onEdit trigger) is created the first
// time anything actually succeeds. Ticking the "Undo" checkbox on a row
// moves that one file (and any subtitles logged with it) straight back to
// its original name and folder — found by Drive file ID, so it works
// however many times the file has been touched since and wherever it's
// since wandered to. Per-item only: there's no "undo my whole last run" —
// tick each row you want reverted individually. The log keeps its most
// recent HIST_MAX_ROWS entries; older ones are trimmed automatically as new
// ones come in (this only ever deletes LOG ROWS — bookkeeping about what
// happened — never a media file; the no-delete rule for actual movies/TV
// episodes is completely untouched by this).
//
// setupHistorySheet() is optional — run it manually only if you want to
// force-create the Sheet before any rename has happened yet, or to
// re-install the onEdit trigger if it was ever removed by hand.

var HIST_COL_TIMESTAMP = 1, HIST_COL_STATUS = 2, HIST_COL_TYPE = 3, HIST_COL_UNDO = 4,
  HIST_COL_VIDEO_ID = 5, HIST_COL_ORIG_NAME = 6, HIST_COL_ORIG_FOLDER_ID = 7, HIST_COL_ORIG_FOLDER = 8,
  HIST_COL_NEW_NAME = 9, HIST_COL_NEW_FOLDER_ID = 10, HIST_COL_NEW_FOLDER = 11, HIST_COL_SUBS_JSON = 12, HIST_COL_NOTES = 13;
var HIST_TOTAL_COLS = 13;
var HIST_MAX_ROWS = 1000;

function setupHistorySheet() {
  var ss = getOrCreateHistorySheet_();
  installHistorySheetTrigger_(ss); // force-reinstall even if the sheet already existed
  Logger.log('Renamer History sheet ready: ' + ss.getUrl());
  return ss.getUrl();
}

function getOrCreateHistorySheet_() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('HISTORY_SHEET_ID');
  var ss = null;
  if (sheetId) {
    try { ss = SpreadsheetApp.openById(sheetId); } catch (e) { ss = null; } // deleted/trashed — recreate below
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Renamer History');
    props.setProperty('HISTORY_SHEET_ID', ss.getId());
    var sheet = ss.getSheets()[0];
    sheet.setName('History');
    var header = ['Timestamp', 'Status', 'Type', 'Undo', 'Video File ID', 'Original Name',
      'Original Folder ID', 'Original Folder', 'New Name', 'New Folder ID', 'New Folder', 'Subs JSON', 'Notes'];
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.hideColumns(HIST_COL_VIDEO_ID);
    sheet.hideColumns(HIST_COL_ORIG_FOLDER_ID);
    sheet.hideColumns(HIST_COL_NEW_FOLDER_ID);
    sheet.hideColumns(HIST_COL_SUBS_JSON);
    installHistorySheetTrigger_(ss);
    Logger.log('Renamer History sheet created: ' + ss.getUrl());
  }
  return ss;
}

function installHistorySheetTrigger_(ss) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onHistorySheetEdit_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onHistorySheetEdit_').forSpreadsheet(ss.getId()).onEdit().create();
}

// Called right after every successful rename+move, movie or TV, auto or
// button-resolved. Best-effort and silent on failure by design — a problem
// writing this log entry must never undo or fail an already-successful
// rename; the file is correctly renamed either way, only its undo record
// might be missing this one time.
//
// Fixed 2026-11-04: added a one-retry (mirrors safeFetchJson_'s existing
// retry-once pattern for TMDb calls). Confirmed cause: a large batch (e.g.
// 267 TV episodes in one run) writes one Sheets row per episode back to
// back with zero pacing between writes - unlike TMDb calls, which already
// have TMDB_PACING_MS between them. That's exactly the shape that
// occasionally trips a transient "service unavailable"-style error from
// the Sheets API for a random call or two out of hundreds; this function
// had no retry at all, so a single transient hiccup permanently lost that
// one row (the rename itself was never affected either way - only its
// undo record). A one-off transient error essentially never fails twice
// in a row, so one retry with a short pause is enough.
function logRenameForUndo_(opts) {
  var lastError = null;
  for (var attempt = 1; attempt <= 2; attempt++) {
    try {
      var sheet = getOrCreateHistorySheet_().getSheets()[0];
      var row = [
        new Date(),
        'Done',
        opts.type,
        false,
        opts.videoFileId,
        opts.originalName,
        opts.originalFolderId || '',
        opts.originalFolderDisplay || '',
        opts.newName,
        opts.newFolderId,
        opts.newFolderDisplay,
        JSON.stringify(opts.subs || []),
        opts.originalFolderId ? '' : 'Original location was not recorded for this entry — cannot auto-undo.'
      ];
      var lastRow = sheet.getLastRow();
      sheet.getRange(lastRow + 1, 1, 1, HIST_TOTAL_COLS).setValues([row]);
      sheet.getRange(lastRow + 1, HIST_COL_UNDO, 1, 1).insertCheckboxes();
      trimHistorySheet_(sheet);
      return; // success
    } catch (e) {
      lastError = e.message;
      Logger.log('Log undo history attempt ' + attempt + ' failed: ' + e.message);
      if (attempt === 1) Utilities.sleep(1000);
    }
  }
  Logger.log('Could not log undo history after retry (non-fatal — the rename itself already succeeded): ' + lastError);
}

function trimHistorySheet_(sheet) {
  var dataRows = sheet.getLastRow() - 1;
  if (dataRows > HIST_MAX_ROWS) {
    sheet.deleteRows(2, dataRows - HIST_MAX_ROWS); // oldest rows sit right under the header
  }
}

// Installable onEdit handler for the History Sheet. Only reacts to the
// Undo column being ticked TRUE on a row whose Status is still "Done" —
// unticking does nothing, and re-ticking an already-Reverted (or already-
// Revert-Failed) row is ignored rather than attempted twice.
function onHistorySheetEdit_(e) {
  try {
    var range = e.range;
    var sheet = range.getSheet();
    if (sheet.getName() !== 'History') return;
    if (range.getColumn() !== HIST_COL_UNDO || range.getNumRows() !== 1 || range.getNumColumns() !== 1) return;
    var row = range.getRow();
    if (row === 1) return;
    if (range.getValue() !== true) return;

    var status = sheet.getRange(row, HIST_COL_STATUS).getValue();
    if (status !== 'Done') return;

    performUndo_(sheet, row);
  } catch (err) {
    Logger.log('onHistorySheetEdit_ error: ' + err.message + '\n' + err.stack);
  }
}

// Fixed 2026-11-03: used to trust origFolderId blindly and move the file
// straight back into whatever that ID still points to. That's often NOT a
// safe place by the time someone actually clicks Undo - maybe days later:
// if the rename emptied the original folder, moveFolderToEmpty_ already
// relocated it into RenamerReview/Empty for cleanup; if the person then
// (reasonably) deleted it from there since it looked like empty junk,
// that folder is now sitting in Drive's Trash. DriveApp.getFolderById()
// returns a trashed folder just fine, no exception - so the old code
// "reverted successfully" while actually filing the video straight into
// Trash. This only reuses the original folder when it's still untouched
// (not trashed, still a direct child of Open); otherwise it recreates a
// fresh folder with the same name directly inside Open and uses that -
// never Trash, never the stale RenamerReview/Empty copy.
function resolveUndoDestinationFolder_(origFolderId, origFolderDisplay) {
  var openFolder = getOpenFolder_();
  var subfolderName = (origFolderDisplay && origFolderDisplay.indexOf('/') !== -1)
    ? origFolderDisplay.substring(origFolderDisplay.indexOf('/') + 1)
    : null;

  if (subfolderName === null) {
    // Was a loose top-level file - Open itself is always the right place.
    return { folder: openFolder, recreated: false };
  }

  var safe = null;
  try {
    var candidate = DriveApp.getFolderById(origFolderId);
    var isDirectChildOfOpen = false;
    var parents = candidate.getParents();
    while (parents.hasNext()) {
      if (parents.next().getId() === openFolder.getId()) { isDirectChildOfOpen = true; break; }
    }
    if (!candidate.isTrashed() && isDirectChildOfOpen) safe = candidate;
  } catch (e) {
    safe = null; // folder permanently gone — fall through to recreate
  }
  if (safe) return { folder: safe, recreated: false };

  // Fixed 2026-11-09: used to recreate the stale/deleted folder fresh
  // inside Open and file the undone item straight back in there, same as
  // a normal "healthy folder" revert. But a folder that's gone/archived
  // enough to need recreating is itself a sign something about this item
  // needs a human look before it goes back into the active Open queue —
  // so recreate it inside RenamerReview instead. Only this recreate path
  // changes; the "healthy folder found" and "loose top-level file" cases
  // above are untouched.
  var reviewFolder = getReviewFolder_(openFolder);
  var fresh = getOrCreateFolder_(reviewFolder, subfolderName);
  return { folder: fresh, recreated: true };
}

function performUndo_(sheet, row) {
  var videoId = sheet.getRange(row, HIST_COL_VIDEO_ID).getValue();
  var origName = sheet.getRange(row, HIST_COL_ORIG_NAME).getValue();
  var origFolderId = sheet.getRange(row, HIST_COL_ORIG_FOLDER_ID).getValue();
  var origFolderDisplay = sheet.getRange(row, HIST_COL_ORIG_FOLDER).getValue();
  var subsJson = sheet.getRange(row, HIST_COL_SUBS_JSON).getValue();
  var typeLabel = sheet.getRange(row, HIST_COL_TYPE).getValue();

  if (!origFolderId) {
    sheet.getRange(row, HIST_COL_STATUS).setValue('Revert Failed');
    sheet.getRange(row, HIST_COL_NOTES).setValue('Original location was never recorded for this entry — cannot auto-undo. Move it back manually if needed.');
    sendTelegram_('⚠️ Undo failed for "' + origName + '" — original location unknown, could not auto-revert. Move it back manually if needed.', false);
    return;
  }

  var resolved;
  try {
    resolved = resolveUndoDestinationFolder_(origFolderId, origFolderDisplay);
  } catch (e) {
    sheet.getRange(row, HIST_COL_STATUS).setValue('Revert Failed');
    sheet.getRange(row, HIST_COL_NOTES).setValue('Could not resolve a safe folder to undo into: ' + e.message);
    sendTelegram_('⚠️ Undo failed for "' + origName + '" — could not resolve a safe destination folder. Move it back manually if needed.', false);
    return;
  }
  var origFolder = resolved.folder;

  try {
    var videoFile = DriveApp.getFileById(videoId);
    videoFile.setName(origName);
    videoFile.moveTo(origFolder);

    var subs = [];
    try { subs = JSON.parse(subsJson || '[]'); } catch (e) { subs = []; }
    var subErrors = [];
    subs.forEach(function (s) {
      try {
        var subFile = DriveApp.getFileById(s.fileId);
        subFile.setName(s.oldName);
        subFile.moveTo(origFolder);
      } catch (e) {
        subErrors.push(s.oldName + ': ' + e.message);
      }
    });

    var recreatedNote = resolved.recreated
      ? (' Original folder was gone/archived — recreated "' + origFolder.getName() + '" fresh inside RenamerReview and filed it there instead of Open, so it gets a look before re-processing.')
      : '';
    sheet.getRange(row, HIST_COL_STATUS).setValue('Reverted');
    sheet.getRange(row, HIST_COL_NOTES).setValue((subErrors.length
      ? ('Video reverted OK; subtitle issue(s): ' + subErrors.join('; '))
      : ('Reverted ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'))) + recreatedNote);
    sendTelegram_('↩️ Undone: "' + origName + '" moved back' + (typeLabel ? ' (' + typeLabel + ')' : '') + recreatedNote, false);
  } catch (e) {
    sheet.getRange(row, HIST_COL_STATUS).setValue('Revert Failed');
    sheet.getRange(row, HIST_COL_NOTES).setValue('Revert error: ' + e.message);
    sendTelegram_('⚠️ Undo failed for "' + origName + '": ' + e.message, false);
  }
}

// ---------- Telegram webhook (button taps) ----------
//
// Requires a one-time deployment step this code can't do for you: Deploy ->
// New deployment -> "Web app" -> execute as yourself, access "Anyone" ->
// copy the URL -> register it with Telegram via:
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WEB_APP_URL>"
// See SETUP.md for the full walkthrough. Without this, button taps are
// received by Telegram but never reach this script.

function doGet(e) {
  return ContentService.createTextOutput('Renamer webhook is alive.');
}

function doPost(e) {
  var update;
  try {
    update = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput('bad request');
  }
  if (!update.callback_query) {
    return ContentService.createTextOutput('ignored');
  }

  var cq = update.callback_query;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    // Don't leave the tap hanging with no feedback just because a scheduled
    // run happens to be in progress — tell the person to try again shortly.
    answerCallback_(cq.id, 'Busy right now — tap again in a few seconds.');
    return ContentService.createTextOutput('locked');
  }
  try {
    handleCallbackQuery_(cq);
  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + err.stack);
    answerCallback_(cq.id, 'Something went wrong — check the script logs.');
  } finally {
    lock.releaseLock();
  }
  return ContentService.createTextOutput('ok');
}

function handleCallbackQuery_(cq) {
  if (getProp_('SCHEDULER_PAUSED') === 'true') {
    answerCallback_(cq.id, 'Renamer is stopped — run startAutoRenamer (or flip SCHEDULER_PAUSED back to false) to resume before resolving this.');
    return;
  }
  var parts = (cq.data || '').split('|');
  if (parts[0] !== 'rr' || parts.length !== 3) {
    answerCallback_(cq.id, 'Unrecognized action.');
    return;
  }
  var token = parts[1];
  var choice = parts[2];

  var pending = getPendingReviews_();
  var record = pending[token];
  if (!record) {
    answerCallback_(cq.id, 'This item was already resolved (or the script was redeployed since).');
    return;
  }

  if (choice === 'skip') {
    delete pending[token];
    setPendingReviews_(pending);
    answerCallback_(cq.id, 'OK — left in RenamerReview for manual handling.');
    editMessageText_(record.chatId, record.messageId,
      '🚫 Marked "none of these": ' + record.videoName + '\nStill in RenamerReview — handle it manually.');
    return;
  }

  var idx = parseInt(choice, 10);
  var candidate = record.candidates[idx];
  if (!candidate) {
    answerCallback_(cq.id, 'Invalid or stale choice.');
    return;
  }

  answerCallback_(cq.id, 'Working on it…');

  var result = finalizeReviewPick_(record, candidate);

  delete pending[token];
  setPendingReviews_(pending);

  editMessageText_(record.chatId, record.messageId,
    result.ok
      ? ('✅ ' + record.videoName + '\n→ ' + result.summary)
      : ('⚠️ Resolution failed: ' + record.videoName + '\n' + result.error));
}

// Performs the actual rename/move for a button-resolved review item. The
// video/subtitle files are located by the Drive file IDs stored at review
// time — moveTo doesn't change a file's ID, so this works regardless of
// which folder they're currently sitting in.
function finalizeReviewPick_(record, candidate) {
  var doneFolder = getDoneFolder_();

  var videoFile;
  try {
    videoFile = DriveApp.getFileById(record.videoFileId);
  } catch (e) {
    return { ok: false, error: 'Could not find the video file anymore (ID ' + record.videoFileId + ') — it may have been moved or deleted manually.' };
  }

  var movie = enrichTmdbById_(candidate.tmdbId, candidate.title, candidate.year);
  var parsed = { tags: record.tags };
  var finalBase = buildFinalBaseName_(parsed, movie);
  var folderName = sanitizeFilename_(movie.title + ' (' + movie.year + ')');

  var existing = doneFolder.getFoldersByName(folderName);
  if (existing.hasNext()) {
    return { ok: false, error: '"' + folderName + '" already exists in the Done folder — left as-is in RenamerReview rather than risking a silent merge. Handle this one manually.' };
  }

  var finalVideoName = sanitizeFilename_(finalBase + '.' + record.videoExt);
  var subMoves = [];
  for (var i = 0; i < record.subs.length; i++) {
    var s = record.subs[i];
    var suffix = s.langSuffix ? '.' + s.langSuffix.toLowerCase() : '';
    var subFile;
    try {
      subFile = DriveApp.getFileById(s.fileId);
    } catch (e) {
      continue; // sub went missing independently — don't fail the whole video over it
    }
    subMoves.push({ file: subFile, oldName: s.name, newName: sanitizeFilename_(finalBase + suffix + '.' + s.ext) });
  }

  sendTelegram_('🔄 Renaming & moving (button pick)\n' + record.videoName + '\n→ ' + folderName + '/' + finalVideoName, false);

  try {
    var destFolder = getOrCreateFolder_(doneFolder, folderName);
    videoFile.setName(finalVideoName);
    videoFile.moveTo(destFolder);
    subMoves.forEach(function (s) {
      s.file.setName(s.newName);
      s.file.moveTo(destFolder);
    });

    // Undo-history logging. record.videoParentFolderId is only set for a
    // folder-sourced review item (see its assignment in
    // sendReviewWithButtons_); for a top-level loose file, the file was
    // already sitting in RenamerReview itself right up until this move, so
    // THAT'S the correct "original" location to log for undo purposes, not
    // Open (which is one step further back than this specific operation).
    var origFolderForLog = null;
    if (record.videoParentFolderId) {
      try { origFolderForLog = DriveApp.getFolderById(record.videoParentFolderId); } catch (e) { origFolderForLog = null; }
    } else {
      try { origFolderForLog = getReviewFolder_(getOpenFolder_()); } catch (e) { origFolderForLog = null; }
    }
    logRenameForUndo_({
      type: 'Movie',
      videoFileId: videoFile.getId(),
      originalName: record.videoName,
      originalFolderId: origFolderForLog ? origFolderForLog.getId() : null,
      originalFolderDisplay: origFolderForLog ? origFolderForLog.getName() : '',
      newName: finalVideoName,
      newFolderId: destFolder.getId(),
      newFolderDisplay: 'Done/' + folderName,
      subs: subMoves.map(function (s) { return { fileId: s.file.getId(), oldName: s.oldName, newName: s.newName }; })
    });

    // Clean up the now-emptied original folder (see the comment at
    // videoParentFolderId's assignment in sendReviewWithButtons_). Best
    // effort only — a failure here never turns a successful rename/move
    // into a reported failure; it just leaves that leftover folder for
    // manual cleanup instead of silently losing the fact that it happened.
    if (record.videoParentFolderId) {
      try {
        var originalFolder = DriveApp.getFolderById(record.videoParentFolderId);
        if (folderIsNowEmptyOfMedia_(originalFolder)) {
          moveFolderToEmpty_(originalFolder, false);
        }
      } catch (cleanupErr) {
        Logger.log('Post-resolution cleanup of original folder (ID ' + record.videoParentFolderId + ') skipped: ' + cleanupErr.message);
      }
    }

    return { ok: true, summary: folderName + '/' + finalVideoName };
  } catch (e) {
    var errMsg = '⚠️ Rename/move FAILED (button pick)\n' + record.videoName
      + '\n(intended) → ' + folderName + '/' + finalVideoName
      + '\nError: ' + e.message
      + '\nCheck RenamerReview and the Done folder manually — the file may be partially moved.';
    sendTelegram_(errMsg, false);
    return { ok: false, error: e.message };
  }
}

function sendTelegramKeyboard_(text, keyboard) {
  var token = getProp_('TELEGRAM_BOT_TOKEN');
  var chatId = getProp_('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    Logger.log('Telegram not configured, button message was: ' + text);
    return null;
  }
  // See sendTelegram_ for why this is wrapped in try/catch — muteHttpExceptions
  // alone does not protect against a genuine network-level failure.
  var res;
  try {
    res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, text: text, reply_markup: { inline_keyboard: keyboard } }),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('Telegram button-send threw: ' + e.message);
    return null;
  }
  Utilities.sleep(TELEGRAM_PACING_MS);
  if (res.getResponseCode() !== 200) {
    Logger.log('Telegram button-send FAILED (' + res.getResponseCode() + '): ' + res.getContentText());
    return null;
  }
  try {
    var body = JSON.parse(res.getContentText());
    return { chatId: body.result.chat.id, messageId: body.result.message_id };
  } catch (e) {
    return null;
  }
}

function answerCallback_(callbackQueryId, text) {
  var token = getProp_('TELEGRAM_BOT_TOKEN');
  if (!token) return;
  // See sendTelegram_ for why this is wrapped — a network-level failure here
  // would otherwise crash doPost mid-button-tap-handling.
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/answerCallbackQuery', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ callback_query_id: callbackQueryId, text: text }),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('answerCallback_ threw: ' + e.message);
  }
}

function editMessageText_(chatId, messageId, text) {
  var token = getProp_('TELEGRAM_BOT_TOKEN');
  if (!token) return;
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/editMessageText', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text }),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('editMessageText_ threw: ' + e.message);
  }
}

// ---------- timing helpers ----------

function timeRunningOut_() {
  return (Date.now() - g_runStartedAt) > MAX_RUN_MS;
}

// ---------- scanning the Open folder ----------

// collectMediaEntries_ is called per top-level subfolder from
// processRenamerFolder (not on the whole tree at once — see the comment
// there for why). Recurses into subfolders too (any depth) — AllDebrid/rclone drops often
// keep each release in its own folder ("SomeRelease/movie.mkv" inside the Open folder),
// and Drive's getFiles() only ever sees direct children, not nested ones.
// Each entry records its immediate parentFolder and whether that parent IS
// the Open folder itself (topLevel) — this is what lets processVideo_ and the
// main loop decide "move just this file" (loose, top-level) vs. "leave it,
// the whole containing folder will be moved" (folder-sourced). Pairing is
// deliberately scoped to each group separately at the call site (top-level
// pool vs. each folder's own pool) rather than globally — closes the
// earlier known gap where a subtitle in one folder could in principle pair
// with a video in an unrelated one.
function collectMediaEntries_(folder, out, folders, isTop) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    var ext = getExtension_(name);
    if (VIDEO_EXTENSIONS.indexOf(ext) !== -1) {
      out.push({ type: 'video', file: file, name: name, ext: ext, core: coreName_(name), parentFolder: folder, topLevel: isTop });
    } else if (SUBTITLE_EXTENSIONS.indexOf(ext) !== -1) {
      out.push({ type: 'subtitle', file: file, name: name, ext: ext, core: coreName_(name), parentFolder: folder, topLevel: isTop });
    }
    // anything else (nfo, jpg, sample files, partial downloads, etc.) is
    // deliberately ignored — not renamed, not moved, not logged.
  }

  var subfolders = folder.getFolders();
  while (subfolders.hasNext()) {
    var sub = subfolders.next();
    folders.push(sub);
    collectMediaEntries_(sub, out, folders, false);
  }
}

function coreName_(name) {
  var base = stripExtension_(name);
  base = stripSitePrefix_(base);
  return base.replace(/\[([^\[\]]+)\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Strips a leading site/release-tag like "www.1TamilMV.solar - " or
// "TamilBlasters.cam - " from the very start of a filename. These piracy-
// aggregator sites rotate their TLD constantly (.solar, .wiki, .cam,
// .estate, .capital, ...) to dodge takedowns, so this matches the SHAPE (a
// dotted, space-free token right at the start, followed by " - ") rather
// than a hardcoded list of domains, which would need updating every few
// months.
//
// Fixed 2026-10-27: the trailing separator used to be \s*-\s* (spaces
// OPTIONAL on both sides), so it also matched a plain hyphenated release
// tag with no spaces at all - confirmed on a real file,
// "Irudhi.Suttru.2016.1080p.AMZN.WEB-DL.DD+5.1.H265-HBN.mkv", where this
// wrongly matched "Irudhi.Suttru.2016.1080p.AMZN.WEB-" as if it were a site
// prefix and deleted it, taking the real title/year/most tags with it -
// what was left ("DL.DD+5.1.H265-HBN") is garbage, which is exactly what
// got sent to TMDb as the "title" (no match, no year found). Every real
// site-prefix example actually seen ("solar - Baththa", "cam - Title ")
// has a real space on both sides of that dash; "WEB-DL" doesn't. Changed
// to \s+-\s+ (space REQUIRED both sides) so a same-word compound hyphen
// like WEB-DL/x264-GROUP/HC-ESub is never mistaken for a site-prefix
// separator - consistent with how every other separator-dash in this
// script (e.g. the afterYear tag-splitter) already requires real
// whitespace on both sides for exactly this reason.
//
// Fixed 2026-11-01: the TLD part was capped at {2,6} letters, confirmed on
// a real file, "www.1TamilMV.capital - Mandaadi (2026) ...", where
// ".capital" (7 letters) didn't fit the cap - the regex requires the TLD
// to be immediately followed by " - ", and even at its greedy max of 6
// letters ("capita") the next character is "l", not a space, so the whole
// match fails and "www.1TamilMV.capital - " survives untouched into the
// title, producing the garbled "www 1TamilMV capital - Mandaadi" seen in
// the review queue. This cap was already too tight for ".estate" (also 7
// letters), named right in the comment above as one of this site's own
// rotating TLDs - just not yet hit on a real file. Real gTLDs run well
// beyond 6 letters (".estate", ".capital", ".international", ...), so
// raised the cap to {2,24}, comfortably covering any realistic TLD this
// site rotates to next. This doesn't meaningfully widen what can be
// mistaken for a site prefix, since the match still requires the whole
// token to be immediately followed by " - " (space-dash-space) - the same
// guard that already prevents a false match on ordinary dotted text.
function stripSitePrefix_(base) {
  return base.replace(/^\s*(?:www\.)?[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,24}\s+-\s+/, '');
}

// Extracts just the release year from a subtitle filename, using the same
// prefer-parenthesized/fallback-bare-year logic as the video's own title
// parsing (see the year lookup in parseFilename_). Used only by the
// one-video-one-subtitle title+year check below - not by anything else a
// subtitle goes through.
function extractYearFromName_(name) {
  var base = stripExtension_(name);
  var yearMatch = base.match(/\(((?:19|20)\d{2})\)/);
  if (!yearMatch) yearMatch = base.match(/\b((?:19|20)\d{2})\b/);
  return yearMatch ? yearMatch[1] : null;
}

// Requested 2026-10-28, replacing the earlier "pair no matter what" rule
// for the one-video-one-subtitle case: only require that the OTHER name
// (the subtitle) contains at least one whole word from the video's TITLE
// (tags/quality info are deliberately not considered at all), or the
// video's title words glued together with no separator and in their
// original order (e.g. title "Cat Run" -> "catrun"). Every check here is
// an EXACT token match, never a substring search - so for title "Cat Run",
// "cat"/"run"/"catrun" all count as a match, but "ca"/"un" (fragments of a
// real word) and "runcat" (the same words glued in the wrong order) do
// not, because none of those are exactly equal to "cat", "run", or
// "catrun". Known, accepted simplification: for a title longer than two
// words, only a single whole word or the FULLY glued title (every word,
// in order) counts - a partial glue of just some of the words does not;
// this wasn't tested against a 3+-word example, so flag it if one ever
// behaves unexpectedly.
function titleWordsAppearIn_(videoTitle, otherName) {
  var titleTokens = (videoTitle || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(function (w) { return w; });
  if (titleTokens.length === 0) return false;
  var gluedTitle = titleTokens.join('');
  var otherTokens = (otherName || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(function (w) { return w; });
  var otherSet = {};
  otherTokens.forEach(function (w) { otherSet[w] = true; });
  if (otherSet[gluedTitle]) return true;
  return titleTokens.some(function (w) { return otherSet[w]; });
}

// Returns { matched: [...], undersized: [...] } rather than a flat list.
// "matched" = name-matched AND big enough to actually be a real subtitle
// (see MIN_SUBTITLE_BYTES below). "undersized" = name-matched but too small
// to trust - requested 2026-10-28 after a user asked to gate on file size
// rather than blindly renaming/filing anything that matches by name alone;
// callers are responsible for routing "undersized" entries to RenamerReview
// instead of treating them as a successful pairing.
function findPairedSubtitles_(video, subtitles, usedIds) {
  var matched = [];
  var undersized = [];
  subtitles.forEach(function (sub) {
    if (usedIds[sub.file.getId()]) return;

    var isNameMatch = false;
    var langSuffix = null;

    if (sub.core === video.core) {
      isNameMatch = true;
    } else if (sub.core.indexOf(video.core) === 0) {
      var rest = sub.core.substring(video.core.length).replace(/^[\s._-]+/, '');
      if (rest === '') {
        // Leftover after stripping the video's core + any separator was
        // pure punctuation with nothing after it (e.g. a stray double dot
        // right before the extension - confirmed on a real "City Hunter
        // (1993)" release: "...AC3[TA+EN]..srt"). That's not a language
        // suffix, it's just filename noise, so treat it the same as an
        // exact-name match rather than rejecting it.
        isNameMatch = true;
      } else if (/^[A-Za-z]{2,12}$/.test(rest)) {
        // Bare language code only (en, eng, english, ...) - deliberately
        // NOT extended to accept ".forced"/numeric-track suffixes
        // (eng.forced.1, eng.2, etc.); that was tried and then reverted on
        // request 2026-10-28, so a release using that mkvextract-style
        // naming will still land here as "no match" (-> unpaired/orphan),
        // not as a silent auto-pair.
        isNameMatch = true;
        langSuffix = rest;
      }
    }
    if (!isNameMatch) return;

    var entry = { file: sub.file, name: sub.name, ext: sub.ext, langSuffix: langSuffix };
    if (sub.file.getSize() > MIN_SUBTITLE_BYTES) {
      matched.push(entry);
    } else {
      undersized.push(entry);
    }
  });
  return { matched: matched, undersized: undersized };
}

// Moves each undersized (name-matched but too-small) top-level subtitle
// straight into RenamerReview on its own - its video has already been
// renamed/moved normally by this point, so this subtitle is the only
// leftover thing needing a human look, not a generic "orphan" (it DID
// match a video; it just failed the size check).
function moveUndersizedSubtitlesToReview_(undersizedSubs, reviewFolder, dryRun) {
  undersizedSubs.forEach(function (s) {
    var sizeKb = (s.file.getSize() / 1024).toFixed(1);
    if (dryRun) {
      Logger.log('[DRY RUN] "' + s.name + '" is only ' + sizeKb + ' KB -> would move to RenamerReview instead of pairing with its video');
      return;
    }
    sendTelegram_('⚠️ Subtitle too small — left for manual review\nFile: ' + s.name
      + '\nSize: ' + sizeKb + ' KB (at or under the ' + (MIN_SUBTITLE_BYTES / 1024) + ' KB minimum) — likely empty, truncated, or a placeholder rather than a real subtitle.'
      + '\nIts video was still renamed and filed normally — only this subtitle is held back.', false);
    try {
      s.file.moveTo(reviewFolder);
      Logger.log('Moved undersized subtitle to RenamerReview: ' + s.name + ' (' + sizeKb + ' KB)');
    } catch (e) {
      sendTelegram_('⚠️ Move to RenamerReview FAILED\n' + s.name + '\nError: ' + e.message, false);
      Logger.log('Move to RenamerReview failed for undersized subtitle ' + s.name + ': ' + e.message + '\n' + e.stack);
    }
  });
}

// ---------- per-video processing ----------

// Returns 'success' or 'issue' (never 'error' — a TMDb failure throws and
// is left for the caller to catch; that's deliberate, see safeFetchJson_).
// Whether an 'issue' also means an individual file move depends entirely on
// video.topLevel: a loose, top-level file (sitting directly in the Open
// folder) still moves itself (+ paired
// subs) into RenamerReview as before. A folder-sourced file does NOT move
// itself — it's left exactly where it is, because the caller (the
// folder-group loop in processRenamerFolder) will move the WHOLE containing
// folder into RenamerReview once every file in it has been decided.
function processVideo_(video, matchedSubs, reviewFolder, doneFolder, dryRun) {
  var folderNote = video.topLevel ? '' : ' (inside folder "' + video.parentFolder.getName() + '")';
  var fixInstruction = video.topLevel
    ? '\n\nFix: correct the filename (add/fix the year or title) and drop it back into the Open folder — it\'ll be picked up on the next run.'
    : '\n\nThe whole folder will be moved to RenamerReview — fix the filename inside it there, then move the folder back into the Open folder to retry.';

  var seriesLabel = detectSeriesPattern_(video.name);
  if (seriesLabel) {
    return processTvEpisode_(video, matchedSubs, reviewFolder, dryRun, folderNote, fixInstruction);
  }

  var parsed = parseFilename_(video.name);
  if (!parsed.title) {
    // Fixed 2026-10-27: this used to only Logger.log (never seen unless you
    // go digging in Executions) and return - no Telegram message at all,
    // unlike every other review reason. Found on a real file ("1911
    // (2011)...") whose folder was silently moved to RenamerReview with no
    // explanation above the generic "Folder needs review" message.
    var noTitleMsg = '⚠️ Could not parse a title' + folderNote + '\nFile: ' + video.name
      + '\nNothing recognizable as a title was left after removing the year and tags from the filename.'
      + fixInstruction;
    sendToReview_(video, matchedSubs, reviewFolder, noTitleMsg, dryRun,
      '[DRY RUN] "' + video.name + '"' + folderNote + ' -> could not parse a title -> would move to RenamerReview',
      video.topLevel);
    return 'issue';
  }

  var lookup = lookupTmdbWithVariants_(parsed.title, parsed.year);

  // Fixed 2026-11-08: a filename with NO year at all ("Vilangu.mkv") is a
  // much weaker signal than usual - every other movie example has at least
  // a year to anchor on. Confirmed real case: "Vilangu" is both a 1987
  // Tamil movie AND an unrelated 2022 Tamil web series on TMDb - with no
  // year and no season/episode marker in the filename, there's genuinely
  // no way to tell which one this is from the filename alone, but the old
  // code never even looked at the TV catalog before confidently auto-
  // filing it as the movie. This can't (and never will be able to) make
  // the TV case auto-file correctly - that needs an actual season/episode
  // number present in the filename, which simply isn't there - it only
  // stops the wrong confident guess: when there's no year AND a plausible
  // match exists on BOTH sides, that's genuinely ambiguous and goes to
  // review instead of silently picking the movie. Only fires in the no-
  // year case, so the ordinary (year-present) movie path is untouched.
  var movieTvCollision = null;
  if (lookup.matched && lookup.confident && !parsed.year) {
    try {
      var tvCollisionCheck = lookupTmdbTvSingle_(parsed.title, null);
      if (tvCollisionCheck && tvCollisionCheck.matched && tvCollisionCheck.confident) {
        movieTvCollision = tvCollisionCheck.candidates[0];
      }
    } catch (e) {
      Logger.log('Movie/TV collision check failed (non-fatal, proceeding as movie): ' + e.message);
    }
  }

  if (movieTvCollision) {
    var collisionMsg = '⚠️ Ambiguous — could be a movie or a TV series' + folderNote + '\nFile: ' + video.name
      + (matchedSubs.length ? '\nSubtitle: ' + matchedSubs.map(function (s) { return s.name; }).join(', ') : '')
      + '\nNo year in the filename, and TMDb has a plausible match on both sides:'
      + '\n  Movie: ' + lookup.candidates[0].title + ' (' + lookup.candidates[0].year + ') — https://www.themoviedb.org/movie/' + lookup.candidates[0].tmdbId
      + '\n  TV series: ' + movieTvCollision.title + ' (' + movieTvCollision.year + ') — https://www.themoviedb.org/tv/' + movieTvCollision.tmdbId
      + '\nIf this is actually an episode, add a season/episode marker to the filename (e.g. "S01E05") and drop it back in — it can only be routed to TV once there is an episode number to anchor on.'
      + fixInstruction;
    sendToReview_(video, matchedSubs, reviewFolder, collisionMsg, dryRun,
      '[DRY RUN] "' + video.name + '"' + folderNote + ' -> ambiguous movie/TV collision with no year in filename -> would move to RenamerReview',
      video.topLevel);
    return 'issue';
  }

  if (lookup.matched && lookup.confident) {
    var movie = lookup.candidates[0];
    var finalBase = buildFinalBaseName_(parsed, movie);
    var folderName = sanitizeFilename_(movie.title + ' (' + movie.year + ')');

    var existing = doneFolder.getFoldersByName(folderName);
    if (existing.hasNext()) {
      // Fixed 2026-11-09: a confirmed duplicate used to land in plain
      // RenamerReview mixed in with every other kind of review case
      // (ambiguous matches, unpaired subtitles, etc). For a loose
      // top-level file — the case this is actually moved for — file it
      // into its own "Already Exist" subfolder instead, so duplicates are
      // easy to batch-review/clear separately from everything else. A
      // file inside its own release folder still moves as part of that
      // whole folder (below, via moveFolderToReview_) into plain
      // RenamerReview, same as any other issue found in that folder —
      // splitting a multi-item folder by individual issue type isn't done
      // anywhere else in this script either.
      var dupReviewFolder = video.topLevel ? getOrCreateFolder_(reviewFolder, 'Already Exist') : reviewFolder;
      var dupMsg = '⚠️ Possible duplicate' + folderNote + '\nFile: ' + video.name
        + (matchedSubs.length ? '\nSubtitle: ' + matchedSubs.map(function (s) { return s.name; }).join(', ') : '')
        + '\nMatched: ' + movie.title + ' (' + movie.year + ')'
        + '\n"' + folderName + '" already exists in the Done folder.'
        + (video.topLevel
          ? '\nMoving to RenamerReview/Already Exist instead of dropping it in alongside the existing one — check whether this is a second edition/rip you want to keep, or a true duplicate to delete.'
          : '\nThe whole folder will be moved to RenamerReview instead of dropping this in alongside the existing one.');
      sendToReview_(video, matchedSubs, dupReviewFolder, dupMsg, dryRun,
        '[DRY RUN] "' + video.name + '"' + folderNote + ' matched ' + folderName + ' but it already exists in the Done folder -> would move to RenamerReview/Already Exist (duplicate)',
        video.topLevel);
      return 'issue';
    }

    var finalVideoName = sanitizeFilename_(finalBase + '.' + video.ext);
    var subRenames = matchedSubs.map(function (s) {
      var suffix = s.langSuffix ? '.' + s.langSuffix.toLowerCase() : '';
      return { file: s.file, oldName: s.name, newName: sanitizeFilename_(finalBase + suffix + '.' + s.ext) };
    });

    if (dryRun) {
      Logger.log('[DRY RUN] "' + video.name + '"' + folderNote + ' -> Done folder: "' + folderName + '/' + finalVideoName + '"');
      subRenames.forEach(function (s) {
        Logger.log('[DRY RUN]   subtitle "' + s.oldName + '" -> "' + s.newName + '"');
      });
      return 'success';
    }

    var preMsg = '🔄 Renaming & moving' + folderNote + '\n' + video.name + '\n→ ' + folderName + '/' + finalVideoName;
    subRenames.forEach(function (s) {
      preMsg += '\n(subtitle) ' + s.oldName + '\n→ ' + folderName + '/' + s.newName;
    });
    sendTelegram_(preMsg, false);

    try {
      var destFolder = getOrCreateFolder_(doneFolder, folderName);
      video.file.setName(finalVideoName);
      video.file.moveTo(destFolder);
      subRenames.forEach(function (s) {
        s.file.setName(s.newName);
        s.file.moveTo(destFolder);
      });
      logRenameForUndo_({
        type: 'Movie',
        videoFileId: video.file.getId(),
        originalName: video.name,
        originalFolderId: video.parentFolder.getId(),
        originalFolderDisplay: video.topLevel ? 'Open' : ('Open/' + video.parentFolder.getName()),
        newName: finalVideoName,
        newFolderId: destFolder.getId(),
        newFolderDisplay: 'Done/' + folderName,
        subs: subRenames.map(function (s) { return { fileId: s.file.getId(), oldName: s.oldName, newName: s.newName }; })
      });
      Logger.log('Processed: ' + finalVideoName);
      return 'success';
    } catch (e) {
      var errMsg = '⚠️ Rename/move FAILED' + folderNote + '\n' + video.name
        + '\n(intended) → ' + folderName + '/' + finalVideoName
        + '\nError: ' + e.message
        + (video.topLevel
          ? '\nCheck the Open folder and the Done folder manually — the file may be partially moved or left behind.'
          : '\nThe folder will still be moved to RenamerReview — check inside it manually, the file may be partially moved.');
      sendTelegram_(errMsg, false);
      Logger.log('Rename/move failed for ' + video.name + ': ' + e.message + '\n' + e.stack);
      return 'issue';
    }
  } else if (lookup.candidates.length >= 1 && lookup.candidates.length <= 5) {
    // Fixed 2026-11-09: used to require 2+ candidates before offering
    // buttons (genuine multi-match ambiguity, e.g. two unrelated films
    // both titled "Paradise" the same year) — a single weak/rejected
    // candidate, the far more common review case, fell through to the
    // text-only branch below, forcing a manual retype of the exact TMDb
    // title to fix it. Now 1-5 candidates of ANY confidence get buttons -
    // tap the right one (or "None of these") instead of retyping. Only
    // falls through to text-only when there are more than 5 (too many to
    // sensibly show as buttons) or genuinely zero (nothing to tap at all).
    sendReviewWithButtons_(video, matchedSubs, reviewFolder, parsed, lookup, dryRun, video.topLevel);
    return 'issue';
  } else {
    var variantNote = '\nTried title variant(s): ' + lookup.variantsTried.map(function (v) { return '"' + v + '"'; }).join(', ');
    var simNote = (lookup.lowSimNotes && lookup.lowSimNotes.length)
      ? '\nRejected low-similarity match(es):\n' + lookup.lowSimNotes.join('\n')
      : '';
    var lines = lookup.candidates.slice(0, 5).map(function (c, i) {
      return (i + 1) + ') ' + c.title + ' (' + c.year + ') — https://www.themoviedb.org/movie/' + c.tmdbId;
    }).join('\n');
    var ambigMsg = '🎬 Needs review — no confident match' + folderNote + '\nFile: ' + video.name
      + (matchedSubs.length ? '\nSubtitle: ' + matchedSubs.map(function (s) { return s.name; }).join(', ') : '')
      + '\nParsed title: "' + parsed.title + '"'
      + (parsed.year ? ', year ' + parsed.year : ', no year found in filename')
      + variantNote
      + simNote
      + (lines ? '\nCandidates:\n' + lines : '\nNo TMDb matches found at all, even after variants.')
      + fixInstruction;
    sendToReview_(video, matchedSubs, reviewFolder, ambigMsg, dryRun,
      '[DRY RUN] "' + video.name + '"' + folderNote + ' -> would move to RenamerReview (' + lookup.candidates.length + ' candidate(s) across variants' + variantNote + simNote + ')',
      video.topLevel);
    return 'issue';
  }
}

// ---------- TV episodes ----------
//
// Mirrors processVideo_'s overall shape (parse -> match -> build name ->
// message-then-act move, or route to RenamerReview with a clear reason) but
// against TMDb's TV catalog, and with the three deliberate differences
// spelled out in the TV SHOWS header comment: series-only matching (season/
// episode numbers come from the filename), specials always reviewed
// manually, and text-only (no button) ambiguity resolution.
function processTvEpisode_(video, matchedSubs, reviewFolder, dryRun, folderNote, fixInstruction) {
  var epParsed = parseEpisodeFilename_(video.name);

  if (!epParsed) {
    // detectSeriesPattern_ matched (e.g. a bare "Season 2" or "Complete
    // Series" dump), but no precise "SxxEyy"/"NxNN" marker could be found
    // to anchor a season+episode number to. Can't safely auto-file without
    // knowing exactly which episode this is - same "don't guess" principle
    // as an unparseable movie title.
    var noEpMsg = '📺 Looks like a TV file, but no precise season/episode number found' + folderNote + '\nFile: ' + video.name
      + (matchedSubs.length ? '\nSubtitle: ' + matchedSubs.map(function (s) { return s.name; }).join(', ') : '')
      + '\nCan\'t safely auto-file without a clear "SxxEyy" (or "NxNN") marker in the name.'
      + fixInstruction;
    sendToReview_(video, matchedSubs, reviewFolder, noEpMsg, dryRun,
      '[DRY RUN] "' + video.name + '"' + folderNote + ' looks like TV but has no parseable episode number -> would move to RenamerReview',
      video.topLevel);
    return 'issue';
  }

  if (!epParsed.seriesTitle) {
    var noTitleMsg = '⚠️ Could not parse a series title' + folderNote + '\nFile: ' + video.name
      + '\nNothing recognizable as a series title was left before the season/episode marker.'
      + fixInstruction;
    sendToReview_(video, matchedSubs, reviewFolder, noTitleMsg, dryRun,
      '[DRY RUN] "' + video.name + '"' + folderNote + ' -> could not parse a series title -> would move to RenamerReview',
      video.topLevel);
    return 'issue';
  }

  if (epParsed.isSpecial) {
    // Decision (2026-11-02): Season 00 / specials always go to manual
    // review, never auto-filed - named too inconsistently across releases
    // (recaps, behind-the-scenes, OVAs) to trust blindly.
    var specialMsg = '📺 Special / Season 00 episode — routed for a manual look' + folderNote + '\nFile: ' + video.name
      + (matchedSubs.length ? '\nSubtitle: ' + matchedSubs.map(function (s) { return s.name; }).join(', ') : '')
      + '\nParsed series: "' + epParsed.seriesTitle + '", ' + episodeCode_(epParsed)
      + '\nSpecials are always sent to RenamerReview rather than auto-filed — file it manually into the right series/Season 00 folder in your TV Done location if it looks right.';
    sendToReview_(video, matchedSubs, reviewFolder, specialMsg, dryRun,
      '[DRY RUN] "' + video.name + '"' + folderNote + ' is a Season 00 special -> would move to RenamerReview (specials always reviewed manually)',
      video.topLevel);
    return 'issue';
  }

  var lookup = lookupTmdbTvCached_(epParsed.seriesTitle, epParsed.titleYear);

  if (lookup.matched && lookup.confident) {
    var series = lookup.candidates[0];
    var seriesFolderName = sanitizeFilename_(series.title + ' (' + series.year + ') [tmdbid-' + series.tmdbId + ']');
    var seasonFolderName = 'Season ' + pad2_(epParsed.season);
    var tagStr = epParsed.tags.map(function (t) { return '[' + t + ']'; }).join(' ');
    // Added 2026-11-03: the episode's own title, e.g. "Pilot" or "Ozymandias".
    // Only ever looked up for the file's STARTING episode number, even for a
    // multi-episode range (S01E01-E02 uses E01's title only) — fetching
    // every episode in a range would double the cost for a combined title
    // most releases don't carry anyway. Failure here (not-yet-aired episode,
    // a TMDb data gap, a transient error) never blocks the rename — it's
    // enrichment, not the thing that decides where the file goes, so it
    // just comes back null and the filename falls back to the no-name form.
    // Fixed 2026-11-09: for a multi-episode range (e.g. S01E01-E07), a
    // single episode's title (here, E01's) is misleading tacked onto a
    // filename that covers the whole range — so skip the title lookup
    // entirely for a range (also saves the TMDb call) and show only the
    // range code.
    var episodeName = epParsed.isMultiEpisode
      ? null
      : lookupTmdbEpisodeNameCached_(series.tmdbId, epParsed.season, epParsed.episodeStart);
    var finalBase = series.title + ' (' + series.year + ') ' + episodeCode_(epParsed)
      + (episodeName ? ' ' + episodeName : '')
      + (tagStr ? ' ' + tagStr : '');
    var finalVideoName = sanitizeFilename_(finalBase + '.' + video.ext);
    var subRenames = matchedSubs.map(function (s) {
      var suffix = s.langSuffix ? '.' + s.langSuffix.toLowerCase() : '';
      return { file: s.file, oldName: s.name, newName: sanitizeFilename_(finalBase + suffix + '.' + s.ext) };
    });

    // Read-only existence check, decided BEFORE any Telegram message goes
    // out — same timing as the movie duplicate check — so exactly one
    // message is sent (the dup notice, or the renaming notice), never both.
    // An existing SERIES or SEASON folder is the NORMAL case here (more
    // episodes of a show already underway); only an existing file with
    // this exact final name is a real duplicate.
    var existingEpFile = false;
    var tvDoneFolderForCheck = getTvDoneFolder_();
    var seriesIter = tvDoneFolderForCheck.getFoldersByName(seriesFolderName);
    if (seriesIter.hasNext()) {
      var seasonIter = seriesIter.next().getFoldersByName(seasonFolderName);
      if (seasonIter.hasNext() && seasonIter.next().getFilesByName(finalVideoName).hasNext()) {
        existingEpFile = true;
      }
    }

    if (existingEpFile) {
      // Fixed 2026-11-09: same "Already Exist" subfolder treatment as the
      // movie duplicate check above, for a loose top-level episode file -
      // see the comment there for why a folder-nested episode still goes
      // to plain RenamerReview instead.
      var dupReviewFolder = video.topLevel ? getOrCreateFolder_(reviewFolder, 'Already Exist') : reviewFolder;
      var dupMsg = '⚠️ Possible duplicate episode' + folderNote + '\nFile: ' + video.name
        + (matchedSubs.length ? '\nSubtitle: ' + matchedSubs.map(function (s) { return s.name; }).join(', ') : '')
        + '\nMatched: ' + series.title + ' ' + episodeCode_(epParsed)
        + '\n"' + finalVideoName + '" already exists in ' + seriesFolderName + '/' + seasonFolderName
        + (video.topLevel
          ? '\nMoving to RenamerReview/Already Exist instead of dropping it in alongside the existing one — check whether this is a better/duplicate rip you want to keep.'
          : '\nThe whole folder will be moved to RenamerReview instead of dropping this in alongside the existing one.');
      sendToReview_(video, matchedSubs, dupReviewFolder, dupMsg, dryRun,
        '[DRY RUN] "' + video.name + '"' + folderNote + ' matched ' + seriesFolderName + '/' + seasonFolderName + '/' + finalVideoName + ' but it already exists -> would move to RenamerReview/Already Exist (duplicate)',
        video.topLevel);
      return 'issue';
    }

    if (dryRun) {
      Logger.log('[DRY RUN] "' + video.name + '"' + folderNote + ' -> TV Done folder: "' + seriesFolderName + '/' + seasonFolderName + '/' + finalVideoName + '"');
      subRenames.forEach(function (s) { Logger.log('[DRY RUN]   subtitle "' + s.oldName + '" -> "' + s.newName + '"'); });
      return 'success';
    }

    var preMsg = '📺 Renaming & moving' + folderNote + '\n' + video.name + '\n→ ' + seriesFolderName + '/' + seasonFolderName + '/' + finalVideoName;
    subRenames.forEach(function (s) {
      preMsg += '\n(subtitle) ' + s.oldName + '\n→ ' + seriesFolderName + '/' + seasonFolderName + '/' + s.newName;
    });
    sendTelegram_(preMsg, false);

    try {
      var seriesFolder = getOrCreateFolder_(getTvDoneFolder_(), seriesFolderName);
      var seasonFolder = getOrCreateFolder_(seriesFolder, seasonFolderName);
      video.file.setName(finalVideoName);
      video.file.moveTo(seasonFolder);
      subRenames.forEach(function (s) {
        s.file.setName(s.newName);
        s.file.moveTo(seasonFolder);
      });
      logRenameForUndo_({
        type: 'TV',
        videoFileId: video.file.getId(),
        originalName: video.name,
        originalFolderId: video.parentFolder.getId(),
        originalFolderDisplay: video.topLevel ? 'Open' : ('Open/' + video.parentFolder.getName()),
        newName: finalVideoName,
        newFolderId: seasonFolder.getId(),
        newFolderDisplay: 'TV Done/' + seriesFolderName + '/' + seasonFolderName,
        subs: subRenames.map(function (s) { return { fileId: s.file.getId(), oldName: s.oldName, newName: s.newName }; })
      });
      Logger.log('Processed TV episode: ' + finalVideoName);
      return 'success';
    } catch (e) {
      var errMsg = '⚠️ Rename/move FAILED (TV episode)' + folderNote + '\n' + video.name
        + '\n(intended) → ' + seriesFolderName + '/' + seasonFolderName + '/' + finalVideoName
        + '\nError: ' + e.message
        + (video.topLevel
          ? '\nCheck the Open folder and the TV Done folder manually — the file may be partially moved or left behind.'
          : '\nThe folder will still be moved to RenamerReview — check inside it manually, the file may be partially moved.');
      sendTelegram_(errMsg, false);
      Logger.log('Rename/move failed for TV episode ' + video.name + ': ' + e.message + '\n' + e.stack);
      return 'issue';
    }
  } else if (lookup.candidates.length >= 2) {
    // Text-only, deliberately - the Telegram tap-to-resolve button flow is
    // movie-specific (finalizeReviewPick_ etc.) and intentionally not
    // extended to TV in this version. See the TV SHOWS header comment.
    var lines2 = lookup.candidates.slice(0, 5).map(function (c, i) {
      return (i + 1) + ') ' + c.title + ' (' + c.year + ')' + (c.language ? ' [' + c.language + ']' : '') + ' — https://www.themoviedb.org/tv/' + c.tmdbId;
    }).join('\n');
    var ambigMsg2 = '📺 Needs review — multiple TMDb series candidates' + folderNote + '\nFile: ' + video.name
      + (matchedSubs.length ? '\nSubtitle: ' + matchedSubs.map(function (s) { return s.name; }).join(', ') : '')
      + '\nParsed series: "' + epParsed.seriesTitle + '", ' + episodeCode_(epParsed)
      + '\nCandidates:\n' + lines2
      + fixInstruction;
    sendToReview_(video, matchedSubs, reviewFolder, ambigMsg2, dryRun,
      '[DRY RUN] "' + video.name + '"' + folderNote + ' -> would move to RenamerReview (' + lookup.candidates.length + ' series candidate(s))',
      video.topLevel);
    return 'issue';
  } else {
    var lines3 = lookup.candidates.slice(0, 5).map(function (c, i) {
      return (i + 1) + ') ' + c.title + ' (' + c.year + ') — https://www.themoviedb.org/tv/' + c.tmdbId;
    }).join('\n');
    var simNote2 = lookup.lowSimNotes && lookup.lowSimNotes.length
      ? '\nRejected low-similarity match(es):\n' + lookup.lowSimNotes.join('\n')
      : '';
    var ambigMsg3 = '📺 Needs review — no confident series match' + folderNote + '\nFile: ' + video.name
      + (matchedSubs.length ? '\nSubtitle: ' + matchedSubs.map(function (s) { return s.name; }).join(', ') : '')
      + '\nParsed series: "' + epParsed.seriesTitle + '", ' + episodeCode_(epParsed)
      + simNote2
      + (lines3 ? '\nCandidates:\n' + lines3 : '\nNo TMDb TV matches found at all, even after variants.')
      + fixInstruction;
    sendToReview_(video, matchedSubs, reviewFolder, ambigMsg3, dryRun,
      '[DRY RUN] "' + video.name + '"' + folderNote + ' -> would move to RenamerReview (no confident series match)',
      video.topLevel);
    return 'issue';
  }
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

function episodeCode_(epParsed) {
  return 'S' + pad2_(epParsed.season) + 'E' + pad2_(epParsed.episodeStart)
    + (epParsed.isMultiEpisode ? '-E' + pad2_(epParsed.episodeEnd) : '');
}

// Primary: "SxxEyy", optionally a range ("SxxEyy-Ezz" or "SxxEyy-zz").
// Fallback: legacy "NxNN" (e.g. "1x05") - no range support for this one,
// it's rare enough in practice not to be worth the extra complexity.
var EPISODE_PATTERNS_ = [
  // Fixed 2026-11-03 (mirrors the SERIES_PATTERNS fix above, same reason):
  // tolerates a space before "E"/"EP", an "EP" instead of bare "E", a
  // space before the episode number, and optional spaces around the
  // range dash - e.g. "S01 EP 08", "S01EP08", "S01 E08-EP10". Capture
  // group numbering (1=season, 2=epStart, 3=epEnd) is unchanged, and
  // every filename that matched the old tight "S01E08" form still
  // matches identically since this is a strict superset of it. Extended
  // 2026-11-03 to also allow a space right after "S" ("S 01 E 01").
  //
  // Fixed 2026-11-08: the range-closing side couldn't handle a repeated
  // season marker - "S01E01 - S01E07" (confirmed real release: a 7-
  // episode dump in one file). The old pattern's closing group only
  // expected an optional bare "E"/"EP" then digits; faced with "- S01E07"
  // it matched zero characters at that position (since the very next char
  // was "S", not a digit), so the ENTIRE 7-episode file silently got
  // treated as a single "S01E01" and filed under episode 1's title alone
  // - episodes 2-7 vanished from the output with no warning. The closing
  // group now optionally skips a repeated "S<digits>" (season number not
  // re-validated against the opening one - trusts the release is
  // internally consistent, same risk tolerance as the rest of this file)
  // before the E/EP + digits. Strict superset again: every previously-
  // working range form ("S01E01-E03", "S01E01-03") still matches exactly
  // the same way.
  /S\s*(\d{1,2})\s*EP?\s*(\d{1,3})(?:\s*-\s*(?:S\s*\d{1,2}\s*)?E?P?\s*(\d{1,3}))?/i,
  // Added 2026-11-03: the fully-spelled-out word form - "Season 01
  // Episode 01", with or without leading zeros on either number
  // independently ("Season 1 Episode 01", "Season 01 Episode 1", etc.).
  // SERIES_PATTERNS already recognized the bare word "Season N" for
  // TV/movie routing, but nothing here could actually pull the episode
  // number back out of this form - so a file named this way was
  // correctly detected as "looks like TV" and then immediately failed to
  // parse, landing in RenamerReview every single time instead of being
  // auto-filed. Tried before the "NxNN" fallback since it's unambiguous
  // and more specific.
  /Season\s*(\d{1,2})\s*Episode\s*(\d{1,3})(?:\s*-\s*Episode\s*(\d{1,3}))?/i,
  /\b(\d{1,2})x(\d{1,3})\b/
];

// Mirrors parseFilename_'s preprocessing chain exactly (strip extension,
// decode HTML entities, strip a site prefix) and then splits on the
// episode marker instead of on a year - everything before it is the
// series title (+ any leading bracket tags, dropped same as a movie's
// leading tags), everything after it is release tags (resolution/source/
// codec/audio/language), filtered through the SAME STANDARD_TAG_PATTERNS_
// whitelist movies use. Returns null when no EPISODE_PATTERNS_ marker is
// found at all - the caller treats that as "looks TV-like but unparseable
// precise episode", not a hard failure.
function parseEpisodeFilename_(fullName) {
  var base = stripExtension_(fullName);
  var ext = getExtension_(fullName);
  base = decodeHtmlEntities_(base);
  base = stripSitePrefix_(base);

  var epMatch = null;
  for (var p = 0; p < EPISODE_PATTERNS_.length; p++) {
    var m = EPISODE_PATTERNS_[p].exec(base);
    if (m) { epMatch = m; break; }
  }
  if (!epMatch) return null;

  var season = parseInt(epMatch[1], 10);
  var epStart = parseInt(epMatch[2], 10);
  var epEnd = epMatch[3] ? parseInt(epMatch[3], 10) : epStart;

  var beforeMarker = base.substring(0, epMatch.index);
  var afterMarker = base.substring(epMatch.index + epMatch[0].length);

  var titlePart = beforeMarker.replace(/\[([^\[\]]+)\]/g, '').trim();

  // Strip a parenthetical or bare year, if present, before it reaches
  // TMDb as query text - left in, it's a spurious extra token in
  // tokenOverlap_'s Jaccard score, able to drag a genuinely correct match
  // below SIMILARITY_THRESHOLD for no real reason. Confirmed on "Sacred
  // Games (2018) S01E01...": left in, the score was 0.67 - barely above
  // the 0.65 cutoff by sheer luck; one word longer on either side and it
  // would have wrongly landed in RenamerReview as "no confident match".
  //
  // Fixed 2026-11-03: the year used to just be thrown away here, on the
  // stated assumption that "TV release names rarely carry a year, and
  // when they do it's not load-bearing." That assumption is simply wrong
  // for releases that DO carry one - e.g. "Mahabharat (2013) S01E01.mkv"
  // - where TMDb has 3+ series all literally named "Mahabharat" (1988,
  // unknown-date, 2013) and title-similarity alone can never tell them
  // apart. Capture it as titleYear below and thread it through to
  // lookupTmdbTvCached_, which now uses it as a tiebreaker exactly the
  // way the movie path already did (see lookupTmdbSingle_) - an
  // unambiguous year match among several same-titled strong candidates
  // becomes a confident auto-match instead of an unnecessary review.
  var titleYearMatch = titlePart.match(/\(((?:19|20)\d{2})\)/) || titlePart.match(/\b((?:19|20)\d{2})\b/);
  var titleYear = titleYearMatch ? titleYearMatch[1] : null;
  if (titleYearMatch) {
    titlePart = (titlePart.substring(0, titleYearMatch.index) + titlePart.substring(titleYearMatch.index + titleYearMatch[0].length)).trim();
  }

  var tags = [];
  var tagRegex = /\[([^\[\]]+)\]/g;
  var m2;
  while ((m2 = tagRegex.exec(afterMarker)) !== null) tags.push(m2[1]);
  var afterDashPart = afterMarker.replace(/\[([^\[\]]+)\]/g, '').trim();
  if (afterDashPart) {
    tags = tags.concat(afterDashPart.split(/\s+-\s+/)
      .map(function (t) { return t.trim(); })
      .filter(function (t) { return t.length > 0; }));
  }

  var seriesTitle = titlePart
    .replace(/[._]/g, ' ')
    .replace(/\s*-\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  tags = tags.map(filterStandardTag_).filter(function (t) { return t && t.length > 0; });

  return {
    seriesTitle: seriesTitle,
    titleYear: titleYear,
    season: season,
    episodeStart: epStart,
    episodeEnd: epEnd,
    isMultiEpisode: epEnd !== epStart,
    isSpecial: season === 0,
    tags: tags,
    ext: ext
  };
}

// ---------- TV TMDb lookup ----------
//
// Series-only - deliberately never called per-episode. lookupTmdbTvCached_
// is the only entry point processTvEpisode_ uses; it's what makes a whole
// season's worth of episodes cost one search + one details call per run.

function lookupTmdbTvCached_(seriesTitle, year) {
  var key = normalizeTitle_(seriesTitle) + '_' + (year || '');
  if (Object.prototype.hasOwnProperty.call(g_tvSeriesCache, key)) return g_tvSeriesCache[key];
  var result = lookupTmdbTvWithVariants_(seriesTitle, year);
  g_tvSeriesCache[key] = result;
  return result;
}

function lookupTmdbTvWithVariants_(title, year) {
  var variants = titleVariants_(title);
  var candidateMap = {};
  var lowSimNotes = [];

  for (var i = 0; i < variants.length; i++) {
    var result = lookupTmdbTvSingle_(variants[i], year);
    if (result.confident) {
      return { matched: true, confident: true, candidates: result.candidates, variantsTried: variants.slice(0, i + 1), lowSimNotes: [] };
    }
    if (result.lowSimilarity) {
      lowSimNotes.push('"' + variants[i] + '" vs TMDb "' + result.lowSimilarity.title + '" — similarity '
        + result.lowSimilarity.score.toFixed(2) + ' (below ' + SIMILARITY_THRESHOLD + ')');
    }
    result.candidates.forEach(function (c) { candidateMap[c.tmdbId] = c; });
  }

  var merged = [];
  for (var key in candidateMap) { merged.push(candidateMap[key]); }
  return { matched: false, confident: false, candidates: merged.slice(0, 5), variantsTried: variants, lowSimNotes: lowSimNotes };
}

// Fixed 2026-11-03: used to have no same-year pre-filter at all, on the
// (wrong, for releases that DO carry a year) assumption that TV filenames
// rarely have one. Now mirrors lookupTmdbSingle_ (movies) exactly when a
// year IS available: pass it to TMDb's own first_air_date_year filter,
// THEN re-filter client-side by actual first_air_date year (TMDb's year
// param is occasionally loose), falling back to the full pool only if
// literally nothing matched that year, THEN score by title similarity on
// that narrowed pool - same-year alone is never enough on its own (several
// unrelated shows can share a year), it has to also look similar. When no
// year was parsed from the filename, behavior is completely unchanged
// from before.
function lookupTmdbTvSingle_(title, year) {
  var key = requireProp_('TMDB_API_KEY');
  var url = 'https://api.themoviedb.org/3/search/tv?api_key=' + encodeURIComponent(key)
    + '&query=' + encodeURIComponent(title)
    + '&include_adult=false'
    + (year ? '&first_air_date_year=' + encodeURIComponent(year) : '');

  var res = safeFetchJson_(url);
  if (!res || !res.results || res.results.length === 0) {
    return { matched: false, confident: false, candidates: [] };
  }
  var results = res.results;

  if (year) {
    var sameYear = results.filter(function (r) {
      return r.first_air_date && r.first_air_date.substring(0, 4) === String(year);
    });
    var pool = sameYear.length > 0 ? sameYear : results;

    var scoredY = pool.map(function (r) { return { r: r, score: tokenOverlap_(title, r.name) }; });
    var strongY = scoredY.filter(function (x) { return x.score >= SIMILARITY_THRESHOLD; });

    if (strongY.length === 1) {
      return { matched: true, confident: true, candidates: [enrichTmdbTv_(strongY[0].r)] };
    }
    if (strongY.length > 1) {
      // Genuinely 2+ textually-plausible same-year candidates — real
      // ambiguity, not search noise. Stays a review case, same as before.
      return { matched: false, confident: false, candidates: strongY.map(function (x) { return toTvCandidate_(x.r); }).slice(0, 5) };
    }
    var bestY = scoredY.slice().sort(function (a, b) { return b.score - a.score; })[0];
    return {
      matched: false, confident: false,
      candidates: pool.slice(0, 5).map(toTvCandidate_),
      lowSimilarity: bestY ? { title: bestY.r.name, score: bestY.score } : null
    };
  }

  var scored = results.map(function (r) { return { r: r, score: tokenOverlap_(title, r.name) }; });
  var strong = scored.filter(function (x) { return x.score >= SIMILARITY_THRESHOLD; });

  if (strong.length === 1) {
    return { matched: true, confident: true, candidates: [enrichTmdbTv_(strong[0].r)] };
  }
  if (strong.length > 1) {
    return { matched: false, confident: false, candidates: strong.map(function (x) { return toTvCandidate_(x.r); }).slice(0, 5) };
  }
  var best = scored.slice().sort(function (a, b) { return b.score - a.score; })[0];
  return {
    matched: false, confident: false,
    candidates: results.slice(0, 5).map(toTvCandidate_),
    lowSimilarity: best ? { title: best.r.name, score: best.score } : null
  };
}

// Called once per unique series per run (see lookupTmdbTvCached_), never
// per episode.
function enrichTmdbTv_(r) {
  var key = requireProp_('TMDB_API_KEY');
  var url = 'https://api.themoviedb.org/3/tv/' + r.id + '?api_key=' + encodeURIComponent(key);
  var full = safeFetchJson_(url);
  return {
    title: (full && full.name) || r.name,
    year: r.first_air_date ? r.first_air_date.substring(0, 4) : '????',
    tmdbId: r.id
  };
}

function lookupTmdbEpisodeNameCached_(seriesId, season, episode) {
  var key = seriesId + '_S' + season + 'E' + episode;
  if (Object.prototype.hasOwnProperty.call(g_tvEpisodeNameCache, key)) return g_tvEpisodeNameCache[key];
  var name = lookupTmdbEpisodeName_(seriesId, season, episode);
  g_tvEpisodeNameCache[key] = name;
  return name;
}

// One lightweight DETAILS call per episode — not a search/match call, so it
// doesn't reintroduce the per-episode-ambiguity risk the "series match
// only" design (2026-11-02) deliberately avoided; this only ever runs
// after the series is already confidently identified, purely to fetch that
// one episode's title text. Deliberately swallows every failure and
// returns null rather than throwing (unlike safeFetchJson_'s normal
// behavior, and unlike the series-level match) — a missing/not-yet-aired
// episode or a transient TMDb error would otherwise permanently strand an
// otherwise-correct episode in RenamerReview for a problem that isn't
// really one; the episode still gets filed correctly, just without a name
// in the filename for that one file.
function lookupTmdbEpisodeName_(seriesId, season, episode) {
  try {
    var key = requireProp_('TMDB_API_KEY');
    var url = 'https://api.themoviedb.org/3/tv/' + seriesId + '/season/' + season + '/episode/' + episode
      + '?api_key=' + encodeURIComponent(key);
    var res = safeFetchJson_(url);
    return (res && res.name) ? res.name : null;
  } catch (e) {
    Logger.log('Episode name lookup failed (non-fatal) for series ' + seriesId + ' S' + season + 'E' + episode + ': ' + e.message);
    return null;
  }
}

function toTvCandidate_(r) {
  return {
    title: r.name,
    year: r.first_air_date ? r.first_air_date.substring(0, 4) : '????',
    tmdbId: r.id,
    language: languageName_(r.original_language),
    overview: (r.overview || '').trim()
  };
}

// ---------- multi-candidate review: Telegram inline-button resolution ----------
//
// Used only when lookupTmdbWithVariants_ found 2+ genuinely distinct TMDb
// movies (not the single-weak-match case, which stays text-only/manual —
// deliberately out of scope here). The file is moved to RenamerReview same
// as any other review item; a pending record keyed by a short token is
// stashed in Script Properties so that whenever you tap a button — minutes
// or days later — doPost() can look up exactly what to rename/move without
// needing anything re-parsed or re-guessed.

var BUTTON_TEXT_MAX = 60;

function truncateButtonText_(s) {
  return s.length > BUTTON_TEXT_MAX ? s.substring(0, BUTTON_TEXT_MAX - 1) + '…' : s;
}

// moveFileNow (default true): when false (a folder-sourced video), the
// button message/pending record are still created exactly as normal — a
// tap still works, any time later, the same way — but the physical Drive
// move is skipped here. The caller (folder-group processing) moves the
// WHOLE containing folder into RenamerReview instead, carrying this
// not-yet-resolved file along inside it. finalizeReviewPick_ (the button
// handler) doesn't care either way: it finds the file by ID regardless of
// which folder currently contains it.
function sendReviewWithButtons_(video, matchedSubs, reviewFolder, parsed, lookup, dryRun, moveFileNow) {
  if (moveFileNow === undefined) moveFileNow = true;
  var folderNote = video.topLevel ? '' : ' (inside folder "' + video.parentFolder.getName() + '")';
  var candidates = lookup.candidates.slice(0, 5);
  var variantNote = '\nTried title variant(s): ' + lookup.variantsTried.map(function (v) { return '"' + v + '"'; }).join(', ');
  // Fixed 2026-11-09: this message now also covers the "1 weak/rejected
  // candidate" case (see the call site), not just genuine multi-match
  // ambiguity, so the header can no longer claim "multiple real matches"
  // unconditionally, and the same low-similarity rejection context the
  // old text-only path showed needs to carry over here too - otherwise
  // switching this case to buttons would silently lose it.
  var simNote = (lookup.lowSimNotes && lookup.lowSimNotes.length)
    ? '\nRejected low-similarity match(es):\n' + lookup.lowSimNotes.join('\n')
    : '';
  var lines = candidates.map(function (c, i) {
    return (i + 1) + ') ' + c.title + ' (' + c.year + ') [' + c.language + ']'
      + (c.overview ? ' — ' + (c.overview.length > 140 ? c.overview.substring(0, 140) + '…' : c.overview) : '')
      + '\n   https://www.themoviedb.org/movie/' + c.tmdbId;
  }).join('\n');
  var text = '🎬 Needs review — tap the right one below, or "None of these"' + folderNote + '\nFile: ' + video.name
    + (matchedSubs.length ? '\nSubtitle: ' + matchedSubs.map(function (s) { return s.name; }).join(', ') : '')
    + '\nParsed title: "' + parsed.title + '"'
    + (parsed.year ? ', year ' + parsed.year : ', no year found in filename')
    + variantNote
    + simNote
    + '\n\n' + lines
    + '\n\nTap a button below to rename & file it — works any time, even days from now.'
    + (moveFileNow
      ? '\n(Or: fix the filename yourself and drop it back into the Open folder if none of these are right and the buttons don\'t work for some reason.)'
      : '\n(The whole folder this came from is being moved to RenamerReview along with this message\'s pending choice.)');

  if (dryRun) {
    Logger.log('[DRY RUN] "' + video.name + '"' + folderNote + ' -> would move to RenamerReview with ' + candidates.length
      + ' button option(s)' + variantNote + '\n' + lines);
    matchedSubs.forEach(function (s) { Logger.log('[DRY RUN]   subtitle "' + s.name + '" would move with it'); });
    return;
  }

  var token = newReviewToken_();
  var keyboard = candidates.map(function (c, i) {
    return [{ text: truncateButtonText_((i + 1) + ') ' + c.title + ' (' + c.year + ') [' + c.language + ']'), callback_data: 'rr|' + token + '|' + i }];
  });
  keyboard.push([{ text: '🚫 None of these', callback_data: 'rr|' + token + '|skip' }]);

  var sent = sendTelegramKeyboard_(text, keyboard);
  if (!sent) {
    Logger.log('Telegram send with buttons failed for ' + video.name + ' — leaving in the Open folder for next run.');
    return;
  }

  // When moveFileNow is false, the video came from inside its own folder
  // (e.g. "Bad Girl (2025)/Bad Girl...mkv"), and that whole folder is about
  // to be moved into RenamerReview intact by the folder-group caller. Once a
  // button tap later pulls the video (and subs) back out of it via
  // finalizeReviewPick_, that original folder is left behind sitting in
  // RenamerReview — not scanned by anything else, so nothing ever cleans it
  // up on its own. Recording its ID here lets finalizeReviewPick_ check,
  // right after a successful move, whether it's now empty and sweep it into
  // RenamerReview/Empty itself, the same way an ordinary empty release
  // folder is handled. Null when moveFileNow is true (a loose top-level
  // file has no containing folder to track).
  var pending = getPendingReviews_();
  pending[token] = {
    videoFileId: video.file.getId(),
    videoName: video.name,
    videoExt: video.ext,
    videoParentFolderId: (!moveFileNow && video.parentFolder) ? video.parentFolder.getId() : null,
    subs: matchedSubs.map(function (s) {
      return { fileId: s.file.getId(), name: s.name, ext: s.ext, langSuffix: s.langSuffix };
    }),
    tags: parsed.tags,
    candidates: candidates.map(function (c) { return { tmdbId: c.tmdbId, title: c.title, year: c.year }; }),
    chatId: sent.chatId,
    messageId: sent.messageId,
    createdAt: Date.now()
  };
  setPendingReviews_(pending);

  if (!moveFileNow) return; // folder-group caller will move the whole folder instead

  try {
    video.file.moveTo(reviewFolder);
    matchedSubs.forEach(function (s) { s.file.moveTo(reviewFolder); });
    Logger.log('Moved to RenamerReview (awaiting button tap): ' + video.name);
  } catch (e) {
    sendTelegram_('⚠️ Move to RenamerReview FAILED\n' + video.name
      + '\nError: ' + e.message
      + '\nThe buttons above still reference this file by ID, so they may not work until it\'s back in a folder the script can find — check manually.', false);
    Logger.log('Move to review (buttoned) failed for ' + video.name + ': ' + e.message + '\n' + e.stack);
  }
}

function newReviewToken_() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 10);
}

function getPendingReviews_() {
  var raw = getProp_('PENDING_REVIEWS');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function setPendingReviews_(obj) {
  PropertiesService.getScriptProperties().setProperty('PENDING_REVIEWS', JSON.stringify(obj));
}

// moveFileNow (default true): false for a folder-sourced video — the
// message is still sent exactly the same, but the individual file is left
// untouched; the caller moves the whole containing folder instead.
function sendToReview_(video, matchedSubs, reviewFolder, message, dryRun, dryRunLogLine, moveFileNow) {
  if (moveFileNow === undefined) moveFileNow = true;
  if (dryRun) {
    Logger.log(dryRunLogLine);
    matchedSubs.forEach(function (s) { Logger.log('[DRY RUN]   subtitle "' + s.name + '" would move with it'); });
    return;
  }

  sendTelegram_(message, false);
  if (!moveFileNow) return; // folder-group caller will move the whole folder instead

  try {
    video.file.moveTo(reviewFolder);
    matchedSubs.forEach(function (s) { s.file.moveTo(reviewFolder); });
    Logger.log('Moved to RenamerReview: ' + video.name);
  } catch (e) {
    var errMsg = '⚠️ Move to RenamerReview FAILED\n' + video.name
      + (matchedSubs.length ? '\nSubtitle: ' + matchedSubs.map(function (s) { return s.name; }).join(', ') : '')
      + '\nError: ' + e.message
      + '\nFile may still be in the Open folder, or partially moved — check manually.';
    sendTelegram_(errMsg, false);
    Logger.log('Move to review failed for ' + video.name + ': ' + e.message + '\n' + e.stack);
  }
}

// ---------- orphan subtitles ----------

function handleOrphanSubtitles_(subtitles, usedSubtitleIds, dryRun) {
  var orphans = subtitles.filter(function (s) { return !usedSubtitleIds[s.file.getId()]; });
  if (orphans.length === 0) return;

  var notified = getNotifiedOrphanIds_();
  var stillOrphanIds = {};

  for (var i = 0; i < orphans.length; i++) {
    if (timeRunningOut_()) {
      Logger.log('Approaching the execution time limit — stopping orphan-subtitle notices early.');
      break;
    }
    var s = orphans[i];
    var id = s.file.getId();
    stillOrphanIds[id] = true;
    if (notified[id]) continue; // already told you about this one

    var msg = '⚠️ Orphan subtitle — no matching video\nFile: ' + s.name
      + '\nNo video in the Open folder matched this subtitle\'s name this run.'
      + ' Left in place — if a matching video turns up later it\'ll be picked up automatically.'
      + ' If this file doesn\'t belong here, remove it manually.';
    if (dryRun) {
      Logger.log('[DRY RUN] would send orphan-subtitle notice for: ' + s.name);
    } else {
      sendTelegram_(msg, false);
      Logger.log('Orphan subtitle flagged: ' + s.name);
    }
  }

  if (!dryRun) setNotifiedOrphanIds_(stillOrphanIds);
}

function getNotifiedOrphanIds_() {
  var raw = getProp_('NOTIFIED_ORPHAN_IDS');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function setNotifiedOrphanIds_(obj) {
  PropertiesService.getScriptProperties().setProperty('NOTIFIED_ORPHAN_IDS', JSON.stringify(obj));
}

// ---------- series detection ----------

function detectSeriesPattern_(name) {
  for (var i = 0; i < SERIES_PATTERNS.length; i++) {
    if (SERIES_PATTERNS[i].re.test(name)) return SERIES_PATTERNS[i].label;
  }
  return null;
}

// ---------- filename parsing ----------

// Some sites/scrapers save literal HTML entities into the filename itself
// (not just "&" but occasionally "&amp;", "&quot;", etc. — almost always
// from a page title that was HTML-escaped once too many times upstream).
// Decode the common ones before anything else touches the name, so the
// renamed output never carries literal "&amp;" text. Safe either way: if
// the real filename already just has a plain "&", there's nothing here to
// match and this is a no-op.
function decodeHtmlEntities_(s) {
  return (s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function parseFilename_(fullName) {
  var base = stripExtension_(fullName);
  var ext = getExtension_(fullName);

  base = decodeHtmlEntities_(base);
  base = stripSitePrefix_(base);

  var year = null;
  var beforeYearBase = base;
  var afterYearBase = '';
  // Fixed 2026-10-28: some releases put the YEAR itself inside a [bracket]
  // instead of (parentheses) - e.g. "Roja [1992] 1080p HD - AVC - x264 -
  // 2.3GB - Tamil][Thangamey].mkv". The bracket-tag stripping below treats
  // EVERY [...] group as an opaque, meaningless tag, with no idea one of
  // them IS the year - so it got swallowed and removed before year
  // extraction (further down) ever got a chance to look for it. With the
  // year already gone from the string, nothing year-shaped was left to
  // find, so the whole rest of the filename - title, quality, size,
  // language, even a stray unmatched "]" - got glued into "title" as one
  // unparseable blob, matching nothing on TMDb. Look for a bracket-year
  // FIRST, before any other bracket is touched, and split `base` around it
  // exactly like an inline (Year) is split below: everything before it is
  // the title side, everything after it is the tag side, and each side's
  // OWN brackets/dashes are stripped independently afterward. When no
  // bracket-year exists, beforeYearBase stays the whole base and
  // afterYearBase stays '' - which reduces every single step below to
  // exactly what it did before this change, so the normal
  // parentheses-or-bare-year filenames are completely unaffected.
  var bracketYearMatch = base.match(/\[((?:19|20)\d{2})\]/);
  if (bracketYearMatch) {
    year = bracketYearMatch[1];
    beforeYearBase = base.substring(0, bracketYearMatch.index);
    afterYearBase = base.substring(bracketYearMatch.index + bracketYearMatch[0].length);
  }

  var tags = [];
  var tagRegex = /\[([^\[\]]+)\]/g;
  var m;
  while ((m = tagRegex.exec(beforeYearBase)) !== null) {
    tags.push(m[1]);
  }
  while ((m = tagRegex.exec(afterYearBase)) !== null) {
    tags.push(m[1]);
  }
  var head = beforeYearBase.replace(/\[([^\[\]]+)\]/g, '').trim();
  var afterYear = afterYearBase.replace(/\[([^\[\]]+)\]/g, '').trim();
  // Stripping a bracket that sat between two dash-separators (e.g.
  // "AVC - [Tamil + Telugu + Hindi] - (DD+5.1...") leaves the two dashes
  // that used to flank it now sitting next to each other with nothing but
  // whitespace between — collapse any such run of 2+ dash-separators back
  // into one clean " - " so the dash-tag split below doesn't pick up a
  // stray leading "-" on the next tag. A single legitimate separator, or a
  // compound hyphen with no surrounding space (HC-ESub, x264-GROUP), never
  // matches this (it requires 2+ dash-groups in a row), so neither is
  // affected. Applied to both sides independently since either one's
  // brackets may have sat between two dashes.
  head = head.replace(/(\s*-\s*){2,}/g, ' - ').trim();
  afterYear = afterYear.replace(/(\s*-\s*){2,}/g, ' - ').trim();

  // Only look for an inline year if a bracket-year wasn't already found
  // above. Prefer a PARENTHESIZED year - (2011), not bare 2011 - over a
  // bare one, and only fall back to a bare year if no parenthesized one
  // exists at all. Fixed 2026-10-27: the old pattern (/\(?...\)?/, parens
  // optional on both ends) matched the FIRST year-shaped 4-digit number
  // anywhere, parens or not - so a real movie whose own title IS a
  // year-shaped number, e.g. "1911 (2011) ...", got "1911" read as the year
  // (it's the first match, bare, before the real "(2011)"), leaving the
  // title empty. Every real filename seen in this project always
  // parenthesizes the actual release year, so checking for that first and
  // only falling back to a bare match when no parenthesized year exists at
  // all fixes this with no regression for the normal case.
  if (!year) {
    var yearMatch = head.match(/\(((?:19|20)\d{2})\)/);
    if (!yearMatch) yearMatch = head.match(/\b((?:19|20)\d{2})\b/);
    if (yearMatch) {
      year = yearMatch[1];
      afterYear = head.substring(yearMatch.index + yearMatch[0].length).trim();
      head = head.substring(0, yearMatch.index).trim();
    }
  }

  // Capture whatever's left after the year as additional dash-separated
  // tags (e.g. TamilMV-style "Title (Year) Tamil HDRip - 1080p - x265 -
  // HEVC - AAC - 1.6GB - HC-ESub", with no brackets at all) instead of
  // silently discarding it. Runs whether or not bracket tags were already
  // found above — fixed 2026-10-27: it used to only run when there were
  // ZERO bracket tags, so a release mixing one [bracket] tag with extra
  // plain dash-separated info outside it (e.g. "... (2026) TRUE WEB-DL -
  // 720p - AVC - [Tamil + Telugu + Hindi] - (DD+5.1 - 192Kbps)") silently
  // lost everything except the bracket content: 720p, AVC, WEB-DL, and the
  // audio tag all vanished from the renamed file. In a purely
  // bracket-tagged release (the originally-designed format), every
  // meaningful token is already inside a bracket and stripped out above,
  // so `afterYear` is normally empty by this point and this adds nothing —
  // no regression for that format.
  if (afterYear) {
    // Split only on a dash with space on BOTH sides — a bare hyphen with no
    // surrounding space is almost always part of one tag (HC-ESub, x264-GROUP),
    // not a separator between two tags.
    var dashTags = afterYear.split(/\s+-\s+/)
      .map(function (t) { return t.trim(); })
      .filter(function (t) { return t.length > 0; });
    tags = tags.concat(dashTags);
  }

  var title = head
    .replace(/[._]/g, ' ')
    .replace(/\s*-\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Keep only standard quality tokens (resolution/source/codec/audio/
  // visual-edition — the exact reference list the user supplied
  // 2026-10-27) and drop everything else: language labels, file size,
  // release-group/site noise, soft-subtitle markers, HQ/quality-tier
  // adjectives that aren't on the list. Applies to every tag regardless
  // of whether it came from a [bracket] or a dash-separated chunk — see
  // STANDARD_TAG_PATTERNS_ below for exactly what counts as standard.
  tags = tags
    .map(filterStandardTag_)
    .filter(function (t) { return t && t.length > 0; });

  return { title: title, year: year, tags: tags, ext: ext };
}

// ---------- standard-tags-only filter (added 2026-10-27, user-specified) ----------

// Ordered so a longer/more specific pattern is tried before a shorter one
// it could otherwise be mistaken inside (DTS-HD before bare DTS, WEB-DL
// before a hypothetical bare WEB, HDR10 before bare HDR, H.264/H264
// before AVC's own distinct pattern, etc.). Every pattern is \b-bounded
// so e.g. bare "HD" never matches inside "HDTV" or "HDRip", and bare "DC"
// or "TS" only match as their own standalone word, not as a substring of
// something else.
var STANDARD_TAG_PATTERNS_ = [
  // Resolution & quality
  /\b480p\b/i, /\b720p\b/i, /\b1080p\b/i, /\b1440p\b/i, /\b2160p\b/i,
  /\bSD\b/i, /\bHD\b/i, /\bFHD\b/i, /\bQHD\b/i, /\bUHD\b/i, /\b4K\b/i, /\b8K\b/i,
  // Source — added 2026-10-27 on request: HDRip (the single most common
  // source tag in this user's actual TamilMV files, missing from their
  // original reference list) + Blu-Ray (bare) + Screener/SCR, the other
  // common source terms that reference list also left out.
  /\bCAMRip\b/i, /\bCAM\b/i, /\bTelesync\b/i, /\bTS\b/i, /\bWorkprint\b/i, /\bWP\b/i,
  /\bHC\b/i, /\bWEB-?DL\b/i, /\bWEBRip\b/i, /\bHDRip\b/i, /\bHDTV\b/i, /\bPDTV\b/i,
  /\bDSRip\b/i, /\bDSR\b/i, /\bDVDRip\b/i, /\bBDRip\b/i, /\bBRRip\b/i,
  /\bBlu-?Ray\b/i, /\bScreener\b/i, /\bSCR\b/i, /\bREMUX\b/i,
  // Codec
  /\bH\.?264\b/i, /\bx264\b/i, /\bAVC\b/i,
  /\bH\.?265\b/i, /\bx265\b/i, /\bHEVC\b/i,
  /\bAV1\b/i, /\bXviD\b/i, /\bDivX\b/i,
  // Audio layout & codec — added 2026-10-27 on request: MP3 (missing from
  // the reference list despite being in the user's own original example
  // filename) + FLAC/PCM/LPCM (other common lossless/legacy codecs that
  // list also left out) + DDP (the alternate spelling of DD+/E-AC3 seen
  // constantly in the wild as "DDP5.1") + Dual/Multi Audio (very relevant
  // for this user's multi-language library specifically).
  /\b2\.0\b/, /\b5\.1\b/, /\b7\.1\b/,
  /\bE-?AC3\b/i, /\bDDP(?![A-Za-z])/i, /\bDD\+?(?![A-Za-z])/i, /\bAC3\b/i, /\bAAC\b/i, /\bMP3\b/i,
  /\bFLAC\b/i, /\bLPCM\b/i, /\bPCM\b/i,
  /\bTrueHD\b/i, /\bDTS-?HD(\s*MA)?\b/i, /\bDTS\b/i, /\bAtmos\b/i,
  /\bDual[\s-]?Audio\b/i, /\bMulti[\s-]?Audio\b/i,
  // Visual & edition
  /\bHDR10\b/i, /\bHDR\b/i, /\bDoVi\b/i, /\bDV\b/i, /\bSDR\b/i,
  /\b10bit\b/i, /\b8bit\b/i, /\bIMAX\b/i,
  /\bPROPER\b/i, /\bREPACK\b/i, /\bEXTENDED\b/i, /\bUNRATED\b/i, /\bDC\b/i,
  // Language — added 2026-10-27 on request. Full names are low-risk (very
  // unlikely to collide with anything else in a filename). Short 2-letter
  // codes are genuinely risky (e.g. "It"=Italian, "No"=Norwegian, "Or"=
  // Odia, "As"=Assamese, "Hi" as a stray greeting are all common English
  // words/abbreviations too), so only the codes this user's own files
  // actually use are included, deliberately leaving out the
  // higher-collision ones for languages that don't come up in this
  // library — full names below still catch those if they ever appear
  // spelled out instead of as a 2-letter code.
  /\bEnglish\b/i, /\bTamil\b/i, /\bTelugu\b/i, /\bHindi\b/i, /\bMalayalam\b/i,
  /\bKannada\b/i, /\bBengali\b/i, /\bPunjabi\b/i, /\bMarathi\b/i, /\bGujarati\b/i,
  /\bUrdu\b/i, /\bOdia\b/i, /\bAssamese\b/i, /\bFrench\b/i, /\bSpanish\b/i,
  /\bGerman\b/i, /\bItalian\b/i, /\bPortuguese\b/i, /\bRussian\b/i, /\bJapanese\b/i,
  /\bKorean\b/i, /\bChinese\b/i, /\bMandarin\b/i, /\bArabic\b/i, /\bTurkish\b/i,
  /\bThai\b/i, /\bVietnamese\b/i, /\bIndonesian\b/i, /\bDutch\b/i, /\bPolish\b/i,
  /\bEn\b/i, /\bTa\b/i, /\bTe\b/i, /\bHi\b/i, /\bMl\b/i, /\bKn\b/i, /\bBn\b/i,
  /\bMr\b/i, /\bGu\b/i, /\bPa\b/i, /\bUr\b/i, /\bFr\b/i, /\bEs\b/i, /\bDe\b/i,
  /\bJa\b/i, /\bKo\b/i, /\bZh\b/i, /\bRu\b/i, /\bAr\b/i, /\bPt\b/i
];

// Scans one raw tag string for every standard token it contains and keeps
// only those pieces, in the order they appeared, joined by a single
// space — e.g. "192Kbps & AAC 2.0)" -> "AAC 2.0" (the bitrate and stray
// "&"/")" noise drop out, the two real specs survive). A tag with no
// standard token anywhere in it (a language label, a file-size tag, a
// bare "Tamil HQ HDRip" chunk) returns '' and is filtered out entirely
// by the caller. Note: this normalizes spacing between kept pieces — a
// source tag like "DD+5.1" (no space in the original) comes out as
// "DD+ 5.1" (one space inserted) rather than byte-for-byte original
// spacing; the information is identical, just not glued together.
function filterStandardTag_(tag) {
  var found = [];
  var seenSpans = [];
  STANDARD_TAG_PATTERNS_.forEach(function (re) {
    var global = new RegExp(re.source, re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags);
    var m;
    while ((m = global.exec(tag)) !== null) {
      var start = m.index, end = start + m[0].length;
      var overlaps = seenSpans.some(function (span) { return start < span[1] && end > span[0]; });
      if (!overlaps) {
        seenSpans.push([start, end]);
        found.push({ start: start, text: m[0] });
      }
    }
  });
  found.sort(function (a, b) { return a.start - b.start; });
  return found.map(function (f) { return f.text; }).join(' ');
}

function buildFinalBaseName_(parsed, movie) {
  // Switched 2026-11-02 from the bare, unprefixed "[tt1234567]" IMDb-style
  // tag to Jellyfin's actual recognized provider-id key, "[tmdbid-1234]".
  // Jellyfin's naming parser only recognizes specific key prefixes
  // (imdbid-/imdb-, tmdbid-/tmdb-, tvdbid-/tvdb-) — a bare "tt..." with no
  // key in front of it was never actually read as an ID at all, just
  // inert text sitting in the filename; Jellyfin was silently falling
  // back to a fuzzy title+year search for every single file. Using
  // movie.tmdbId instead of movie.imdbId costs nothing extra: it's the
  // same numeric id TMDb's search result already carries (r.id), already
  // present on the enriched movie object alongside imdbId — no additional
  // API call, just a different field.
  var tagStr = parsed.tags.map(function (t) { return '[' + t + ']'; }).join(' ');
  var base = movie.title + ' (' + movie.year + ')'
    + (movie.tmdbId ? ' [tmdbid-' + movie.tmdbId + ']' : '')
    + (tagStr ? ' ' + tagStr : '');
  return base;
}

// ---------- title variants (a/an/the) ----------

function titleVariants_(title) {
  var variants = [title];
  var m = title.match(/^(a|an|the)\s+(.+)$/i);
  if (m) {
    var stripped = m[2].trim();
    if (stripped && variants.indexOf(stripped) === -1) variants.push(stripped);
  }
  return variants;
}

// ---------- token-overlap similarity ----------

// Sequel numbering shows up in wildly different spellings across releases
// of the same movie - "Methagu-II" (TMDb's own title) vs a real folder
// named any of "Methagu 2" / "Methagu Part 2" / "Methagu P2" / "Methagu -
// P2" / "Methagu II" / "Methagu Part Two" / "Methagu Two" / "Methagu-2" /
// "Methagu - 2" - confirmed 2026-10-28 that only the one spelled exactly
// "II" (matching TMDb byte-for-byte) scored high enough to auto-match;
// every other spelling scored 0.25-0.33, well under the 0.65 threshold,
// and would've sat in RenamerReview as "no confident match" purely because
// of HOW the sequel number was spelled, not because of any real ambiguity.
// This canonicalizes every such spelling down to a bare digit before
// scoring, so all of the above become indistinguishable from each other.
//
// Deliberately global (any token position, not just the last word) since
// tokenOverlap_/normalizeTitle_ are bag-of-words comparisons with no
// positional concept to begin with - adding position-awareness just for
// this would be extra complexity for no real benefit.
//
// Known, accepted collision risk (documented rather than silently taken):
// a bare roman numeral (I/V/X especially) or a spelled-out number word
// (one/two/.../ten) occurring in a title for some OTHER reason, not as a
// sequel marker, will still get folded into a digit. In practice a bare
// single-letter token or number word in a movie title is rare enough that
// this is the same kind of accepted trade-off already made elsewhere in
// this project (e.g. the short 2-letter language codes) rather than a new
// category of risk.
var ROMAN_NUMERAL_WORDS_ = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
var SPELLED_NUMBER_WORDS_ = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };

function canonicalizeSequelTokens_(tokens) {
  // 1) A token already glued together with no space - "p2", "part2" - goes
  // straight to the bare digit.
  var step1 = tokens.map(function (t) {
    var m = t.match(/^p(?:art)?(\d+)$/);
    return m ? m[1] : t;
  });
  // 2) A standalone roman numeral or spelled-out number word becomes a
  // bare digit too - "ii" -> "2", "two" -> "2".
  var step2 = step1.map(function (t) {
    if (ROMAN_NUMERAL_WORDS_.hasOwnProperty(t)) return ROMAN_NUMERAL_WORDS_[t];
    if (SPELLED_NUMBER_WORDS_.hasOwnProperty(t)) return SPELLED_NUMBER_WORDS_[t];
    return t;
  });
  // 3) A separate "part"/"p" token immediately followed by a (now-digit)
  // number token collapses into just the digit - "part" "2" -> "2".
  var step3 = [];
  for (var i = 0; i < step2.length; i++) {
    if ((step2[i] === 'part' || step2[i] === 'p') && i + 1 < step2.length && /^\d+$/.test(step2[i + 1])) {
      continue; // drop "part"/"p" - the digit itself gets pushed on the next iteration
    }
    step3.push(step2[i]);
  }
  return step3;
}

function tokenSet_(s) {
  var norm = (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  var tokens = canonicalizeSequelTokens_(norm.split(' ').filter(function (w) { return w; }));
  var set = {};
  tokens.forEach(function (w) { set[w] = true; });
  return set;
}

function tokenOverlap_(a, b) {
  var ta = tokenSet_(a), tb = tokenSet_(b);
  var union = {};
  var intersectionCount = 0;
  for (var k in ta) {
    union[k] = true;
    if (tb[k]) intersectionCount++;
  }
  for (var k2 in tb) { union[k2] = true; }
  var unionCount = Object.keys(union).length;
  return unionCount === 0 ? 0 : intersectionCount / unionCount;
}

// ---------- TMDb lookup ----------

function lookupTmdbWithVariants_(title, year) {
  var variants = titleVariants_(title);
  var candidateMap = {};
  var lowSimNotes = [];

  for (var i = 0; i < variants.length; i++) {
    var result = lookupTmdbSingle_(variants[i], year);
    if (result.confident) {
      return { matched: true, confident: true, candidates: result.candidates, variantsTried: variants.slice(0, i + 1), lowSimNotes: [] };
    }
    if (result.lowSimilarity) {
      lowSimNotes.push('"' + variants[i] + '" vs TMDb "' + result.lowSimilarity.title + '" — similarity '
        + result.lowSimilarity.score.toFixed(2) + ' (below ' + SIMILARITY_THRESHOLD + ')');
    }
    result.candidates.forEach(function (c) { candidateMap[c.tmdbId] = c; });
  }

  var merged = [];
  for (var key in candidateMap) { merged.push(candidateMap[key]); }
  return { matched: false, confident: false, candidates: merged.slice(0, 5), variantsTried: variants, lowSimNotes: lowSimNotes };
}

function lookupTmdbSingle_(title, year) {
  var key = requireProp_('TMDB_API_KEY');
  var url = 'https://api.themoviedb.org/3/search/movie?api_key=' + encodeURIComponent(key)
    + '&query=' + encodeURIComponent(title)
    + '&include_adult=false'
    + (year ? '&year=' + year : '');

  var res = safeFetchJson_(url);
  if (!res || !res.results || res.results.length === 0) {
    return { matched: false, confident: false, candidates: [] };
  }
  var results = res.results;

  if (year) {
    var sameYear = results.filter(function (r) {
      return r.release_date && r.release_date.substring(0, 4) === String(year);
    });
    // Prefer same-year hits; only fall back to the full (any-year) pool if
    // literally nothing matched the year at all.
    var pool = sameYear.length > 0 ? sameYear : results;

    // TMDb's search is a fuzzy word match, not an exact-title match — a
    // query for "Dorothy" or "Paradise" happily returns every same-year
    // title that merely CONTAINS that word ("Friends of Dorothy", "The
    // Siege of Paradise", ...). Being the only/one-of-several same-year hit
    // is not evidence of being the right movie on its own; score every
    // candidate against the parsed title and only trust ones that actually
    // look similar.
    var scored = pool.map(function (r) { return { r: r, score: tokenOverlap_(title, r.title) }; });
    var strong = scored.filter(function (x) { return x.score >= SIMILARITY_THRESHOLD; });

    if (strong.length === 1) {
      return { matched: true, confident: true, candidates: [enrichTmdb_(strong[0].r)] };
    }
    if (strong.length > 1) {
      // Genuinely 2+ textually-plausible same-year candidates — real
      // ambiguity (e.g. two unrelated movies both actually titled
      // "Paradise" the same year), not search noise. This is the case that
      // gets Telegram buttons (see sendReviewWithButtons_).
      return { matched: false, confident: false, candidates: strong.map(function (x) { return toCandidate_(x.r); }).slice(0, 5) };
    }
    // Nothing cleared the similarity bar — not a real ambiguity, just a
    // weak or absent match. Report the closest one for context, but this
    // stays text-only/manual, same as the old single-weak-match case.
    var best = scored.slice().sort(function (a, b) { return b.score - a.score; })[0];
    return {
      matched: false, confident: false,
      candidates: pool.slice(0, 5).map(toCandidate_),
      lowSimilarity: best ? { title: best.r.title, score: best.score } : null
    };
  }

  var norm = normalizeTitle_(title);
  var exact = results.filter(function (r) { return normalizeTitle_(r.title) === norm; });
  if (exact.length === 1) {
    return { matched: true, confident: true, candidates: [enrichTmdb_(exact[0])] };
  }
  return { matched: false, confident: false, candidates: results.slice(0, 5).map(toCandidate_) };
}

function enrichTmdb_(r) {
  var key = requireProp_('TMDB_API_KEY');
  var url = 'https://api.themoviedb.org/3/movie/' + r.id
    + '?api_key=' + encodeURIComponent(key) + '&append_to_response=external_ids';
  var full = safeFetchJson_(url);
  return {
    title: (full && full.title) || r.title,
    year: r.release_date ? r.release_date.substring(0, 4) : '????',
    imdbId: full && full.external_ids ? full.external_ids.imdb_id : null,
    tmdbId: r.id
  };
}

function toCandidate_(r) {
  return {
    title: r.title,
    year: r.release_date ? r.release_date.substring(0, 4) : '????',
    tmdbId: r.id,
    language: languageName_(r.original_language),
    overview: (r.overview || '').trim()
  };
}

// Readable label from TMDb's original_language code. Falls back to the raw
// code (uppercased) for anything not in this short list, rather than
// guessing — good enough to tell apart "same title, different film industry"
// collisions like a Telugu release vs. a French/Canadian one.
var LANGUAGE_NAMES_ = {
  en: 'English', ta: 'Tamil', te: 'Telugu', hi: 'Hindi', ml: 'Malayalam',
  kn: 'Kannada', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', pt: 'Portuguese', ru: 'Russian',
  ar: 'Arabic', bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi'
};
function languageName_(code) {
  if (!code) return 'unknown language';
  return LANGUAGE_NAMES_[code] || code.toUpperCase();
}

function enrichTmdbById_(tmdbId, fallbackTitle, fallbackYear) {
  var key = requireProp_('TMDB_API_KEY');
  var url = 'https://api.themoviedb.org/3/movie/' + tmdbId
    + '?api_key=' + encodeURIComponent(key) + '&append_to_response=external_ids';
  var full = safeFetchJson_(url);
  return {
    title: (full && full.title) || fallbackTitle,
    year: (full && full.release_date) ? full.release_date.substring(0, 4) : fallbackYear,
    imdbId: full && full.external_ids ? full.external_ids.imdb_id : null,
    tmdbId: tmdbId
  };
}

// ---------- Telegram ----------

function sendTelegram_(text, dryRun) {
  if (dryRun) {
    Logger.log('[DRY RUN] Telegram message suppressed: ' + text);
    return;
  }
  var token = getProp_('TELEGRAM_BOT_TOKEN');
  var chatId = getProp_('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    Logger.log('Telegram not configured, message was: ' + text);
    return;
  }
  // One quick retry on a transient failure (e.g. a brief 429 rate-limit
  // blip) to reduce the chance of silently losing a notification — but
  // deliberately never throws. Drive is the part of the job that actually
  // matters; a notification that still can't be delivered after a retry
  // just gets logged, it doesn't block or undo the rename/move it was
  // describing.
  //
  // Fixed 2026-10-27 — this "never throws" claim was false in practice.
  // muteHttpExceptions only suppresses Apps Script's default behavior of
  // throwing on a non-2xx HTTP status; it does NOT catch a genuine
  // network-level failure (DNS resolution, connection refused, "Address
  // unavailable", etc.) — UrlFetchApp.fetch() still throws a real
  // exception for those regardless of muteHttpExceptions, and nothing
  // here was catching it. Confirmed in production: a transient Telegram
  // connectivity blip threw out of this exact fetch call, propagated all
  // the way up through moveFolderToReview_ -> processFolderGroup_ ->
  // processRenamerFolder, and crashed the ENTIRE run (status: Failed) —
  // not just lost one notification, lost the whole run's progress for
  // that cycle. Now wrapped in try/catch so a network-level failure is
  // treated the same as a bad HTTP status: logged, retried once, then
  // genuinely given up on without ever threatening the caller.
  var opts = { method: 'post', payload: { chat_id: chatId, text: text }, muteHttpExceptions: true };
  var url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  var res = null;
  try {
    res = UrlFetchApp.fetch(url, opts);
  } catch (e) {
    Logger.log('Telegram send threw (' + e.message + ') — retrying once\nMessage was: ' + text);
  }
  if (!res || res.getResponseCode() !== 200) {
    if (res) {
      Logger.log('Telegram send FAILED (' + res.getResponseCode() + '): ' + res.getContentText()
        + ' — retrying once\nMessage was: ' + text);
    }
    Utilities.sleep(1000);
    try {
      res = UrlFetchApp.fetch(url, opts);
    } catch (e) {
      Logger.log('Telegram send threw again (' + e.message + ') — giving up on this notification, continuing anyway\nMessage was: ' + text);
      res = null;
    }
    if (res && res.getResponseCode() !== 200) {
      Logger.log('Telegram send FAILED again (' + res.getResponseCode() + '): ' + res.getContentText()
        + ' — giving up on this notification, continuing anyway\nMessage was: ' + text);
    }
  }
  Utilities.sleep(TELEGRAM_PACING_MS);
}

// ---------- small utilities ----------

function getExtension_(name) {
  var dot = name.lastIndexOf('.');
  return dot > -1 ? name.substring(dot + 1).toLowerCase() : '';
}

function stripExtension_(name) {
  var dot = name.lastIndexOf('.');
  return dot > -1 ? name.substring(0, dot) : name;
}

function normalizeTitle_(t) {
  var norm = (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Same sequel-numbering canonicalization as tokenSet_ above, applied here
  // too so the no-year exact-match path (lookupTmdbSingle_'s fallback when
  // the filename has no parsed year) gets the same "II" = "2" = "Part 2"
  // = "P2" = "Two" treatment, not just the year-known Jaccard-overlap path.
  return canonicalizeSequelTokens_(norm.split(' ').filter(function (w) { return w; })).join(' ');
}

function sanitizeFilename_(name) {
  return name.replace(/[\\\/:*?"<>|]/g, '').replace(/\s{2,}/g, ' ').trim();
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

// Throws (rather than returning null) when TMDb genuinely couldn't be
// reached/answered after a retry — deliberate. A failed API call and a
// real "TMDb has no such movie" are different facts, and callers need to
// tell them apart: a thrown error propagates up to the per-video try/catch
// in processRenamerFolder(), which reports it and leaves the file untouched
// in the Open folder (picked up again next run) instead of wrongly treating an
// outage as "zero candidates" and shipping the file off to RenamerReview.
function safeFetchJson_(url) {
  var lastError = null;
  for (var attempt = 1; attempt <= 2; attempt++) {
    try {
      var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      Utilities.sleep(TMDB_PACING_MS); // pace every call, success or not
      if (res.getResponseCode() === 200) {
        return JSON.parse(res.getContentText());
      }
      lastError = 'HTTP ' + res.getResponseCode() + ': ' + res.getContentText().substring(0, 200);
      Logger.log('Non-200 (' + res.getResponseCode() + ') for ' + url + ' (attempt ' + attempt + ')');
    } catch (e) {
      lastError = e.message;
      Logger.log('Fetch failed (attempt ' + attempt + '): ' + url + ' — ' + e.message);
    }
    if (attempt === 1) Utilities.sleep(800);
  }
  throw new Error('TMDb request failed after retry — ' + lastError);
}

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function requireProp_(key) {
  var v = getProp_(key);
  if (!v) throw new Error('Missing Script Property: ' + key);
  return v;
}

function deleteTriggers_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handlerName) ScriptApp.deleteTrigger(t);
  });
}
