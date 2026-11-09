-- newsdesk schema (idempotent, non-destructive)
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'rss' CHECK (type IN ('rss','api')),
  category TEXT NOT NULL DEFAULT 'tech',
  region TEXT NOT NULL DEFAULT 'intl' CHECK (region IN ('cn','intl')),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fetched INTEGER,
  last_error TEXT,
  last_count INTEGER,
  last_attempt INTEGER,
  last_success INTEGER,
  last_status INTEGER,
  last_final_url TEXT,
  last_content_type TEXT,
  last_elapsed_ms INTEGER,
  last_attempts INTEGER,
  last_body_snippet TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  url_hash TEXT NOT NULL UNIQUE,
  title_hash TEXT NOT NULL,
  summary TEXT,
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  category TEXT,
  region TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  read_at INTEGER,
  starred_at INTEGER,
  summary_zh TEXT,
  translated_title TEXT
);
CREATE INDEX IF NOT EXISTS idx_articles_pub ON articles (published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_articles_cat_pub ON articles (category, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_region_pub ON articles (region, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_source_pub ON articles (source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_title_hash ON articles (title_hash);
CREATE INDEX IF NOT EXISTS idx_articles_starred ON articles (is_starred, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_read ON articles (is_read, published_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(title, summary, content='articles', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, summary) VALUES (new.id, new.title, coalesce(new.summary,''));
END;
CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, coalesce(old.summary,''));
END;
CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE OF title, summary ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, coalesce(old.summary,''));
  INSERT INTO articles_fts(rowid, title, summary) VALUES (new.id, new.title, coalesce(new.summary,''));
END;

