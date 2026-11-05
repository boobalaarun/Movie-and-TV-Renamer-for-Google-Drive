/**
 * Folder Tree Exporter — Google Apps Script
 *
 * Recursively lists a Drive folder's full structure (subfolders + files,
 * any depth) as an indented ASCII tree and saves it as a plain-text file
 * in Drive — Logger.log alone truncates on anything but a small folder,
 * and isn't easy to keep/share/search afterward.
 *
 * Output format (dash count = depth, same convention you showed):
 *   -Moviebox
 *   --Movie1
 *   ---Movie.mkv (712.4 MB)
 *   --Movie2
 *   ---Movie.avi (1.1 GB)
 *   ---Movie.srt (42.0 KB)
 *
 * Folders are listed before files at each level, both alphabetically, so
 * the report is stable and readable run to run.
 *
 * SETUP (all optional Script Properties — Project Settings -> gear icon ->
 * Script Properties):
 *   TREE_ROOT_FOLDER_ID    - Drive folder ID to start from. Unset = your
 *                            entire My Drive root (can be huge/slow —
 *                            pointing this at a specific folder, e.g. your
 *                            Moviebox folder, is almost always what you
 *                            want). Grab the ID from the folder's URL:
 *                            drive.google.com/drive/folders/<THIS PART>.
 *   TREE_OUTPUT_FOLDER_ID  - Drive folder ID to save the resulting .txt
 *                            report into. Unset = My Drive root.
 *
 * RUN: function dropdown (top toolbar) -> generateFolderTree -> Run. First
 * run asks you to authorize Drive access — approve it. Check Executions
 * (clock icon) or View -> Logs for the saved file's URL.
 *
 * TOGGLE: set TREE_INCLUDE_SIZE_ below to false for bare names only (no
 * "(123 MB)" suffix), matching the plain format you showed.
 *
 * LIMITS: Apps Script caps a single execution at ~5 minutes here (a safety
 * buffer under its hard 6-minute limit). A genuinely huge tree (tens of
 * thousands of files) may not finish in one run — if you hit that, point
 * TREE_ROOT_FOLDER_ID at a smaller subfolder and run it folder-by-folder.
 * Everything found before the cutoff is still written to the file, with a
 * note at the end saying it stopped early. A folder you don't have access
 * to read (rare, e.g. a partially-shared item) is skipped with a note
 * rather than failing the whole run.
 */

var TREE_INCLUDE_SIZE_ = true;

function generateFolderTree() {
  var props = PropertiesService.getScriptProperties();
  var rootId = props.getProperty('TREE_ROOT_FOLDER_ID');
  var rootFolder = rootId ? DriveApp.getFolderById(rootId) : DriveApp.getRootFolder();

  var startTime = Date.now();
  var MAX_MS = 5 * 60 * 1000;
  var timedOut = false;

  var lines = [];
  lines.push('-' + rootFolder.getName());

  function walk(folder, depth) {
    if (timedOut) return;
    var prefix = repeatChar_('-', depth);

    var subfolders = [];
    try {
      var subIter = folder.getFolders();
      while (subIter.hasNext()) subfolders.push(subIter.next());
    } catch (e) {
      lines.push(prefix + '[could not list subfolders here: ' + e.message + ']');
    }
    subfolders.sort(function (a, b) { return a.getName().localeCompare(b.getName()); });

    for (var i = 0; i < subfolders.length; i++) {
      if (Date.now() - startTime > MAX_MS) { timedOut = true; return; }
      var sub = subfolders[i];
      lines.push(prefix + sub.getName());
      walk(sub, depth + 1);
      if (timedOut) return;
    }

    var files = [];
    try {
      var fileIter = folder.getFiles();
      while (fileIter.hasNext()) files.push(fileIter.next());
    } catch (e) {
      lines.push(prefix + '[could not list files here: ' + e.message + ']');
    }
    files.sort(function (a, b) { return a.getName().localeCompare(b.getName()); });

    for (var j = 0; j < files.length; j++) {
      if (Date.now() - startTime > MAX_MS) { timedOut = true; return; }
      var f = files[j];
      var suffix = TREE_INCLUDE_SIZE_ ? ' (' + treeHumanSize_(f.getSize()) + ')' : '';
      lines.push(prefix + f.getName() + suffix);
    }
  }

  walk(rootFolder, 2); // root itself is 1 dash (pushed above); its direct children are 2 dashes

  if (timedOut) {
    lines.push('');
    lines.push('[Stopped early — hit the ~5-minute safety cutoff. Point TREE_ROOT_FOLDER_ID at a smaller subfolder and re-run for the rest.]');
  }

  var content = lines.join('\n');
  var outputFolderId = props.getProperty('TREE_OUTPUT_FOLDER_ID');
  var outputFolder = outputFolderId ? DriveApp.getFolderById(outputFolderId) : DriveApp.getRootFolder();
  var fileName = 'Folder Tree - ' + rootFolder.getName() + ' - ' + treeFormatTimestamp_(new Date()) + '.txt';
  var file = outputFolder.createFile(fileName, content, MimeType.PLAIN_TEXT);

  Logger.log('Tree saved: ' + file.getUrl());
  Logger.log('Lines: ' + lines.length + (timedOut ? ' (stopped early)' : ' (complete)'));
  Logger.log('--- preview (first 40 lines) ---');
  Logger.log(lines.slice(0, 40).join('\n'));

  return file.getUrl();
}

function repeatChar_(ch, n) {
  var s = '';
  for (var i = 0; i < n; i++) s += ch;
  return s;
}

function treeHumanSize_(bytes) {
  if (bytes < 1024) return bytes + ' B';
  var units = ['KB', 'MB', 'GB', 'TB'];
  var val = bytes;
  for (var i = 0; i < units.length; i++) {
    val /= 1024;
    if (val < 1024 || i === units.length - 1) return val.toFixed(1) + ' ' + units[i];
  }
}

function treeFormatTimestamp_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH-mm');
}
