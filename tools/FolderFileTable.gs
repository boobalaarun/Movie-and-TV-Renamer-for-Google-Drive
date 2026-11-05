/**
 * Folder/File Table Exporter — Google Apps Script
 *
 * Builds a WIDE table — one row per top-level subfolder (e.g. one row per
 * movie) — and saves it as a new Google Sheet. Open the Sheet and use
 * File -> Download -> Microsoft Excel (.xlsx) to get the actual .xlsx
 * file.
 *
 * Built to catch three specific organizing problems at a glance:
 *   1. A movie folder that itself has a subfolder inside it (a folder
 *      nested inside another movie folder, instead of sitting as its own
 *      top-level entry) — column "Subfolder(s) Inside".
 *   2. A movie folder with more than 1 video file in it.
 *   3. A movie folder with more than 2 subtitle files in it.
 * Every row also gets a "Flags" column that spells out whichever of
 * these apply in plain words (blank = nothing to check), and the Sheet
 * is colored so problem rows jump out: the Flags cell, the Subfolder(s)
 * Inside cell, and an over-threshold Video/Subtitle Files cell all turn
 * amber; everything else stays plain.
 *
 * Example output:
 *   Folder Name       | Flags              | Video Files | Subtitle Files | Image Files | Subfolder(s) Inside | File-1                 | File-1 Size | File-2 | File-2 Size
 *   12 Rounds (2009)  |                    | 1           | 1              | 2           |                      | 12 Rounds...avi        | 704.7 MB    | 12...srt | 107.0 KB
 *   Some Messy Folder | Subfolder inside: Movie6 | 2     | 3              | 0           | Movie6               | Movie.mkv              | 1228.8 MB   | Movie2.mkv | 921.6 MB
 *
 * The File-N columns are NOT alphabetical — they're ordered by type, video
 * first, then subtitles, then anything else (images, .nfo, etc.), each
 * group alphabetical within itself. So with 2 video files and 3 subtitles,
 * File-1/File-2 are always the videos and File-3/File-4/File-5 are always
 * the subtitles, regardless of what either is actually named. Sizes use a
 * FIXED unit by type rather than the usual auto-scaling B/KB/MB/GB: video
 * files are always shown in MB (so a 1.2 GB file reads "1228.8 MB", never
 * "1.2 GB" — keeps every video size directly comparable at a glance), and
 * subtitle files are always shown in KB. Anything else (images, etc.)
 * still auto-scales.
 *
 * Only the FILES directly inside each top-level subfolder are listed in
 * the File-N columns (not files inside a further-nested subfolder — that
 * nested folder's existence is what the "Subfolder(s) Inside" column is
 * for; its own contents aren't expanded here). For a full nested view,
 * use the separate Folder Tree script (the ASCII-tree one) instead.
 *
 * SETUP (Script Properties — Project Settings -> gear icon -> Script
 * Properties):
 *   FILETABLE_ROOT_FOLDER_ID    - REQUIRED. The folder whose direct
 *                                 subfolders become rows (e.g. your
 *                                 Moviebox folder). Grab the ID from its
 *                                 URL: drive.google.com/drive/folders/<ID>.
 *   FILETABLE_OUTPUT_FOLDER_ID  - Optional. Drive folder to save the new
 *                                 Sheet into. Unset = My Drive root.
 *
 * RUN: function dropdown -> generateFolderFileTable -> Run. Check
 * Executions (clock icon) or View -> Logs for the Sheet's URL.
 *
 * CUMULATIVE RUNS (added 2026-11-03). A run no longer always makes a new
 * Sheet from scratch — it remembers, per root folder ID, which Sheet it's
 * already written and which subfolders it has already recorded (tracked in
 * a Script Property named FILETABLE_STATE_<rootId>, never shown in the
 * Properties list by that literal name since the ID varies — you don't
 * need to touch it directly). This means:
 *   - Same FILETABLE_ROOT_FOLDER_ID as before -> new/never-seen subfolders
 *     get APPENDED as new rows to the SAME existing Sheet. A folder already
 *     recorded is skipped entirely (not re-scanned, not re-written) — this
 *     is what makes a 100+ folder library actually finish across several
 *     runs instead of re-covering the same first batch every time.
 *   - Different FILETABLE_ROOT_FOLDER_ID -> its own separate Sheet, tracked
 *     independently. Switching the property back to an earlier root ID
 *     later correctly resumes THAT root's own Sheet, not whichever ran most
 *     recently.
 *   - Want a clean, full re-scan of the same root from zero? Just delete
 *     (trash is fine, no need to permanently delete) the Sheet in Drive.
 *     The next run notices it's gone, forgets everything it had recorded
 *     for that root, and starts a brand new Sheet.
 * A folder that changes after being recorded (new file added, something
 * renamed) is NOT picked up automatically — it was already written and is
 * now skipped. That's the tradeoff that makes forward progress on a large,
 * slow-to-finish library possible at all; delete the Sheet (above) if you
 * want a fully fresh pass that re-reads everything.
 *
 * LIMITS: capped at ~5 minutes of NEW work per run (buffer under Apps
 * Script's hard 6-minute limit) — already-recorded folders don't count
 * against this, only ones actually being scanned this run. If a run times
 * out before finishing every new folder, whatever it got through so far is
 * already saved to the Sheet permanently; just run it again to continue
 * with the rest — no need to split anything up manually. A subfolder that
 * can't be read (rare — e.g. a partially-shared item) is skipped with a
 * note in its row rather than failing the whole run.
 */

var VIDEO_EXTENSIONS_ = ['mkv', 'avi', 'mp4', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'm2ts', 'mpg', 'mpeg', '3gp'];
var SUBTITLE_EXTENSIONS_ = ['srt', 'sub', 'ass', 'ssa', 'vtt', 'idx'];
var IMAGE_EXTENSIONS_ = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff'];

// Fixed column positions, before the dynamic File-N columns. Shared between
// a brand-new sheet and a resumed one, so column math stays consistent
// either way.
var FIXED_COLS_ = ['Folder Name', 'Flags', 'Video Files', 'Subtitle Files', 'Image Files', 'Subfolder(s) Inside'];
var FLAGS_COL_ = 2, VIDEO_COL_ = 3, SUBTITLE_COL_ = 4, SUBFOLDER_COL_ = 6;

function generateFolderFileTable() {
  var props = PropertiesService.getScriptProperties();
  var rootId = props.getProperty('FILETABLE_ROOT_FOLDER_ID');
  if (!rootId) {
    throw new Error('Set the Script Property FILETABLE_ROOT_FOLDER_ID to the folder you want a table of (e.g. your Moviebox folder ID), then run this again.');
  }
  var rootFolder = DriveApp.getFolderById(rootId);

  var startTime = Date.now();
  var MAX_MS = 5 * 60 * 1000;
  var timedOut = false;

  // ---- Resume-or-start-fresh: see the CUMULATIVE RUNS header comment. ----
  var stateKey = 'FILETABLE_STATE_' + rootId;
  var state = loadTableState_(stateKey);
  var ss, sheet, existingMaxFiles = 0, resuming = false;

  if (state && state.sheetId) {
    if (sheetFileStillUsable_(state.sheetId)) {
      ss = SpreadsheetApp.openById(state.sheetId);
      sheet = ss.getSheets()[0];
      existingMaxFiles = state.maxFiles || 0;
      resuming = true;
    } else {
      // Deleted (or trashed) since last run — that's the documented way to
      // force a clean restart. Forget everything recorded for this root.
      Logger.log('Previously tracked Sheet for this root folder no longer exists (deleted or trashed) — starting a fresh report and re-scanning every subfolder.');
      state = null;
    }
  }
  if (!state) state = { sheetId: null, processedFolderIds: [], maxFiles: 0 };
  var alreadyDone = {};
  state.processedFolderIds.forEach(function (id) { alreadyDone[id] = true; });

  var subfolders = [];
  var subIter = rootFolder.getFolders();
  while (subIter.hasNext()) subfolders.push(subIter.next());
  subfolders.sort(function (a, b) { return a.getName().localeCompare(b.getName()); });

  var toProcess = subfolders.filter(function (f) { return !alreadyDone[f.getId()]; });

  if (toProcess.length === 0 && resuming) {
    Logger.log('Nothing new — all ' + subfolders.length + ' subfolder(s) under this root are already recorded in ' + ss.getUrl());
    return ss.getUrl();
  }

  var newRows = [];
  var newlyProcessedIds = [];
  var runMaxFiles = existingMaxFiles;

  for (var i = 0; i < toProcess.length; i++) {
    if (Date.now() - startTime > MAX_MS) { timedOut = true; break; }
    var folder = toProcess[i];

    var nestedNames = [];
    try {
      var nestedIter = folder.getFolders();
      while (nestedIter.hasNext()) nestedNames.push(nestedIter.next().getName());
    } catch (e) {
      nestedNames.push('[could not check: ' + e.message + ']');
    }

    var fileCells = [];
    var videoCount = 0, subtitleCount = 0, imageCount = 0, thisFolderFileCount = 0;

    try {
      var files = [];
      var fileIter = folder.getFiles();
      while (fileIter.hasNext()) files.push(fileIter.next());
      files.sort(function (a, b) { return a.getName().localeCompare(b.getName()); });

      // Group by type first (alphabetical preserved within each group,
      // since `files` above is already sorted before this split), THEN
      // concatenate video+subtitle+other — this is what makes File-1/2
      // always the video(s) and the next columns always the subtitle(s),
      // instead of whatever order the names happen to sort in.
      var videoFiles = [], subtitleFiles = [], otherFiles = [];
      for (var j = 0; j < files.length; j++) {
        var kind = tableClassifyExt_(files[j].getName());
        if (kind === 'video') { videoCount++; videoFiles.push(files[j]); }
        else if (kind === 'subtitle') { subtitleCount++; subtitleFiles.push(files[j]); }
        else {
          if (kind === 'image') imageCount++;
          otherFiles.push(files[j]);
        }
      }

      var orderedFiles = videoFiles.concat(subtitleFiles).concat(otherFiles);
      for (var o = 0; o < orderedFiles.length; o++) {
        var f = orderedFiles[o];
        var oKind = tableClassifyExt_(f.getName());
        var sizeStr = oKind === 'video' ? tableSizeAsMB_(f.getSize())
          : oKind === 'subtitle' ? tableSizeAsKB_(f.getSize())
          : tableHumanSize_(f.getSize());
        fileCells.push(f.getName());
        fileCells.push(sizeStr);
      }
      thisFolderFileCount = files.length;
    } catch (e) {
      fileCells.push('[could not read files: ' + e.message + ']');
      fileCells.push('');
      thisFolderFileCount = 1;
    }
    if (thisFolderFileCount > runMaxFiles) runMaxFiles = thisFolderFileCount;

    var flags = [];
    if (nestedNames.length > 0) flags.push('Subfolder inside: ' + nestedNames.join(', '));
    if (videoCount > 1) flags.push(videoCount + ' video files');
    if (subtitleCount > 2) flags.push(subtitleCount + ' subtitle files');

    var row = [
      folder.getName(),
      flags.join(' | '),
      videoCount,
      subtitleCount,
      imageCount,
      nestedNames.join(', ')
    ].concat(fileCells);

    newRows.push(row);
    newlyProcessedIds.push(folder.getId());
  }

  var totalCols = FIXED_COLS_.length + runMaxFiles * 2;
  for (var r = 0; r < newRows.length; r++) {
    while (newRows[r].length < totalCols) newRows[r].push('');
  }

  if (!resuming) {
    ss = SpreadsheetApp.create('Folder File Table - ' + rootFolder.getName() + ' - ' + tableFormatTimestamp_(new Date()));
    sheet = ss.getSheets()[0];
    var header = FIXED_COLS_.slice();
    for (var k = 1; k <= runMaxFiles; k++) { header.push('File-' + k); header.push('File-' + k + ' Size'); }
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sheet.setFrozenRows(1);

    var outputFolderId = props.getProperty('FILETABLE_OUTPUT_FOLDER_ID');
    if (outputFolderId) {
      var outputFolder = DriveApp.getFolderById(outputFolderId);
      var file = DriveApp.getFileById(ss.getId());
      outputFolder.addFile(file);
      DriveApp.getRootFolder().removeFile(file);
    }
  } else if (runMaxFiles > existingMaxFiles) {
    // This run's folders need more File-N columns than the sheet currently
    // has — extend the header; existing rows simply stay blank in the new
    // columns, same as always.
    var newHeaderCells = [];
    for (var k2 = existingMaxFiles + 1; k2 <= runMaxFiles; k2++) { newHeaderCells.push('File-' + k2, 'File-' + k2 + ' Size'); }
    var startCol = FIXED_COLS_.length + existingMaxFiles * 2 + 1;
    sheet.getRange(1, startCol, 1, newHeaderCells.length).setValues([newHeaderCells]).setFontWeight('bold');
  }

  // Drop a stale "[Stopped early...]" marker row left by a previous
  // incomplete run, if the last row is one — it's about to be superseded
  // by either more real rows, a fresh marker, or both.
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var lastRowFirstCell = sheet.getRange(lastRow, 1).getValue();
    if (typeof lastRowFirstCell === 'string' && lastRowFirstCell.indexOf('[Stopped early') === 0) {
      sheet.deleteRow(lastRow);
      lastRow = sheet.getLastRow();
    }
  }

  if (newRows.length > 0) {
    sheet.getRange(lastRow + 1, 1, newRows.length, totalCols).setValues(newRows);
    lastRow += newRows.length;
  }

  var stillRemaining = subfolders.length - (Object.keys(alreadyDone).length + newlyProcessedIds.length);
  if (timedOut) {
    var note = ['[Stopped early — hit the ~5-minute safety cutoff for this run. '
      + stillRemaining + ' subfolder(s) not yet scanned — just run this again to continue; already-recorded folders above are not re-scanned.]'];
    while (note.length < totalCols) note.push('');
    sheet.getRange(lastRow + 1, 1, 1, totalCols).setValues([note]);
    lastRow += 1;
  }

  sheet.autoResizeColumns(1, totalCols);

  var dataRowCount = lastRow - 1;
  if (dataRowCount > 0) {
    sheet.clearConditionalFormatRules();
    var rules = [];
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenCellNotEmpty()
      .setBackground('#FFF3CD').setFontColor('#8A6D00')
      .setRanges([sheet.getRange(2, FLAGS_COL_, dataRowCount, 1)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenCellNotEmpty()
      .setBackground('#FFF3CD').setFontColor('#8A6D00')
      .setRanges([sheet.getRange(2, SUBFOLDER_COL_, dataRowCount, 1)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(1)
      .setBackground('#FFF3CD').setFontColor('#8A6D00')
      .setRanges([sheet.getRange(2, VIDEO_COL_, dataRowCount, 1)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(2)
      .setBackground('#FFF3CD').setFontColor('#8A6D00')
      .setRanges([sheet.getRange(2, SUBTITLE_COL_, dataRowCount, 1)]).build());
    sheet.setConditionalFormatRules(rules);
  }

  // Persist progress: merge this run's newly-processed IDs into state and
  // save. Best-effort — if the property write fails (e.g. an extremely
  // large single root pushed the per-property size cap), the Sheet itself
  // is already correct and saved; only the "skip already-done" bookkeeping
  // for the NEXT run would be affected, so this never loses report data.
  state.sheetId = ss.getId();
  state.maxFiles = runMaxFiles;
  state.processedFolderIds = Object.keys(alreadyDone).concat(newlyProcessedIds);
  try {
    saveTableState_(stateKey, state);
  } catch (e) {
    Logger.log('Could not save progress state (' + e.message + ') — the Sheet is fine, but the next run may not know these folders are already done. '
      + 'This usually means one root folder has grown very large; consider using a smaller/different root if it keeps happening.');
  }

  Logger.log((resuming ? 'Appended to existing Sheet: ' : 'Sheet created: ') + ss.getUrl());
  Logger.log('This run: ' + newlyProcessedIds.length + ' new folder(s) recorded. '
    + (stillRemaining > 0 ? stillRemaining + ' subfolder(s) still left — run again to continue.' : 'All ' + subfolders.length + ' subfolder(s) under this root are now recorded.'));
  Logger.log('To get an .xlsx file: open the Sheet above, then File -> Download -> Microsoft Excel (.xlsx).');

  return ss.getUrl();
}

function loadTableState_(key) {
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return null;
  try {
    var parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.processedFolderIds)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function saveTableState_(key, state) {
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(state));
}

// True only if the Sheet file still genuinely exists AND hasn't been moved
// to Trash — either one is treated as "the user wants a fresh start",
// matching the documented delete-the-Sheet-to-reset behavior.
function sheetFileStillUsable_(fileId) {
  try {
    var f = DriveApp.getFileById(fileId);
    return !f.isTrashed();
  } catch (e) {
    return false;
  }
}

function tableClassifyExt_(name) {
  var dot = name.lastIndexOf('.');
  var ext = dot > -1 ? name.substring(dot + 1).toLowerCase() : '';
  if (VIDEO_EXTENSIONS_.indexOf(ext) > -1) return 'video';
  if (SUBTITLE_EXTENSIONS_.indexOf(ext) > -1) return 'subtitle';
  if (IMAGE_EXTENSIONS_.indexOf(ext) > -1) return 'image';
  return 'other';
}

function tableHumanSize_(bytes) {
  if (bytes < 1024) return bytes + ' B';
  var units = ['KB', 'MB', 'GB', 'TB'];
  var val = bytes;
  for (var i = 0; i < units.length; i++) {
    val /= 1024;
    if (val < 1024 || i === units.length - 1) return val.toFixed(1) + ' ' + units[i];
  }
}

// Fixed-unit sizes (no auto-scaling to GB/TB) so every video size and every
// subtitle size is directly comparable column-to-column at a glance.
function tableSizeAsMB_(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function tableSizeAsKB_(bytes) {
  return (bytes / 1024).toFixed(1) + ' KB';
}

function tableFormatTimestamp_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH-mm');
}
