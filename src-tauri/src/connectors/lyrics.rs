//! Lyric features via LRCLIB (free, no key). We fetch plain lyrics per track,
//! extract derived features on-device — keyword list, theme tags, colours,
//! word count — and DISCARD the text. Nothing copyrighted is stored (schema:
//! track_lyric_features). Politeness: ≤ 2 requests/second, descriptive UA.

use crate::db::Db;
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

const API: &str = "https://lrclib.net/api/get";
const UA: &str = "DeepCuts/3.0 (local personal listening analytics; https://github.com/deep-cuts/deep-cuts)";

const STOP: &[&str] = &["the","and","you","that","for","with","this","but","your","are","not","have","all","was","what","when","just","like","know","get","got","can","dont","don't","im","i'm","its","it's","she","her","him","his","they","them","then","than","there","here","from","out","about","into","been","ill","i'll","ive","i've","were","we're","cant","can't","wont","won't","yeah","ooh","oh","ah","na","la","let","one","now","see","say","said","come","gonna","wanna","make","take","cause","'cause","because","never","ever","every","only","down","back","away","over","again","through","around","some","more","much","want","need","tell","give","keep","feel","time","way","day","thing","things","would","could","should","will","did","does","doing","being","where","who","how","why","our","their","these","those","yours","mine","too","very","also","still","even","well","right","left","little","long","many"];

/// Theme dictionary: theme → words that trigger it. Kept deliberately small and literal.
fn themes() -> Vec<(&'static str, &'static [&'static str])> {
    vec![
        ("rain", &["rain", "rains", "raining", "rainy", "storm", "storms", "thunder", "downpour", "drizzle", "umbrella"]),
        ("night", &["night", "nights", "midnight", "tonight", "moon", "moonlight", "stars", "starlight", "dark", "darkness", "3am", "insomnia"]),
        ("sun", &["sun", "sunshine", "sunlight", "sunny", "summer", "sunrise", "sunset", "golden", "warm", "heat"]),
        ("winter", &["winter", "snow", "snowing", "cold", "ice", "frozen", "freeze", "december", "frost"]),
        ("ocean", &["ocean", "sea", "waves", "tide", "shore", "beach", "sand", "sail", "sailing", "harbor", "harbour"]),
        ("city", &["city", "cities", "streets", "street", "downtown", "subway", "traffic", "neon", "skyline", "sidewalk", "avenue"]),
        ("road", &["road", "roads", "highway", "drive", "driving", "car", "wheels", "miles", "travel", "travelling", "traveling", "journey"]),
        ("home", &["home", "house", "room", "bed", "kitchen", "window", "door", "porch", "hometown"]),
        ("love", &["love", "loved", "lover", "loving", "kiss", "kisses", "heart", "hearts", "darling", "baby", "honey"]),
        ("heartbreak", &["goodbye", "gone", "leave", "leaving", "left", "lonely", "alone", "cry", "crying", "tears", "broken", "miss", "missing"]),
        ("dance", &["dance", "dancing", "dancefloor", "party", "disco", "groove", "move", "moving", "rhythm", "beat"]),
        ("dream", &["dream", "dreams", "dreaming", "sleep", "asleep", "awake", "wake"]),
        ("fire", &["fire", "flame", "flames", "burn", "burning", "smoke", "ashes", "spark"]),
        ("money", &["money", "dollar", "dollars", "rich", "gold", "cash", "pay", "paid", "work", "working", "job"]),
        ("faith", &["god", "heaven", "hell", "pray", "prayer", "angel", "angels", "soul", "souls", "devil", "sin", "holy"]),
        ("youth", &["young", "youth", "kids", "school", "teenage", "teenager", "seventeen", "sixteen", "child", "childhood", "grow", "growing"]),
        ("death", &["die", "died", "dying", "death", "dead", "grave", "funeral", "kill", "killed", "bury", "buried"]),
        ("war", &["war", "soldier", "soldiers", "gun", "guns", "fight", "fighting", "battle", "army", "bullet", "bullets"]),
        ("time", &["yesterday", "tomorrow", "forever", "years", "hours", "minutes", "clock", "memories", "memory", "remember"]),
        ("nature", &["river", "mountain", "mountains", "forest", "trees", "tree", "flowers", "flower", "garden", "wind", "sky", "field", "fields", "birds", "bird"]),
    ]
}
const COLOURS: &[&str] = &["red", "blue", "green", "yellow", "purple", "violet", "black", "white", "gold", "golden", "silver", "grey", "gray", "pink", "orange", "brown", "crimson", "scarlet", "indigo", "turquoise", "lavender"];

pub struct Features { pub word_count: i64, pub keywords: Vec<String>, pub themes: Vec<String>, pub colours: Vec<String> }

/// Pure function: lyrics text → derived features. Text is not retained by the caller.
pub fn extract(text: &str) -> Features {
    let stop: HashSet<&str> = STOP.iter().copied().collect();
    let mut freq: HashMap<String, usize> = HashMap::new();
    let mut n = 0i64;
    for raw in text.split(|c: char| !c.is_alphanumeric() && c != '\'') {
        let w = raw.trim_matches('\'').to_lowercase();
        if w.len() < 3 || w.chars().all(|c| c.is_ascii_digit()) { continue; }
        n += 1;
        if stop.contains(w.as_str()) { continue; }
        *freq.entry(w).or_insert(0) += 1;
    }
    let mut kw: Vec<(String, usize)> = freq.into_iter().collect();
    kw.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let words: HashSet<String> = kw.iter().map(|(w, _)| w.clone()).collect();
    let mut th = Vec::new();
    for (theme, triggers) in themes() { if triggers.iter().any(|t| words.contains(*t)) { th.push(theme.to_string()); } }
    let colours: Vec<String> = COLOURS.iter().filter(|c| words.contains(**c)).map(|c| c.to_string()).collect();
    Features { word_count: n, keywords: kw.into_iter().take(40).map(|(w, _)| w).collect(), themes: th, colours }
}

fn arr(v: &[String]) -> Value { json!(serde_json::to_string(v).unwrap_or_else(|_| "[]".into())) }

/// Fetch and featurise the most-played tracks that haven't been looked up yet.
pub fn enrich_batch(db: &Db, max_tracks: usize) -> Result<usize> {
    let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(15)).user_agent(UA).build()?;
    let rows = db.query(&format!(
        "SELECT t.track_id, t.name, a.name AS artist, al.name AS album, COALESCE(t.duration_ms, t.duration_ms_est) AS dur
         FROM tracks t LEFT JOIN artists a ON a.artist_id = t.artist_id LEFT JOIN albums al ON al.album_id = t.album_id
         JOIN (SELECT track_id, COUNT(*) c FROM plays_resolved WHERE attended GROUP BY 1) p USING (track_id)
         WHERE NOT EXISTS (SELECT 1 FROM track_lyric_features f WHERE f.track_id = t.track_id) AND t.name IS NOT NULL AND a.name IS NOT NULL
         ORDER BY p.c DESC LIMIT {max_tracks}"), &[])?;
    let mut n = 0;
    for r in rows {
        let g = |k: &str| r.get(k).and_then(|v| v.as_str()).map(str::to_string);
        let (Some(id), Some(name), Some(artist)) = (g("track_id"), g("name"), g("artist")) else { continue };
        let mut q: Vec<(&str, String)> = vec![("track_name", name.clone()), ("artist_name", artist.clone())];
        if let Some(al) = g("album") { q.push(("album_name", al)); }
        if let Some(d) = r.get("dur").and_then(|v| v.as_i64()) { q.push(("duration", (d / 1000).to_string())); }
        let resp = http.get(API).query(&q).send();
        let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('lrclib', 'get', ?)", &[json!(resp.as_ref().map(|r| r.status().as_u16() as i64).unwrap_or(0))]);
        match resp {
            Ok(res) if res.status().is_success() => {
                let v: Value = res.json().unwrap_or(Value::Null);
                let text = v["plainLyrics"].as_str().unwrap_or("");
                if text.trim().is_empty() {
                    db.exec("INSERT INTO track_lyric_features (track_id, source, found) VALUES (?, 'lrclib', FALSE) ON CONFLICT DO NOTHING", &[json!(id)])?;
                } else {
                    let f = extract(text);
                    db.exec("INSERT INTO track_lyric_features (track_id, source, found, word_count, keywords, themes, colours, lang) VALUES (?, 'lrclib', TRUE, ?, CAST(? AS JSON)::VARCHAR[], CAST(? AS JSON)::VARCHAR[], CAST(? AS JSON)::VARCHAR[], NULL) ON CONFLICT DO NOTHING",
                        &[json!(id), json!(f.word_count), arr(&f.keywords), arr(&f.themes), arr(&f.colours)])?;
                }
                n += 1;
            }
            Ok(res) if res.status().as_u16() == 404 => {
                db.exec("INSERT INTO track_lyric_features (track_id, source, found) VALUES (?, 'lrclib', FALSE) ON CONFLICT DO NOTHING", &[json!(id)])?;
                n += 1;
            }
            Ok(res) if res.status().as_u16() == 429 => { std::thread::sleep(Duration::from_secs(30)); break; }
            Ok(_) | Err(_) => break,
        }
        std::thread::sleep(Duration::from_millis(600));
    }
    if n > 0 { db.log_activity("lyrics", "info", &format!("Lyric features for {n} tracks"), None); }
    Ok(n)
}
