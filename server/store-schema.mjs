export const STORE_SCHEMA_VERSION = 4;

const APPLICATION_TABLES = [
  'series_fts',
  'metadata_job_items',
  'metadata_jobs',
  'scan_issues',
  'read_progress',
  'series_tags',
  'series_metadata',
  'custom_covers',
  'favorites',
  'series_category_overrides',
  'series_categories',
  'pages',
  'chapters',
  'volumes',
  'series',
  'library_state',
  'settings',
  'app_state',
  'app_meta',
];

function getSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get();
    return Number.parseInt(row?.value ?? '', 10);
  } catch {
    return null;
  }
}

function resetSchema(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of APPLICATION_TABLES) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }

    db.exec(`
      CREATE TABLE app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE library_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_scan_at TEXT,
        scan_root TEXT,
        series_count INTEGER NOT NULL DEFAULT 0,
        volume_count INTEGER NOT NULL DEFAULT 0,
        chapter_count INTEGER NOT NULL DEFAULT 0,
        page_count INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        categories_json TEXT NOT NULL DEFAULT '[]',
        scan_meta_json TEXT
      ) STRICT;

      CREATE TABLE series (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        source_key TEXT NOT NULL UNIQUE,
        source_path TEXT NOT NULL,
        source_folder_name TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        dir_mtime TEXT,
        scan_fingerprint TEXT,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        tags_json TEXT NOT NULL DEFAULT '[]',
        cover_source_path TEXT,
        cover_file_name TEXT,
        volume_count INTEGER NOT NULL DEFAULT 0,
        chapter_count INTEGER NOT NULL DEFAULT 0,
        page_count INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE INDEX series_title_idx ON series(title COLLATE NOCASE, id);
      CREATE INDEX series_updated_at_idx ON series(updated_at DESC, id);
      CREATE INDEX series_source_key_idx ON series(source_key);

      CREATE TABLE volumes (
        id TEXT PRIMARY KEY,
        series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        source_path TEXT NOT NULL,
        synthetic INTEGER NOT NULL CHECK (synthetic IN (0, 1)),
        UNIQUE(series_id, position)
      ) STRICT;

      CREATE INDEX volumes_series_idx ON volumes(series_id, position);

      CREATE TABLE chapters (
        id TEXT PRIMARY KEY,
        series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
        volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        source_key TEXT NOT NULL,
        source_path TEXT NOT NULL,
        volume_title TEXT NOT NULL,
        page_count INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        UNIQUE(volume_id, position)
      ) STRICT;

      CREATE INDEX chapters_series_idx ON chapters(series_id, position);
      CREATE INDEX chapters_volume_idx ON chapters(volume_id, position);

      CREATE TABLE pages (
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        source_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(chapter_id, position)
      ) STRICT;

      CREATE INDEX pages_chapter_idx ON pages(chapter_id, position);

      CREATE TABLE series_categories (
        series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('auto', 'folder')),
        value TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY(series_id, kind, value)
      ) STRICT;

      CREATE INDEX series_categories_value_idx ON series_categories(value COLLATE NOCASE, series_id);

      CREATE TABLE series_category_overrides (
        source_key TEXT NOT NULL,
        value TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY(source_key, value)
      ) STRICT;

      CREATE TABLE favorites (
        source_key TEXT PRIMARY KEY
      ) STRICT;

      CREATE TABLE custom_covers (
        source_key TEXT PRIMARY KEY,
        chapter_id TEXT NOT NULL,
        page_index INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE series_metadata (
        source_key TEXT PRIMARY KEY,
        title TEXT,
        author TEXT,
        description TEXT
      ) STRICT;

      CREATE TABLE series_tags (
        source_key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(source_key, value)
      ) STRICT;

      CREATE INDEX series_tags_value_idx ON series_tags(value COLLATE NOCASE, source_key);

      CREATE TABLE read_progress (
        source_key TEXT PRIMARY KEY,
        chapter_id TEXT NOT NULL,
        page_index INTEGER NOT NULL,
        total_pages INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE scan_issues (
        position INTEGER PRIMARY KEY,
        message TEXT NOT NULL
      ) STRICT;

      CREATE TABLE metadata_jobs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        apply_changes INTEGER NOT NULL CHECK (apply_changes IN (0, 1)),
        overwrite_existing INTEGER NOT NULL CHECK (overwrite_existing IN (0, 1)),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
        total_count INTEGER NOT NULL DEFAULT 0,
        completed_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE INDEX metadata_jobs_status_idx ON metadata_jobs(status, created_at);

      CREATE TABLE metadata_job_items (
        job_id TEXT NOT NULL REFERENCES metadata_jobs(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        series_id TEXT,
        source_key TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        error TEXT,
        PRIMARY KEY(job_id, position)
      ) STRICT;

      CREATE INDEX metadata_job_items_status_idx ON metadata_job_items(job_id, status, position);

      CREATE VIRTUAL TABLE series_fts USING fts5(
        series_id UNINDEXED,
        title,
        author,
        description,
        tags,
        tokenize = 'unicode61'
      );
    `);

    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(STORE_SCHEMA_VERSION),
    );
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run('revision', '0');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function initializeStoreSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
  `);

  if (getSchemaVersion(db) !== STORE_SCHEMA_VERSION) {
    resetSchema(db);
  }

  // PRAGMA foreign_keys 是连接级设置，重建之后再次确保开启。
  db.exec('PRAGMA foreign_keys = ON;');
}
