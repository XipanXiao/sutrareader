# Sutra Reader App Design

## 1. Product Direction

Sutra Reader is a calm mobile reading app for Buddhist sutras that makes long-term reading visible, resumable, and meaningful.

The core difference from ordinary ebook or scripture apps is the home screen: it is not a library shelf first, but a living progress map. The reader can see how much of the whole sutra sea has been read, jump into any point, resume any previous bookmark, and gradually fill a visual field of dots over months or years.

Initial platform: iOS.

Secondary goal: keep the data model, import pipeline, and sync assumptions portable enough that Android can be supported later without redesigning the app.

## 2. Design Principles

- Reading should feel spacious, quiet, and stable.
- Global progress should be visible without making the app feel gamified.
- The reader must be able to begin from anywhere, not only from the first page of a text.
- Bookmarks are first-class because the reader may move among multiple sutras.
- Bookmarks must preserve arbitrary in-page positions, not only section or paragraph starts.
- Offline reading is required after content has been downloaded.
- Source text structure should be preserved: canon, sutra, volume, chapter/pin, section, line anchors.
- Simplified Chinese is the preferred reading display.
- Sync should be automatic and recoverable, but local data should remain usable without network.

## 3. Target User Flow

1. Open app.
2. See a global progress map for the whole sutra sea.
3. Tap `Continue` to resume the most recent bookmark, or tap any dot/outline item to start elsewhere.
4. Read in a comfortable full-screen reader.
5. Tap `Start` when beginning a reading session.
6. Tap `Mark Here` when finished.
7. App saves:
   - current sutra position
   - read span from session start to marked position
   - bookmark for that sutra
   - aggregate progress for the whole sutra sea
8. Return home and see more dots filled.

## 4. Primary Screens

### 4.1 Home: Global Progress Map

Purpose: provide a global perspective on the reader's progress through the whole sutra sea, plus fast return to reading.

Content:

- Whole-corpus title, such as `大藏经`, `CBETA`, or a custom reading plan.
- Main global progress visualization.
- Current active sutra shown as secondary context.
- `Continue` button for latest bookmark.
- Small list of active bookmarks.
- Switch between `Map` and `Outline`.
- Search / library access.

Suggested layout:

```text
+-----------------------------+
| Sutra Reader        Search  |
| Whole Sutra Sea              |
| 3.2% global progress         |
|                             |
|     . . # # # # . .         |
|   . # # # # ~ . . .         |
|  . # # # # # ~ . .          |
|   . . # # # . . .           |
|     . . . . .               |
|                             |
| [Continue]                  |
|                             |
| Active bookmarks            |
| 卷第五百一十三 - 真如品       |
| 妙法莲华经 - 方便品           |
|                             |
| Map | Outline | Library      |
+-----------------------------+
```

Global map behavior:

- Each dot represents an ordered segment of the whole sutra sea, not just the currently open sutra.
- Empty dot: unread.
- Filled dot: fully read.
- Partially filled dot: partially read.
- Tapping a dot opens the first unfinished work or nearest corresponding text location in that global segment.
- Long-pressing a dot on mobile shows the full label.
- On iPad/macOS or future web, hover shows the label.
- Pinch zoom can reveal smaller subsegments in later versions.
- The current sutra can have its own local progress in outline/reader context, but the homepage map must stay global.

Visual shape options:

- MVP: square / responsive grid of dots.
- V2: selectable shapes, including square, circle, lotus-like radial field, or 卍-shaped path.
- Important: the shape must still preserve deterministic mapping from dot to text order.

Recommendation: build the MVP as a dense square grid first. It is readable, accessible, and technically reliable. Add symbolic shapes after the global progress model is proven.

### 4.2 Outline View

Purpose: linear navigation through the sutra sea.

Content:

- Canon / collection hierarchy.
- Sutra title.
- Volume / juan.
- Chapter / pin / section.
- Progress marker per row.
- Download status.

Suggested layout:

```text
大般若波罗蜜多经
  卷第五百一十一     ##### 100%
  卷第五百一十二     ###~.  72%
  卷第五百一十三     #~...  28%
    第三分真如品第十九之一
    第三分真如品第十九之二
  卷第五百一十四     .....   0%
```

Interactions:

- Tap row to open reader.
- Swipe row to bookmark / download / mark read.
- Search within the outline.
- Filter: unread, in progress, bookmarked, downloaded.

### 4.3 Reader

Purpose: comfortable sutra reading with precise progress capture.

Default reading experience:

- Large Chinese text with generous line height.
- Simplified Chinese by default.
- Source-preserving traditional Chinese can be kept as a future display option when available.
- Minimal chrome.
- Warm light, white, sepia, and dark themes.
- Font size control.
- Optional vertical text mode in V2.
- Line/paragraph anchors hidden by default, visible from a menu.

Reader controls:

- `Start`: sets a precise session start position.
- `Mark Here`: saves progress from session start position to current position.
- Bookmark icon: saves current position without marking a read range.
- Table of contents icon.
- Reader settings icon.

Suggested layout:

```text
+-----------------------------+
| Back 大般若波罗蜜多经  Menu  |
| 卷第五百一十三 - 真如品       |
|                             |
|   如是我闻。一时佛在...       |
|                             |
|   舍利子，真如甚深...         |
|                             |
|                             |
| [Start]        [Mark Here]   |
+-----------------------------+
```

Session behavior:

- If the user taps `Start`, store the current reading position.
- As the user scrolls, track the nearest visible text block, character offset, and scroll fraction.
- When the user taps `Mark Here`, store a read range from the session start position to the current reading position.
- If the end is before the start, ask whether to mark the reverse range or only bookmark.
- If no session is active, `Mark Here` acts as a bookmark and offers `Mark from last bookmark`.

### 4.4 Arbitrary Position Bookmarks

The app should treat a bookmark as a precise position in the sutra sea, not merely a page, section, or paragraph.

A reading position should include:

- work id
- nearest stable anchor id
- text block id
- character offset inside the normalized text block
- optional scroll fraction inside the rendered block
- display mode metadata, such as font size and writing mode, for best-effort visual restoration

This allows a reader to stop in the middle of any visible page and later resume close to the exact same phrase, even if pagination changes because of device size or font settings.

## 5. Text Sources and Ingestion

### 5.1 Preferred Source Strategy

Use CBETA data as the primary structured source for Chinese Buddhist texts.

Useful source options:

- CBETA XML P5 from GitHub: structured TEI XML suitable for preserving metadata and hierarchy.
- CBETA Normal Text: simpler plain text, easier for first import, but less semantically rich.
- CBETA Online API/export: useful for fetching specific texts or validating display, but the app should not rely on network-only reading.
- Mingguang pages can be supported later as a secondary importer if licensing and structure are acceptable.

The source layer should be importer-based:

```text
Source Adapter
  |- CBETA XML P5 Adapter
  |- CBETA Normal Text Adapter
  |- CBETA Online Export Adapter
  `- Mingguang HTML Adapter
```

MVP recommendation:

1. Start with a curated downloadable package generated from CBETA XML P5 or CBETA Normal Text.
2. Store normalized app-ready data in SQLite.
3. Add online refresh/import later.

### 5.2 Licensing Note

Before bundling any full corpus in the app, verify the source license and attribution requirements. The app design should support:

- source attribution per text
- source URL
- source version/date
- license/copyright note
- import timestamp

### 5.3 Simplified Chinese Display

The reader should prefer simplified Chinese text. If the source is traditional Chinese, the import pipeline should store both:

- `text_source`: the original source text for traceability.
- `text_simplified`: the converted display text used by default.

Conversion should happen during import when possible, so the reader remains fast offline. The app can expose source-preserving traditional display later, but simplified Chinese should be the default experience.

## 6. Data Model

### 6.1 Core Entities

```text
Canon
  id
  title
  source
  source_version

Work
  id
  canon_id
  title
  normalized_title
  source_work_id
  order_index

Section
  id
  work_id
  parent_section_id
  title
  type            // volume, chapter, pin, paragraph group, etc.
  order_index
  start_anchor_id
  end_anchor_id

Anchor
  id
  work_id
  section_id
  source_ref      // e.g. CBETA linehead or XML element id
  global_index
  char_start
  char_end
  label

TextBlock
  id
  work_id
  section_id
  start_anchor_id
  end_anchor_id
  text
  text_simplified
  text_source
  display_type    // paragraph, verse, heading, note
```

### 6.2 Progress Entities

```text
Bookmark
  id
  work_id
  position_id
  anchor_id
  text_block_id
  char_offset
  scroll_fraction
  title
  note
  created_at
  updated_at
  is_primary_for_work

ReadingSession
  id
  work_id
  start_position_id
  end_position_id
  started_at
  ended_at
  status          // active, saved, discarded

ReadRange
  id
  work_id
  start_position_id
  end_position_id
  start_offset
  end_offset
  work_total_chars
  created_at
  source_session_id

ReadingPosition
  id
  work_id
  anchor_id
  text_block_id
  char_offset
  scroll_fraction
  display_state_json
  created_at

ProgressSegment
  id
  collection_id
  start_anchor_id
  end_anchor_id
  start_work_id
  end_work_id
  order_index
  label
  read_fraction   // 0.0 to 1.0, derived/cacheable
```

Read progress should be stored as ranges, not just percentages. The dot map can be recalculated from ranges.

### 6.3 Why Range-Based Progress

Range-based progress supports:

- starting anywhere
- reading out of order
- partial dot fill
- multiple sessions in the same sutra
- recalculating progress if dot resolution changes
- syncing compactly
- resolving overlaps and duplicate reads

Positions should be finer than anchors. Anchors provide stable source references, while `ReadingPosition` adds the text block and character offset needed to resume in the middle of a rendered page.

## 7. Progress Map Design

### 7.1 Global Segment Generation

The home screen divides the whole sutra sea into ordered `ProgressSegment`s.

Segment size options:

- by ordered work ranges for MVP
- by volume/juan for high-level view
- by chapter/pin for medium view
- by fixed character count for even visual distribution
- by source anchor count for easier mapping

MVP recommendation:

- Build a dense grid of global dots, each covering an ordered slice of the CBETA work catalog.
- A dot can summarize many works in the early MVP.
- Tapping a global dot opens the first unfinished work inside that dot's catalog slice.
- Keep segment labels based on the covered range:
  `大正藏 T01n0001 - T01n0025`
- Later, refine global segments by character count after the import pipeline has reliable total character counts for every work.

### 7.2 Partial Fill Calculation

For each global segment:

```text
read_fraction = sum(work_read_fraction_inside_segment) / work_count_inside_segment
```

For each work:

```text
work_read_fraction = merged_read_char_count / work_total_chars
```

The app stores `start_offset`, `end_offset`, and `work_total_chars` in each `ReadRange` so global progress can be computed even when that sutra is not currently open.

### 7.3 Dot Rendering

States:

- `0.0`: outline dot / low contrast
- `0.01...0.99`: partially filled dot
- `1.0`: filled dot
- bookmarked: small ring or center mark
- current location: larger ring

Accessibility:

- Do not rely on color alone.
- Each dot should expose an accessibility label:
  `卷第五百一十三，第三分真如品第十九之一，已读百分之二十八`
- Minimum tap target should be larger than the visual dot.

## 8. Offline Storage

Use a local SQLite database for normalized text and progress cache.

Recommended iOS stack:

- SwiftUI for UI.
- SQLite via GRDB or SQLite.swift for explicit durable storage.
- CloudKit for sync of user data.
- Local file storage for downloaded text packages.

Why not only SwiftData:

- The app needs durable imported text, range queries, and likely many rows.
- SQLite gives clearer control over imports, anchors, and progress calculations.

Offline behavior:

- Recently opened texts are cached automatically.
- User can download a full work, canon, or reading plan.
- Progress writes locally first.
- Sync happens when network/iCloud is available.

## 9. Cloud Sync

### 9.1 iOS MVP

Use CloudKit private database for user-owned data:

- bookmarks
- reading sessions
- read ranges
- settings
- selected collections
- downloaded package manifest references

Do not sync the whole text corpus through CloudKit. Sync only user data and source/package identifiers.

### 9.2 Cross-Platform Future

For Android support, consider one of:

- Firebase Auth + Firestore for progress/bookmarks.
- Supabase Auth + Postgres for progress/bookmarks.
- Google Drive app data folder for portable JSON progress backup.

Design decision:

- Keep sync behind a `ProgressSyncProvider` interface.
- CloudKit is provider one.
- Google Drive/Firebase/Supabase can be provider two later.

```text
ProgressRepository
  |- LocalProgressStore
  `- ProgressSyncProvider
       |- CloudKitSyncProvider
       `- FutureCrossPlatformSyncProvider
```

## 10. App Architecture

Recommended architecture for iOS MVP:

```text
SwiftUI Views
  |
View Models
  |
Repositories
  |- TextRepository
  |- ProgressRepository
  |- BookmarkRepository
  `- DownloadRepository
  |
SQLite + Local Files + CloudKit
```

Key modules:

- `Library`: browse/search/download sutras.
- `Reader`: text display and session marking.
- `ProgressMap`: dot grid and outline.
- `Sync`: CloudKit sync and conflict resolution.
- `ImportPipeline`: transforms source data into app database packages, including simplified Chinese display text.

## 11. Conflict Resolution

Progress data should be merge-friendly.

Rules:

- Bookmarks: latest update wins per bookmark id.
- Bookmark positions: preserve anchor, text block, character offset, and scroll fraction; latest update wins.
- Primary bookmark per work: latest `updated_at` wins.
- Read ranges: append-only; never delete automatically.
- Overlapping ranges: merge locally for display, keep original records for audit/debug.
- Deleted bookmarks: use tombstones so deletion syncs across devices.

## 12. MVP Scope

### Must Have

- iOS app shell.
- Local sutra database package for a small initial corpus.
- Library list.
- Reader view.
- Start / Mark Here session flow.
- Multiple precise bookmarks with arbitrary in-page positions.
- Home progress map as square dot grid.
- Outline view.
- Offline reading for downloaded texts.
- Simplified Chinese display by default.
- Local persistence.
- iCloud/CloudKit sync for progress and bookmarks.

### Should Have

- Search by sutra title.
- Reader font size/theme controls.
- Download manager.
- Progress labels on dot long press.
- Import script for CBETA source data.
- Optional source-preserving traditional Chinese display toggle.

### Later

- 卍-shaped progress map.
- Vertical reading mode.
- Notes.
- Full-text search.
- Multiple reading plans.
- Android app.
- Cross-platform sync provider.
- Web companion.

## 13. Implementation Milestones

### Milestone 1: Prototype the Reading Loop

- Create SwiftUI app.
- Use a small bundled sample sutra.
- Build reader screen.
- Add `Start` and `Mark Here`.
- Save precise bookmark position and read range locally.
- Show simple progress percentage.

### Milestone 2: Progress Map

- Normalize sample text into anchors and segments.
- Render square dot grid.
- Calculate full and partial segment progress.
- Tap dot to open reader at anchor.
- Long press dot to show label.

### Milestone 3: Real Source Import

- Build CBETA import pipeline.
- Generate SQLite package.
- Preserve work, volume, section, anchor metadata.
- Add library and outline views.

### Milestone 4: Offline Downloads

- Package texts by work or canon.
- Add download status.
- Ensure reader works without network.

### Milestone 5: CloudKit Sync

- Sync bookmarks and read ranges.
- Merge ranges from multiple devices.
- Validate airplane-mode and device-switch scenarios.

## 14. Open Questions

- What initial corpus should ship first: only selected sutras, 大正藏 subset, or a user-imported package?
- Should progress be tracked across one giant canon, per sutra, or user-defined reading plans?
- Should rereading count separately, or should progress only mean first-time coverage?
- Should punctuation/modern formatting be source-provided, user-toggleable, or normalized?
- Is iCloud required, or is a cross-platform sync account preferable from day one?

## 15. Recommended First Build Decision

Build a native iOS SwiftUI MVP with:

- SQLite local text/progress database.
- CBETA-derived import package.
- CloudKit sync for user progress.
- Square dot-map progress visualization.
- Simplified Chinese reader text by default.
- Precise reading positions for bookmarks and saved progress.

This gives the fastest path to the distinctive product: a peaceful sutra reader whose home screen shows visible, tappable, partially filled reading progress, while still leaving a clean path toward Android later.

## 16. External References

- Spec: `spec.md`
- CBETA homepage: https://cbeta.org/
- CBETA XML P5 repository: https://github.com/cbeta-org/xml-p5
- CBETA full-text download formats: https://cbdata.dila.edu.tw/static_pages/download_fulltext
- CBETA API/export page: https://api.cbetaonline.cn/static_pages/export
- Mingguang Longzang library page from the spec: https://mingguang.im/library/longz/index.html
