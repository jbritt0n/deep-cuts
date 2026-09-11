# Deep Cuts v3 — Feature Recommendations (external review)

**Source:** DeepSeek (AI advisor), September 11, 2026
**Status:** Suggestions only — not committed to roadmap, not scoped, not estimated.
**Purpose:** A menu of possible next features, organized by theme, for the owner to
triage. Everything here is written against the current architecture as documented in
`docs/PROJECT-STATUS-AND-ROADMAP.md`, `docs/PHASE1-NOTES.md`, and the SQL/TS layers.

> **Note to whoever picks this up:** these are *recommendations from an outside reader
> of the codebase*, not requests from the owner. Treat them as a starting menu. The
> owner's actual priorities are in §3 of `PROJECT-STATUS-AND-ROADMAP.md` and should
> take precedence. Each item below notes which existing tables/queries it would build
> on so the effort is easy to gauge.

---

## 0. How to read this file

- **§1** — Top 5 picks, if only five things get done.
- **§2** — Full menu, grouped by theme.
- **§3** — Notes on where each idea touches the codebase.
- **§4** — Things deliberately *not* suggested (and why).
- **§5** — Sequencing notes, including a specific order for the graph features in §2.13.

Nothing here requires a cloud service the project doesn't already use. Nothing
requires telemetry. Nothing relaxes the copyright boundary on lyrics or the
local-first boundary on data.

---

## 1. Top 5 picks (highest value-to-effort)

1. **Record Hygiene page** — systematize data-quality detection and correction.
   You already found one bug (the "So Excited" stuck-repeat class); this turns ad-hoc
   detection into a first-class surface. Builds on `stuck_repeat`, `session_overrides`,
   `tz_overrides`, and the `set_session_attention` command that already exists.

2. **Personal annotations / listening journal** — the app knows everything about your
   listening *except what you think about it*. New `notes` table keyed by entity; feeds
   Liner Notes with personal context.

3. **Blind spots analysis + bubble score** — a genuinely new lens. Your current engines
   recommend from inside your taste graph; this one measures how narrow the graph is
   and points at unexplored territory. Uses existing tag/relation caches.

4. **Playlist health analysis** — you create playlists; you don't yet analyze them.
   Natural Library extension: per-playlist play/skip/redundancy stats, genealogy, dead
   weight. Uses the playlist tables that already sync.

5. **Query console / local API** — unlocks power users, scripting, and external tool
   integration with minimal new surface area. `Db::assert_read_only` and
   `dev-server.mjs`'s command surface already exist as the seam.

> §2.13 (Graph & connection views) is a larger, multi-drop initiative rather than a
> single pick. It is deliberately *not* in the top 5, but it contains one small
> high-value entry — the playlist overlap graph — that could slot in earlier. See §5.1
> for a concrete build order.

---

## 2. Full menu by theme

### 2.1 Data quality & record integrity

**Record Hygiene page** *(top pick)*
- **Outlier review panel** — sessions flagged `stuck_repeat`, tracks with play counts
  disproportionate to duration, days with impossible hourly totals (30 h in 24 h),
  plays where `ms_played` exceeds track duration.
- **Session surgery** — manually split/merge sessions, bulk-correct attention flags,
  reassign a session to a timezone override. `session_overrides` exists; surface it as
  a first-class editing UI rather than one row at a time via the session detail page.
- **Import diffing** — when importing a newer export, show what changed (new plays,
  corrected metadata, removed duplicates) instead of just "N new plays."
- **Integrity report card** — dashboard card showing duplicate rate, unattended share,
  stuck-repeat count, timezone override coverage, enrichment completeness. Confidence
  signal that the numbers are real.

**Related:** extend `stuck_repeat` detection to catch short-*playlist* looping (a
variant noted as unhandled in §2.4 of the roadmap doc).

### 2.2 Personal annotations & memory

**Listening journal layer** *(top pick)*
- **Notes on any entity** — "first heard this at…", "reminds me of…", "saw them live
  in 2019." New `notes` table keyed by `(entity_type, entity_id)`. Searchable. Feeds
  Liner Notes with personal context. Additive, non-destructive, trivially backed up.
- **On this day** — daily card: what you played on this date in each prior year, with
  an optional note. Ties directly into existing anniversary/milestone machinery in
  `compute_milestones.sql`.
- **Life events / chapters** — manually mark "moved to Istanbul", "new job", "breakup"
  and see how listening shifted around them. Your era detection is behavioral; this
  adds the human narrative. A `life_events` table joined into era naming and drift
  charts would be a small change with outsized storytelling value.
- **Concert memory** — the `concerts` table exists but is manual-entry only. Surface
  it: "you saw Beach House on 2022-08-14 — here's what you played the week before and
  after, and which songs from that setlist you've never streamed." Setlist.fm
  connector already on the Phase 8 candidates list; this is the UI half.

### 2.3 Discovery depth

**Blind spots + bubble score** *(top pick)*
- **Blind spots analysis** — what you've *never* explored: countries (via `country_zones`
  and MusicBrainz artist origin), decades, genres (Last.fm tags), languages, label
  families, instrumentations. "You've played 11,293 artists but zero from 14 countries."
  Different lens than structural gaps, which live inside the taste graph.
- **Bubble score** — single number for how narrow/wide your taste is this year vs.
  prior years, with a sparkline. "Artists that would widen your bubble" draws from
  adjacency but selects for unexplored territory.
- **Rediscovery engine** — scheduled "on this week in 2019 you loved X; here's a
  playlist." Time-triggered rather than query-triggered, unlike existing forgotten-
  favourites.
- **Anti-recommendations** — artists you *should* like per your graph but consistently
  skip. The negative signal is as interesting as the positive and no current engine
  uses it.
- **Import from other services** — Apple Music, YouTube Music, Tidal, Last.fm scrobble
  history. Even imperfect, cross-referencing fills gaps (pre-Spotify listening,
  non-Spotify plays). Fits the `source` column on `plays_normalized` already.

### 2.4 Time & context enrichment

- **Weather correlation** (opt-in, local only) — did you play more melancholy music
  on rainy days? One-time historical fetch for top cities; nothing ongoing.
- **Activity inference** — from session shape + time + day: "commute", "workout",
  "focus", "dinner", "late night." Mood stations are close; make this a first-class
  taggable dimension across pages.
- **Listening velocity** — plays/day, hours/week, trend lines. Current stats are
  totals; this is rate. A small set of new TS queries in `queries.ts`.
- **Temporal Sankey** — artist→artist transitions within sessions, or year→year genre
  flows. A visualization your current charts don't cover.

### 2.5 Playlist intelligence

**Playlist health** *(top pick)*
- **Per-playlist health** — for any Spotify playlist (yours or followed): how many
  tracks you've actually played, skip rate within the playlist context, redundancy
  (same artist/album over-represented), dead weight (never played, never skipped —
  just ignored).
- **Playlist genealogy** — which of your playlists share tracks? Which are subsets of
  others? Venn/set view.
- **Auto-curation rules** — "keep this playlist at 50 tracks, drop the least-played
  when adding new." A rules engine that runs nightly and *suggests* changes (never
  applies silently, per the local-first ethos).
- **Blend v2 at scale** — multiple friends, not just one. A "taste compatibility"
  matrix across your friend group. Still local-first: each friend exports, you import,
  no cloud.

### 2.6 Audio features & music theory

*Depends on Deezer connector (already a Phase 8 candidate) or local analysis via
Essentia/AcousticBrainz.*
- **Tempo drift** — average listening BPM by year/month/day-part. "Your 2024 was
  12 BPM faster than 2023."
- **Key/mode analysis** — "you over-index on minor keys in winter."
- **Harmonic diversity** — how varied is your listening across keys/tempos? A single
  "adventurousness" metric.
- **Duration preference** — 3-minute pop vs. 8-minute epics; trend over time.

### 2.7 Social & sharing (without cloud)

- **Year-in-Review as a shareable microsite** — self-contained HTML a friend can open
  without the app. HTML export exists; polish into a proper "wrapped" experience.
- **Taste profile card** — compact, shareable summary: top genres, hours, era,
  signature artists. Music-themed business card.
- **Collaborative playlists via file exchange** — export a "playlist request" file,
  friend imports it, their app suggests tracks from *their* library that match, exports
  back. Sneakernet social.

### 2.8 Power user & extensibility

**Query console / local API** *(top pick)*
- **Query console** — read-only SQL editor for power users. `Db::assert_read_only`
  exists as the validator. Results as tables or fed into existing chart components.
- **Local API** — expose the command set over HTTP on localhost (as `dev-server.mjs`
  already does). Lets other tools query the record: Obsidian, Notion, custom scripts.
- **CLI** — `deep-cuts query "top artists 2024"` for scripting. Reuses the same query
  layer.
- **Saved views / custom dashboards** — let the user compose their own dashboard from
  existing cards. Component library is already modular.
- **Plugin system** — a `plugins/` folder with a manifest; each plugin can register a
  connector, a card, or a query. Rust-side dynamic loading is hard, but a JS-side
  plugin API (loaded at runtime) could work for UI extensions. Larger project; flag
  for the far horizon, not the next drop.

### 2.9 Accessibility & inclusivity

- **Full keyboard navigation** — skip-link exists; complete the audit.
- **Data table alternatives** for every chart — screen-reader accessible.
- **Internationalization** — even if English-only now, externalize strings.
- **High-contrast mode** — skins are beautiful but may not meet WCAG AA. A
  "high contrast" skin in the `THEMES` array.
- **Reduced motion** — media query exists; verify every animation respects it.

### 2.10 Gamification & habit

- **Listening goals** — "listen to 10 new artists this month", "reduce skip rate below
  15%", "play one album front-to-back each week." Track streaks, celebrate completions.
- **Quests** — multi-step challenges: "explore 5 countries", "listen to an album from
  each decade." Pulls from blind spots analysis.
- **Yearly wrapped** — Year in Review exists; make it a proper annual event with a
  timeline of highlights, not just a stats page.
- **Listening streaks** — current streak tracked; add longest streak, streak calendar,
  streak recovery.

### 2.11 Operational & quality-of-life

- **Auto-update** — Tauri's updater with opt-in. Already a Phase 8 candidate; note
  that signing key custody is a real decision point.
- **Scheduled exports** — weekly Parquet backup exists; add "write a markdown report
  to my Obsidian vault" as an optional output.
- **Notifications** — system notifications for: new release from top artist, "you
  haven't listened to X in a year", weekly Liner Notes ready.
- **Portable mode improvements** — "sync my portable data to cloud storage" (user-
  managed, e.g., a Dropbox folder).
- **Multi-record support** — separate records for different people or time periods,
  switchable in the UI. Useful for testing and for households with multiple listeners.

### 2.12 The meta-feature: Ask the archive

*Already on the roadmap as the LLM phase. Listed here for completeness because it is
the natural capstone to the data layer.*
- **Natural language queries** — "what did I listen to on rainy Sundays in 2021?" →
  text-to-SQL with `Db::assert_read_only`.
- **Narrative insights** — Liner Notes rewritten in a model's voice, with fact-checking
  against the fact sheet (`composeNotes` output is the existing rule-based version to
  wrap).
- **Theme playlists** — "make me a playlist for a melancholy autumn evening." Candidate
  scoring already exists in `recQueries.ts`; the LLM ranks and explains, never invents
  candidates.
- **Conversational exploration** — "tell me more about that Beach House phase" → the
  model queries the record and narrates.

**Blocker per the roadmap doc:** do not start this until the owner confirms Ollama is
installed and reachable at `http://127.0.0.1:11434`.

### 2.13 Graph & connection views

**Idea in one line:** a family of visualizations that show how your artists, albums,
tracks, and followed playlists connect — lineage, containment, and proximity — rather
than listing them side by side.

This is really **three distinct features** wearing one hat, and they want different
visual metaphors and different data. Treating them as one project is the fastest way
to build the wrong thing. Build them as separate views sharing one edge table (§5.1).

#### A. Artist family tree (hierarchical, MusicBrainz-driven)

A *tree*, not a network. MusicBrainz relations are genuinely hierarchical for one
specific relation family: band → member → their other bands → those bands' members.

You already cache this in `artist_relations` via the MusicBrainz connector (Phase 3
notes: "MusicBrainz relationships + release groups"). It is currently only consumed by
the side-projects recommendation engine. A tree view is a new *presentation* of
existing rows — no new connector work.

- **Seed:** an artist you've played ≥ N times, so the tree is anchored in your
  listening rather than a random MB entity.
- **Expand on click:** members, their other bands, those bands' members, etc.
- **Node encoding:** size = your play count; ring = "in your record" vs. "not played";
  edge style = relation type (solid = member, dashed = collaboration, dotted =
  influenced-by).
- **Hard caps:** depth 2–3 hops, top 10 branches per level by your play count. Without
  caps, a prolific artist gives you 200 relations and an unreadable tree.
- **Click a node → existing artist page.** This is the killer interaction. The tree is
  a *navigation surface*, not a destination.
- **Sparse-relation handling:** pop artists have rich MB graphs; niche and non-Western
  artists often have none. Show "no relationships known for this artist" rather than
  an empty canvas.

**Value:** answers "how did I get from X to Y" — a question lists cannot answer. "This
drummer was in three bands I love and I never noticed."

**Effort:** moderate. New SQL view over `artist_relations`, a tree-layout component
(Reingold–Tilford or nested flex — no physics needed), a "Family tree" tab on the
artist page. This is the **lower-risk, higher-signal** of the three.

#### B. Containment pack (artist → albums → tracks, nested circles)

A *pack* layout, not a force graph. D3-pack or a custom circle-packing routine, nested
hierarchically. No physics, fully deterministic, readable at a glance, and it fits the
existing design language.

- Artist → albums → tracks nested inside. Node area = play count or hours.
- Color = album, ring = "played whole" vs. "partial" vs. "never touched."
- Complements the family tree: the tree shows *lineage*, the pack shows *containment*.
- Same drill-in pattern: click a circle → entity page.
- Small N (an artist has tens of albums, hundreds of tracks at most) so this stays
  legible where a force graph would not.

**Effort:** moderate, ~1 drop. Very legible; low risk.

#### C. Seed-based neighborhood graph (force-directed network)

The ambitious one. Entities: artists, albums, tracks, playlists, tags. Edges: many
kinds. The most interesting edge type is the one you didn't author yourself — your
followed playlists.

**Edge types buildable today:**

| Edge | Source | Signal |
|---|---|---|
| artist ↔ artist (similar) | `artist_relations` (`similar`, `lb_similar`) | Last.fm + ListenBrainz |
| artist ↔ artist (collaborated) | MusicBrainz | genuine |
| artist ↔ artist (shared tag) | `artist_tags` | cosine/Jaccard over tag vectors |
| artist ↔ album | entity resolution | containment |
| album ↔ track | entity resolution | containment |
| artist ↔ track | entity resolution | credit (incl. features) |
| track ↔ playlist | playlist sync | containment |
| artist ↔ artist (co-session) | `plays_resolved` grouped by `session_id` | **your behavior** |
| artist ↔ artist (co-playlist) | playlist items | **a curator's behavior** |
| playlist ↔ playlist | shared tracks | **curation overlap** |
| artist ↔ era | `compute_insights.sql` | your history |

The last three columns are where the value is. **Co-session and co-playlist edges are
unique to you** — no external service produces them, and they capture something
similarity graphs cannot: "these two artists live in the same *context* in my
listening, even if they sound nothing alike."

**The visual problem:** a force-directed graph with all entity types is a hairball.
The standard failure mode is: it looks beautiful in a screenshot and you never open it
again. To avoid that:

1. **Seed-based, always.** No "show me everything." Start from an artist, playlist,
   track, or era and expand outward.
2. **Filter by edge type at the top.** Default: your behavioral edges (co-session,
   co-playlist) + similar-artist. Toggles for MusicBrainz collaborations, shared tags,
   etc. The graph *means* something different depending on which are on.
3. **Force layout with pinned seed and community clustering.** Pin the seed at center;
   use a clustering force (Louvain or tag-family assignment) so related nodes settle
   together.
4. **Node encoding:** size = play count (log), color = entity type or community, ring
   = "in your record" vs. "recommended-only."
5. **Edge encoding:** opacity = strength, width = play-count-weighted co-occurrence,
   color = edge type.
6. **Canvas, not SVG.** Above ~200 nodes, SVG re-layout is painful. Share cards
   already use canvas, so the pipeline is familiar.
7. **Interaction:** pan, zoom, click-to-focus (re-roots the graph on that node), hover
   tooltip, "expand from here," and a breadcrumb of focus history.
8. **Seeded PRNG.** Force layouts are non-deterministic unless you seed them. Seeding
   matters for shareability and for your own muscle memory.

**Effort:** large — 2–3 drops plus ongoing tuning. Treat as a stretch goal, not a
starting point.

#### D. What's specifically interesting about "playlists I follow"

This deserves its own note, because it's the part of the graph you cannot get
anywhere else:

- **Curator overlap graph.** Which followed playlists share artists? Which are
  near-duplicates? Which curator's taste most overlaps yours? This answers "whose ear
  do I trust," a different question from "what should I listen to," and it feeds the
  existing "Followed playlists / lost gems" Library feature.
- **Playlist ↔ playlist edges by shared tracks** produces a graph where nodes are
  curations and edges are overlap. Color by Spotify-owned vs. user-owned (the Library
  reorg you're already planning) and see whether your algorithmic playlists cluster
  separately from human-curated ones. That's a genuinely novel insight into how
  Spotify shapes your listening.
- **Co-playlist artist edges** are a curator's taste graph, not yours. Overlaying that
  on your co-session graph shows where your taste and a curator's agree — and where
  they diverge, which is where discovery lives.

**This is the part to protect if scope has to shrink.** It's unique, it uses data you
already sync, and no other tool gives it to you.

#### E. Where it fits in the codebase

- **New page:** `src/pages/Connections.tsx` (or `Map.tsx`), routed from the sidebar.
  Tabs for "Family tree" / "Pack" / "Playlists" / "Neighborhood" so they share a
  surface.
- **New query file:** `src/lib/graphQueries.ts` —
  `artistNeighborhood(seedId, {hops, edgeTypes})`, `artistFamilyTree(mbid, {depth})`,
  `playlistOverlapGraph()`, `packArtist(artistId)`. All read-only, all SQL over
  existing tables.
- **New SQL view** (in `src-tauri/sql/`): `graph_edges.sql` materializing the union of
  edge types into one shape:
  `(src_id, src_type, dst_id, dst_type, edge_type, weight)`.
  This is the key abstraction — every layout consumes the same edge table.
- **Rendering:** a `GraphCanvas` component using canvas for force layouts and SVG for
  tree/pack (small N, crisper text, existing SVG infrastructure). Both are new; both
  are self-contained.
- **Fixture tests:** graph edge SQL deserves fixture coverage — same discipline that
  caught the album-ride and stuck-repeat bugs.
- **Accessibility:** every graph needs a data-table alternative (per the existing
  Phase 8 accessibility candidate). A "list view" toggle that renders the same edges
  as a sortable table is the honest way to do this and doubles as a debugging tool.

#### F. Risks worth naming now

- **Hairball failure mode.** If the force graph ships without strong filtering and a
  seed-based entry point, it will look impressive once and never be opened again.
  Design the filters before the layout.
- **MusicBrainz relation quality varies.** Pop artists have rich relations; niche and
  non-Western artists often have sparse or missing ones. The tree will be uneven
  across your library. Surface the gap rather than showing an empty canvas.
- **Co-session edges scale quadratically.** A session with 50 artists produces up to
  1,225 edges. Cap edges per session (top N by play count) or weight by co-occurrence
  count rather than presence.
- **Force layouts are non-deterministic.** Seed the PRNG or every render looks
  different, which breaks shareability and muscle memory.
- **Performance on the real record.** 11,293 artists and 42,942 tracks means any
  "expand everything" affordance will hang. Enforce hop limits and node caps in the
  query layer, not the renderer.

---

## 3. Where each idea touches the codebase (quick reference)

| Recommendation | Primary files / tables |
|---|---|
| Record Hygiene page | `compute_sessions.sql`, `session_overrides`, `tz_overrides`, `set_session_attention` command |
| Import diffing | `import_*` SQL, `import_files` table |
| Notes / journal | new `notes` table in `schema.sql`; `composeNotes` in `notesQueries.ts` |
| On this day | `compute_milestones.sql`, `milestones` table |
| Life events | new `life_events` table; `compute_insights.sql` era naming |
| Concert memory | `concerts` table (exists); Setlist.fm connector (Phase 8 candidate) |
| Blind spots | `country_zones`, `artist_relations`, `artist_tags`; new query in `recQueries.ts` |
| Bubble score | new TS query; year-over-year artist share vectors (already computed for drift) |
| Rediscovery engine | `queries.ts` (forgotten favourites); needs a scheduled trigger |
| Anti-recommendations | `recQueries.ts`; new negative-signal query over `plays_resolved` |
| Cross-service import | `plays_normalized.source` column (exists); new connectors |
| Weather correlation | new optional `weather_cache` table; one-time historical fetch |
| Activity inference | `compute_sessions.sql` (shapes) + new `activities` view or table |
| Listening velocity | new queries in `queries.ts`; dashboard card |
| Playlist health | playlist tables (exist); new queries in `phase4Queries.ts` |
| Playlist genealogy | same; set intersection over playlist items |
| Auto-curation rules | new scheduled job; suggest-only writes |
| Blend v2 | `blend_plays` table (exists); loop over multiple labels |
| Audio features | Deezer or Essentia connector; new `track_features` table |
| Share microsite | `exportHtml.ts` (exists; extend) |
| Taste profile card | new canvas component; `Share cards` infra exists |
| Query console | `Db::assert_read_only` (exists); new page + command |
| Local API | `dev-server.mjs` command surface (exists; formalize) |
| CLI | new binary or `src-tauri/src/bin/`; reuses `commands.rs` |
| Saved views | `FilterContext` (exists); new persistence in `app_meta` |
| Plugin system | larger project; defer |
| Accessibility pass | everywhere; audit-first |
| Goals / quests | new `goals` table; dashboard card |
| Streaks | `getDashboardStats` (streak exists; extend) |
| Auto-update | Tauri updater config; signing key custody decision |
| Notifications | new scheduler jobs; OS notification API |
| Multi-record | `Db` path selection (exists for demo/real); UI switcher |
| **Artist family tree** | `artist_relations` (exists, MusicBrainz-sourced); new tree component; "Family tree" tab on artist page |
| **Containment pack** | entity resolution tables (exist); new circle-packing component |
| **Seed-based neighborhood graph** | new `graph_edges.sql` view; new `src/lib/graphQueries.ts`; new `GraphCanvas` component (canvas) |
| **Playlist overlap graph** | playlist tables (exist); new query in `graphQueries.ts`; smallest graph feature |
| **Co-session edges** | `plays_resolved` grouped by `session_id`; needs edge-per-session cap |
| **Co-playlist edges** | playlist items (exist); set-overlap query |
| **Graph data-table alternative** | new component; consumes same `graph_edges` view |

---

## 4. Deliberately not suggested (and why)

- **Cloud sync / accounts / a web version.** Violates the local-first principle
  documented in `docs/SETUP.md` §D and stated repeatedly in the project docs. Any
  future feature in this direction should be a separate product, not a Deep Cuts mode.
- **Telemetry / analytics on the user.** Same reason.
- **Storing full lyric text.** The copyright boundary is explicit in
  `PROJECT-STATUS-AND-ROADMAP.md` §1 (Phase 4 notes) and §5. Do not relax it.
- **Mobile app.** The Tauri stack doesn't extend to iOS/Android without significant
  rework; the effort is better spent on the desktop experience the owner actually uses.
- **Real-time collaborative features.** The Blend-via-file-exchange pattern is the
  right level for this project's ethos.
- **Making stats.fm work harder.** Per §2.2 of the roadmap doc, the stats.fm API is
  unofficial and the connector is unlikely to ever work as built. Do not invest more
  until stats.fm publishes something real.
- **A single unified "everything" graph view.** Tempting as the end state of §2.13, it
  is the hairball failure mode by definition. Every graph view should be seed-based
  and edge-type-filtered. If someone proposes "show all connections," that is a sign
  the scope has drifted.

---

## 5. A note on sequencing

If the owner picks any of these up, the workflow that has worked throughout this
project (per `PROJECT-STATUS-AND-ROADMAP.md` §5) should continue to apply:

1. Edit `.sql` files → validate with `scripts/validate_sql.py` and/or a one-off
   Python DuckDB script → run `scripts/test_sql_fixtures.py`.
2. Update the mirrored TypeScript in `src/lib/*Queries.ts`.
3. Add a fixture test for any new session-shape or attention-detection rule (the
   fixture suite is cheap insurance — it caught two real bugs before the owner saw
   them, plus the stuck-repeat false positive).
4. Smoke-test via `npm run dev:browser` against `dev-server.mjs`.
5. Only then touch Rust. The Rust layer is the least-proven part of the codebase per
   §2.1 of the roadmap doc.
6. Schema changes go at the end of `schema.sql` using `ALTER TABLE … ADD COLUMN IF
   NOT EXISTS` so existing owner records upgrade in place.

### 5.1 Sequencing the graph features specifically

The graph work in §2.13 is a multi-drop initiative and should be built smallest-first,
with each step reusing the previous step's edge table and rendering primitives.

1. **Playlist overlap graph** — smallest. Nodes are playlists (dozens, not thousands),
   edges are shared tracks. Trivial layout, immediately useful, feeds Library. Also
   the single highest-value standalone piece in §2.13. **~1 drop.**
2. **Artist family tree** — moderate. New SQL view over `artist_relations`, a tree
   component, a tab on the artist page. Deterministic layout, low risk. **~1–2 drops.**
3. **Containment pack** (artist → albums → tracks) — moderate. D3-pack or custom
   circle-packing. Very legible, no physics. **~1 drop.**
4. **Seed-based neighborhood force graph** — large. Force simulation, canvas renderer,
   filter UI, interaction model, performance tuning, seeded PRNG. **~2–3 drops,** plus
   ongoing tuning.
5. **Full multi-modal graph with all entity types** — the vision, and a capstone, not
   a stepping stone. Treat as Phase 9+.

Recommended: run steps 1–3 as independent drops *before* committing to step 4.
Steps 1–3 are each individually useful, each has bounded risk, and together they
validate the shared `graph_edges` abstraction before it carries the weight of a
general force-graph renderer. If step 4 never happens, steps 1–3 still stand on their
own.

---

*End of DeepSeek recommendations. Compiled September 11, 2026.*