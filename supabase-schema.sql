-- Schema Postgres per Supabase.
-- Da incollare in Supabase → SQL Editor → New query → Run.
-- Ricalca lo schema SQLite: booleani come SMALLINT 0/1, timestamp come TEXT ISO
-- (compatibile 1:1 col codice attuale che scrive new Date().toISOString()).

CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  finished_at    TEXT,
  status         TEXT NOT NULL,
  stage          TEXT,
  progress       INTEGER DEFAULT 0,
  message        TEXT,
  params         TEXT,
  stats          TEXT,
  error          TEXT,
  pipeline_state TEXT
);

CREATE TABLE IF NOT EXISTS apify_runs (
  run_id      TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  stage       TEXT NOT NULL,
  batch_index INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'pending',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apify_runs_job ON apify_runs(job_id, stage);

CREATE TABLE IF NOT EXISTS leads (
  id              BIGSERIAL PRIMARY KEY,
  job_id          TEXT NOT NULL,
  platform        TEXT NOT NULL,
  username        TEXT NOT NULL,
  profile_url     TEXT,
  profile_pic_url TEXT,
  full_name       TEXT,
  bio             TEXT,
  category        TEXT,
  is_business     SMALLINT DEFAULT 0,
  is_verified     SMALLINT DEFAULT 0,
  is_private      SMALLINT DEFAULT 0,
  followers       INTEGER,
  following       INTEGER,
  posts_count     INTEGER,
  email           TEXT,
  phone           TEXT,
  website         TEXT,
  address         TEXT,
  source          TEXT,
  source_profile  TEXT,
  score           INTEGER DEFAULT 0,
  enriched        SMALLINT DEFAULT 0,
  UNIQUE(job_id, platform, username)
);
CREATE INDEX IF NOT EXISTS idx_leads_job   ON leads(job_id);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(job_id, score DESC);

CREATE TABLE IF NOT EXISTS lead_posts (
  id             BIGSERIAL PRIMARY KEY,
  job_id         TEXT NOT NULL,
  platform       TEXT NOT NULL,
  username       TEXT NOT NULL,
  post_url       TEXT,
  caption        TEXT,
  hashtags       TEXT,
  location       TEXT,
  image_urls     TEXT,
  likes          INTEGER,
  comments_count INTEGER,
  posted_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_lead_posts_job  ON lead_posts(job_id);
CREATE INDEX IF NOT EXISTS idx_lead_posts_user ON lead_posts(job_id, username);

CREATE TABLE IF NOT EXISTS crm (
  id                     BIGSERIAL PRIMARY KEY,
  platform               TEXT NOT NULL,
  username               TEXT NOT NULL,
  profile_url            TEXT,
  profile_pic_url        TEXT,
  full_name              TEXT,
  bio                    TEXT,
  bio_analysis           TEXT,
  category               TEXT,
  is_business            SMALLINT DEFAULT 0,
  is_verified            SMALLINT DEFAULT 0,
  is_private             SMALLINT DEFAULT 0,
  followers              INTEGER,
  following              INTEGER,
  posts_count            INTEGER,
  email                  TEXT,
  phone                  TEXT,
  website                TEXT,
  address                TEXT,
  source                 TEXT,
  source_profile         TEXT,
  score                  INTEGER DEFAULT 0,
  enriched               SMALLINT DEFAULT 0,
  added_at               TEXT NOT NULL,
  job_id                 TEXT,
  notes                  TEXT,
  estimated_age          TEXT,
  gender                 TEXT,
  country                TEXT,
  city                   TEXT,
  language               TEXT,
  profession             TEXT,
  interests              TEXT,
  economic_level         TEXT,
  status                 TEXT DEFAULT 'nuovo',
  ai_analysis            TEXT,
  status_changed_at      TEXT,
  followup_dismissed_at  TEXT,
  UNIQUE(platform, username)
);
CREATE INDEX IF NOT EXISTS idx_crm_platform ON crm(platform);
CREATE INDEX IF NOT EXISTS idx_crm_status   ON crm(status);
CREATE INDEX IF NOT EXISTS idx_crm_added    ON crm(added_at);

CREATE TABLE IF NOT EXISTS profiles (
  id          BIGSERIAL PRIMARY KEY,
  platform    TEXT NOT NULL,
  username    TEXT NOT NULL,
  profile_url TEXT,
  notes       TEXT,
  added_at    TEXT NOT NULL,
  UNIQUE(platform, username)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
