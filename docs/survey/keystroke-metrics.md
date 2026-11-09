# Keystroke logging and timeline metrics for a transcription-typing experiment

Status: research note, 2026-11-09. Items marked [verified] were read on the cited page in this
session (some only at search-snippet level); [background] items come from prior knowledge and were
NOT re-checked (confirm before citing).

## 1. Survey

### 1.1 Datasets, tools, metrics
- Dhakal, Feit, Kristensson, Oulasvirta, CHI 2018, "Observations on Typing from 136 Million Keystrokes"
  (168k volunteers, online transcription test). Data: `Keystrokes.zip` (1.4 GB zipped / 16 GB), code of
  the capture page `136m-keystrokes.zip`, non-commercial licence with attribution [verified].
  https://userinterfaces.aalto.fi/136Mkeystrokes/ ; paper https://www.pokristensson.com/pubs/DhakalEtAlCHI2018.pdf
  Findings: rollover typing (next key down before previous up) is common (40-70% of keystrokes for fast
  typists) [verified, press summary]; 8 typist clusters from normalised IKI [verified].
  Row format [background]: one row per keystroke: PARTICIPANT_ID, TEST_SECTION_ID, SENTENCE, USER_INPUT,
  KEYSTROKE_ID, PRESS_TIME, RELEASE_TIME, LETTER, KEYCODE (ms). Lesson: they log press AND release plus
  the full typed string after each key, so text is reconstructable without replay. Their task is
  sentence-by-sentence transcription (same paradigm as ours). Not IME-aware (English test).
- Inputlog (Leijten and Van Waes 2013, Written Communication 30(3):358-392): Windows logger for Word
  etc. Records key, mouse, time, and output position/text. Pause analyses at fixed thresholds; 2 s is
  the widespread "pause" criterion, 1 s also used, sweeps of 200/500/1000/2000 ms in Van Waes and
  Leijten 2015; time-based "linear analysis" in fixed 60 s intervals [verified via search snippets].
  Caveat: a threshold ignores sub-threshold behaviour.
  https://www.inputlog.net/ ; tutorial https://archive.measuringbehavior.org/mb2012/files/tutorials/MB2012_KeystrokeLogging.pdf
- ScriptLog (Strombqvist et al.), CyWrite (Chukharev-Hudilainen) [background]: log keystroke plus
  revision (insertion/deletion with position) streams. Common theme: log edits with cursor position,
  derive bursts/pauses afterward.
- WriteTrack (npm `writetrack`, docs https://writetrack.pages.dev/llms-full.txt) [verified, partial page]:
  browser logger; six arrays: events (keydown/keyup with key, timestamp, flightTime, cursorPosition,
  isCorrection), clipboardEvents, selectionEvents, undoRedoEvents, programmaticInsertionEvents,
  compositionEvents (completed CJK composition: insertedLength, duration). It SUPPRESSES intermediate
  keystrokes during composition and logs only the completed composition. Repo/licence not stated.
- keyboard-history (npm; per key: duration, timestamp, physical `code`, JSON export) and
  @authored/tracker (timestamp plus derived flight/dwell; batched JSON POST) [verified via search
  snippets] https://www.pkgstats.com/pkg:keyboard-history , https://www.pkgstats.com/pkg:@authored/tracker
  No GitHub logger with an IME-aware schema was found; we design our own (section 3).
- Text-entry metrics (Soukoreff and MacKenzie): CHI 2001 (MSD error rate, KSPC), CHI 2003 "Metrics for
  text entry research: an evaluation of MSD and KSPC, and a new unified error metric" (pp.113-120):
  MSD ignores corrected errors; KSPC captures correction effort; unified Total Error Rate = Corrected
  ER + Not-corrected ER [verified]. https://www.yorku.ca/mack/chi03.html , https://www.yorku.ca/mack/CHI01a.htm
  Conventions [background]: WPM = ((|T|-1)/seconds)*60/5 (timer starts at first key; 5 chars = 1
  word); MSD error rate = MSD(P,T)/max(|P|,|T|).
- Pause/burst conventions: 2 s common; IKI is heavy-tailed (roughly log-normal), so use median or log
  IKI, not mean [background; Inputlog sources above].

## 2. Japanese IME specifics (Chrome/Edge on Windows)

Typical sequence for typing "ka", Space (convert), Enter (commit) in a textarea [background,
consistent with the sources below; VERIFY with a 10-minute probe page before locking the schema]:
1. keydown key="Process", keyCode=229, isComposing=false (first key; IME takes it), code="KeyK"
   (code stays physical).
2. compositionstart (data "") -> beforeinput insertCompositionText -> compositionupdate (data="k")
   -> input inputType="insertCompositionText", isComposing=true. Further romaji keys repeat
   keydown(Process, 229, isComposing=true) / compositionupdate / input.
3. Space: keydown Process; compositionupdate data = candidate (e.g. a kanji). Editor text changes
   though nothing is committed.
4. Enter (commit): keydown Process/229; Chrome fires `compositionend` (data = committed string). In
   Chrome the last `input` (insertCompositionText) comes BEFORE compositionend, so isComposing is still
   true on it. Safari instead fires keydown/input after compositionend, hence the standard guard
   `isComposing || keyCode === 229`.
   https://azukiazusa.dev/en/blog/ime-enter-submit , https://bugs.webkit.org/show_bug.cgi?id=165004 ,
   https://stum.de/2016/06/24/handling-ime-events-in-javascript/ [verified at snippet level]
5. Backspace while composing edits the composition (insertCompositionText, not
   deleteContentBackward). Backspace outside composition: keydown key="Backspace", input
   inputType="deleteContentBackward". Direct input (IME off / half-width): keydown key="a" + input
   insertText.

Pitfalls
- `key` is "Process" and `keyCode` 229 for most keys under IME; use `code` for the physical key and
  `data` of compositionupdate/end for the intended text. keyCode is deprecated; log isComposing.
- Keystrokes != characters: romaji "shi" = 3 keys -> 1 kana; Space/Enter conversion produces no new
  characters; kanji conversion shrinks length (3 kana -> 2 kanji). Editor length can go DOWN with no
  deletion.
- Editor text during composition includes uncommitted text; only compositionend defines "committed".
  Focus loss or punctuation can auto-commit and fire compositionend without Enter.
- Event order differs across Chrome / Firefox / Safari; Edge = Chrome. Fix the browser in the study.
- The candidate popup lets participants pause legitimately (choosing kanji): pauses are confounded
  with conversion; report it rather than remove it.
- Timestamps: use `performance.timeOrigin + event.timeStamp` (monotonic; browsers coarsen to
  0.1-1 ms, fine). Do not use Date.now() per event (clock jumps). Record a `Date.now()` /
  `performance.now()` pair at session start for UTC alignment.
- Paste, drag-drop, autofill, undo and mouse caret moves must be flagged (inputType insertFromPaste /
  historyUndo / insertFromDrop; selectionchange) or disabled.
- Keystrokes reveal content: informed consent, separate identity from log.

How Japanese typing speed is measured
- No peer-reviewed standard was found in search (only vendor sites; low confidence). Units seen:
  (a) kana/characters committed per minute (clerical tests, kana input speed, proficient roughly
  250-350 chars/min); (b) romaji keystrokes per minute converted to WPM (5 keys = 1 word); (c) kana
  per second x 12. https://typetest.io/blog/posts/2026-05-20-ime-typing-test.html
- Recommendation: primary unit = committed characters per minute (CPM) of output text. It is
  comparable across scripts and fits transcription of a fixed source. English WPM = CPM / 5. Report
  KSPC as a session summary, never as the timeline unit.

## 3. Recommendations

### 3a. Minimal event schema (JSONL, one object per event)

```json
{"t": 1731139200123.4, "seq": 57, "type": "keydown", "key": "Process", "code": "KeyK",
 "isComposing": false, "repeat": false, "inputType": null, "data": null,
 "len": 12, "caret": 12, "selLen": 0}
```

| field | meaning |
|---|---|
| t | UTC ms (float): `performance.timeOrigin + e.timeStamp` |
| seq | integer counter; disambiguates equal t |
| type | keydown, keyup, beforeinput, input, compositionstart, compositionupdate, compositionend, paste, select (selectionchange), focus, blur, snapshot, session_start, session_end |
| key | `e.key` (keyboard events; "Process" under IME) |
| code | `e.code`, physical key |
| isComposing | `e.isComposing` (keyboard/input events) |
| repeat | `e.repeat` (auto-repeat; exclude from speed) |
| inputType | `e.inputType` (input/beforeinput): insertText, insertCompositionText, deleteContentBackward, deleteContentForward, insertFromPaste, historyUndo, ... |
| data | `e.data` (composition*, insertText): needed to rebuild text; may be omitted if privacy forbids, relying on `len` plus snapshots |
| len | editor text length AFTER the event (read in input/composition handlers; for keydown/keyup it is the current length) |
| caret | `selectionStart` after the event |
| selLen | `selectionEnd - selectionStart` |

Rules: capture-phase listeners on the editor. Add `snapshot` events with full editor text at
session_start, every 5 s, and session_end (robust to any missed event). session_start meta: source
text id, user agent, `performance.timeOrigin`, `Date.now()`. Buffer in IndexedDB, flush via fetch or
sendBeacon, order by seq.

Derived definitions (not logged)
- Commit event i with size k_i: (a) `input` with inputType insertText and isComposing=false ->
  k = data.length; (b) `compositionend` -> k = data.length. Paste/drop are flagged and excluded.
- Correction event: input with deleteContentBackward/Forward outside composition. In-composition
  edits are normal IME use and not counted.
- Activity event: any keydown (including "Process"), compositionupdate, or input.
  Gap_j = t_{j+1} - t_j between consecutive activity events.

### 3b. Exactly two timeline metrics

Grid: window W = 10 s, step 1 s; the window at time s covers (s-W, s]. Axis starts at the first
activity event and ends at the last commit; windows with s < W use the elapsed span (grey them).

Metric 1, rolling committed speed:

    CPM(s) = 60 * ( sum of k_i over commit events with t_i in (s-W, s] ) / W      (English: WPM = CPM/5)

Committed characters are output-side, so they are robust to IME (romaji keys, conversion Space and
candidate navigation add nothing until compositionend) and to English alike. Speed on transcribed
characters is the Soukoreff and MacKenzie convention. 10 s holds roughly 20-60 characters, and IME
commits arrive in phrase bursts, so 10 s is about the minimum sensible window.

Metric 2, rolling pause ratio:

    PR(s) = ( time inside (s-W, s] that lies within gaps with Gap_j >= 2000 ms ) / W

The whole long gap counts (clipped to the window); an open gap at the right edge counts up to s.
Range 0-1. It captures hesitation (reading the source, being stuck, choosing kanji) that speed alone
cannot separate from slow-but-steady typing. 2 s is the dominant pause criterion in writing research
(Inputlog; Leijten and Van Waes 2013; 0.2-2 s sweeps in Van Waes and Leijten 2015) and exceeds routine
IME conversion keystrokes. Activity events include "Process" keydowns, so composition work is not
mislabelled as pausing. Rejected: median IKI (unstable with few keys per window, ambiguous under
IME: romaji vs committed); correction rate (sparse per window, in-composition edits are invisible;
use it as a session summary instead).

Slowdown segments (participant-relative, so skill level and language are comparable):
- base = median of CPM(s) over grid points with CPM > 0, excluding the first 10 s and last window.
- Slowdown = maximal run of grid points with CPM(s) < 0.5 * base lasting >= 5 s; merge runs separated
  by < 2 s.
- Label a segment "hesitation" if mean PR over it >= 0.5, otherwise "slow typing" (careful typing,
  heavy conversion).
- Parameters 0.5, 5 s, 2 s, 10 s are defaults to tune in a pilot; keep them as named constants and
  report them.
Session summaries (not on the chart): KSPC = non-repeat keydowns / committed characters; backspace
share = deletions / commits; median log IKI.

### 3c. Final accuracy against the source text

Normalise both strings (Unicode NFC, line breaks to \n, trim trailing whitespace; decide in advance
whether full/half-width variants are equal, e.g. NFKC, and state it). With P = presented source,
T = transcribed final text, and MSD = Levenshtein distance (unit-cost insert, delete, substitute) over
code points (grapheme clusters if combining marks occur):

    Error rate (%) = 100 * MSD(P, T) / max(|P|, |T|)

This is the MSD error rate of Soukoreff and MacKenzie 2001, i.e. the not-corrected-error component
of Total Error Rate (CHI 2003). Corrected errors are invisible in the final text; report them through
the logged backspace share, or implement full TER (CER + NER) if needed [TER detail: background].

## Key URLs
- https://userinterfaces.aalto.fi/136Mkeystrokes/ (Dhakal et al. 2018 data and capture code)
- https://www.pokristensson.com/pubs/DhakalEtAlCHI2018.pdf
- https://www.yorku.ca/mack/chi03.html (MSD / KSPC / TER, CHI 2003)
- https://www.yorku.ca/mack/CHI01a.htm (MSD error rate, CHI 2001)
- https://www.inputlog.net/ and https://archive.measuringbehavior.org/mb2012/files/tutorials/MB2012_KeystrokeLogging.pdf
- https://writetrack.pages.dev/llms-full.txt (browser logger; IME = completed composition only)
- https://www.pkgstats.com/pkg:keyboard-history , https://www.pkgstats.com/pkg:@authored/tracker
- https://azukiazusa.dev/en/blog/ime-enter-submit , https://bugs.webkit.org/show_bug.cgi?id=165004
- https://stum.de/2016/06/24/handling-ime-events-in-javascript/
- https://typetest.io/blog/posts/2026-05-20-ime-typing-test.html (Japanese speed units; vendor, low confidence)
