//! DuckDB access. One connection, one writer (spec §2.3). Thin by design:
//! open, migrate, run embedded SQL files, and turn result sets into JSON rows
//! for the TypeScript side, which owns all analytics SQL.

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use duckdb::types::{TimeUnit, Value};
use duckdb::{params_from_iter, Connection};
use serde_json::{json, Map, Value as Json};
use std::path::Path;
use std::sync::Mutex;

// Embedded SQL — the analytics pipeline ships inside the binary.
pub const SCHEMA_SQL: &str = include_str!("../sql/schema.sql");
pub const ENTITY_RESOLUTION_SQL: &str = include_str!("../sql/entity_resolution.sql");
pub const COMPUTE_SESSIONS_SQL: &str = include_str!("../sql/compute_sessions.sql");
pub const DEMO_SEED_SQL: &str = include_str!("../sql/demo_seed.sql");
pub const IMPORT_EXISTING_KEYS_SQL: &str = include_str!("../sql/import_existing_keys.sql");
pub const IMPORT_STAGE_SQL: &str = include_str!("../sql/import_stage.sql");
pub const IMPORT_PREVIEW_SQL: &str = include_str!("../sql/import_preview.sql");
pub const IMPORT_INSERT_SQL: &str = include_str!("../sql/import_insert.sql");
pub const IMPORT_MARK_KEYS_SQL: &str = include_str!("../sql/import_mark_keys.sql");
pub const POLL_INSERT_SQL: &str = include_str!("../sql/poll_insert.sql");
pub const IMPORT_BLEND_SQL: &str = include_str!("../sql/import_blend.sql");
pub const COMPUTE_MILESTONES_SQL: &str = include_str!("../sql/compute_milestones.sql");
pub const COMPUTE_SCENES_SQL: &str = include_str!("../sql/compute_scenes.sql");     // Phase 9f
pub const COMPUTE_INSIGHTS_SQL: &str = include_str!("../sql/compute_insights.sql");
pub const WILD_INSERT_SQL: &str = include_str!("../sql/wild_insert.sql");   // Phase 8

pub struct Db {
    conn: Mutex<Connection>,
    pub zone: String,
}

pub type Row = Map<String, Json>;

impl Db {
    /// Open (or create) the database at `path`, apply the schema and load the
    /// time-zone offset table for `zone` (an IANA name, e.g. "America/Detroit").
    pub fn open(path: &Path, zone: &str) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        // We never depend on ICU; keep the session clock in UTC so TIMESTAMPTZ
        // casts are identity. (Ignored if the setting isn't available.)
        let _ = conn.execute_batch("SET TimeZone='UTC';");
        conn.execute_batch(SCHEMA_SQL).context("applying schema.sql")?;
        let db = Db { conn: Mutex::new(conn), zone: zone.to_string() };
        db.load_tz_offsets(zone)?;
        Ok(db)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Fill `tz_offsets` for the home zone plus every zone the record needs:
    /// single-zone countries seen in `conn_country` and manual travel overrides.
    /// One row per UTC-offset change between 2008 and 2032, walked hourly.
    pub fn load_tz_offsets(&self, zone: &str) -> Result<()> {
        let mut zones: Vec<String> = vec![zone.to_string()];
        if let Ok(rows) = self.query(
            "SELECT DISTINCT cz.zone FROM plays_normalized p JOIN country_zones cz USING (country)              UNION SELECT DISTINCT zone FROM tz_overrides WHERE zone IS NOT NULL", &[]) {
            for r in rows { if let Some(z) = r.get("zone").and_then(|v| v.as_str()) { if !zones.iter().any(|x| x == z) { zones.push(z.to_string()); } } }
        }
        let conn = self.lock();
        conn.execute_batch("DELETE FROM tz_offsets;")?;
        let mut stmt = conn.prepare("INSERT INTO tz_offsets (from_utc, offset_s, zone) VALUES (?, ?, ?)")?;
        for z in &zones {
            let tz: chrono_tz::Tz = match z.parse() { Ok(t) => t, Err(_) => { log::warn!("unknown time zone {z}; skipped"); continue; } };
            let mut t = Utc.with_ymd_and_hms(2008, 1, 1, 0, 0, 0).unwrap();
            let end = Utc.with_ymd_and_hms(2032, 1, 1, 0, 0, 0).unwrap();
            let mut prev: Option<i32> = None;
            while t < end {
                let off = tz.offset_from_utc_datetime(&t.naive_utc());
                let secs = chrono::Offset::fix(&off).local_minus_utc();
                if prev != Some(secs) {
                    stmt.execute(duckdb::params![t.naive_utc().format("%Y-%m-%d %H:%M:%S").to_string(), secs, z.as_str()])?;
                    prev = Some(secs);
                }
                t += chrono::Duration::hours(1);
            }
        }
        drop(stmt);
        conn.execute(
            "INSERT INTO app_meta (key, value) VALUES ('timezone', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            duckdb::params![zone],
        )?;
        Ok(())
    }

    /// Run a multi-statement script (no parameters).
    pub fn exec_batch(&self, sql: &str) -> Result<()> {
        self.lock().execute_batch(sql)?;
        Ok(())
    }

    /// Run a single statement with JSON parameters. Returns affected rows.
    pub fn exec(&self, sql: &str, params: &[Json]) -> Result<usize> {
        let conn = self.lock();
        let vals: Vec<Value> = params.iter().map(json_to_value).collect();
        Ok(conn.execute(sql, params_from_iter(vals))?)
    }

    /// Run a read-only query and return rows as JSON objects (column → value).
    pub fn query(&self, sql: &str, params: &[Json]) -> Result<Vec<Row>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(sql)?;
        let vals: Vec<Value> = params.iter().map(json_to_value).collect();
        let mut rows = stmt.query(params_from_iter(vals))?;
        let names: Vec<String> = rows
            .as_ref()
            .map(|s| s.column_names())
            .unwrap_or_default();
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let mut obj = Map::with_capacity(names.len());
            for (i, name) in names.iter().enumerate() {
                let v: Value = row.get_ref(i)?.to_owned();
                obj.insert(name.clone(), value_to_json(v));
            }
            out.push(obj);
        }
        Ok(out)
    }

    /// Enforce read-only SQL for the UI query bridge (also the seam NFR-04's
    /// LLM validator will reuse): one statement, SELECT/WITH only.
    ///
    /// LIMITATION (Phase 8 review): this is substring matching, not a SQL parser.
    /// It can false-positive (a literal containing "DROP " inside a LIKE pattern
    /// trips it) and it gives a false sense of rigor. It is adequate for the
    /// trusted UI today, but before the LLM "Ask" phase feeds *model-written*
    /// SQL through here it should be replaced by a real parse (DuckDB's own
    /// `json_serialize_sql` can classify statement type) or a strict allow-list
    /// grammar. Tracked in docs/PROJECT-STATUS-AND-ROADMAP.md.
    pub fn assert_read_only(sql: &str) -> Result<()> {
        let trimmed = sql.trim().trim_end_matches(';');
        if trimmed.contains(';') {
            return Err(anyhow!("only a single statement is allowed"));
        }
        let head = trimmed
            .split_whitespace()
            .next()
            .map(|w| w.to_ascii_uppercase())
            .unwrap_or_default();
        if head != "SELECT" && head != "WITH" && head != "DESCRIBE" && head != "SHOW" {
            return Err(anyhow!("only SELECT / WITH queries are allowed"));
        }
        let upper = trimmed.to_ascii_uppercase();
        for bad in ["INSERT ", "UPDATE ", "DELETE ", "DROP ", "ALTER ", "CREATE ", "ATTACH ", "COPY ", "EXPORT ", "IMPORT ", "PRAGMA ", "INSTALL ", "LOAD ", "CALL "] {
            if upper.contains(bad) {
                return Err(anyhow!("statement contains a disallowed keyword: {}", bad.trim()));
            }
        }
        Ok(())
    }

    pub fn scalar_i64(&self, sql: &str) -> Result<i64> {
        let rows = self.query(sql, &[])?;
        Ok(rows
            .first()
            .and_then(|r| r.values().next())
            .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
            .unwrap_or(0))
    }

    pub fn scalar_f64(&self, sql: &str) -> Result<f64> {
        let rows = self.query(sql, &[])?;
        Ok(rows
            .first()
            .and_then(|r| r.values().next())
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0))
    }

    pub fn log_activity(&self, task: &str, level: &str, message: &str, detail: Option<&str>) {
        let _ = self.exec(
            "INSERT INTO activity_log (task, level, message, detail) VALUES (?, ?, ?, ?)",
            &[json!(task), json!(level), json!(message), json!(detail)],
        );
    }

    /// DM-02 rebuild: entity resolution → sessions → milestones.
    pub fn rebuild_all(&self) -> Result<()> {
        self.exec_batch(ENTITY_RESOLUTION_SQL).context("entity_resolution.sql")?;
        self.exec_batch(COMPUTE_SESSIONS_SQL).context("compute_sessions.sql")?;
        self.exec_batch(COMPUTE_MILESTONES_SQL).context("compute_milestones.sql")?;
        self.exec_batch(COMPUTE_SCENES_SQL).context("compute_scenes.sql")?;
        self.exec_batch(COMPUTE_INSIGHTS_SQL).context("compute_insights.sql")?;
        self.checkpoint()
    }

    pub fn checkpoint(&self) -> Result<()> {
        self.lock().execute_batch("CHECKPOINT;")?;
        Ok(())
    }
}

fn json_to_value(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Boolean(*b),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::BigInt(i)
            } else {
                Value::Double(n.as_f64().unwrap_or(0.0))
            }
        }
        Json::String(s) => Value::Text(s.clone()),
        other => Value::Text(other.to_string()),
    }
}

fn ts_to_string(unit: TimeUnit, v: i64) -> String {
    let (secs, nanos) = match unit {
        TimeUnit::Second => (v, 0),
        TimeUnit::Millisecond => (v.div_euclid(1000), (v.rem_euclid(1000) * 1_000_000) as u32),
        TimeUnit::Microsecond => (v.div_euclid(1_000_000), (v.rem_euclid(1_000_000) * 1000) as u32),
        TimeUnit::Nanosecond => (v.div_euclid(1_000_000_000), v.rem_euclid(1_000_000_000) as u32),
    };
    match DateTime::<Utc>::from_timestamp(secs, nanos) {
        Some(dt) => dt.format("%Y-%m-%d %H:%M:%S").to_string(),
        None => v.to_string(),
    }
}

fn date_to_string(days: i32) -> String {
    let base = NaiveDateTime::parse_from_str("1970-01-01 00:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
    (base + chrono::Duration::days(days as i64)).format("%Y-%m-%d").to_string()
}

pub fn value_to_json(v: Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Boolean(b) => json!(b),
        Value::TinyInt(i) => json!(i),
        Value::SmallInt(i) => json!(i),
        Value::Int(i) => json!(i),
        Value::BigInt(i) => json!(i),
        Value::HugeInt(i) => json!(i as f64),
        Value::UHugeInt(i) => json!(i as f64),
        Value::UTinyInt(i) => json!(i),
        Value::USmallInt(i) => json!(i),
        Value::UInt(i) => json!(i),
        Value::UBigInt(i) => json!(i),
        Value::Float(f) => json!(f),
        Value::Double(f) => json!(f),
        Value::Decimal(d) => d.to_string().parse::<f64>().map(|f| json!(f)).unwrap_or_else(|_| json!(d.to_string())),
        Value::Timestamp(unit, t) => json!(ts_to_string(unit, t)),
        Value::Date32(d) => json!(date_to_string(d)),
        Value::Time64(_, t) => json!(t),
        Value::Text(s) => json!(s),
        Value::Enum(s) => json!(s),
        Value::Blob(b) | Value::Geometry(b) => json!(format!("<{} bytes>", b.len())),
        Value::Interval { months, days, nanos } => json!({ "months": months, "days": days, "nanos": nanos }),
        Value::List(items) | Value::Array(items) => Json::Array(items.into_iter().map(value_to_json).collect()),
        Value::Struct(m) => {
            let mut obj = Map::new();
            for (k, val) in m.iter() {
                obj.insert(k.clone(), value_to_json(val.clone()));
            }
            Json::Object(obj)
        }
        Value::Map(m) => {
            let mut obj = Map::new();
            for (k, val) in m.iter() {
                obj.insert(format!("{k:?}"), value_to_json(val.clone()));
            }
            Json::Object(obj)
        }
        Value::Union(inner) => value_to_json(*inner),
        // `Value` is #[non_exhaustive]; render anything new as its debug form rather than failing.
        other => json!(format!("{other:?}")),
    }
}
