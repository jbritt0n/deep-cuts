(globalThis as unknown as { window: object }).window = {};
import { askArchive, llmStatus } from '../src/lib/ask';
import { setActiveFilter } from '../src/lib/filter';
import { primeSettings } from '../src/lib/settings';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null }); primeSettings({});
const st = await llmStatus(); console.log(`✓ llm_status ${st.reachable ? 'reachable' : 'unreachable'} · ${st.models.join(',')}`);
if (!st.reachable) { console.log('  (run with OLLAMA_MOCK=1 on the dev server, or a real Ollama, to exercise the pipeline)'); process.exit(0); }
const t = await askArchive('Who are my most played artists?', st.models[0]); console.log(`✓ ask · ${t.rowCount} rows · ${t.error ?? 'ok'} · sql: ${t.sql?.slice(0, 60)} · ${t.narrative?.slice(0, 60)}`);
const t2 = await askArchive('What tracks with river in their lyrics do I play?', st.models[0], [t]); console.log(`✓ ask tracks · ${t2.tracks?.length ?? 0} tracks lifted`);
const t3 = await askArchive('What did I play on rainy days?', st.models[0]); console.log(`✓ ask unanswerable · ${t3.narrative}`);
