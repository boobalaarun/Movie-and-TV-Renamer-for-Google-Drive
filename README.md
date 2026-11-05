# Movie &amp; TV Renamer for Google Drive

A Google Apps Script that watches a Google Drive folder, matches movie and TV files
against [TMDb](https://www.themoviedb.org/), renames them into clean,
Jellyfin-compatible filenames, and sorts them into organized destination folders —
with Telegram notifications and tap-to-resolve buttons for anything it isn't
confident about.

Runs entirely inside your own Google account. No server, no hosting, no cost
beyond Google's and TMDb's free tiers.

## Features

- **Movies and TV shows**, auto-detected from the filename — season/episode
  patterns in several formats (`S01E01`, `S01 EP 08`, `Season 1 Episode 1`, ...)
- **Jellyfin-style naming**: `Title (Year) [tmdbid-12345]`, `Season 01`,
  `Title (Year) S01E01 Episode Name.ext`
- **TMDb matching** with title-similarity scoring and year-based disambiguation
  for same-titled series/movies
- **Telegram integration**: get notified as files are processed, and resolve
  ambiguous matches by tapping a button — no need to open Apps Script
- **Undo history**: every successful rename is logged to a "Renamer History"
  sheet with a one-click Undo checkbox per row
- **Settings Sheet**: a plain Google Sheet UI for configuring folder IDs, API
  keys, dry-run mode, and pausing/resuming the scheduler — no code editing
  required for day-to-day use
- **Safe by design**: never deletes real media files or folders; anything it
  can't confidently handle gets moved to a review folder, original name intact

Two standalone companion tools live in [`tools/`](tools/):

- **`FolderTree.gs`** — exports an ASCII folder-tree view of any Drive folder
- **`FolderFileTable.gs`** — generates a Google Sheet report of every file in a
  folder tree (works on any folder structure, not just media), with cumulative/
  checkpointed runs on large libraries

## Quick start

See [`SETUP.md`](SETUP.md) for the full step-by-step install walkthrough
(copying the script into Apps Script, getting a TMDb API key, setting up the
Telegram bot, and configuring the Settings Sheet).

## Requirements

- A Google account (Drive + Apps Script + Sheets)
- A free [TMDb API key](https://www.themoviedb.org/settings/api)
- (Optional) A Telegram bot token, for notifications and tap-to-resolve buttons

## Disclaimer

This is a personal project, shared as-is, with no warranty. It organizes files
that are already in your Drive folder — it does not download, source, or
distribute any media itself. Review `SETUP.md` and the script before running
it against your own data.

This product uses the TMDb API but is not endorsed or certified by
[TMDb](https://www.themoviedb.org/).

## License

MIT — see [`LICENSE`](LICENSE).
