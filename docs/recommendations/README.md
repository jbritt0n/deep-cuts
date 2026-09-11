# External advisory reviews

Four outside reads of the codebase at Phase 7d (all Sep 11 2026), kept verbatim for reference:

| File | Source | What it is |
|---|---|---|
| `NEXT-DROP-RECOMMENDATIONS.md` | synthesis | De-duplicated plan built on the three below plus an independent code read. **Start here.** |
| `deepseek_markdown_20260911_eca849.md` | DeepSeek | Feature menu by theme, incl. the graph/connection views initiative and its build order |
| `deepseek_markdown_20260911_d17ea2.md` | DeepSeek | Service-connector assessment, tiers, and the connector build contract |
| `kimi-recommendations.md` | Kimi | Codebase review + corrections to an earlier Gemini doc (wrong stack claims) + T1–T7 / R1–R7 |

**Phase 8 took** from these: CI test gating (Kimi T1), vitest coverage and the parameterised-SQL fix (synthesis §1.3/§1.1), the `assert_read_only` note (§1.2), the owner's §3 items, and the first slice of Record Hygiene (§2.1.1). Two owner ideas not in any of these documents — Shazam/Now Playing capture and discovery by genre — became *Heard in the Wild* and *Browse by genre*.

**Still open** is tracked in `docs/PROJECT-STATUS-AND-ROADMAP.md` §4. These files are not updated as items ship; the roadmap is.
