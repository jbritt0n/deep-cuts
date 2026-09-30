//! Lyric features via LRCLIB (free, no key). We fetch plain lyrics per track, extract derived
//! features on-device and DISCARD the text. Nothing copyrighted is stored (schema:
//! track_lyric_features, track_lyric_terms). Politeness: ≤ 2 requests/second, descriptive UA.
//!
//! Phase 9f (features_rev 2) — owner feedback: "keywords are generic, themes don't match the feel".
//!   * Keywords are no longer the most frequent words of one song. We store each song's top content
//!     words with their counts (`track_lyric_terms`) and the `track_lyric_keywords` view scores them
//!     TF-IDF against *your* lyric corpus — a word that appears in a third of your songs ("love",
//!     "night", "baby") stops counting as a keyword for any of them. The stop list is also ~5× larger
//!     and covers contractions, fillers and vocalisations.
//!   * Themes are scored, not triggered. Each theme has weighted cue words; a theme needs ≥ 2 distinct
//!     cues or ≥ 3 hits, and its score is weighted hits per 100 content words. Only the top 4 above a
//!     floor are kept in `themes`; the full score map is in `theme_scores` so the UI can show strength.
//!   * Structure: `valence` (−1…+1 from a small sentiment lexicon), `repetition` (1 − distinct/total),
//!     `vocab`. Language is detected from function-word hits; themes/valence are only computed for
//!     English (the lexicons are English), so a Turkish or Japanese song gets terms and structure but
//!     no themes rather than wrong ones.
//!   * Optional: when `lyrics_llm_enabled` is on and Ollama is reachable, the transient text is also
//!     shown to the local model for 3–5 themes and a one-phrase mood (`llm_themes`, `llm_mood`).
//!     The text still never touches the database.
//! Rows written under the old rules (features_rev 1) are re-fetched and re-featurised gradually.

use crate::db::Db;
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

pub const FEATURES_REV: i64 = 2;
const API: &str = "https://lrclib.net/api/get";
const UA: &str = "DeepCuts/3.0 (local personal listening analytics; https://github.com/deep-cuts/deep-cuts)";

const STOP: &str = "the and you that for with this but your are not have all was what when just like know get got can dont don't im i'm its it's she her him his they them then than there here from out about into been ill i'll ive i've were we're cant can't wont won't yeah ooh oh ah na la let one now see say said come gonna wanna make take cause 'cause because never ever every only down back away over again through around some more much want need tell give keep feel time way day thing things would could should will did does doing being where who how why our their these those yours mine too very also still even well right left little long many \
a an i me my we us it in on at to of by or as if so no yes up off is be do go am has had he she's he's you're they're we've you've they've i'd you'd he'd she'd we'd they'd who's what's that's there's here's where's let's ain't isn't aren't wasn't weren't hasn't haven't hadn't doesn't didn't couldn't shouldn't wouldn't mustn't gotta gotcha kinda sorta outta lemme gimme ya yo yall y'all em 'em til till until while whether either neither both each other another any anything anyone anybody everything everyone everybody nothing nobody someone something somebody somewhere anywhere everywhere nowhere myself yourself himself herself itself ourselves themselves \
ohh ooo uh huh hey heya hoo whoa woah wow yea yeh yep nah mmm mm hmm hm ha haha aah ahh eh ay ayy aye dum doo wop bop sha nananana ooooh woo alright okay ok \
chorus verse bridge intro outro hook refrain repeat x2 x3 x4 instrumental \
gone going went goes came comes coming made makes making took takes taking gave gives giving told tells telling knew knows knowing gets getting felt feels feeling saw sees seeing think thought thinks thinking look looked looks looking find found finds finding put puts turn turned turns try tried tries trying call called calls hold held holds holding run running ran stay stayed stays walk walked walks talk talked talks wait waited waits believe believed believes mean meant means show showed shows seem seemed seems \
always sometimes maybe really truly actually probably already yet almost enough quite rather pretty least most less better best worse worst good bad new old big small high low first last next same different whole own such else \
inside outside without within before after since during between against along across behind above below under toward towards upon onto near far \
today tonight tomorrow yesterday someday sometime somehow anyway anymore anyhow everyday once twice";

/// Theme lexicon: (theme, cues with weight). Weight 2 = strongly diagnostic; 1 = supportive; 0.5 = weak.
/// Concrete nouns/verbs on purpose; abstract fillers ("feel", "want") are excluded because they fire everywhere.
fn themes() -> Vec<(&'static str, Vec<(&'static str, f64)>)> {
    let w = |list: &[(&'static str, f64)]| list.to_vec();
    vec![
        ("rain", w(&[("rain", 2.), ("rains", 2.), ("raining", 2.), ("rainy", 2.), ("storm", 1.5), ("storms", 1.5), ("thunder", 1.5), ("downpour", 2.), ("drizzle", 2.), ("umbrella", 2.), ("puddles", 2.), ("lightning", 1.), ("clouds", 1.)])),
        ("night", w(&[("midnight", 2.), ("moon", 1.5), ("moonlight", 2.), ("starlight", 2.), ("stars", 1.), ("darkness", 1.), ("3am", 2.), ("insomnia", 2.), ("streetlights", 1.5), ("nightfall", 2.), ("dusk", 1.5), ("nocturnal", 2.), ("sleepless", 2.), ("night", 0.5)])),
        ("sun & summer", w(&[("sunshine", 2.), ("sunlight", 2.), ("sunny", 2.), ("summer", 1.5), ("summertime", 2.), ("sunrise", 1.5), ("sunset", 1.5), ("heatwave", 2.), ("july", 1.5), ("august", 1.5), ("sunburn", 2.), ("shade", 1.), ("golden", 0.5)])),
        ("winter", w(&[("winter", 2.), ("snow", 2.), ("snowing", 2.), ("snowfall", 2.), ("frost", 2.), ("frozen", 1.5), ("freeze", 1.), ("freezing", 1.5), ("ice", 1.), ("december", 1.5), ("january", 1.5), ("blizzard", 2.), ("cold", 0.5)])),
        ("ocean & shore", w(&[("ocean", 2.), ("sea", 1.5), ("waves", 1.5), ("tide", 2.), ("tides", 2.), ("shore", 2.), ("beach", 1.5), ("sand", 1.), ("sail", 1.5), ("sailing", 1.5), ("harbour", 2.), ("harbor", 2.), ("island", 1.), ("lighthouse", 2.), ("seaside", 2.), ("undertow", 2.), ("saltwater", 2.), ("shipwreck", 2.)])),
        ("river & lake", w(&[("river", 2.), ("rivers", 2.), ("riverside", 2.), ("stream", 1.5), ("creek", 2.), ("lake", 1.5), ("downstream", 2.), ("water", 0.5)])),
        ("the city", w(&[("city", 1.5), ("cities", 1.5), ("streets", 1.), ("downtown", 2.), ("subway", 2.), ("traffic", 1.5), ("neon", 1.5), ("skyline", 2.), ("sidewalk", 2.), ("avenue", 1.5), ("apartment", 1.5), ("taxi", 1.5), ("rooftop", 1.5), ("concrete", 1.), ("skyscraper", 2.), ("uptown", 2.), ("boulevard", 2.), ("metro", 1.5), ("suburbs", 1.5)])),
        ("the road", w(&[("highway", 2.), ("road", 1.), ("roads", 1.5), ("driving", 1.5), ("drove", 1.5), ("wheels", 1.5), ("miles", 1.5), ("journey", 1.5), ("motel", 2.), ("gasoline", 2.), ("hitchhike", 2.), ("interstate", 2.), ("headlights", 2.), ("windshield", 2.), ("passenger", 1.5), ("dashboard", 2.), ("route", 1.5), ("wander", 1.), ("roam", 1.5)])),
        ("home", w(&[("home", 1.), ("house", 1.), ("kitchen", 2.), ("porch", 2.), ("hometown", 2.), ("doorstep", 2.), ("hallway", 2.), ("backyard", 2.), ("living room", 2.), ("bedroom", 1.5), ("garden", 1.), ("neighbours", 1.5), ("neighbors", 1.5), ("attic", 2.), ("basement", 1.5), ("staircase", 2.), ("curtains", 1.5), ("windowsill", 2.)])),
        ("romance", w(&[("kiss", 2.), ("kisses", 2.), ("kissed", 2.), ("darling", 2.), ("lover", 1.5), ("lovers", 1.5), ("sweetheart", 2.), ("embrace", 1.5), ("lips", 1.5), ("desire", 1.5), ("romance", 2.), ("valentine", 2.), ("honeymoon", 2.), ("adore", 1.5), ("tender", 1.5), ("caress", 2.), ("love", 0.5)])),
        ("heartbreak", w(&[("goodbye", 1.5), ("lonely", 1.5), ("alone", 1.), ("cry", 1.), ("crying", 1.5), ("tears", 1.5), ("broken", 1.), ("heartbreak", 2.), ("heartbroken", 2.), ("missing", 1.), ("apart", 1.), ("betrayed", 2.), ("cheated", 2.), ("divorce", 2.), ("farewell", 2.), ("regret", 1.5), ("regrets", 1.5), ("ruins", 1.5), ("wreck", 1.), ("shattered", 1.5), ("empty", 1.)])),
        ("longing", w(&[("yearn", 2.), ("yearning", 2.), ("ache", 1.5), ("aching", 1.5), ("wish", 1.), ("wishing", 1.), ("waiting", 1.), ("faraway", 2.), ("distance", 1.5), ("distant", 1.5), ("homesick", 2.), ("crave", 1.5), ("craving", 1.5), ("return", 1.), ("reunion", 2.)])),
        ("nostalgia & memory", w(&[("memories", 2.), ("memory", 1.5), ("remember", 1.), ("remembering", 1.5), ("photograph", 2.), ("photographs", 2.), ("polaroid", 2.), ("years ago", 2.), ("childhood", 1.5), ("used to", 1.), ("old days", 2.), ("faded", 1.5), ("souvenir", 2.), ("reminisce", 2.), ("nostalgia", 2.), ("nostalgic", 2.), ("younger", 1.)])),
        ("dancing & party", w(&[("dance", 1.5), ("dancing", 1.5), ("dancefloor", 2.), ("party", 1.5), ("disco", 2.), ("groove", 1.5), ("rhythm", 1.), ("boogie", 2.), ("club", 1.), ("dj", 1.5), ("shake", 1.), ("funky", 1.5), ("jam", 1.), ("celebrate", 1.5), ("bounce", 1.)])),
        ("dreams & sleep", w(&[("dream", 1.5), ("dreams", 1.5), ("dreaming", 1.5), ("dreamt", 2.), ("dreamer", 2.), ("asleep", 1.5), ("awake", 1.), ("pillow", 2.), ("nightmare", 2.), ("nightmares", 2.), ("lullaby", 2.), ("slumber", 2.), ("daydream", 2.), ("sleepwalk", 2.), ("subconscious", 2.)])),
        ("fire & smoke", w(&[("fire", 1.5), ("flame", 2.), ("flames", 2.), ("burn", 1.), ("burning", 1.5), ("smoke", 1.5), ("ashes", 2.), ("spark", 1.), ("sparks", 1.5), ("ember", 2.), ("embers", 2.), ("inferno", 2.), ("wildfire", 2.), ("cigarette", 1.5), ("cigarettes", 1.5), ("torch", 1.5), ("blaze", 2.)])),
        ("money & work", w(&[("money", 2.), ("dollar", 2.), ("dollars", 2.), ("cash", 2.), ("rich", 1.5), ("paid", 1.), ("paycheck", 2.), ("bills", 1.5), ("rent", 1.5), ("boss", 1.5), ("factory", 2.), ("overtime", 2.), ("hustle", 1.5), ("broke", 1.), ("poverty", 2.), ("wealth", 2.), ("millionaire", 2.), ("diamonds", 1.5), ("greed", 2.), ("bank", 1.), ("job", 1.), ("working", 1.), ("labor", 1.5), ("labour", 1.5)])),
        ("faith & the divine", w(&[("god", 1.5), ("lord", 1.5), ("heaven", 1.5), ("hell", 1.), ("pray", 2.), ("prayer", 2.), ("praying", 2.), ("angel", 1.5), ("angels", 1.5), ("devil", 1.5), ("sin", 1.5), ("sins", 1.5), ("holy", 1.5), ("church", 2.), ("preacher", 2.), ("jesus", 2.), ("gospel", 2.), ("faith", 1.5), ("blessed", 1.5), ("hallelujah", 2.), ("salvation", 2.), ("sacred", 1.5), ("temple", 1.5), ("sermon", 2.), ("bible", 2.), ("mercy", 1.5), ("saint", 1.5), ("saints", 1.5), ("soul", 0.5)])),
        ("youth & growing up", w(&[("young", 1.), ("youth", 2.), ("kids", 1.5), ("school", 1.5), ("teenage", 2.), ("teenager", 2.), ("seventeen", 2.), ("sixteen", 2.), ("eighteen", 1.5), ("childhood", 1.5), ("grow", 1.), ("growing", 1.), ("grew", 1.5), ("innocent", 1.5), ("innocence", 2.), ("playground", 2.), ("prom", 2.), ("graduation", 2.), ("adolescent", 2.), ("boyhood", 2.), ("girlhood", 2.)])),
        ("death & mourning", w(&[("die", 1.), ("died", 1.5), ("dying", 1.5), ("death", 2.), ("dead", 1.), ("grave", 2.), ("graves", 2.), ("funeral", 2.), ("bury", 2.), ("buried", 2.), ("coffin", 2.), ("ghost", 1.5), ("ghosts", 1.5), ("mourn", 2.), ("mourning", 2.), ("widow", 2.), ("tombstone", 2.), ("cemetery", 2.), ("afterlife", 2.), ("eulogy", 2.), ("bones", 1.), ("dust", 0.5)])),
        ("war & violence", w(&[("war", 2.), ("soldier", 2.), ("soldiers", 2.), ("gun", 1.5), ("guns", 1.5), ("fight", 1.), ("fighting", 1.), ("battle", 1.5), ("army", 2.), ("bullet", 2.), ("bullets", 2.), ("bomb", 2.), ("bombs", 2.), ("blood", 1.), ("knife", 1.5), ("trigger", 1.5), ("enemy", 1.5), ("enemies", 1.5), ("warfare", 2.), ("trenches", 2.), ("shrapnel", 2.), ("uniform", 1.5), ("riot", 1.5), ("violence", 2.)])),
        ("time passing", w(&[("forever", 1.), ("years", 1.), ("hours", 1.), ("minutes", 1.), ("seconds", 1.), ("clock", 2.), ("clocks", 2.), ("ticking", 2.), ("calendar", 2.), ("decades", 2.), ("centuries", 2.), ("eternity", 2.), ("fleeting", 2.), ("temporary", 1.5), ("moments", 1.), ("aging", 1.5), ("ageing", 1.5), ("older", 1.), ("hourglass", 2.), ("moment", 0.5)])),
        ("nature & wild", w(&[("mountain", 1.5), ("mountains", 1.5), ("forest", 2.), ("trees", 1.5), ("tree", 1.), ("flowers", 1.5), ("flower", 1.), ("wind", 1.), ("field", 1.), ("fields", 1.5), ("birds", 1.5), ("bird", 1.), ("valley", 1.5), ("meadow", 2.), ("wolves", 2.), ("wolf", 1.5), ("deer", 2.), ("leaves", 1.5), ("roots", 1.), ("soil", 1.5), ("moss", 2.), ("canyon", 2.), ("desert", 1.5), ("prairie", 2.), ("wilderness", 2.), ("bloom", 1.5), ("petals", 2.), ("thorns", 1.5), ("branches", 1.5), ("horizon", 1.), ("sky", 0.5)])),
        ("defiance & protest", w(&[("resist", 2.), ("resistance", 2.), ("revolution", 2.), ("rebel", 2.), ("rebels", 2.), ("freedom", 1.5), ("chains", 1.5), ("power", 1.), ("system", 1.5), ("government", 2.), ("police", 1.5), ("justice", 2.), ("protest", 2.), ("march", 1.), ("marching", 1.5), ("uprising", 2.), ("oppression", 2.), ("liberty", 2.), ("refuse", 1.5), ("stand up", 2.), ("rights", 1.5), ("union", 1.5), ("strike", 1.), ("rise", 1.), ("fight", 0.5)])),
        ("loneliness & isolation", w(&[("alone", 1.5), ("lonely", 2.), ("loneliness", 2.), ("isolated", 2.), ("solitude", 2.), ("nobody", 1.), ("no one", 1.), ("empty room", 2.), ("silence", 1.), ("silent", 1.), ("stranger", 1.), ("strangers", 1.5), ("invisible", 1.5), ("outsider", 2.), ("abandoned", 1.5), ("forgotten", 1.5), ("hermit", 2.), ("ghost town", 2.), ("crowd", 0.5)])),
        ("drink & intoxication", w(&[("whiskey", 2.), ("whisky", 2.), ("wine", 1.5), ("beer", 2.), ("drunk", 2.), ("drinking", 1.5), ("bottle", 1.5), ("bottles", 1.5), ("bar", 1.), ("bartender", 2.), ("hangover", 2.), ("stoned", 2.), ("weed", 2.), ("cocaine", 2.), ("pills", 2.), ("needle", 1.5), ("sober", 2.), ("tequila", 2.), ("champagne", 2.), ("gin", 1.5), ("vodka", 2.), ("shots", 1.), ("intoxicated", 2.), ("wasted", 1.5), ("high", 0.5), ("smoke", 0.5)])),
        ("anger & revenge", w(&[("hate", 1.5), ("hatred", 2.), ("anger", 2.), ("angry", 2.), ("rage", 2.), ("fury", 2.), ("furious", 2.), ("revenge", 2.), ("scream", 1.5), ("screaming", 1.5), ("bitter", 1.5), ("spite", 2.), ("liar", 1.5), ("liars", 1.5), ("traitor", 2.), ("curse", 1.5), ("vengeance", 2.), ("payback", 2.), ("burn it down", 2.), ("destroy", 1.5), ("wrath", 2.), ("damn", 0.5)])),
        ("hope & light", w(&[("hope", 1.5), ("hopeful", 2.), ("shine", 1.), ("shining", 1.), ("bright", 1.), ("brighter", 1.5), ("dawn", 1.5), ("rising", 1.), ("heal", 1.5), ("healing", 1.5), ("brand new", 1.5), ("begin again", 2.), ("rainbow", 2.), ("promise", 1.), ("miracle", 1.5), ("survive", 1.5), ("survivor", 2.), ("carry on", 1.5), ("better days", 2.), ("light", 0.5), ("morning", 0.5), ("hallelujah", 1.)])),
        ("family", w(&[("mother", 2.), ("mama", 2.), ("mom", 2.), ("father", 2.), ("papa", 2.), ("dad", 2.), ("daddy", 1.5), ("brother", 1.5), ("sister", 1.5), ("daughter", 2.), ("son", 1.), ("grandma", 2.), ("grandmother", 2.), ("grandpa", 2.), ("grandfather", 2.), ("family", 2.), ("cousin", 2.), ("uncle", 2.), ("aunt", 2.), ("cradle", 2.), ("bloodline", 2.), ("heirloom", 2.)])),
        ("the body", w(&[("skin", 1.5), ("bones", 1.5), ("heartbeat", 2.), ("breath", 1.), ("breathe", 1.), ("breathing", 1.), ("veins", 2.), ("fingers", 1.5), ("fingertips", 2.), ("shoulders", 1.5), ("teeth", 1.5), ("tongue", 1.5), ("spine", 2.), ("bruise", 2.), ("bruises", 2.), ("scars", 2.), ("scar", 1.5), ("wounds", 1.5), ("pulse", 1.5), ("lungs", 2.), ("flesh", 1.5), ("sweat", 1.5), ("blood", 0.5)])),
        ("machines & static", w(&[("machine", 2.), ("machines", 2.), ("television", 2.), ("tv", 1.5), ("radio", 1.5), ("telephone", 2.), ("phone", 1.), ("computer", 2.), ("screen", 1.), ("screens", 1.5), ("static", 2.), ("signal", 1.5), ("wires", 2.), ("electric", 1.5), ("electricity", 2.), ("robot", 2.), ("robots", 2.), ("circuit", 2.), ("digital", 2.), ("antenna", 2.), ("frequency", 2.), ("plastic", 1.5), ("engine", 0.5), ("factory", 1.), ("modern", 1.)])),
        ("space & cosmos", w(&[("planet", 2.), ("planets", 2.), ("galaxy", 2.), ("universe", 2.), ("cosmic", 2.), ("cosmos", 2.), ("orbit", 2.), ("rocket", 2.), ("astronaut", 2.), ("satellite", 1.5), ("constellation", 2.), ("comet", 2.), ("gravity", 2.), ("stardust", 2.), ("supernova", 2.), ("mars", 1.5), ("saturn", 2.), ("jupiter", 2.), ("interstellar", 2.), ("black hole", 2.), ("outer space", 2.), ("space", 1.), ("moon", 0.5)])),
        ("the troubled mind", w(&[("thoughts", 1.5), ("brain", 1.5), ("crazy", 1.), ("madness", 2.), ("insane", 1.5), ("paranoid", 2.), ("anxiety", 2.), ("anxious", 2.), ("panic", 2.), ("therapy", 2.), ("medication", 2.), ("depressed", 2.), ("depression", 2.), ("numb", 1.5), ("overthinking", 2.), ("spiral", 1.5), ("voices", 1.), ("sanity", 2.), ("breakdown", 2.), ("mind", 1.)])),
        ("small town & country", w(&[("small town", 2.), ("farm", 2.), ("truck", 2.), ("pickup", 2.), ("dirt road", 2.), ("county", 2.), ("cornfield", 2.), ("barn", 2.), ("tractor", 2.), ("railroad", 2.), ("train", 1.), ("trains", 1.5), ("whistle", 1.5), ("main street", 2.), ("diner", 2.), ("gravel", 2.), ("holler", 2.), ("hometown", 1.), ("porch", 1.), ("creek", 1.), ("prairie", 1.), ("fields", 0.5), ("church", 0.5)])),
        ("dawn & morning", w(&[("morning", 1.5), ("sunrise", 1.5), ("dawn", 2.), ("daybreak", 2.), ("coffee", 2.), ("breakfast", 2.), ("wake up", 1.5), ("waking", 1.5), ("alarm", 1.5), ("early", 1.), ("first light", 2.), ("rooster", 2.), ("dew", 2.), ("sunday morning", 2.), ("monday", 1.5)])),
    ]
}

/// Compact sentiment lexicon: (word, valence). Small on purpose; used for a coarse −1…+1 read.
fn valence_lexicon() -> HashMap<&'static str, f64> {
    let pos: &[&str] = &["love", "loved", "happy", "happiness", "joy", "joyful", "smile", "smiling", "laugh", "laughing", "beautiful", "sweet", "sunshine", "bright", "shine", "shining", "hope", "hopeful", "free", "freedom", "alive", "heaven", "paradise", "peace", "peaceful", "gentle", "warm", "warmth", "kind", "kindness", "dance", "dancing", "celebrate", "wonderful", "glorious", "golden", "bloom", "blossom", "delight", "magic", "magical", "shelter", "safe", "together", "embrace", "kiss", "sweetheart", "darling", "angel", "grace", "blessed", "miracle", "glow", "glowing", "sparkle", "wonder", "lucky", "victory", "win", "winning", "heal", "healing", "summer", "spring", "friend", "friends", "trust", "comfort", "tender", "soft", "calm", "serene", "easy", "fun", "party", "glad", "cheer", "laughter", "pleasure", "adore", "treasure", "precious", "shimmer"];
    let neg: &[&str] = &["hate", "hatred", "sad", "sadness", "cry", "crying", "tears", "pain", "painful", "hurt", "hurting", "broken", "lonely", "loneliness", "alone", "dead", "death", "die", "dying", "kill", "killed", "grave", "cold", "dark", "darkness", "fear", "afraid", "scared", "lost", "losing", "lose", "empty", "goodbye", "sorrow", "grief", "misery", "miserable", "despair", "hopeless", "bitter", "angry", "anger", "rage", "war", "blood", "wound", "wounds", "scar", "scars", "sick", "sickness", "poison", "shame", "guilt", "guilty", "sin", "hell", "devil", "demon", "demons", "cruel", "cruelty", "liar", "lies", "lying", "betray", "betrayed", "regret", "mistake", "mistakes", "ruin", "ruins", "wreck", "burn", "burning", "ashes", "drown", "drowning", "suffocate", "choke", "numb", "tired", "weary", "exhausted", "storm", "shadow", "shadows", "ghost", "ghosts", "haunted", "nightmare", "curse", "cursed", "damn", "damned", "worthless", "useless", "ugly", "filthy", "rot", "rotting", "decay", "prison", "cage", "chains", "trapped", "stuck", "falling", "fell", "fail", "failed", "failure", "wrong", "sorry", "weep", "weeping", "ache", "aching", "bleed", "bleeding", "stranger", "forgotten", "fade", "fading", "faded", "wither", "grey", "gray", "nowhere"];
    let mut m = HashMap::new();
    for w in pos { m.insert(*w, 1.0); }
    for w in neg { m.insert(*w, -1.0); }
    m
}

/// Function-word profiles for a coarse language guess. Hits are counted over all tokens; the
/// language with the highest share wins if it clears 3 % of tokens, else "und".
fn language_profiles() -> Vec<(&'static str, &'static [&'static str])> {
    vec![
        ("en", &["the", "and", "you", "that", "with", "your", "for", "this", "but", "not", "have", "all", "was", "what", "when", "just", "like", "know", "don't", "i'm", "it's", "gonna", "never", "there", "from", "they", "she", "him", "her", "we"]),
        ("es", &["que", "de", "no", "la", "el", "y", "en", "un", "una", "por", "con", "para", "te", "me", "mi", "tu", "es", "se", "lo", "los", "las", "como", "pero", "más", "sin", "todo", "nada", "cuando", "siempre", "corazón"]),
        ("pt", &["que", "não", "de", "e", "o", "a", "um", "uma", "para", "com", "por", "você", "eu", "meu", "minha", "se", "mas", "mais", "em", "do", "da", "na", "no", "é", "tudo", "nada", "quando", "sempre", "coração", "amor"]),
        ("fr", &["je", "tu", "le", "la", "les", "et", "de", "des", "un", "une", "que", "qui", "pas", "ne", "est", "dans", "pour", "mais", "avec", "sur", "mon", "ma", "mes", "ton", "te", "moi", "toi", "nous", "vous", "c'est"]),
        ("de", &["ich", "du", "und", "der", "die", "das", "nicht", "ist", "ein", "eine", "mit", "auf", "für", "wir", "ihr", "sie", "es", "mich", "dich", "mein", "dein", "wenn", "aber", "noch", "schon", "nur", "alles", "nichts", "immer", "nie"]),
        ("it", &["che", "non", "di", "la", "il", "e", "un", "una", "per", "con", "mi", "ti", "io", "tu", "sei", "sono", "ma", "più", "come", "quando", "sempre", "mai", "tutto", "niente", "nel", "nella", "della", "del", "cuore", "amore"]),
        ("tr", &["bir", "ve", "bu", "ne", "sen", "ben", "seni", "beni", "bana", "sana", "çok", "gibi", "için", "ama", "değil", "yok", "var", "kadar", "daha", "şimdi", "hiç", "her", "aşk", "gece", "gönül", "kalbim", "sevgilim", "canım", "ile", "diye"]),
        ("ja", &["の", "に", "を", "は", "が", "と", "で", "て", "た", "も", "な", "い", "か", "この", "その", "君", "僕", "私", "あなた", "ない", "する", "から", "まで", "だけ", "でも", "こと", "もう", "ずっと", "いつも", "愛"]),
        ("ko", &["나", "너", "내", "네", "사랑", "우리", "이", "그", "은", "는", "을", "를", "에", "의", "도", "만", "다", "지", "고", "게", "해", "않", "없", "있", "니", "야", "요", "오늘", "다시", "마음"]),
        ("ru", &["я", "ты", "и", "не", "в", "на", "что", "это", "как", "мы", "он", "она", "меня", "тебя", "мне", "тебе", "но", "за", "по", "все", "всё", "только", "уже", "ещё", "нет", "да", "так", "был", "была", "любовь"]),
        ("ar", &["في", "من", "على", "ما", "لا", "أنا", "أنت", "هذا", "كل", "يا", "إلى", "عن", "مع", "كان", "قلبي", "حبيبي", "الله", "و", "أن", "لم", "لن", "هو", "هي", "نحن", "إذا", "ليل", "عيني", "روحي", "دنيا", "عمري"]),
    ]
}

pub struct Features {
    pub word_count: i64, pub vocab: i64, pub repetition: f64, pub lang: String, pub valence: Option<f64>,
    pub terms: Vec<(String, i64)>, pub themes: Vec<String>, pub theme_scores: Vec<(String, f64)>, pub colours: Vec<String>,
}

const COLOURS: &[&str] = &["red", "blue", "green", "yellow", "purple", "violet", "black", "white", "gold", "golden", "silver", "grey", "gray", "pink", "orange", "brown", "crimson", "scarlet", "indigo", "turquoise", "lavender", "amber", "emerald", "ivory", "magenta", "maroon", "navy", "teal", "ochre", "ruby", "sapphire"];

/// Pure function: lyrics text → derived features. Text is not retained by the caller.
pub fn extract(text: &str) -> Features {
    let stop: HashSet<&str> = STOP.split_whitespace().collect();
    let lower = text.to_lowercase();
    // tokens: letters/digits/apostrophes; each CJK / Hangul code point is its own token
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    for c in lower.chars() {
        let cjk = ('\u{3040}'..='\u{30ff}').contains(&c) || ('\u{4e00}'..='\u{9fff}').contains(&c) || ('\u{ac00}'..='\u{d7af}').contains(&c);
        if cjk { if !cur.is_empty() { tokens.push(std::mem::take(&mut cur)); } tokens.push(c.to_string()); continue; }
        if c.is_alphanumeric() || c == '\'' || c == '’' { cur.push(if c == '’' { '\'' } else { c }); } else if !cur.is_empty() { tokens.push(std::mem::take(&mut cur)); }
    }
    if !cur.is_empty() { tokens.push(cur); }
    let tokens: Vec<String> = tokens.into_iter().map(|t| t.trim_matches('\'').to_string()).filter(|t| !t.is_empty()).collect();

    // language
    let total = tokens.len().max(1) as f64;
    let mut lang = "und".to_string(); let mut best = 0.0;
    for (code, words) in language_profiles() {
        let set: HashSet<&str> = words.iter().copied().collect();
        let hits = tokens.iter().filter(|t| set.contains(t.as_str())).count() as f64 / total;
        if hits > best && hits >= 0.03 { best = hits; lang = code.to_string(); }
    }
    let ideographic = lang == "ja" || lang == "ko";
    // content words
    let mut freq: HashMap<String, i64> = HashMap::new();
    let mut n = 0i64;
    for w in &tokens {
        if w.chars().count() < 3 && !ideographic { continue; }
        if w.chars().all(|c| c.is_ascii_digit()) { continue; }
        n += 1;
        if stop.contains(w.as_str()) { continue; }
        let base = w.strip_suffix("'s").unwrap_or(w).to_string();   // possessive / plural-'s
        if base.chars().count() < 3 && !ideographic { continue; }
        *freq.entry(base).or_insert(0) += 1;
    }
    let vocab = freq.len() as i64;
    let content_total: i64 = freq.values().sum::<i64>().max(1);
    let repetition = 1.0 - vocab as f64 / content_total as f64;
    let mut terms: Vec<(String, i64)> = freq.iter().map(|(k, v)| (k.clone(), *v)).collect();
    terms.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    terms.truncate(60);

    // English-only lexicons
    let (mut th, mut scores, mut valence) = (Vec::new(), Vec::new(), None);
    if lang == "en" {
        let joined = format!(" {} ", tokens.join(" "));
        let count = |cue: &str| -> i64 {
            if cue.contains(' ') { joined.matches(&format!(" {cue} ")).count() as i64 } else { *freq.get(cue).unwrap_or(&0) }
        };
        for (theme, cues) in themes() {
            let mut hits = 0i64; let mut distinct = 0; let mut weighted = 0.0;
            for (cue, w) in &cues { let c = count(cue); if c > 0 { hits += c; distinct += 1; weighted += c as f64 * w; } }
            if hits == 0 || (distinct < 2 && hits < 3) { continue; }
            // weighted density per 100 content words; a 20× chant of one weak word can't carry a theme alone
            let score = (weighted.min(hits as f64 * 2.0) * 100.0 / content_total as f64).min(25.0);
            if score >= 0.8 { scores.push((theme.to_string(), (score * 100.0).round() / 100.0)); }
        }
        scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        th = scores.iter().take(4).map(|(t, _)| t.clone()).collect();
        let lex = valence_lexicon();
        let mut sum = 0.0; let mut hits = 0.0;
        for (w, c) in &freq { if let Some(v) = lex.get(w.as_str()) { sum += v * *c as f64; hits += *c as f64; } }
        if hits >= 3.0 { valence = Some(((sum / hits) * 100.0).round() / 100.0); }
    }
    let colours: Vec<String> = COLOURS.iter().filter(|c| freq.contains_key(**c)).map(|c| c.to_string()).collect();
    Features { word_count: n, vocab, repetition: (repetition * 1000.0).round() / 1000.0, lang, valence, terms, themes: th, theme_scores: scores, colours }
}

fn arr(v: &[String]) -> Value { json!(serde_json::to_string(v).unwrap_or_else(|_| "[]".into())) }

fn setting(db: &Db, key: &str) -> Option<String> {
    db.query("SELECT value FROM app_meta WHERE key = ?", &[json!(key)]).ok().and_then(|r| r.first().and_then(|m| m.get("value")).and_then(|v| v.as_str().map(str::to_string)))
}

/// Write one track's features (replacing any older-rev row) and its term list.
fn store(db: &Db, id: &str, f: &Features) -> Result<()> {
    let scores: serde_json::Map<String, Value> = f.theme_scores.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
    db.exec("DELETE FROM track_lyric_terms WHERE track_id = ?", &[json!(id)])?;
    for (t, c) in &f.terms { db.exec("INSERT INTO track_lyric_terms (track_id, term, tf) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", &[json!(id), json!(t), json!(c)])?; }
    db.exec("INSERT OR REPLACE INTO track_lyric_features (track_id, source, found, word_count, keywords, themes, colours, lang, fetched_at, features_rev, theme_scores, valence, repetition, vocab)
             VALUES (?, 'lrclib', TRUE, ?, CAST(? AS JSON)::VARCHAR[], CAST(? AS JSON)::VARCHAR[], CAST(? AS JSON)::VARCHAR[], ?, now(), ?, CAST(? AS JSON), ?, ?, ?)",
        &[json!(id), json!(f.word_count), arr(&f.terms.iter().take(15).map(|(t, _)| t.clone()).collect::<Vec<_>>()), arr(&f.themes), arr(&f.colours), json!(f.lang), json!(FEATURES_REV),
          json!(Value::Object(scores).to_string()), json!(f.valence), json!(f.repetition), json!(f.vocab)])?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 10d — local-model tagging v2 (llm_rev 2). Owner feedback on qwen2.5:0.5b: moods were generic and redundant
// ("happy", "happy and joyful", "joy"), two were the prompt echoed back ("1 to 2 words", "1-2 words"), a theme was the
// title suffix ("radio edit"), and themes were vague ("emotional", "personal"). A half-billion-parameter model can't
// be talked out of that with wording, so v2 constrains it instead:
//   * moods come from a fixed palette of 38 distinct moods (each placed on a bright↔bleak × calm↔intense map in
//     src/lib/lyricVocab.ts), themes from a fixed vocabulary that includes the lexicon's own themes — sent as a JSON
//     schema so decoding can only produce allowed values (Ollama ≥ 0.5; older servers fall back to JSON mode and the
//     answers are coerced onto the palette, synonyms first);
//   * keywords must be words that actually occur in the lyrics — anything else is dropped (grounding);
//   * the title is cleaned before the model sees it ("Big Bad Wolf (Radio Edit)" → "Big Bad Wolf"), and release
//     words (edit, remix, remaster, version…) or instruction echoes can never be stored;
//   * a one-line summary is kept only if it doesn't reproduce the lyrics (no 5-word run in common).
// Tagging no longer rides inside the LRCLIB batch (a slow CPU turned one 40-song batch into hours): it has its own
// queue (`llm_batch`) that re-fetches each song's text transiently, a few songs per tick, and yields to the pages.
// The Rust lists below must match src/lib/lyricVocab.ts — a vitest test compares them.
pub const LLM_REV: i64 = 2;

pub const MOODS: &[&str] = &["euphoric", "joyful", "celebratory", "triumphant", "empowered", "confident", "playful", "carefree", "smitten", "romantic", "tender", "hopeful",
    "serene", "dreamy", "sultry", "hypnotic", "wry", "nostalgic", "wistful", "bittersweet", "reflective", "yearning", "vulnerable", "melancholic", "lonely", "heartbroken",
    "mournful", "resigned", "brooding", "eerie", "anxious", "restless", "gritty", "defiant", "bitter", "angry", "menacing", "desperate"];

pub const THEME_VOCAB: &[&str] = &["rain", "night", "sun & summer", "winter", "ocean & shore", "river & lake", "the city", "the road", "home", "romance", "heartbreak", "longing",
    "nostalgia & memory", "dancing & party", "dreams & sleep", "fire & smoke", "money & work", "faith & the divine", "youth & growing up", "death & mourning", "war & violence",
    "time passing", "nature & wild", "defiance & protest", "loneliness & isolation", "drink & intoxication", "anger & revenge", "hope & light", "family", "the body",
    "machines & static", "space & cosmos", "the troubled mind", "small town & country", "dawn & morning",
    "new love", "desire & lust", "devotion", "jealousy", "betrayal", "friendship", "self-worth", "ambition & success", "freedom & escape", "identity", "addiction", "grief",
    "regret", "forgiveness", "moving on", "obsession", "temptation", "survival", "fame", "social commentary", "travel & wanderlust", "nightlife"];

const MOOD_SYNONYMS: &[(&str, &str)] = &[("happy", "joyful"), ("happiness", "joyful"), ("joy", "joyful"), ("upbeat", "joyful"), ("cheerful", "joyful"), ("sad", "melancholic"), ("sadness", "melancholic"),
    ("melancholy", "melancholic"), ("gloomy", "melancholic"), ("anger", "angry"), ("rage", "angry"), ("furious", "angry"), ("hopelessness", "resigned"), ("hopeless", "resigned"), ("tragic", "mournful"),
    ("grief", "mournful"), ("sorrowful", "mournful"), ("lighthearted", "carefree"), ("light-hearted", "carefree"), ("relaxed", "carefree"), ("love", "romantic"), ("loving", "tender"), ("gentle", "tender"),
    ("calm", "serene"), ("peaceful", "serene"), ("chill", "serene"), ("energetic", "euphoric"), ("excited", "euphoric"), ("ecstatic", "euphoric"), ("dark", "brooding"), ("moody", "brooding"),
    ("fear", "anxious"), ("fearful", "anxious"), ("scared", "anxious"), ("nervous", "anxious"), ("longing", "yearning"), ("sexy", "sultry"), ("seductive", "sultry"), ("empowering", "empowered"),
    ("proud", "confident"), ("sarcastic", "wry"), ("ironic", "wry"), ("humorous", "playful"), ("funny", "playful"), ("fun", "playful"), ("sentimental", "nostalgic"), ("heartbreak", "heartbroken"),
    ("frustrated", "bitter"), ("resentful", "bitter"), ("rebellious", "defiant"), ("dreamlike", "dreamy"), ("spooky", "eerie"), ("haunting", "eerie"), ("tense", "anxious"), ("uplifting", "hopeful"),
    ("inspirational", "hopeful"), ("passionate", "romantic"), ("isolated", "lonely"), ("aggressive", "menacing"), ("threatening", "menacing"), ("contemplative", "reflective"), ("introspective", "reflective")];

/// Words that are never a theme, mood or keyword: release/version suffixes and the prompt's own vocabulary echoed back.
const JUNK: &[&str] = &["radio edit", "edit", "remix", "remaster", "remastered", "version", "mix", "feat", "featuring", "live", "mono", "stereo", "single", "demo", "extended", "instrumental",
    "word", "words", "phrase", "phrases", "theme", "themes", "mood", "moods", "lowercase", "noun", "json", "lyrics", "song", "songs", "genre", "title", "none", "n/a", "unknown"];

fn is_junk(s: &str) -> bool {
    let l = s.trim().to_lowercase();
    if l.chars().count() < 3 || l.chars().any(|c| c.is_ascii_digit()) { return true; }
    JUNK.iter().any(|j| l == *j || l.split(|c: char| !c.is_alphanumeric() && c != '\'').any(|w| w == *j && j.len() > 4))
}

/// "Big Bad Wolf (Radio Edit)" → "Big Bad Wolf"; "Song - Remastered 2011" → "Song"; "Song (feat. X)" → "Song".
pub fn clean_title(t: &str) -> String {
    const RELEASE: &[&str] = &["edit", "remix", "mix", "remaster", "remastered", "version", "live", "mono", "stereo", "demo", "feat", "ft", "featuring", "radio", "extended", "acoustic", "deluxe", "bonus", "instrumental", "original", "rework", "dub", "vip", "reprise"];
    let is_rel = |x: &str| x.to_lowercase().split(|c: char| !c.is_alphanumeric()).any(|w| RELEASE.contains(&w));
    let mut out = String::new(); let mut depth = 0usize; let mut group = String::new();
    for c in t.chars() {
        match c {
            '(' | '[' => { if depth == 0 { group.clear(); } else { group.push(c); } depth += 1; }
            ')' | ']' if depth > 0 => { depth -= 1; if depth == 0 { if !is_rel(&group) { out.push('('); out.push_str(&group); out.push(')'); } } else { group.push(c); } }
            _ => if depth > 0 { group.push(c) } else { out.push(c) },
        }
    }
    if let Some(i) = out.find(" - ") { if is_rel(&out[i + 3..]) { out.truncate(i); } }
    let cleaned = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() { t.trim().to_string() } else { cleaned }
}

pub fn coerce_mood(s: &str) -> Option<String> {
    let l = s.trim().to_lowercase();
    if l.is_empty() || is_junk(&l) { return None; }
    if MOODS.contains(&l.as_str()) { return Some(l); }
    if let Some((_, m)) = MOOD_SYNONYMS.iter().find(|(k, _)| *k == l) { return Some(m.to_string()); }
    // "happy and nostalgic" → the most specific palette word it names; synonyms after
    let words: Vec<&str> = l.split(|c: char| !c.is_alphanumeric() && c != '-').filter(|w| !w.is_empty()).collect();
    for w in words.iter().rev() { if MOODS.contains(w) { return Some(w.to_string()); } }
    for w in words.iter().rev() { if let Some((_, m)) = MOOD_SYNONYMS.iter().find(|(k, _)| k == w) { return Some(m.to_string()); } }
    None
}

pub fn coerce_theme(s: &str) -> Option<String> {
    let l = s.trim().to_lowercase().replace(" and ", " & ");
    if l.is_empty() || is_junk(&l) { return None; }
    if THEME_VOCAB.contains(&l.as_str()) { return Some(l); }
    // "heartbreak and loss" → "heartbreak"; "summer" → "sun & summer"; "love" → "romance"
    const ALIAS: &[(&str, &str)] = &[("love", "romance"), ("romantic love", "romance"), ("relationships", "romance"), ("relationship", "romance"), ("girlfriend", "romance"), ("boyfriend", "romance"),
        ("loss", "grief"), ("pain", "heartbreak"), ("breakup", "heartbreak"), ("sadness", "heartbreak"), ("loneliness", "loneliness & isolation"), ("summer", "sun & summer"), ("party", "dancing & party"),
        ("dance", "dancing & party"), ("memories", "nostalgia & memory"), ("nostalgia", "nostalgia & memory"), ("personal growth", "identity"), ("self-discovery", "identity"), ("freedom", "freedom & escape"),
        ("escape", "freedom & escape"), ("money", "money & work"), ("work", "money & work"), ("god", "faith & the divine"), ("religion", "faith & the divine"), ("faith", "faith & the divine"),
        ("death", "death & mourning"), ("violence", "war & violence"), ("war", "war & violence"), ("drugs", "drink & intoxication"), ("alcohol", "drink & intoxication"), ("mental health", "the troubled mind"),
        ("anxiety", "the troubled mind"), ("depression", "the troubled mind"), ("desire", "desire & lust"), ("lust", "desire & lust"), ("sex", "desire & lust"), ("success", "ambition & success"),
        ("ambition", "ambition & success"), ("travel", "travel & wanderlust"), ("adventure", "travel & wanderlust"), ("journey", "the road"), ("road", "the road"), ("city", "the city"), ("hope", "hope & light"),
        ("time", "time passing"), ("nature", "nature & wild"), ("society", "social commentary"), ("politics", "social commentary"), ("police", "defiance & protest"), ("protest", "defiance & protest"),
        ("youth", "youth & growing up"), ("teenage love", "new love"), ("young love", "new love"), ("dreams", "dreams & sleep"), ("anger", "anger & revenge"), ("revenge", "anger & revenge"),
        ("self-love", "self-worth"), ("confidence", "self-worth"), ("empowerment", "self-worth"), ("fire", "fire & smoke"), ("ocean", "ocean & shore"), ("sea", "ocean & shore"), ("space", "space & cosmos")];
    if let Some((_, t)) = ALIAS.iter().find(|(k, _)| *k == l) { return Some(t.to_string()); }
    THEME_VOCAB.iter().find(|t| { let head = t.split(" & ").collect::<Vec<_>>(); head.iter().any(|h| *h == l || l.split_whitespace().any(|w| w == *h && h.len() > 3)) }).map(|t| t.to_string())
}

fn tokens_of(text: &str) -> HashSet<String> {
    text.to_lowercase().split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '’')).map(|w| w.replace('’', "'").trim_matches('\'').to_string()).filter(|w| !w.is_empty()).collect()
}

/// Keep a summary only if it paraphrases: no run of 5 words in common with the lyrics.
fn paraphrases(summary: &str, text: &str) -> bool {
    let norm = |s: &str| s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect::<Vec<_>>();
    let (a, b) = (norm(summary), norm(text));
    if a.len() < 5 { return true; }
    let hay = format!(" {} ", b.join(" "));
    !a.windows(5).any(|w| hay.contains(&format!(" {} ", w.join(" "))))
}

#[derive(serde::Serialize, Default, Debug)]
pub struct LlmTags { pub themes: Vec<String>, pub mood: Option<String>, pub mood2: Option<String>, pub keywords: Vec<String>, pub summary: Option<String>, pub model: String, pub ms: u64 }

/// Validate whatever the model sent back against the vocabularies and the lyrics themselves.
pub fn parse_tags(reply: &str, text: &str, title: &str, artist: &str) -> LlmTags {
    let clean = reply.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let v: Value = serde_json::from_str(clean).unwrap_or(Value::Null);
    let strs = |k: &str| -> Vec<String> { v[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect()).unwrap_or_default() };
    let stop: HashSet<&str> = STOP.split_whitespace().collect();
    let lyric_words = tokens_of(text);
    let name_words: HashSet<String> = tokens_of(&format!("{} {}", artist, title)).into_iter().filter(|w| !lyric_words.contains(w)).collect();
    let mut themes: Vec<String> = Vec::new();
    for t in strs("themes") { if let Some(c) = coerce_theme(&t) { if !themes.contains(&c) { themes.push(c); } } }
    themes.truncate(4);
    let mood = v["mood"].as_str().and_then(coerce_mood);
    let mood2 = v["mood2"].as_str().and_then(coerce_mood).filter(|m| Some(m) != mood.as_ref());
    let mut keywords: Vec<String> = Vec::new();
    for k in strs("keywords") {
        let k = k.trim_matches(|c: char| !c.is_alphanumeric()).to_string();
        let parts: Vec<&str> = k.split_whitespace().collect();
        if parts.is_empty() || parts.len() > 2 || is_junk(&k) { continue; }
        if parts.iter().any(|p| !lyric_words.contains(*p) || name_words.contains(*p)) { continue; }   // grounded in the text, not the title/artist
        if parts.len() == 1 && (stop.contains(parts[0]) || parts[0].chars().count() < 3) { continue; }
        if !keywords.contains(&k) { keywords.push(k); }
    }
    keywords.truncate(12);
    let summary = v["summary"].as_str().map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| { let l = s.to_lowercase(); s.len() >= 12 && s.chars().count() <= 160 && !l.contains("one sentence") && !l.contains("own words") && !l.contains("quote the lyrics") && paraphrases(s, text) });
    LlmTags { themes, mood, mood2, keywords, summary, ..Default::default() }
}

fn tag_schema() -> Value {
    json!({ "type": "object", "properties": {
        "summary": { "type": "string" },
        "themes": { "type": "array", "items": { "type": "string", "enum": THEME_VOCAB }, "minItems": 1, "maxItems": 4 },
        "mood": { "type": "string", "enum": MOODS },
        "mood2": { "type": "string", "enum": MOODS },
        "keywords": { "type": "array", "items": { "type": "string" }, "maxItems": 12 } },
        "required": ["summary", "themes", "mood", "keywords"] })
}

fn tag_prompt(title: &str, artist: &str, text: &str) -> String {
    let excerpt: String = text.chars().take(3500).collect();
    format!("Read these song lyrics and tag them for a personal music library.\n\
Answer with JSON only:\n\
- summary: one sentence in your own words saying what the song is about. Do not quote the lyrics.\n\
- themes: 1 to 4 subjects the song is really about, chosen from: {}.\n\
- mood: the single best emotional tone, chosen from: {}.\n\
- mood2: a second, different tone from the same list.\n\
- keywords: 6 to 12 vivid words copied exactly from the lyrics (images, places, objects, actions). Skip filler like love, baby, yeah, night, and never use the song title.\n\n\
Song: \"{}\" by {}\nLyrics:\n{}",
        THEME_VOCAB.join(", "), MOODS.join(", "), clean_title(title), artist, excerpt)
}

fn pick_model(db: &Db) -> Option<String> {
    let st = crate::llm::status(db);
    if !st.reachable || st.models.is_empty() { return None; }
    match crate::llm::chosen_model(db) { Some(m) if st.models.contains(&m) => Some(m), _ => st.models.first().cloned() }
}

/// Ask the model about one song's (transient) text and store the validated tags. The text is not kept.
pub fn tag_one(db: &Db, id: &str, title: &str, artist: &str, text: &str, model: &str) -> Result<LlmTags> {
    let msgs = vec![crate::llm::ChatMsg { role: "user".into(), content: tag_prompt(title, artist, text) }];
    let r = crate::llm::chat_structured(db, model, &msgs, tag_schema(), 0.2, "lyrics", Some(400));
    let r = match r {
        Ok(r) => r,
        Err(e) => {
            let _ = db.exec("UPDATE track_lyric_features SET llm_attempts = COALESCE(llm_attempts, 0) + 1, llm_error = ? WHERE track_id = ?", &[json!(e.to_string().chars().take(300).collect::<String>()), json!(id)]);
            return Err(e);
        }
    };
    let mut tags = parse_tags(&r.content, text, title, artist);
    tags.model = model.to_string(); tags.ms = r.ms;
    db.exec("UPDATE track_lyric_features SET llm_themes = CAST(? AS JSON)::VARCHAR[], llm_mood = ?, llm_mood2 = ?, llm_keywords = CAST(? AS JSON)::VARCHAR[], llm_summary = ?,
             llm_model = ?, llm_at = now(), llm_rev = ?, llm_ms = ?, llm_error = NULL, llm_attempts = COALESCE(llm_attempts, 0) + 1 WHERE track_id = ?",
        &[arr(&tags.themes), json!(tags.mood), json!(tags.mood2), arr(&tags.keywords), json!(tags.summary), json!(model), json!(LLM_REV), json!(r.ms as i64), json!(id)])?;
    Ok(tags)
}

/// Fetch one song's plain lyrics from LRCLIB (exact title first, then the cleaned title). Ok(None) = LRCLIB has none.
pub fn fetch_text(http: &reqwest::blocking::Client, db: &Db, name: &str, artist: &str, album: Option<&str>, dur_ms: Option<i64>) -> Result<Option<String>> {
    let cleaned = clean_title(name);
    let mut tries: Vec<Vec<(&str, String)>> = Vec::new();
    let mut q: Vec<(&str, String)> = vec![("track_name", name.to_string()), ("artist_name", artist.to_string())];
    if let Some(al) = album { q.push(("album_name", al.to_string())); }
    if let Some(d) = dur_ms { q.push(("duration", (d / 1000).to_string())); }
    tries.push(q);
    if cleaned != name { let mut q2: Vec<(&str, String)> = vec![("track_name", cleaned.clone()), ("artist_name", artist.to_string())]; if let Some(d) = dur_ms { q2.push(("duration", (d / 1000).to_string())); } tries.push(q2); }
    for q in tries {
        let resp = http.get(API).query(&q).send();
        let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('lrclib', 'get', ?)", &[json!(resp.as_ref().map(|r| r.status().as_u16() as i64).unwrap_or(0))]);
        let res = resp?;
        let code = res.status().as_u16();
        if res.status().is_success() {
            let v: Value = res.json().unwrap_or(Value::Null);
            let text = v["plainLyrics"].as_str().unwrap_or("").to_string();
            if !text.trim().is_empty() { return Ok(Some(text)); }
            return Ok(None);
        }
        if code == 429 { return Err(anyhow::anyhow!("LRCLIB rate limit (429)")); }
        if code != 404 { return Err(anyhow::anyhow!("LRCLIB {code}")); }
        std::thread::sleep(Duration::from_millis(400));
    }
    Ok(None)
}

fn lrclib_client() -> Result<reqwest::blocking::Client> { Ok(reqwest::blocking::Client::builder().timeout(Duration::from_secs(15)).user_agent(UA).build()?) }

/// Background queue: songs whose model tags are missing or older than LLM_REV, most-played first. Stops at the
/// deadline, when a page starts its own model call, or on a timeout (no point queueing more behind a slow model).
pub fn llm_batch(db: &Db, max: usize, deadline: Duration) -> Result<usize> {
    if setting(db, "lyrics_llm_enabled").as_deref() != Some("true") || max == 0 || crate::llm::foreground_busy() { return Ok(0); }
    let Some(model) = pick_model(db) else { return Ok(0) };
    let all_langs = setting(db, "llm_lyrics_all_langs").as_deref() == Some("true");
    let rows = db.query(&format!(
        "SELECT f.track_id, t.name, a.name AS artist, al.name AS album, COALESCE(t.duration_ms, t.duration_ms_est) AS dur
         FROM track_lyric_features f JOIN tracks t USING (track_id) LEFT JOIN artists a ON a.artist_id = t.artist_id LEFT JOIN albums al ON al.album_id = t.album_id
         LEFT JOIN lyric_overrides o ON o.track_id = f.track_id
         LEFT JOIN (SELECT track_id, COUNT(*) c FROM plays_resolved WHERE attended GROUP BY 1) p ON p.track_id = f.track_id
         WHERE f.found AND COALESCE(f.features_rev, 1) >= {FEATURES_REV} AND COALESCE(f.llm_rev, 0) < {LLM_REV} AND COALESCE(f.llm_attempts, 0) < 3
           AND NOT COALESCE(o.locked, FALSE) AND NOT COALESCE(o.hidden, FALSE) AND t.name IS NOT NULL AND a.name IS NOT NULL
           {}
         ORDER BY COALESCE(p.c, 0) DESC LIMIT {max}", if all_langs { "" } else { "AND COALESCE(NULLIF(o.lang, ''), f.lang) = 'en'" }), &[])?;
    if rows.is_empty() { return Ok(0); }
    let http = lrclib_client()?;
    let started = std::time::Instant::now();
    let (mut done, mut gone) = (0usize, 0usize);
    for r in rows {
        if crate::llm::foreground_busy() || started.elapsed() > deadline { break; }
        let g = |k: &str| r.get(k).and_then(|v| v.as_str()).map(str::to_string);
        let (Some(id), Some(name), Some(artist)) = (g("track_id"), g("name"), g("artist")) else { continue };
        match fetch_text(&http, db, &name, &artist, g("album").as_deref(), r.get("dur").and_then(|v| v.as_i64())) {
            Ok(Some(text)) => match tag_one(db, &id, &name, &artist, &text, &model) {
                Ok(_) => done += 1,
                Err(e) => { log::warn!("lyrics llm {id}: {e}"); if e.to_string().contains("slow_model") { db.log_activity("lyrics", "warn", "Local model timed out while tagging lyrics — paused until the next tick", Some(&e.to_string())); break; } }
            },
            Ok(None) => { gone += 1; let _ = db.exec("UPDATE track_lyric_features SET llm_attempts = 3, llm_error = 'LRCLIB no longer has these lyrics' WHERE track_id = ?", &[json!(id)]); }
            Err(e) => { log::warn!("lyrics refetch {id}: {e}"); break; }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    if done > 0 || gone > 0 { db.log_activity("lyrics", "info", &format!("Local model ({model}) tagged {done} songs{}", if gone > 0 { format!("; {gone} no longer on LRCLIB") } else { String::new() }), None); }
    Ok(done)
}

/// Lyric hygiene → "Ask the model again" for one song, now (foreground; ignores the attempt cap and the lock).
pub fn retag_track(db: &Db, id: &str) -> Result<LlmTags> {
    let _fg = crate::llm::Foreground::enter();
    let model = pick_model(db).ok_or_else(|| anyhow::anyhow!("could not reach Ollama — start it and pick a model in Settings → Local model"))?;
    let rows = db.query("SELECT t.name, a.name AS artist, al.name AS album, COALESCE(t.duration_ms, t.duration_ms_est) AS dur FROM tracks t LEFT JOIN artists a ON a.artist_id = t.artist_id LEFT JOIN albums al ON al.album_id = t.album_id WHERE t.track_id = ?", &[json!(id)])?;
    let r = rows.first().ok_or_else(|| anyhow::anyhow!("unknown track {id}"))?;
    let g = |k: &str| r.get(k).and_then(|v| v.as_str()).map(str::to_string);
    let (name, artist) = (g("name").unwrap_or_default(), g("artist").unwrap_or_default());
    let text = fetch_text(&lrclib_client()?, db, &name, &artist, g("album").as_deref(), r.get("dur").and_then(|v| v.as_i64()))?
        .ok_or_else(|| anyhow::anyhow!("LRCLIB has no lyrics for this song (not found)"))?;
    tag_one(db, id, &name, &artist, &text, &model)
}

/// Lyric hygiene → "Re-fetch and re-analyse": new text, new features and terms; model tags are re-queued.
pub fn refetch_track(db: &Db, id: &str) -> Result<bool> {
    let rows = db.query("SELECT t.name, a.name AS artist, al.name AS album, COALESCE(t.duration_ms, t.duration_ms_est) AS dur FROM tracks t LEFT JOIN artists a ON a.artist_id = t.artist_id LEFT JOIN albums al ON al.album_id = t.album_id WHERE t.track_id = ?", &[json!(id)])?;
    let r = rows.first().ok_or_else(|| anyhow::anyhow!("unknown track {id}"))?;
    let g = |k: &str| r.get(k).and_then(|v| v.as_str()).map(str::to_string);
    match fetch_text(&lrclib_client()?, db, &g("name").unwrap_or_default(), &g("artist").unwrap_or_default(), g("album").as_deref(), r.get("dur").and_then(|v| v.as_i64()))? {
        Some(text) => { store(db, id, &extract(&text))?; Ok(true) }
        None => { db.exec("INSERT OR REPLACE INTO track_lyric_features (track_id, source, found, features_rev) VALUES (?, 'lrclib', FALSE, ?)", &[json!(id), json!(FEATURES_REV)])?; Ok(false) }
    }
}

/// Fetch and featurise: first tracks never looked up (most-played first), then rows written under
/// older rules (features_rev < current) to re-featurise. Model tagging has its own queue (`llm_batch`).
pub fn enrich_batch(db: &Db, max_tracks: usize) -> Result<usize> {
    let http = lrclib_client()?;
    let rows = db.query(&format!(
        "SELECT t.track_id, t.name, a.name AS artist, al.name AS album, COALESCE(t.duration_ms, t.duration_ms_est) AS dur,
                f.track_id IS NOT NULL AS refresh
         FROM tracks t LEFT JOIN artists a ON a.artist_id = t.artist_id LEFT JOIN albums al ON al.album_id = t.album_id
         JOIN (SELECT track_id, COUNT(*) c FROM plays_resolved WHERE attended GROUP BY 1) p USING (track_id)
         LEFT JOIN track_lyric_features f ON f.track_id = t.track_id
         WHERE t.name IS NOT NULL AND a.name IS NOT NULL
           AND (f.track_id IS NULL OR (f.found AND COALESCE(f.features_rev, 1) < {FEATURES_REV}))
         ORDER BY (f.track_id IS NULL) DESC, p.c DESC LIMIT {max_tracks}"), &[])?;
    let mut n = 0; let mut refreshed = 0;
    for r in rows {
        let g = |k: &str| r.get(k).and_then(|v| v.as_str()).map(str::to_string);
        let (Some(id), Some(name), Some(artist)) = (g("track_id"), g("name"), g("artist")) else { continue };
        let refresh = r.get("refresh").and_then(|v| v.as_bool()).unwrap_or(false);
        match fetch_text(&http, db, &name, &artist, g("album").as_deref(), r.get("dur").and_then(|v| v.as_i64())) {
            Ok(Some(text)) => { store(db, &id, &extract(&text))?; n += 1; if refresh { refreshed += 1; } }   // `text` drops here; nothing of it persists
            Ok(None) => { db.exec("INSERT OR REPLACE INTO track_lyric_features (track_id, source, found, features_rev) VALUES (?, 'lrclib', FALSE, ?)", &[json!(id), json!(FEATURES_REV)])?; n += 1; }
            Err(e) => { if e.to_string().contains("429") { std::thread::sleep(Duration::from_secs(30)); } break; }
        }
        std::thread::sleep(Duration::from_millis(600));
    }
    if n > 0 { db.log_activity("lyrics", "info", &format!("Lyric features for {n} tracks ({refreshed} re-analysed under the v{FEATURES_REV} rules)"), None); }
    Ok(n)
}

/// Settings → Local model: how the tagging queue stands.
pub fn llm_pending(db: &Db) -> (i64, i64, i64) {
    let done = db.scalar_i64(&format!("SELECT COUNT(*) FROM track_lyric_features WHERE found AND COALESCE(llm_rev, 0) >= {LLM_REV}")).unwrap_or(0);
    let queued = db.scalar_i64(&format!("SELECT COUNT(*) FROM track_lyric_features f LEFT JOIN lyric_overrides o USING (track_id) WHERE f.found AND COALESCE(f.features_rev, 1) >= {FEATURES_REV} AND COALESCE(f.llm_rev, 0) < {LLM_REV} AND COALESCE(f.llm_attempts, 0) < 3 AND NOT COALESCE(o.locked, FALSE) AND NOT COALESCE(o.hidden, FALSE)")).unwrap_or(0);
    let failed = db.scalar_i64(&format!("SELECT COUNT(*) FROM track_lyric_features WHERE found AND COALESCE(llm_rev, 0) < {LLM_REV} AND COALESCE(llm_attempts, 0) >= 3")).unwrap_or(0);
    (done, queued, failed)
}

#[cfg(test)]
mod llm_v2_tests {
    use super::*;
    #[test] fn titles_lose_release_suffixes() {
        assert_eq!(clean_title("Big Bad Wolf (Radio Edit)"), "Big Bad Wolf");
        assert_eq!(clean_title("Hypercolour - Original Mix"), "Hypercolour");
        assert_eq!(clean_title("Song (feat. Someone) - Remastered 2011"), "Song");
        assert_eq!(clean_title("(Don't Fear) The Reaper"), "(Don't Fear) The Reaper");
    }
    #[test] fn moods_land_on_the_palette() {
        assert_eq!(coerce_mood("happy").as_deref(), Some("joyful"));
        assert_eq!(coerce_mood("happy and nostalgic").as_deref(), Some("nostalgic"));
        assert_eq!(coerce_mood("anger, sadness, hopelessness").as_deref(), Some("resigned"));
        assert_eq!(coerce_mood("1 to 2 words"), None);
        assert_eq!(coerce_mood("1-2 words"), None);
    }
    #[test] fn junk_themes_and_ungrounded_keywords_are_dropped() {
        let text = "Driving down the road in the blue summer cold, the neon hums, I'm chasing the hypercolour";
        let reply = r#"{"summary":"A late drive that feels endless.","themes":["radio edit","the road","emotional","summer"],"mood":"1 to 2 words","keywords":["road","neon","wolf","radio edit","the","hypercolour"]}"#;
        let t = parse_tags(reply, text, "Hypercolour (Radio Edit)", "CamelPhat");
        assert_eq!(t.themes, vec!["the road".to_string(), "sun & summer".to_string()]);
        assert_eq!(t.mood, None);
        assert_eq!(t.keywords, vec!["road".to_string(), "neon".to_string(), "hypercolour".to_string()]);
        assert!(t.summary.is_some());
    }
    #[test] fn summaries_that_quote_are_dropped() {
        assert!(!paraphrases("chasing the hypercolour down the road", "down the road i'm chasing the hypercolour down the road tonight"));
        assert!(paraphrases("A song about a long drive at night.", "driving down the road"));
    }
}

/// For the Settings card: (rows still on old rules, rows on current rules, played tracks never looked up).
pub fn pending(db: &Db) -> (i64, i64, i64) {
    let old = db.scalar_i64(&format!("SELECT COUNT(*) FROM track_lyric_features WHERE found AND COALESCE(features_rev, 1) < {FEATURES_REV}")).unwrap_or(0);
    let done = db.scalar_i64(&format!("SELECT COUNT(*) FROM track_lyric_features WHERE found AND COALESCE(features_rev, 1) >= {FEATURES_REV}")).unwrap_or(0);
    let never = db.scalar_i64("SELECT COUNT(*) FROM (SELECT DISTINCT track_id FROM plays_resolved WHERE attended AND track_id IS NOT NULL) p WHERE NOT EXISTS (SELECT 1 FROM track_lyric_features f WHERE f.track_id = p.track_id)").unwrap_or(0);
    (old, done, never)
}
