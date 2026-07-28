// Persistenza su Postgres (Supabase) tramite il driver `pg`.
// Tutte le funzioni sono async: ogni chiamata da server.js richiede `await`.

import pg from 'pg';

const { Pool } = pg;

// COUNT(*)/BIGSERIAL tornano come oid 20 (bigint) e pg li serializza come
// stringa per default: qui li facciamo tornare number, così tutta la
// aritmetica esistente nel resto del codice funziona senza modifiche.
pg.types.setTypeParser(20, (val) => parseInt(val, 10));

let pool;
let schemaReady = false;

export async function initDb() {
  if (pool) return pool; // istanza lambda riutilizzata: pool già pronto
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL non impostata. Aggiungila alle variabili d\'ambiente.');

  pool = new Pool({
    connectionString,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
    max: 5,
  });

  if (!schemaReady) {
    await ensureSchema();
    schemaReady = true;
  }
  return pool;
}

/** Schema idempotente: utile al primo avvio e come rete di sicurezza se il DB viene ricreato. */
async function ensureSchema() {
  await pool.query(`
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

    -- Instrada i webhook di Apify al job/stage/batch corretto: ogni run avviato
    -- viene registrato qui prima di partire, il webhook lo cerca per run_id.
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
  `);
}

// ---- Helpers SQL --------------------------------------------------------------

/** Converte i placeholder `?` (stile SQLite) in `$1, $2, ...` (stile Postgres). */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function query(sql, params = []) {
  const res = await pool.query(toPg(sql), params);
  return res.rows;
}

async function get(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function cQuery(client, sql, params = []) {
  const res = await client.query(toPg(sql), params);
  return res.rows;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---- Jobs ----------------------------------------------------------------

export async function createJob(id, params) {
  await query(
    `INSERT INTO jobs (id, created_at, status, stage, progress, message, params)
     VALUES (?, ?, 'pending', 'in coda', 0, 'In attesa di avvio', ?)`,
    [id, new Date().toISOString(), JSON.stringify(params)],
  );
}

export async function updateJob(id, fields) {
  const allowed = ['status', 'stage', 'progress', 'message', 'stats', 'error', 'finished_at', 'pipeline_state'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;

  const sql = `UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  const values = keys.map((k) => {
    const v = fields[k];
    return typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
  });
  await query(sql, [...values, id]);
}

export async function getJob(id) {
  const row = await get('SELECT * FROM jobs WHERE id = ?', [id]);
  if (!row) return null;
  return {
    ...row,
    params: safeParse(row.params),
    stats: safeParse(row.stats),
  };
}

export async function listJobs(limit = 20) {
  const rows = await query(
    'SELECT id, created_at, finished_at, status, stage, progress, message, params, stats FROM jobs ORDER BY created_at DESC LIMIT ?',
    [limit],
  );
  return rows.map((r) => ({ ...r, params: safeParse(r.params), stats: safeParse(r.stats) }));
}

const LEAD_COLS = [
  'job_id', 'platform', 'username', 'profile_url', 'full_name', 'bio', 'category',
  'is_business', 'is_verified', 'is_private', 'followers', 'following', 'posts_count',
  'email', 'phone', 'website', 'address', 'source', 'source_profile', 'score', 'enriched', 'profile_pic_url',
];

export async function insertLeads(jobId, leads) {
  if (!leads.length) return;
  await withTransaction(async (client) => {
    for (const batch of chunkArray(leads, 300)) {
      const values = [];
      const tuples = batch.map((l, i) => {
        values.push(
          jobId, l.platform, l.username, l.profile_url ?? null, l.full_name ?? null, l.bio ?? null, l.category ?? null,
          l.is_business ? 1 : 0, l.is_verified ? 1 : 0, l.is_private ? 1 : 0, l.followers ?? null, l.following ?? null,
          l.posts_count ?? null, l.email ?? null, l.phone ?? null, l.website ?? null, l.address ?? null,
          l.source ?? null, l.source_profile ?? null, l.score ?? 0, l.enriched ? 1 : 0, l.profile_pic_url ?? null,
        );
        const base = i * LEAD_COLS.length;
        return `(${LEAD_COLS.map((_, j) => `$${base + j + 1}`).join(', ')})`;
      });
      const updateCols = LEAD_COLS.filter((c) => !['job_id', 'platform', 'username'].includes(c));
      const sql = `
        INSERT INTO leads (${LEAD_COLS.join(', ')})
        VALUES ${tuples.join(', ')}
        ON CONFLICT (job_id, platform, username) DO UPDATE SET
          ${updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
      `;
      await client.query(sql, values);
    }
  });
}

export async function getLeads(jobId, { limit = 500, offset = 0, onlyWithEmail = false } = {}) {
  const where = onlyWithEmail ? "AND email IS NOT NULL AND email != ''" : '';
  return await query(
    `SELECT * FROM leads WHERE job_id = ? ${where} ORDER BY score DESC, followers DESC LIMIT ? OFFSET ?`,
    [jobId, limit, offset],
  );
}

export async function countLeads(jobId) {
  const total = (await get('SELECT COUNT(*) AS c FROM leads WHERE job_id = ?', [jobId])).c;
  const withEmail = (await get("SELECT COUNT(*) AS c FROM leads WHERE job_id = ? AND email IS NOT NULL AND email != ''", [jobId])).c;
  const withSite = (await get("SELECT COUNT(*) AS c FROM leads WHERE job_id = ? AND website IS NOT NULL AND website != ''", [jobId])).c;
  return { total, withEmail, withSite };
}

const POST_COLS = ['job_id', 'platform', 'username', 'post_url', 'caption', 'hashtags', 'location', 'image_urls', 'likes', 'comments_count', 'posted_at'];

export async function insertLeadPosts(jobId, posts) {
  if (!posts.length) return;
  await withTransaction(async (client) => {
    for (const batch of chunkArray(posts, 300)) {
      const values = [];
      const tuples = batch.map((p, i) => {
        values.push(
          jobId, p.platform, p.username, p.post_url ?? null, p.caption ?? null,
          JSON.stringify(p.hashtags ?? []), p.location ?? null, JSON.stringify(p.image_urls ?? []),
          p.likes ?? null, p.comments_count ?? null, p.posted_at ?? null,
        );
        const base = i * POST_COLS.length;
        return `(${POST_COLS.map((_, j) => `$${base + j + 1}`).join(', ')})`;
      });
      const sql = `INSERT INTO lead_posts (${POST_COLS.join(', ')}) VALUES ${tuples.join(', ')}`;
      await client.query(sql, values);
    }
  });
}

export async function getLeadPosts(jobId, username = null) {
  if (username) {
    const rows = await query('SELECT * FROM lead_posts WHERE job_id = ? AND username = ? ORDER BY posted_at DESC', [jobId, username]);
    return rows.map(parsePostRow);
  }
  const rows = await query('SELECT * FROM lead_posts WHERE job_id = ? ORDER BY username, posted_at DESC', [jobId]);
  return rows.map(parsePostRow);
}

function parsePostRow(row) {
  return { ...row, hashtags: safeParse(row.hashtags) ?? [], image_urls: safeParse(row.image_urls) ?? [] };
}

export async function getLeadPostsByUsername(platform, username, limit = 6) {
  const rows = await query(
    'SELECT * FROM lead_posts WHERE platform = ? AND username = ? ORDER BY posted_at DESC LIMIT ?',
    [platform, username, limit],
  );
  return rows.map(parsePostRow);
}

export async function deleteLead(jobId, username) {
  await query('DELETE FROM leads WHERE job_id = ? AND username = ?', [jobId, username]);
}

export async function deleteJob(id) {
  await withTransaction(async (client) => {
    await cQuery(client, 'DELETE FROM lead_posts WHERE job_id = ?', [id]);
    await cQuery(client, 'DELETE FROM leads WHERE job_id = ?', [id]);
    await cQuery(client, 'DELETE FROM jobs WHERE id = ?', [id]);
  });
}

// ---- CRM -------------------------------------------------------------------

const CRM_IMPORT_COLS = [
  'platform', 'username', 'profile_url', 'full_name', 'bio', 'category',
  'is_business', 'is_verified', 'is_private', 'followers', 'following', 'posts_count',
  'email', 'phone', 'website', 'address', 'source', 'source_profile', 'score', 'enriched',
  'added_at', 'job_id', 'profile_pic_url',
];

export async function importToCrm(jobId) {
  const job = await get('SELECT created_at FROM jobs WHERE id = ?', [jobId]);
  const extractedAt = job?.created_at ?? new Date().toISOString();
  const leads = await query('SELECT * FROM leads WHERE job_id = ?', [jobId]);
  if (!leads.length) return { imported: 0, duplicates: 0, total: 0 };

  let imported = 0;
  await withTransaction(async (client) => {
    for (const batch of chunkArray(leads, 300)) {
      const values = [];
      const tuples = batch.map((l, i) => {
        values.push(
          l.platform, l.username, l.profile_url, l.full_name, l.bio, l.category,
          l.is_business, l.is_verified, l.is_private, l.followers, l.following, l.posts_count,
          l.email, l.phone, l.website, l.address, l.source, l.source_profile, l.score, l.enriched,
          extractedAt, jobId, l.profile_pic_url ?? null,
        );
        const base = i * CRM_IMPORT_COLS.length;
        return `(${CRM_IMPORT_COLS.map((_, j) => `$${base + j + 1}`).join(', ')})`;
      });
      const sql = `
        INSERT INTO crm (${CRM_IMPORT_COLS.join(', ')})
        VALUES ${tuples.join(', ')}
        ON CONFLICT (platform, username) DO NOTHING
        RETURNING username
      `;
      const res = await client.query(sql, values);
      imported += res.rows.length;
    }
  });
  return { imported, duplicates: leads.length - imported, total: leads.length };
}

export async function addManualCrmLead({ platform, username, full_name, email, phone, website, notes }) {
  const p = platform || 'instagram';
  const u = username || '';
  if (u) {
    const existing = await get('SELECT id FROM crm WHERE platform = ? AND username = ?', [p, u]);
    if (existing) return { id: existing.id, duplicate: true };
  }
  const row = await get(
    `INSERT INTO crm (platform, username, full_name, email, phone, website, notes, source, added_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'manuale', ?, 'nuovo')
     RETURNING id`,
    [p, u, full_name || '', email || '', phone || '', website || '', notes || '', new Date().toISOString()],
  );
  return { id: row.id, duplicate: false };
}

export async function getCrmLead(id) {
  return (await get('SELECT * FROM crm WHERE id = ?', [id])) ?? null;
}

export async function getCrmLeads({ limit = 500, offset = 0 } = {}) {
  return await query('SELECT * FROM crm ORDER BY added_at DESC LIMIT ? OFFSET ?', [limit, offset]);
}

export async function countCrmLeads() {
  const total = (await get('SELECT COUNT(*) AS c FROM crm')).c;
  const withEmail = (await get("SELECT COUNT(*) AS c FROM crm WHERE email IS NOT NULL AND email != ''")).c;
  return { total, withEmail };
}

export async function getCrmKpi(days = 7) {
  const ms = 86400000;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const period = Math.max(1, Number(days) || 7);
  // Finestra corrente e finestra precedente della stessa lunghezza
  const dStart = new Date(today.getTime() - (period - 1) * ms).toISOString();
  const dPrevStart = new Date(today.getTime() - (period * 2 - 1) * ms).toISOString();
  // Lo sparkline copre l'intero arco (corrente + precedente), max 30 punti
  const sparkDays = Math.min(period * 2, 30);
  const dSpark = new Date(today.getTime() - (sparkDays - 1) * ms).toISOString();

  const statuses = ['nuovo', 'da contattare', 'contattato', 'interessato', 'cliente', 'scartato'];
  const counts = {};
  (await query("SELECT COALESCE(status,'nuovo') AS s, COUNT(*) AS c FROM crm GROUP BY COALESCE(status,'nuovo')"))
    .forEach((r) => { counts[r.s] = r.c; });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const rows = await query(`SELECT LEFT(added_at, 10) AS day, COALESCE(status,'nuovo') AS s, COUNT(*) AS c FROM crm WHERE added_at >= ? GROUP BY day, s`, [dSpark]);
  const dayMap = {};
  rows.forEach((r) => {
    if (!dayMap[r.s]) dayMap[r.s] = {};
    dayMap[r.s][r.day] = r.c;
  });

  function spark(statusMap) {
    const out = [];
    for (let i = sparkDays - 1; i >= 0; i--) {
      const day = new Date(today.getTime() - i * ms).toISOString().slice(0, 10);
      out.push((statusMap && statusMap[day]) || 0);
    }
    return out;
  }

  const allDays = {};
  rows.forEach((r) => { allDays[r.day] = (allDays[r.day] || 0) + r.c; });

  async function delta(statusFilter) {
    const cur = (await get(`SELECT COUNT(*) AS c FROM crm WHERE added_at >= ?${statusFilter}`, [dStart])).c;
    const prev = (await get(`SELECT COUNT(*) AS c FROM crm WHERE added_at >= ? AND added_at < ?${statusFilter}`, [dPrevStart, dStart])).c;
    const pct = prev > 0 ? Math.round((cur - prev) / prev * 100) : (cur > 0 ? 100 : 0);
    return { cur, prev, pct, days: period };
  }

  const cards = [
    { key: 'tutti', label: 'Lead totali', count: total, spark: spark(null), ...(await delta('')) },
  ];
  for (const s of statuses) {
    const filter = ` AND COALESCE(status,'nuovo') = '${s}'`;
    cards.push({
      key: s.replace(/ /g, '_'),
      label: s === 'da contattare' ? 'Da contattare' : s.charAt(0).toUpperCase() + s.slice(1),
      count: counts[s] || 0,
      spark: spark(dayMap[s]),
      ...(await delta(filter)),
    });
  }
  cards[0].spark = spark(allDays);

  return cards;
}

export async function deleteCrmLead(id) {
  await query('DELETE FROM crm WHERE id = ?', [id]);
}

export async function updateCrmLead(id, fields) {
  const allowed = [
    'notes', 'estimated_age', 'gender', 'country', 'city', 'language', 'profession', 'interests', 'economic_level', 'status', 'ai_analysis', 'bio_analysis',
    'full_name', 'bio', 'category', 'is_business', 'is_verified', 'is_private',
    'followers', 'following', 'posts_count',
    'email', 'phone', 'website',
    'profile_pic_url', 'profile_url', 'enriched', 'score',
    'status_changed_at', 'followup_dismissed_at',
  ];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;

  // Se lo status cambia rispetto al valore corrente, aggiorna il timestamp e
  // resetta il dismiss del follow-up (una nuova mossa merita una nuova notifica).
  if (keys.includes('status') && !keys.includes('status_changed_at')) {
    const current = await get('SELECT status FROM crm WHERE id = ?', [id]);
    if (current && current.status !== fields.status) {
      fields.status_changed_at = new Date().toISOString();
      fields.followup_dismissed_at = null;
      keys.push('status_changed_at', 'followup_dismissed_at');
    }
  }

  const sql = `UPDATE crm SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  await query(sql, [...keys.map((k) => fields[k] ?? null), id]);
}

/**
 * Lead in stato "contattato" da più di `days` giorni senza dismiss recente.
 * Un dismiss è "recente" se avvenuto dopo l'ultimo cambio di stato: se il lead
 * torna contattato dopo un altro stato, il dismiss precedente non conta più.
 */
export async function getFollowups(days = 3) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return await query(
    `SELECT id, platform, username, full_name, profile_pic_url, profile_url, status,
            status_changed_at, followup_dismissed_at, score, followers
     FROM crm
     WHERE status = 'contattato'
       AND status_changed_at IS NOT NULL
       AND status_changed_at < ?
       AND (followup_dismissed_at IS NULL OR followup_dismissed_at < status_changed_at)
     ORDER BY status_changed_at ASC`,
    [cutoff],
  );
}

/** All'avvio: i job "running" salvati pre-webhook erano crash; ora non servono. */
export async function markStaleJobsAsError() {
  // Con i webhook i job running sono legittimi: Apify manderà il callback.
  // Segniamo come errore solo i job pending (mai partiti).
}

// ---- Profili ----------------------------------------------------------------

export async function addProfile(platform, username, profileUrl, notes) {
  return await query(
    `INSERT INTO profiles (platform, username, profile_url, notes, added_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (platform, username) DO NOTHING`,
    [platform, username, profileUrl ?? null, notes ?? null, new Date().toISOString()],
  );
}

export async function listProfiles() {
  return await query('SELECT * FROM profiles ORDER BY added_at DESC');
}

export async function updateProfile(id, fields) {
  const allowed = ['notes', 'platform', 'username', 'profile_url'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  const sql = `UPDATE profiles SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  await query(sql, [...keys.map((k) => fields[k] ?? null), id]);
}

export async function deleteProfile(id) {
  await query('DELETE FROM profiles WHERE id = ?', [id]);
}

export async function getProfileStats() {
  const jobs = await query('SELECT params FROM jobs WHERE status = ?', ['done']);
  const usage = {};
  for (const j of jobs) {
    const p = safeParse(j.params);
    if (!p?.handles) continue;
    for (const h of p.handles) {
      const key = `${p.platform}::${h}`;
      usage[key] = (usage[key] || 0) + 1;
    }
  }
  return usage;
}

// ---- Analytics --------------------------------------------------------------

export async function getAnalytics(days = 30, platform = null, { from, to } = {}) {
  const ms = 86400000;
  const now = new Date();
  let today;
  if (from && to) {
    today = new Date(to + 'T00:00:00');
    days = Math.max(1, Math.round((today.getTime() - new Date(from + 'T00:00:00').getTime()) / ms) + 1);
  } else {
    today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  const curISO = days > 0 ? new Date(today.getTime() - (days - 1) * ms).toISOString() : '1970-01-01T00:00:00.000Z';
  const prevISO = days > 0 ? new Date(today.getTime() - (days * 2 - 1) * ms).toISOString() : '1970-01-01T00:00:00.000Z';

  const pf = platform ? ' AND platform = ?' : '';
  const pp = platform ? [platform] : [];
  const g = async (sql, ...a) => await get(sql, [...a, ...pp]);
  const ga = async (sql, ...a) => await query(sql, [...a, ...pp]);

  function fill(rows, n) {
    const m = {}; rows.forEach((r) => { m[r.day] = r.count; });
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(m[new Date(today.getTime() - i * ms).toISOString().slice(0, 10)] || 0);
    return out;
  }
  function dayLabels(n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(new Date(today.getTime() - i * ms).toISOString().slice(0, 10));
    return out;
  }

  const total = (await g(`SELECT COUNT(*) AS c FROM crm WHERE 1=1 ${pf}`)).c;
  const curAdded = days > 0 ? (await g(`SELECT COUNT(*) AS c FROM crm WHERE added_at >= ? ${pf}`, curISO)).c : total;
  const prevAdded = days > 0 ? (await g(`SELECT COUNT(*) AS c FROM crm WHERE added_at >= ? AND added_at < ? ${pf}`, prevISO, curISO)).c : 0;

  const sr = await ga(`SELECT COALESCE(status,'nuovo') AS status, COUNT(*) AS count FROM crm WHERE 1=1 ${pf} GROUP BY COALESCE(status,'nuovo')`);
  const sc = {}; sr.forEach((r) => { sc[r.status] = r.count; });
  const nuovo = sc['nuovo'] || 0, daContattare = sc['da contattare'] || 0;
  const contattato = sc['contattato'] || 0, interessato = sc['interessato'] || 0;
  const callSt = sc['call'] || 0, cliente = sc['cliente'] || 0;
  const contacted = contattato + interessato + callSt + cliente;
  const replied = interessato + callSt + cliente;
  const contactRate = total > 0 ? Math.round(contacted / total * 100) : 0;
  const replyRate = contacted > 0 ? Math.round(replied / contacted * 100) : 0;
  const convRate = total > 0 ? Math.round(cliente / total * 100) : 0;

  let prevContactRate = 0, prevReplyRate = 0, prevConvRate = 0, prevClients = 0;
  if (days > 0) {
    const ps = {};
    (await ga(`SELECT COALESCE(status,'nuovo') AS status, COUNT(*) AS count FROM crm WHERE added_at >= ? AND added_at < ? ${pf} GROUP BY COALESCE(status,'nuovo')`, prevISO, curISO))
      .forEach((r) => { ps[r.status] = r.count; });
    const pt = Object.values(ps).reduce((a, b) => a + b, 0);
    const pc = (ps['contattato'] || 0) + (ps['interessato'] || 0) + (ps['call'] || 0) + (ps['cliente'] || 0);
    const pr = (ps['interessato'] || 0) + (ps['call'] || 0) + (ps['cliente'] || 0);
    prevContactRate = pt > 0 ? Math.round(pc / pt * 100) : 0;
    prevReplyRate = pc > 0 ? Math.round(pr / pc * 100) : 0;
    prevConvRate = pt > 0 ? Math.round((ps['cliente'] || 0) / pt * 100) : 0;
    prevClients = ps['cliente'] || 0;
  }

  const d7 = new Date(today.getTime() - 6 * ms).toISOString();
  const d14 = new Date(today.getTime() - 13 * ms).toISOString();
  const last7 = (await g(`SELECT COUNT(*) AS c FROM crm WHERE added_at >= ? ${pf}`, d7)).c;
  const prev7 = (await g(`SELECT COUNT(*) AS c FROM crm WHERE added_at >= ? AND added_at < ? ${pf}`, d14, d7)).c;

  const sp = new Date(today.getTime() - 13 * ms).toISOString();
  const sparkAll = fill(await ga(`SELECT LEFT(added_at, 10) AS day, COUNT(*) AS count FROM crm WHERE added_at >= ? ${pf} GROUP BY LEFT(added_at, 10)`, sp), 14);
  const sparkClients = fill(await ga(`SELECT LEFT(added_at, 10) AS day, COUNT(*) AS count FROM crm WHERE added_at >= ? AND status='cliente' ${pf} GROUP BY LEFT(added_at, 10)`, sp), 14);
  const withEmail = (await g(`SELECT COUNT(*) AS c FROM crm WHERE email IS NOT NULL AND email != '' ${pf}`)).c;

  const kpis = {
    totalLeads: { value: total, delta: curAdded, prevDelta: prevAdded, spark: sparkAll },
    newLeads: { value: nuovo },
    last7d: { value: last7, delta: last7, prevDelta: prev7 },
    contactRate: { value: contactRate, prev: prevContactRate },
    replyRate: { value: replyRate, prev: prevReplyRate },
    conversionRate: { value: convRate, prev: prevConvRate },
    clients: { value: cliente, delta: cliente, prevDelta: prevClients, spark: sparkClients },
    revenue: null, avgClientValue: null, avgFirstContact: null,
  };

  const fSteps = [
    { key: 'lead', label: 'Lead', count: total },
    { key: 'da_contattare', label: 'Da contattare', count: daContattare + contacted },
    { key: 'contattato', label: 'Contattati', count: contacted },
    { key: 'interessato', label: 'Interessati', count: replied },
    { key: 'call', label: 'Call', count: callSt + cliente },
    { key: 'cliente', label: 'Clienti', count: cliente },
  ];
  let bdi = -1, bd = 0;
  const funnel = fSteps.map((s, i) => {
    const pt = total > 0 ? Math.round(s.count / total * 100) : 0;
    const pc = i > 0 ? fSteps[i - 1].count : s.count;
    const cfp = pc > 0 ? Math.round(s.count / pc * 100) : 0;
    const drop = i > 0 ? pc - s.count : 0;
    if (drop > bd) { bd = drop; bdi = i; }
    return { ...s, pctTotal: pt, convFromPrev: cfp };
  });
  funnel.forEach((f, i) => { f.isBiggestDrop = i === bdi && bdi > 0; });

  const tDays = days || 30;
  const tStart = new Date(today.getTime() - (tDays - 1) * ms).toISOString();
  const tl = dayLabels(tDays);
  const timeline = {
    labels: tl,
    extracted: fill(await ga(`SELECT LEFT(added_at, 10) AS day, COUNT(*) AS count FROM crm WHERE added_at >= ? ${pf} GROUP BY LEFT(added_at, 10)`, tStart), tDays),
    contacted: fill(await ga(`SELECT LEFT(added_at, 10) AS day, COUNT(*) AS count FROM crm WHERE added_at >= ? AND status IN ('contattato','interessato','call','cliente') ${pf} GROUP BY LEFT(added_at, 10)`, tStart), tDays),
    clients: fill(await ga(`SELECT LEFT(added_at, 10) AS day, COUNT(*) AS count FROM crm WHERE added_at >= ? AND status='cliente' ${pf} GROUP BY LEFT(added_at, 10)`, tStart), tDays),
  };

  const platforms = await query(`
    SELECT platform, COUNT(*) AS leads,
      SUM(CASE WHEN status IN ('contattato','interessato','call','cliente') THEN 1 ELSE 0 END) AS contacted,
      SUM(CASE WHEN status IN ('interessato','call','cliente') THEN 1 ELSE 0 END) AS replied,
      SUM(CASE WHEN status='cliente' THEN 1 ELSE 0 END) AS clients
    FROM crm GROUP BY platform ORDER BY leads DESC
  `);
  platforms.forEach((p) => {
    p.replyRate = p.contacted > 0 ? Math.round(p.replied / p.contacted * 100) : 0;
    p.convRate = p.leads > 0 ? Math.round(p.clients / p.leads * 100) : 0;
  });

  const ranges = [[0, 5], [6, 10], [11, 15], [16, 20]];
  const rl = ['0–5', '6–10', '11–15', '16–20'];
  const scoreDist = [];
  for (let i = 0; i < ranges.length; i++) {
    const [a, b] = ranges[i];
    scoreDist.push({ range: rl[i], count: (await g(`SELECT COUNT(*) AS c FROM crm WHERE score>=? AND score<=? ${pf}`, a, b)).c });
  }
  const scoreConv = [];
  for (let i = 0; i < ranges.length; i++) {
    const [a, b] = ranges[i];
    const l = (await g(`SELECT COUNT(*) AS c FROM crm WHERE score>=? AND score<=? ${pf}`, a, b)).c;
    const cl = (await g(`SELECT COUNT(*) AS c FROM crm WHERE score>=? AND score<=? AND status='cliente' ${pf}`, a, b)).c;
    scoreConv.push({ range: rl[i], leads: l, clients: cl, convRate: l > 0 ? Math.round(cl / l * 100) : 0 });
  }

  const noEmail = (await g(`SELECT COUNT(*) AS c FROM crm WHERE (email IS NULL OR email='') ${pf}`)).c;
  const noPhone = (await g(`SELECT COUNT(*) AS c FROM crm WHERE (phone IS NULL OR phone='') ${pf}`)).c;
  const inactive = (await g(`SELECT COUNT(*) AS c FROM crm WHERE status='nuovo' AND added_at < ? ${pf}`, new Date(today.getTime() - 14 * ms).toISOString())).c;
  const forgotten = (await g(`SELECT COUNT(*) AS c FROM crm WHERE status='da contattare' AND added_at < ? ${pf}`, new Date(today.getTime() - 7 * ms).toISOString())).c;

  const alerts = [];
  if (daContattare > 0) alerts.push({ severity: 'warning', message: `${daContattare} lead da contattare`, count: daContattare });
  const hsn = (await g(`SELECT COUNT(*) AS c FROM crm WHERE score>=15 AND status='nuovo' ${pf}`)).c;
  if (hsn > 0) alerts.push({ severity: 'info', message: `${hsn} lead con score alto non aperti`, count: hsn });
  if (inactive > 0) alerts.push({ severity: 'danger', message: `${inactive} lead inattivi da 14+ giorni`, count: inactive });
  if (forgotten > 0) alerts.push({ severity: 'danger', message: `${forgotten} follow-up in ritardo`, count: forgotten });
  if (convRate < 5 && total > 20) alerts.push({ severity: 'warning', message: `Conversion rate basso: ${convRate}%` });
  if (replyRate < 20 && contacted > 10) alerts.push({ severity: 'warning', message: `Reply rate basso: ${replyRate}%` });
  if (!alerts.length) alerts.push({ severity: 'good', message: 'Nessuna criticità' });

  const mStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dl = dim - now.getDate();
  const mt = Number(await getSetting('monthly_goal')) || 1000;
  const mc = (await g(`SELECT COUNT(*) AS c FROM crm WHERE added_at >= ? ${pf}`, mStart)).c;
  const dn = dl > 0 ? Math.ceil(Math.max(mt - mc, 0) / dl) : 0;

  const topSources = await query(
    `SELECT source_profile, platform, COUNT(*) AS count FROM crm
     WHERE source_profile IS NOT NULL AND source_profile != '' ${pf}
     GROUP BY source_profile, platform ORDER BY count DESC LIMIT 10`,
    pp,
  );

  return {
    kpis, funnel, timeline, platforms, scoreDist, scoreConv,
    crmPerformance: { noEmail, noPhone, inactive, forgotten },
    alerts, goals: { target: mt, current: mc, daysLeft: dl, dailyNeeded: dn },
    topSources, total, withEmail,
  };
}

// ---- Settings ---------------------------------------------------------------

export async function getSetting(key) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value ?? null],
  );
}

export async function getAllSettings() {
  const rows = await query('SELECT key, value FROM settings');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// ---- Apify Runs (webhook routing) -------------------------------------------

export async function registerApifyRun(runId, jobId, stage, batchIndex = 0) {
  await query(
    `INSERT INTO apify_runs (run_id, job_id, stage, batch_index, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
    [runId, jobId, stage, batchIndex, new Date().toISOString()],
  );
}

export async function getApifyRun(runId) {
  return await get('SELECT * FROM apify_runs WHERE run_id = ?', [runId]);
}

export async function updateApifyRunStatus(runId, status) {
  await query('UPDATE apify_runs SET status = ? WHERE run_id = ?', [status, runId]);
}

export async function countPendingRuns(jobId, stage) {
  const row = await get(
    "SELECT COUNT(*) AS c FROM apify_runs WHERE job_id = ? AND stage = ? AND status = 'pending'",
    [jobId, stage],
  );
  return row.c;
}

export async function getPipelineState(jobId) {
  const row = await get('SELECT pipeline_state FROM jobs WHERE id = ?', [jobId]);
  return safeParse(row?.pipeline_state);
}

export async function setPipelineState(jobId, state) {
  await query('UPDATE jobs SET pipeline_state = ? WHERE id = ?', [JSON.stringify(state), jobId]);
}

function safeParse(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
