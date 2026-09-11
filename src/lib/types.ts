// Ported from v1 and extended for the v3 entity pages.
export type DayCell = { day: string; minutes: number; plays: number };
export type HourSlice = { hour: number; hours: number };
export type ArtistRow = { artistId: string; artist: string; plays: number; hours: number; skipRate: number };
export type TrackRow = { trackId: string; track: string; artistId: string | null; artist: string; plays: number; hours: number; skipRate: number };
export type AlbumRow = { albumId: string; album: string; artistId: string | null; artist: string; plays: number; hours: number; imageUrl?: string | null };
export type SessionShapeRow = { shape: string; count: number };
export type MonthPoint = { month: string; key: string; hours: number };
export type PlayRow = {
  playedAt: string;
  trackId: string | null;
  track: string;
  artistId: string | null;
  artist: string;
  album: string | null;
  msPlayed: number;
  skipped: boolean;
  attended: boolean;
  platform: string | null;
};
export type SessionRow = {
  sessionId: string;
  startAt: string;
  endAt: string;
  trackCount: number;
  skipCount: number;
  uniqueArtists: number;
  totalMs: number;
  shape: string;
  openingTrack: string;
  closingTrack: string;
  topArtists?: string[];      // Phase 8 (§3.4): shown on the card face, list view only
  platform: string | null;
  completionRate: number;
  completionSource: string;
  skipRate: number;
  repeatRate: number;
  noveltyRate: number;
  artistEntropy: number;
  dayPart: string;
  albumRide: boolean;
  attention: string;
  interactions: number;
  unattendedMs: number;
};
export type OnThisDayRow = { year: number; plays: number; minutes: number; topArtist: string | null; topArtistId: string | null };
export type RecordItem = { label: string; value: string; detail: string; href?: string };

export type DashboardStats = {
  totalPlays: number;
  totalHours: number;
  uniqueArtists: number;
  uniqueTracks: number;
  currentStreakDays: number;
  peakDay: DayCell | null;
  calendar: DayCell[];
  clock: HourSlice[];
  topArtists: ArtistRow[];
  topTracks: TrackRow[];
  sessionShapes: SessionShapeRow[];
  monthlyHours: MonthPoint[];
  recentPlays: PlayRow[];
  onThisDay: OnThisDayRow[];
  records: RecordItem[];
};

export type DayDetail = {
  date: string;
  minutes: number;
  plays: number;
  uniqueArtists: number;
  skips: number;
  sessions: SessionRow[];
  playsList: PlayRow[];
  prevDay: string | null;
  nextDay: string | null;
};

export type ArtistDetail = {
  artistId: string;
  artist: string;
  aliases: string[];
  plays: number;
  hours: number;
  uniqueTracks: number;
  skipRate: number;
  firstPlayed: string;
  lastPlayed: string;
  rank: number | null;
  monthly: MonthPoint[];
  topTracks: TrackRow[];
  clock: HourSlice[];
  topDays: DayCell[];
  albums: AlbumRow[];
  lateNightShare: number;
  albumLoyalty: { album: string; share: number } | null;
};

export type TrackDetail = {
  trackId: string;
  track: string;
  artistId: string | null;
  artist: string;
  albumId: string | null;
  album: string | null;
  plays: number;
  hours: number;
  skipRate: number;
  durationMs: number | null;
  durationEstimated: boolean;
  firstPlayed: string;
  lastPlayed: string;
  rank: number | null;
  monthly: MonthPoint[];
  clock: HourSlice[];
  exitPoints: { msPlayed: number; count: number }[];
  earlyExitMs: number | null;
  before: { trackId: string; track: string; artist: string; count: number }[];
  after: { trackId: string; track: string; artist: string; count: number }[];
  recentPlays: PlayRow[];
  aliases: string[];
};

export type AlbumDetail = {
  albumId: string;
  album: string;
  artistId: string | null;
  artist: string;
  plays: number;
  hours: number;
  skipRate: number;
  firstPlayed: string;
  lastPlayed: string;
  tracks: TrackRow[];
  monthly: MonthPoint[];
  rideCount: number;
  shareOfArtist: number;
};

export type MonthDetail = {
  key: string;            // 'YYYY-MM'
  label: string;          // 'March 2024'
  plays: number;
  hours: number;
  uniqueArtists: number;
  uniqueTracks: number;
  skips: number;
  newTracks: number;
  days: DayCell[];
  clock: HourSlice[];
  topArtists: ArtistRow[];
  topTracks: TrackRow[];
  shapes: SessionShapeRow[];
  prevMonth: string | null;
  nextMonth: string | null;
};

export type SearchResults = { q: string; artists: ArtistRow[]; tracks: TrackRow[]; albums: AlbumRow[] };

export type AppStatus = {
  version: string;
  hasData: boolean;
  demo: boolean;
  playCount: number;
  totalHours: number;
  firstPlay: string | null;
  lastPlay: string | null;
  importing: boolean;
  portable: boolean;
  dataDir: string;
  dbPath: string;
  timezone: string;
  lastImport: string | null;
};

export type FilePreview = {
  name: string; rowsTotal: number; rowsAudio: number; rowsSkipped: number;
  rowsDuplicateInFile: number; rowsAlreadyImported: number; firstTs: string | null; lastTs: string | null;
};
export type ImportPreview = {
  source: string; sourceKind: string; files: FilePreview[];
  rowsTotal: number; rowsAudio: number; rowsSkipped: number; rowsDuplicateInFile: number;
  rowsAlreadyImported: number; rowsNew: number; firstTs: string | null; lastTs: string | null;
  sample: { ts: string; track_name: string; artist_name: string; album_name: string | null; ms_played: number }[];
};
export type ImportProgress = {
  stage: string; file: string | null; file_index: number; file_count: number;
  rows_inserted: number; rows_duplicate: number; rows_skipped: number; message: string;
};
export type ImportDone = {
  import_id: string; files: number; rows_inserted: number; rows_duplicate: number; rows_skipped: number;
  total_plays: number; total_hours: number; elapsed_ms: number;
};
