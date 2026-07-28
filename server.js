import express from 'express';
import { randomUUID, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ACTORS, UNSUPPORTED, WARNINGS, HARD_LIMITS, DEFAULT_LIMITS, PLATFORM_DEFAULTS, TELEGRAM_ACTOR, TELEGRAM_MESSAGES_ACTOR } from './src/config.js';
import { checkToken, runActor, fetchDatasetItems } from './src/apify.js';
import { estimateCost, startPipeline, handleApifyWebhook, applyProfileData, normalizePost } from './src/pipeline.js';
import { normalizeTarget, extractContacts, scoreLead, profileUrl, normalizeHandle, normalizeFacebook } from './src/extract.js';
import * as store from './src/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// --- Auth gate (protegge tutto se APP_PASSWORD è impostata) ---
function authToken(password) {
  return createHmac('sha256', password).update('lead-finder-auth').digest('hex');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
  }
  return out;
}

app.post('/api/login', (req, res) => {
  const appPw = process.env.APP_PASSWORD;
  if (!appPw) return res.json({ ok: true });
  const { password } = req.body || {};
  if (password !== appPw) return res.status(401).json({ error: 'Password errata' });
  const token = authToken(appPw);
  res.setHeader('Set-Cookie', `lf_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.json({ ok: true });
});

app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'lf_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.redirect(303, '/login.html');
});

app.use((req, res, next) => {
  const appPw = process.env.APP_PASSWORD;
  if (!appPw) return next();
  if (req.path === '/login.html' || req.path === '/api/login') return next();
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.lf_auth === authToken(appPw)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Non autenticato' });
  res.redirect(303, '/login.html');
});

// Su Vercel ogni invocazione può essere un cold start: il DB si inizializza
// lazy al primo request. In locale il top-level await lo fa subito.
let _initDone = false;
let token = process.env.APIFY_TOKEN || '';

async function ensureInit() {
  if (_initDone) return;
  await store.initDb();
  await store.markStaleJobsAsError();
  token = (await store.getSetting('apify_key')) || process.env.APIFY_TOKEN || '';
  _initDone = true;
}

app.use(async (req, res, next) => {
  try { await ensureInit(); } catch (err) { return res.status(500).json({ error: 'DB init failed: ' + err.message }); }
  next();
});

// URL base per i webhook Apify: costruito dal VERCEL_URL o dal HOST locale.
function webhookBaseUrl(req) {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const host = req.get('host') || `localhost:${PORT}`;
  const proto = req.get('x-forwarded-proto') || 'http';
  return `${proto}://${host}`;
}

// Job attivi in memoria: per i vecchi flussi Telegram che usano ancora il polling.
const running = new Map();

/** Valida e normalizza il payload dal frontend. Non ci fidiamo del client. */
function parseParams(body) {
  const errors = [];

  const platform = body.platform;
  if (UNSUPPORTED[platform]) errors.push(UNSUPPORTED[platform]);
  else if (!ACTORS[platform]) errors.push(`Piattaforma non valida: ${platform}`);

  // Facebook si normalizza in URL, Instagram/TikTok in handle.
  const handles = [...new Set((body.handles ?? []).map((h) => normalizeTarget(platform, h)).filter(Boolean))];
  if (!handles.length) errors.push('Inserisci almeno un profilo di riferimento valido.');
  if (handles.length > HARD_LIMITS.maxHandles) errors.push(`Massimo ${HARD_LIMITS.maxHandles} profili per volta.`);

  const sources = (body.sources ?? []).filter((s) => ['comments', 'followers'].includes(s));
  if (!sources.length) errors.push('Seleziona almeno una fonte (commenti o follower).');

  const clamp = (v, def, max) => Math.max(1, Math.min(Number(v) || def, max));
  const defaults = { ...DEFAULT_LIMITS, ...PLATFORM_DEFAULTS[platform] };
  const limits = {
    postsPerProfile: clamp(body.limits?.postsPerProfile, defaults.postsPerProfile, HARD_LIMITS.postsPerProfile),
    commentsPerPost: clamp(body.limits?.commentsPerPost, defaults.commentsPerPost, HARD_LIMITS.commentsPerPost),
    followersPerProfile: clamp(body.limits?.followersPerProfile, defaults.followersPerProfile, HARD_LIMITS.followersPerProfile),
    maxLeads: clamp(body.limits?.maxLeads, defaults.maxLeads, HARD_LIMITS.maxLeads),
  };

  const filters = {
    onlyBusiness: !!body.filters?.onlyBusiness,
    onlyWithContact: !!body.filters?.onlyWithContact,
  };

  return { errors, params: { platform, sources, handles, limits, filters, enrich: body.enrich !== false } };
}

app.get('/api/config', async (req, res) => {
  let apify = { ok: false, error: null, username: null };

  if (!token) {
    apify.error = 'Token Apify mancante.';
  } else {
    try {
      const me = await checkToken(token);
      apify = { ok: true, username: me.username, error: null };
    } catch (err) {
      apify.error = `Token Apify non valido: ${err.message}`;
    }
  }

  res.json({ apify, limits: HARD_LIMITS, defaults: DEFAULT_LIMITS, unsupported: UNSUPPORTED, warnings: WARNINGS });
});

app.post('/api/token', async (req, res) => {
  const newToken = String(req.body?.token ?? '').trim();
  if (!newToken) return res.status(400).json({ error: 'Token vuoto.' });

  try {
    const me = await checkToken(newToken);
    token = newToken;
    await store.setSetting('apify_key', newToken);

    res.json({ ok: true, username: me.username });
  } catch (err) {
    res.status(400).json({ error: `Token non valido: ${err.message}` });
  }
});

app.post('/api/estimate', (req, res) => {
  const { errors, params } = parseParams(req.body);
  if (errors.length) return res.status(400).json({ errors });
  res.json(estimateCost(params));
});

app.post('/api/jobs', async (req, res) => {
  if (!token) return res.status(400).json({ errors: ['Inserisci la chiave API Apify prima di avviare un job.'] });

  const { errors, params } = parseParams(req.body);
  if (errors.length) return res.status(400).json({ errors });

  const jobId = randomUUID();
  await store.createJob(jobId, params);

  const whUrl = `${webhookBaseUrl(req)}/api/webhooks/apify`;

  try {
    await startPipeline(jobId, params, { token, webhookUrl: whUrl });
  } catch (err) {
    console.error(`[${jobId}] start failed:`, err);
    await store.updateJob(jobId, {
      status: 'error',
      error: err.message,
      message: `Errore: ${err.message}`,
      finished_at: new Date().toISOString(),
    });
  }

  res.status(202).json({ jobId });
});

app.get('/api/jobs', async (req, res) => res.json(await store.listJobs()));

app.get('/api/jobs/:id', async (req, res) => {
  const job = await store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job non trovato' });
  res.json({ ...job, counts: await store.countLeads(job.id) });
});

app.post('/api/jobs/:id/cancel', async (req, res) => {
  // Il cancel non funziona con webhook: il job gira su Apify, non qui.
  // Segniamo solo il job come annullato nel DB.
  const job = await store.getJob(req.params.id);
  if (!job || !['running', 'pending'].includes(job.status)) {
    return res.status(404).json({ error: 'Job non in esecuzione' });
  }
  await store.updateJob(req.params.id, {
    status: 'canceled',
    message: 'Annullato',
    finished_at: new Date().toISOString(),
  });
  res.json({ ok: true });
});

app.delete('/api/jobs/:id', async (req, res) => {
  await store.deleteJob(req.params.id);
  res.json({ ok: true });
});

// ---- Webhook Apify (pipeline a stati) ----------------------------------------

app.post('/api/webhooks/apify', async (req, res) => {
  const runId = req.body?.resource?.id;
  if (!runId) return res.status(400).json({ error: 'Missing run ID' });

  const runRecord = await store.getApifyRun(runId);
  if (!runRecord) {
    console.warn(`[webhook] Run sconosciuta: ${runId}`);
    return res.status(200).json({ ok: true, ignored: true });
  }

  // Verifica che il job non sia stato annullato/cancellato nel frattempo
  const job = await store.getJob(runRecord.job_id);
  if (!job || ['canceled', 'error', 'done'].includes(job.status)) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  res.status(200).json({ ok: true });

  const whUrl = `${webhookBaseUrl(req)}/api/webhooks/apify`;

  try {
    await handleApifyWebhook(runRecord, req.body, { token, webhookUrl: whUrl });
  } catch (err) {
    console.error(`[webhook] Errore pipeline job ${runRecord.job_id}:`, err);
    await store.updateJob(runRecord.job_id, {
      status: 'error',
      error: err.message,
      message: `Errore: ${err.message}`,
      finished_at: new Date().toISOString(),
    });
  }
});

app.get('/api/jobs/:id/leads', async (req, res) => {
  const job = await store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job non trovato' });

  res.json({
    leads: await store.getLeads(req.params.id, {
      limit: Math.min(Number(req.query.limit) || 500, 5000),
      offset: Number(req.query.offset) || 0,
      onlyWithEmail: req.query.onlyWithEmail === 'true',
    }),
    counts: await store.countLeads(req.params.id),
  });
});

app.get('/api/jobs/:id/leads/:username/posts', async (req, res) => {
  const posts = await store.getLeadPosts(req.params.id, req.params.username);
  res.json({ posts });
});

app.delete('/api/jobs/:id/leads/:username', async (req, res) => {
  await store.deleteLead(req.params.id, req.params.username);
  res.json({ ok: true });
});

app.get('/api/jobs/:id/export.csv', async (req, res) => {
  const job = await store.getJob(req.params.id);
  if (!job) return res.status(404).send('Job non trovato');

  const leads = await store.getLeads(req.params.id, { limit: 100000, onlyWithEmail: req.query.onlyWithEmail === 'true' });
  const cols = ['username', 'profile_url', 'full_name', 'email', 'phone', 'website', 'address', 'category', 'bio', 'followers', 'following', 'is_business', 'is_verified', 'score', 'source', 'source_profile'];

  // Prefisso ' sui campi che iniziano con =, +, -, @: evita che Excel li esegua come formule.
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  };

  const csv = [cols.join(','), ...leads.map((l) => cols.map((c) => esc(l[c])).join(','))].join('\r\n');

  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="lead-${req.params.id.slice(0, 8)}.csv"`);
  res.send('﻿' + csv); // BOM: senza, Excel sbaglia gli accenti
});

// ---- CRM ------------------------------------------------------------------

app.post('/api/crm/import/:id', async (req, res) => {
  const job = await store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job non trovato' });
  const result = await store.importToCrm(req.params.id);
  res.json(result);
});

app.get('/api/crm/leads', async (req, res) => {
  const leads = await store.getCrmLeads({
    limit: Math.min(Number(req.query.limit) || 500, 5000),
    offset: Number(req.query.offset) || 0,
  });
  const counts = await store.countCrmLeads();
  res.json({ leads, counts });
});

app.get('/api/crm/kpi', async (req, res) => {
  const days = Number(req.query.days) || 7;
  res.json(await store.getCrmKpi(days));
});

app.delete('/api/crm/leads/:id', async (req, res) => {
  await store.deleteCrmLead(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/crm/leads/:id', async (req, res) => {
  await store.updateCrmLead(req.params.id, req.body);
  res.json({ ok: true });
});

app.post('/api/crm/leads', async (req, res) => {
  const { platform, username, full_name, email, phone, website, notes } = req.body;
  if (!username && !full_name) return res.status(400).json({ error: 'Username o nome obbligatorio.' });
  const result = await store.addManualCrmLead({ platform, username, full_name, email, phone, website, notes });
  if (result.duplicate) return res.status(409).json({ error: 'Questo lead esiste già nel CRM.' });

  // Arricchimento automatico via Apify (token è la variabile globale del modulo)
  const p = platform || 'instagram';
  const actors = ACTORS[p];
  if (token && username && actors?.profiles) {
    try {
      const handles = p === 'facebook'
        ? [profileUrl(p, username)]
        : [username];
      const { items } = await runActor(
        actors.profiles.id,
        actors.profiles.buildInput({ handles }),
        { token, maxWaitMs: 60000 },
      );
      if (items?.length) {
        const lead = await store.getCrmLead(result.id);
        const enriched = { ...lead };
        applyProfileData(enriched, items[0], p);
        await store.updateCrmLead(result.id, {
          full_name: enriched.full_name || lead.full_name,
          bio: enriched.bio || null,
          category: enriched.category || null,
          is_business: enriched.is_business ? 1 : 0,
          is_verified: enriched.is_verified ? 1 : 0,
          is_private: enriched.is_private ? 1 : 0,
          followers: enriched.followers ?? null,
          following: enriched.following ?? null,
          posts_count: enriched.posts_count ?? null,
          email: enriched.email || lead.email || null,
          phone: enriched.phone || lead.phone || null,
          website: enriched.website || lead.website || null,
          profile_pic_url: enriched.profile_pic_url || null,
          profile_url: profileUrl(p, username),
          enriched: 1,
          score: scoreLead(enriched),
        });
      }
    } catch (err) {
      console.warn(`Arricchimento automatico fallito per ${username}: ${err.message}`);
    }
  }

  const enrichedLead = await store.getCrmLead(result.id);
  if (token && username && actors?.leadPosts && !enrichedLead.is_private) {
    try {
      const handles = p === 'facebook'
        ? [profileUrl(p, username)]
        : [username];
      const { items } = await runActor(
        actors.leadPosts.id,
        actors.leadPosts.buildInput({ handles, postsPerLead: 2 }),
        { token, maxWaitMs: 60000 },
      );
      if (items?.length) {
        const posts = items.map(item => normalizePost(item, p, username));
        await store.insertLeadPosts(`manual-${result.id}`, posts);
      }
    } catch (err) {
      console.warn(`Scraping post fallito per ${username}: ${err.message}`);
    }
  }

  const lead = await store.getCrmLead(result.id);
  res.json({ ok: true, lead });
});

app.get('/api/crm/followups', async (req, res) => {
  const defaultDays = parseInt(await store.getSetting('followup_days'), 10) || 3;
  const days = Math.max(1, parseInt(req.query.days, 10) || defaultDays);
  const now = Date.now();
  const followups = await store.getFollowups(days);
  const rows = followups.map(l => {
    const changedAt = new Date(l.status_changed_at).getTime();
    const daysWaiting = Math.floor((now - changedAt) / 86400000);
    return { ...l, days_waiting: daysWaiting };
  });
  res.json({ followups: rows, count: rows.length, days });
});

app.post('/api/crm/leads/:id/followup/dismiss', async (req, res) => {
  const lead = await store.getCrmLead(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead non trovato' });
  await store.updateCrmLead(req.params.id, { followup_dismissed_at: new Date().toISOString() });
  res.json({ ok: true });
});

app.get('/api/crm/icp', async (req, res) => {
  const raw = await store.getSetting('crm_icp');
  let icp = null;
  if (raw) { try { icp = JSON.parse(raw); } catch {} }
  res.json({ icp });
});

app.put('/api/crm/icp', async (req, res) => {
  const b = req.body || {};
  const clean = {
    description: String(b.description || '').trim().slice(0, 2000),
    age_min: b.age_min != null && b.age_min !== '' ? Math.max(13, Math.min(90, parseInt(b.age_min, 10) || 0)) : null,
    age_max: b.age_max != null && b.age_max !== '' ? Math.max(13, Math.min(90, parseInt(b.age_max, 10) || 0)) : null,
    gender: ['M', 'F', 'qualsiasi'].includes(b.gender) ? b.gender : 'qualsiasi',
    countries: String(b.countries || '').trim().slice(0, 300),
    languages: String(b.languages || '').trim().slice(0, 200),
    interests: String(b.interests || '').trim().slice(0, 500),
    professions: String(b.professions || '').trim().slice(0, 500),
    followers_min: b.followers_min != null && b.followers_min !== '' ? Math.max(0, parseInt(b.followers_min, 10) || 0) : null,
    followers_max: b.followers_max != null && b.followers_max !== '' ? Math.max(0, parseInt(b.followers_max, 10) || 0) : null,
    economic_level: String(b.economic_level || '').trim().slice(0, 100),
    business_type: ['qualsiasi', 'business', 'personale'].includes(b.business_type) ? b.business_type : 'qualsiasi',
    avoid: String(b.avoid || '').trim().slice(0, 1000),
  };
  await store.setSetting('crm_icp', JSON.stringify(clean));
  res.json({ ok: true, icp: clean });
});

app.post('/api/crm/leads/:id/analyze', async (req, res) => {
  const lead = await store.getCrmLead(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead non trovato' });

  const provider = (await store.getSetting('ai_provider')) || 'google';
  const key = await store.getSetting('ai_key');
  if (!key) return res.status(400).json({ error: 'Nessuna chiave AI configurata. Vai in Impostazioni.' });

  const profile = [
    `Username: @${lead.username}`,
    `Piattaforma: ${lead.platform}`,
    lead.full_name && `Nome: ${lead.full_name}`,
    lead.bio && `Bio: ${lead.bio}`,
    lead.category && `Categoria: ${lead.category}`,
    lead.followers != null && `Follower: ${lead.followers}`,
    lead.following != null && `Following: ${lead.following}`,
    lead.posts_count != null && `Post: ${lead.posts_count}`,
    lead.is_business ? 'Tipo: Pagina business' : 'Tipo: Profilo personale',
    lead.is_verified ? 'Verificato: Sì' : null,
    lead.email && `Email: ${lead.email}`,
    lead.website && `Sito web: ${lead.website}`,
    lead.address && `Indirizzo: ${lead.address}`,
    lead.source && `Fonte: ${lead.source}`,
    lead.source_profile && `Profilo fonte: ${lead.source_profile}`,
  ].filter(Boolean).join('\n');

  let imageB64 = null;
  let imageMime = 'image/jpeg';
  if (lead.profile_pic_url) {
    try {
      const imgRes = await fetch(lead.profile_pic_url, { signal: AbortSignal.timeout(8000) });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        imageB64 = buf.toString('base64');
        imageMime = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
      }
    } catch {}
  }

  const postCaptions = [];
  const postLocations = [];
  const postHashtags = new Set();
  if (!lead.is_private) {
    const posts = await store.getLeadPostsByUsername(lead.platform, lead.username, 6);
    for (const p of posts) {
      if (p.caption) postCaptions.push(p.caption.substring(0, 150));
      if (p.location) postLocations.push(p.location);
      if (p.hashtags?.length) p.hashtags.forEach(h => postHashtags.add(h));
    }
  }

  const photoNote = imageB64
    ? '\n\nHai anche la foto profilo allegata. Analizzala per dedurre: sesso, aspetto professionale vs personale, eventuali loghi o brand visibili. Per l\'età usala solo come ultimo indizio e con range ampio (vedi procedura ETÀ). Includi le osservazioni nel campo "photo_analysis".'
    : '';
  const postData = [];
  if (postCaptions.length) postData.push(`Caption dei post recenti:\n${postCaptions.map((c, i) => `${i + 1}. "${c}"`).join('\n')}`);
  if (postLocations.length) postData.push(`Luoghi taggati: ${[...new Set(postLocations)].join(', ')}`);
  if (postHashtags.size) postData.push(`Hashtag usati: #${[...postHashtags].slice(0, 15).join(' #')}`);
  const postsNote = postData.length
    ? `\n\nDATI DEI POST RECENTI (profilo pubblico):\n${postData.join('\n')}\n\nAnalizza caption, luoghi e hashtag per dedurre: interessi, stile di vita, professione, città, livello economico. IMPORTANTE: identifica la LINGUA delle caption — se sono in italiano la persona è probabilmente italiana, se in spagnolo probabilmente spagnola/sudamericana, se in francese probabilmente francese, ecc. Usa la lingua delle caption per compilare i campi "country" e "language". Includi le osservazioni nel campo "posts_analysis".`
    : '';

  // L'anno corrente va passato al modello: senza, calcola l'età sull'anno
  // del proprio knowledge cutoff e sbaglia sistematicamente di 1-2 anni.
  const nowDate = new Date();
  const currentYear = nowDate.getFullYear();
  const todayStr = nowDate.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });

  let icp = null;
  try { const raw = await store.getSetting('crm_icp'); if (raw) icp = JSON.parse(raw); } catch {}
  let icpBlock = '';
  if (icp && (icp.description || icp.age_min || icp.age_max || icp.countries || icp.languages || icp.interests || icp.professions || icp.followers_min || icp.followers_max || icp.economic_level || (icp.gender && icp.gender !== 'qualsiasi') || (icp.business_type && icp.business_type !== 'qualsiasi') || icp.avoid)) {
    const rows = [];
    if (icp.description) rows.push(`Descrizione: ${icp.description}`);
    if (icp.age_min || icp.age_max) rows.push(`Età target: ${icp.age_min ?? '?'}-${icp.age_max ?? '?'}`);
    if (icp.gender && icp.gender !== 'qualsiasi') rows.push(`Sesso: ${icp.gender}`);
    if (icp.countries) rows.push(`Paesi/città: ${icp.countries}`);
    if (icp.languages) rows.push(`Lingue: ${icp.languages}`);
    if (icp.interests) rows.push(`Interessi: ${icp.interests}`);
    if (icp.professions) rows.push(`Professioni: ${icp.professions}`);
    if (icp.followers_min || icp.followers_max) rows.push(`Follower: ${icp.followers_min ?? 0}-${icp.followers_max ?? '∞'}`);
    if (icp.economic_level) rows.push(`Livello economico: ${icp.economic_level}`);
    if (icp.business_type && icp.business_type !== 'qualsiasi') rows.push(`Tipo account: ${icp.business_type}`);
    if (icp.avoid) rows.push(`DA EVITARE: ${icp.avoid}`);
    icpBlock = `\n\n━━━ PROFILO CLIENTE IDEALE (ICP) ━━━\nL'utente ha definito il suo cliente ideale così:\n${rows.join('\n')}\n\nIl tuo compito è valutare quanto questo lead COMBACIA con questo ICP. Calcola un campo "match_score" 0-100 che riflette il fit con l'ICP (100 = perfect match, 0 = totalmente fuori target). Il campo "score" finale DEVE pesare sia la qualità intrinseca del profilo che il match con l'ICP: circa 60% match_score + 40% qualità. In "score_motivation.positives" cita esplicitamente gli elementi che combaciano con l'ICP; in "score_motivation.negatives" cita quelli che divergono. Se il lead rientra nelle caratteristiche "DA EVITARE", il match_score deve essere ≤20 e la priority "bassa".`;
  }

  const prompt = `Sei un analista di lead generation per un software enterprise. Produci un Lead Intelligence Report completo e strutturato.

DATI DEL PROFILO:
${profile}${photoNote}${postsNote}${icpBlock}

ISTRUZIONI: Analizza TUTTI i dati. Deduci il massimo possibile.

━━━ ETÀ (segui ESATTAMENTE questa procedura) ━━━
OGGI È IL ${todayStr}. L'ANNO CORRENTE È ${currentYear}. Usa SEMPRE ${currentYear} per calcolare l'età, mai un altro anno.

Valuta i segnali in questo ordine di affidabilità. Fermati al primo che trovi:

1. ETÀ DICHIARATA nella bio ("24 anni", "24yo", "age 24", "24 y/o") → usala, range stretto (es. "23-25").
2. ANNO DI NASCITA A 4 CIFRE (bio o username: "1998", "born 1998", "est. 1998") → età = ${currentYear} − anno. Range ±1 (es. anno 1998 → ${currentYear}-1998=${currentYear - 1998} → "${currentYear - 1998 - 1}-${currentYear - 1998 + 1}").
3. DATA DI NASCITA / COMPLEANNO nella bio ("12.03.98", "3 marzo 1998") → come sopra.
4. ANNO A 2 CIFRE plausibile → '00-'12 = 20xx, '60-'99 = 19xx. Età = ${currentYear} − anno. Range ±2.
   ATTENZIONE: applica questa regola SOLO se il numero è verosimilmente un anno di nascita. NON è un anno di nascita se:
   - dà un'età < 13 o > 75 (es. "20" → 20${''}20 → età ${currentYear - 2020}: impossibile, scarta)
   - è un numero-meme o ricorrente: 69, 420, 666, 007, 100, 99, 88, 13, 21
   - è un numero di maglia sportiva, un civico, un prefisso o un suffisso anti-duplicato (es. "mario.rossi01", "_02")
   - il profilo contiene un altro segnale d'età che lo contraddice
   In caso di dubbio NON usarlo: passa al punto 5.
5. SCUOLA O UNIVERSITÀ — se trovi QUALSIASI riferimento a un percorso di studi, DEVI compilare l'età. Non lasciare mai null in questo caso.

   Dove cercare: bio, nome della scuola/ateneo, email istituzionale (.edu/.ac/studenti.*), caption su esami/lezioni/tesi/sessione/laurea, hashtag (#maturita #matricola #studentlife #universita), foto in aula/toga/festa di laurea, "studente/studentessa presso...".

   5a. CON ANNO DI DIPLOMA O LAUREA (il più preciso, preferiscilo):
       - Maturità / Diploma / "Class of" ANNO → aveva ~19 anni → età = ${currentYear} − ANNO + 19. Range ±2.
         (es. "Class of 2016" → ${currentYear} − 2016 + 19 = ${currentYear - 2016 + 19} → "${currentYear - 2016 + 17}-${currentYear - 2016 + 21}")
       - Laurea triennale ANNO → aveva ~22 anni → età = ${currentYear} − ANNO + 22. Range ±2.
       - Laurea magistrale ANNO → aveva ~25 anni → età = ${currentYear} − ANNO + 25. Range ±2.
       - Se l'anno è FUTURO (es. "Class of ${currentYear + 2}") sta ancora studiando: la formula resta valida e dà un'età minore.

   5b. SENZA ANNO, solo il livello di studi in corso → usa direttamente questo range:
       - scuola media / middle school → "13-15" (13 è l'età minima per un account social)
       - liceo / superiori / high school / istituto tecnico / ITIS → "15-19"
       - matricola / primo anno / freshman → "18-21"
       - università / college / studente universitario / uni (generico) → "19-24"
       - triennale / bachelor / BSc → "19-23"
       - laureando / tesista → "21-25"
       - magistrale / master / MSc / MBA → "22-27"
       - Erasmus → "20-24"
       - neolaureato / fresh graduate → "22-26"
       - dottorato / PhD / assegnista / specializzando → "26-32"

   5c. Se ci sono più segnali usa il più specifico; se si contraddicono (es. "liceo" e "PhD") usa il più avanzato, perché indica il presente.
   5d. Un riferimento a una scuola dove la persona LAVORA (prof, docente, ricercatore, staff) NON è un indizio da studente: ignora questa regola e passa al punto 6.

6. ALTRI INDIZI DI CONTESTO (usa più segnali insieme, mai uno solo):
   - fase di vita: primo lavoro / carriera avviata / genitore di figli piccoli / nonno
   - riferimenti generazionali, slang, piattaforme d'esordio
   → range di 4-5 anni (es. "26-30").
7. SOLO FOTO, nessun altro indizio → range di 5-6 anni (es. "27-32"), centrato sulla tua stima migliore. La foto è poco affidabile: tienilo come range più largo degli altri, ma non superare i 6 anni.
8. NESSUN INDIZIO → "estimated_age": null.

REGOLE FINALI SULL'ETÀ:
- Il range non deve MAI superare i 6 anni di ampiezza. Se non riesci a stare entro 6 anni, restituisci null invece di un range vago.
- MEGLIO null CHE UN NUMERO INVENTATO. Non dedurre l'età da follower, nicchia, qualità dei contenuti o professione: non sono indicatori d'età.
- Non contraddirti: l'età deve essere coerente con la fase di vita descritta.
- Compila SEMPRE "age_basis" citando testualmente l'indizio usato (es. "username contiene '98'", "bio: 'Maturità 2016'", "bio: 'studentessa di Medicina'", "solo stima da foto", "nessun indizio") e "age_confidence" 0-100:
  >80 = età o anno di nascita dichiarati esplicitamente
  60-80 = anno di diploma/laurea (punto 5a)
  50-70 = livello di studi senza anno (punto 5b)
  <40 = stima da sola foto

- Sesso: da nome, foto, pronomi.
- Paese: se nella bio c'è una città (es. Milano, Roma, Napoli, London, Paris, Barcelona...) il campo "country" DEVE essere "NomeCittà, CodicePaese" (es. "Milano, IT", "London, UK", "Paris, FR", "Barcelona, ES"). Se non c'è città ma c'è una lingua nelle caption, deduci il paese dalla lingua.
- Lingua: lingua delle caption o della bio.
- Score 0-100 come lead commerciale. Grade: S(90-100) A(75-89) B(55-74) C(35-54) D(0-34).
- Breakdown: valuta 10 dimensioni ciascuna 0-100.
- Probabilità: stima risposta e conversione realisticamente.

RISPONDI SOLO JSON VALIDO (no markdown no backtick):

{
  "estimated_age":"range es. '25-30' o null","age_basis":"indizio testuale usato per l'età","age_confidence":70,
  "gender":"M/F o null","country":"paese o null","city":"città o null","language":"lingua o null","profession":"professione o null","interests":"lista,virgola o null","economic_level":"basso/medio/medio-alto/alto/luxury o null",
  "score":75,
  "match_score":70,
  "grade":"B",
  "conversion_probability":43,
  "response_probability":78,
  "priority":"alta/media/bassa",
  "confidence":85,
  "breakdown":{"profile_quality":80,"professionalism":70,"completeness":65,"brand_fit":75,"commercial_potential":80,"reliability":85,"engagement":60,"bio_quality":70,"niche":75,"credibility":80},
  "summary":"2-3 righe: perché questo lead è o non è interessante",
  "strengths":["max 6 punti di forza brevi"],
  "weaknesses":["max 6 criticità brevi"],
  "why_interesting":"3-4 frasi: perché contattare questo lead",
  "contact_strategy":{"approach":"come approcciare","tone":"tono","opening_topic":"argomento iniziale","errors_to_avoid":"errori da evitare"},
  "compatible_brands":["max 6 brand/aziende compatibili con questo profilo"],
  "score_motivation":{"positives":["motivi score alto"],"negatives":["motivi score basso"]}
}`;

  try {
    let reply = '';

    const hasVision = !!imageB64;
    const maxTok = 3000;

    if (provider === 'openrouter') {
      const content = [];
      if (imageB64) content.push({ type: 'image_url', image_url: { url: `data:${imageMime};base64,${imageB64}` } });
      content.push({ type: 'text', text: prompt });
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: hasVision ? 'nvidia/nemotron-nano-12b-v2-vl:free' : 'nvidia/nemotron-3-ultra-550b-a55b:free',
          messages: [{ role: 'user', content: hasVision ? content : prompt }],
          max_tokens: maxTok,
        }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${r.status}`); }
      const data = await r.json();
      reply = data.choices?.[0]?.message?.content || '';
    } else if (provider === 'google') {
      const parts = [];
      if (imageB64) parts.push({ inline_data: { mime_type: imageMime, data: imageB64 } });
      parts.push({ text: prompt });
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: maxTok } }),
        }
      );
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${r.status}`); }
      const data = await r.json();
      reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (provider === 'openai') {
      const content = [];
      if (imageB64) content.push({ type: 'image_url', image_url: { url: `data:${imageMime};base64,${imageB64}` } });
      content.push({ type: 'text', text: prompt });
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content }], max_tokens: maxTok }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${r.status}`); }
      const data = await r.json();
      reply = data.choices?.[0]?.message?.content || '';
    } else if (provider === 'anthropic') {
      const content = [];
      if (imageB64) content.push({ type: 'image', source: { type: 'base64', media_type: imageMime, data: imageB64 } });
      content.push({ type: 'text', text: prompt });
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTok, messages: [{ role: 'user', content }] }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${r.status}`); }
      const data = await r.json();
      reply = data.content?.[0]?.text || '';
    } else {
      return res.status(400).json({ error: `Provider "${provider}" non supportato.` });
    }

    reply = reply.trim();
    reply = reply.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (reply.startsWith('{') && !reply.endsWith('}')) {
      const lastBrace = reply.lastIndexOf('}');
      if (lastBrace > 0) reply = reply.substring(0, lastBrace + 1);
    }

    let parsed;
    try { parsed = JSON.parse(reply); } catch { parsed = null; }

    const update = {};
    if (parsed) {
      update.ai_analysis = JSON.stringify(parsed);
      const fields = ['estimated_age', 'gender', 'country', 'city', 'language', 'profession', 'interests', 'economic_level'];
      for (const f of fields) {
        if (parsed[f] != null && parsed[f] !== 'null' && parsed[f] !== '') {
          update[f] = String(parsed[f]);
        }
      }
      // Scarta età implausibili o range troppo vaghi: meglio vuoto che sbagliato.
      if (update.estimated_age) {
        const nums = update.estimated_age.match(/\d{1,3}/g)?.map(Number) ?? [];
        const ok = nums.length > 0 && nums.every(n => n >= 13 && n <= 90)
          && (nums.length < 2 || (nums[1] >= nums[0] && nums[1] - nums[0] <= 6));
        if (!ok) delete update.estimated_age;
      }
      if (parsed.score != null) {
        const s = parseInt(parsed.score, 10);
        if (!isNaN(s)) update.score = Math.max(0, Math.min(100, s));
      }
      if (parsed.priority) {
        const statusMap = { alta: 'da contattare', media: 'nuovo', bassa: 'scartato' };
        if (statusMap[parsed.priority]) update.status = statusMap[parsed.priority];
      }
    } else {
      update.ai_analysis = reply;
    }

    await store.updateCrmLead(req.params.id, update);
    res.json({ ok: true, analysis: update.ai_analysis, fields: update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/crm/export.csv', async (req, res) => {
  const leads = await store.getCrmLeads({ limit: 100000 });
  const cols = ['username', 'platform', 'profile_url', 'full_name', 'email', 'phone', 'website', 'address', 'category', 'bio', 'followers', 'is_business', 'is_verified', 'source', 'source_profile', 'added_at', 'notes'];
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  };
  const csv = [cols.join(','), ...leads.map((l) => cols.map((c) => esc(l[c])).join(','))].join('\r\n');
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="crm-leads.csv"');
  res.send('﻿' + csv);
});

// ---- Profili ----------------------------------------------------------------

app.get('/api/profiles', async (req, res) => {
  const profiles = await store.listProfiles();
  const usage = await store.getProfileStats();
  res.json({ profiles, usage });
});

app.post('/api/profiles', async (req, res) => {
  const { platform, username, profile_url, notes } = req.body;
  if (!platform || !username) return res.status(400).json({ error: 'Platform e username obbligatori.' });
  await store.addProfile(platform, username, profile_url, notes);
  res.json({ ok: true });
});

app.patch('/api/profiles/:id', async (req, res) => {
  await store.updateProfile(req.params.id, req.body);
  res.json({ ok: true });
});

app.delete('/api/profiles/:id', async (req, res) => {
  await store.deleteProfile(req.params.id);
  res.json({ ok: true });
});

// ---- Settings ---------------------------------------------------------------

app.get('/api/settings', async (req, res) => {
  const all = await store.getAllSettings();
  const masked = { ...all };
  if (masked.apify_key) masked.apify_key = mask(masked.apify_key);
  if (masked.ai_key) masked.ai_key = mask(masked.ai_key);
  res.json(masked);
});

app.patch('/api/settings', async (req, res) => {
  const allowed = ['apify_key', 'ai_provider', 'ai_key', 'followup_days'];
  const keys = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!keys.length) return res.status(400).json({ error: 'Nessun campo valido.' });
  for (const k of keys) await store.setSetting(k, req.body[k] ?? null);

  if (req.body.apify_key !== undefined) {
    token = String(req.body.apify_key ?? '').trim();
  }

  res.json({ ok: true });
});

function mask(s) {
  if (!s || s.length < 8) return '••••••••';
  return s.slice(0, 4) + '•'.repeat(Math.max(s.length - 8, 4)) + s.slice(-4);
}

// ---- Test AI Key ------------------------------------------------------------

app.post('/api/settings/test-ai', async (req, res) => {
  const provider = (await store.getSetting('ai_provider')) || 'google';
  const key = await store.getSetting('ai_key');
  if (!key) return res.status(400).json({ error: 'Nessuna chiave AI salvata.' });

  try {
    if (provider === 'google') {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Rispondi solo "ok".' }] }],
            generationConfig: { maxOutputTokens: 10 },
          }),
        }
      );
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${r.status}`);
      }
      const data = await r.json();
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      res.json({ ok: true, provider: 'Google Gemini', reply: reply.trim() });
    } else if (provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Rispondi solo "ok".' }],
          max_tokens: 10,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${r.status}`);
      }
      const data = await r.json();
      const reply = data.choices?.[0]?.message?.content || '';
      res.json({ ok: true, provider: 'OpenAI', reply: reply.trim() });
    } else if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Rispondi solo "ok".' }],
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${r.status}`);
      }
      const data = await r.json();
      const reply = data.content?.[0]?.text || '';
      res.json({ ok: true, provider: 'Anthropic', reply: reply.trim() });
    } else if (provider === 'openrouter') {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
          messages: [{ role: 'user', content: 'Rispondi solo "ok".' }],
          max_tokens: 10,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${r.status}`);
      }
      const data = await r.json();
      const reply = data.choices?.[0]?.message?.content || '';
      res.json({ ok: true, provider: 'OpenRouter', reply: reply.trim() });
    } else {
      res.status(400).json({ error: `Provider "${provider}" non supportato.` });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Analytics --------------------------------------------------------------

app.get('/api/analytics', async (req, res) => {
  const days = Number(req.query.days) || 30;
  const platform = req.query.platform || null;
  const from = req.query.from || undefined;
  const to = req.query.to || undefined;
  res.json(await store.getAnalytics(days, platform, { from, to }));
});

// ---- Telegram extraction -------------------------------------------------------

const telegramJobs = new Map();

async function tgJobUpdate(jobId, fields) {
  const j = telegramJobs.get(jobId);
  if (!j) return;
  Object.assign(j, fields);
  await store.updateJob(jobId, {
    status: j.status === 'done' ? 'done' : j.status === 'error' ? 'error' : 'running',
    progress: j.progress,
    message: j.message,
    ...(j.status === 'error' ? { error: j.error } : {}),
    ...(j.status === 'done' ? { finished_at: new Date().toISOString(), stats: { members: j.members.length } } : {}),
  });
}

function normalizeMembersFromItems(items) {
  const seen = new Set();
  const members = [];
  for (const item of (items ?? [])) {
    if (item.is_deleted || item.is_scam || item.is_fake || item.entity_type === 'bot') continue;
    const username = item.usernames?.[0] ?? null;
    const fullName = [item.first_name, item.last_name].filter(Boolean).join(' ').trim();
    const telegramId = item.user_id != null ? String(item.user_id) : null;
    const key = telegramId ?? username ?? fullName;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    members.push({
      username, full_name: fullName || null, phone: item.phone_number ?? null,
      telegram_id: telegramId, is_premium: !!item.is_premium,
      is_verified: !!item.is_verified, last_seen: item.last_seen ?? null,
    });
  }
  return members;
}

function normalizeSendersFromMessages(items) {
  const senderMap = new Map();
  for (const item of (items ?? [])) {
    if (item.type === 'Service' || !item.sender) continue;
    const sender = item.sender.trim();
    if (!sender) continue;
    const isUsername = sender.startsWith('@');
    const key = isUsername ? sender.toLowerCase() : sender;
    if (!senderMap.has(key)) {
      senderMap.set(key, {
        username: isUsername ? sender.slice(1) : null,
        display_name: isUsername ? null : sender,
        sender_id: !isUsername && /^\d+$/.test(sender) ? sender : null,
        message_count: 0, last_message_date: null,
      });
    }
    const entry = senderMap.get(key);
    entry.message_count++;
    if (item.date && (!entry.last_message_date || item.date > entry.last_message_date)) {
      entry.last_message_date = item.date;
    }
  }
  return [...senderMap.values()]
    .sort((a, b) => b.message_count - a.message_count)
    .map(m => ({
      username: m.username,
      full_name: m.display_name || (m.username ? `@${m.username}` : m.sender_id),
      phone: null, telegram_id: m.sender_id, is_premium: false,
      is_verified: false, last_seen: m.last_message_date, message_count: m.message_count,
    }));
}

app.post('/api/telegram/extract', async (req, res) => {
  if (!token) return res.status(400).json({ error: 'Token Apify mancante.' });
  const groupUrl = String(req.body?.groupUrl ?? '').trim();
  if (!groupUrl) return res.status(400).json({ error: 'Gruppo Telegram obbligatorio.' });

  const maxResults = Math.max(100, Math.min(Number(req.body?.maxResults) || 500, 10000));
  const deepSearch = !!req.body?.deepSearch;
  const jobId = randomUUID();

  await store.createJob(jobId, { type: 'telegram', mode: 'members', groupUrl, maxResults, deepSearch });
  telegramJobs.set(jobId, { status: 'running', progress: 5, message: 'Avvio actor Apify...', members: [], error: null });

  (async () => {
    try {
      const input = TELEGRAM_ACTOR.buildInput({ groupUrl, maxResults, deepSearch });
      const { items } = await runActor(TELEGRAM_ACTOR.id, input, {
        token, maxWaitMs: 15 * 60 * 1000,
        onProgress: ({ status }) => {
          const j = telegramJobs.get(jobId);
          if (!j) return;
          if (j.progress < 85) j.progress = Math.min(85, j.progress + 4);
          j.message = status === 'RUNNING' ? 'Estrazione membri in corso...' : `Stato actor: ${status}`;
        },
      });
      const members = normalizeMembersFromItems(items);
      await tgJobUpdate(jobId, { status: 'done', progress: 100, message: 'Completato', members });
    } catch (err) {
      await tgJobUpdate(jobId, { status: 'error', error: err.message });
    }
  })();

  res.status(202).json({ jobId });
});

app.post('/api/telegram/extract-messages', async (req, res) => {
  if (!token) return res.status(400).json({ error: 'Token Apify mancante.' });
  const groupUrl = String(req.body?.groupUrl ?? '').trim();
  if (!groupUrl) return res.status(400).json({ error: 'Gruppo Telegram obbligatorio.' });

  const maxResults = Math.max(50, Math.min(Number(req.body?.maxResults) || 200, 5000));
  const jobId = randomUUID();

  await store.createJob(jobId, { type: 'telegram', mode: 'messages', groupUrl, maxResults });
  telegramJobs.set(jobId, { status: 'running', progress: 5, message: 'Avvio scraping messaggi...', members: [], error: null });

  (async () => {
    try {
      const input = TELEGRAM_MESSAGES_ACTOR.buildInput({ groupUrl, maxResults });
      const { items } = await runActor(TELEGRAM_MESSAGES_ACTOR.id, input, {
        token, maxWaitMs: 15 * 60 * 1000,
        onProgress: ({ status }) => {
          const j = telegramJobs.get(jobId);
          if (!j) return;
          if (j.progress < 85) j.progress = Math.min(85, j.progress + 3);
          j.message = status === 'RUNNING' ? 'Scraping messaggi in corso...' : `Stato actor: ${status}`;
        },
      });
      const members = normalizeSendersFromMessages(items);
      await tgJobUpdate(jobId, { status: 'done', progress: 100, message: 'Completato', members });
    } catch (err) {
      await tgJobUpdate(jobId, { status: 'error', error: err.message });
    }
  })();

  res.status(202).json({ jobId });
});

app.get('/api/telegram/status/:id', (req, res) => {
  const job = telegramJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job non trovato' });
  res.json(job);
});

app.get('/api/telegram/jobs', async (req, res) => {
  const rows = (await store.listJobs(30)).filter(j => j.params?.type === 'telegram');
  res.json(rows);
});

app.delete('/api/telegram/jobs/:id', async (req, res) => {
  await store.deleteJob(req.params.id);
  telegramJobs.delete(req.params.id);
  res.json({ ok: true });
});

app.post('/api/telegram/save-crm', async (req, res) => {
  const members = req.body?.members;
  if (!Array.isArray(members) || !members.length) return res.status(400).json({ error: 'Nessun membro da salvare.' });

  let saved = 0;
  let duplicates = 0;
  for (const m of members) {
    const username = m.username ?? m.telegram_id ?? (m.full_name ?? '').toLowerCase().replace(/\s+/g, '_');
    if (!username) continue;
    const result = await store.addManualCrmLead({
      platform: 'telegram', username,
      full_name: m.full_name ?? null, phone: m.phone ?? null,
      website: m.username ? `https://t.me/${m.username}` : null,
    });
    if (result.duplicate) duplicates++;
    else saved++;
  }
  res.json({ saved, duplicates });
});

// In locale: avvia il server. Su Vercel: esporta l'app come handler serverless.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n  Lead Finder attivo su http://localhost:${PORT}`);
    if (!token) console.log('  ATTENZIONE: APIFY_TOKEN mancante — inseriscilo dalla UI.\n');
  });
}

export default app;
