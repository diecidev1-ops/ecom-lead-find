// Pipeline a stati: ogni fase avvia actor Apify con webhook e ritorna subito.
// Quando un webhook arriva, advancePipeline() fa avanzare la macchina a stati.

import { ACTORS, HARD_LIMITS, COST_HINTS } from './config.js';
import { startActorWithWebhook, fetchDatasetItems } from './apify.js';
import { extractContacts, scoreLead, passesFilters, profileUrl, normalizeHandle, normalizeFacebook } from './extract.js';
import {
  updateJob, insertLeads, insertLeadPosts, countLeads,
  registerApifyRun, updateApifyRunStatus, countPendingRuns,
  getPipelineState, setPipelineState,
} from './store.js';

function pick(obj, ...paths) {
  for (const path of paths) {
    const val = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function effectiveLimits({ handles, limits }) {
  const n = Math.max(1, handles.length);
  const perProfile = Math.ceil(limits.maxLeads / n);
  return {
    ...limits,
    followersPerProfile: Math.max(50, Math.min(limits.followersPerProfile, perProfile)),
  };
}

export function estimateCost({ platform, sources, handles, limits: rawLimits, enrich }) {
  const limits = effectiveLimits({ handles, limits: rawLimits });
  const n = handles.length;
  let posts = 0, comments = 0, followers = 0;

  if (sources.includes('comments')) {
    posts = n * limits.postsPerProfile;
    comments = posts * limits.commentsPerPost;
  }
  if (sources.includes('followers') && ['instagram', 'facebook'].includes(platform)) {
    followers = n * limits.followersPerProfile;
  }

  const rawCandidates = Math.min(comments + followers, limits.maxLeads * 3);
  const uniqueCandidates = Math.min(Math.round(rawCandidates * 0.6), limits.maxLeads);
  const profiles = enrich ? uniqueCandidates : 0;

  const usd =
    (posts / 1000) * COST_HINTS.perThousandPosts +
    (comments / 1000) * COST_HINTS.perThousandComments +
    (followers / 1000) * COST_HINTS.perThousandFollowers +
    (profiles / 1000) * COST_HINTS.perThousandProfiles;

  return {
    units: { posts, comments, followers, profiles, uniqueCandidates },
    usd: Math.round(usd * 100) / 100,
    disclaimer:
      'Stima approssimativa basata su prezzi indicativi degli actor. Il costo reale ' +
      'dipende dai prezzi correnti su Apify e da quanti risultati trovano davvero. ' +
      'Controlla il consumo su console.apify.com.',
  };
}

function candidateFromComment(item, platform, sourceProfile) {
  if (platform === 'facebook') {
    const fb = normalizeFacebook(pick(item, 'profileUrl', 'profile.url', 'authorUrl'));
    if (!fb) return null;
    return {
      username: fb.key,
      profile_url: fb.url,
      full_name: pick(item, 'profileName', 'name', 'authorName'),
      source: 'comments',
      source_profile: sourceProfile,
    };
  }

  const username =
    platform === 'tiktok'
      ? pick(item, 'uniqueId', 'user.uniqueId', 'username', 'authorMeta.name', 'uid')
      : pick(item, 'ownerUsername', 'owner.username', 'username');

  const handle = normalizeHandle(username);
  if (!handle) return null;

  return {
    username: handle,
    full_name: pick(item, 'ownerName', 'owner.full_name', 'user.nickname', 'fullName'),
    source: 'comments',
    source_profile: sourceProfile,
  };
}

function candidateFromFollower(item, sourceProfile, platform = 'instagram') {
  if (platform === 'facebook') {
    const fb = normalizeFacebook(pick(item, 'profileUrl', 'url'));
    if (!fb) return null;
    return {
      username: fb.key,
      profile_url: fb.url,
      full_name: pick(item, 'title', 'name'),
      bio: pick(item, 'subtitle'),
      source: 'followers',
      source_profile: sourceProfile,
    };
  }

  const handle = normalizeHandle(pick(item, 'username', 'user.username'));
  if (!handle) return null;

  return {
    username: handle,
    full_name: pick(item, 'full_name', 'fullName'),
    is_verified: !!pick(item, 'is_verified', 'isVerified'),
    is_private: !!pick(item, 'is_private', 'isPrivate'),
    source: 'followers',
    source_profile: pick(item, 'username_scrape', 'followed_to') ?? sourceProfile,
  };
}

function applyFacebookPageData(lead, item) {
  const email = pick(item, 'email', 'pageEmail');
  const phone = pick(item, 'phone', 'phoneNumber', 'pagePhone');
  const website = pick(item, 'website', 'websites.0', 'pageWebsite');
  const likes = pick(item, 'likes', 'likesCount');
  const followers = pick(item, 'followers', 'followersCount');
  const categories = pick(item, 'categories', 'pageCategory', 'category');

  const bio = pick(item, 'intro', 'about', 'pageIntro', 'info.0') ?? lead.bio ?? '';
  const isPage = !!(email || likes || followers || categories || website);

  const contacts = extractContacts({ bio, externalUrl: website, publicEmail: email, publicPhone: phone });

  lead.full_name = pick(item, 'title', 'pageName', 'name') ?? lead.full_name;
  lead.bio = bio || lead.bio;
  lead.category = Array.isArray(categories) ? categories.join(', ') : categories;
  lead.is_business = isPage;
  lead.is_verified = !!pick(item, 'verified', 'isVerified', 'confirmedOwner');
  lead.followers = followers ?? likes ?? null;
  lead.email = contacts.email;
  lead.phone = contacts.phone;
  lead.website = contacts.website;
  lead.isLinkHub = contacts.isLinkHub;
  lead.address = pick(item, 'address', 'pageAddress');
  lead.profile_pic_url = pick(item, 'profilePicUrl', 'profilePic', 'profilePicture', 'logo', 'avatarUrl') ?? lead.profile_pic_url;
  lead.enriched = true;

  return lead;
}

export function applyProfileData(lead, item, platform) {
  if (platform === 'facebook') return applyFacebookPageData(lead, item);

  const bio = pick(item, 'biography', 'bio', 'signature', 'authorMeta.signature') ?? '';
  const externalUrl = pick(item, 'externalUrl', 'external_url', 'bioLink.link', 'authorMeta.bioLink');
  const publicEmail = pick(item, 'public_email', 'publicEmail', 'businessEmail', 'email');
  const publicPhone = pick(item, 'public_phone_number', 'contactPhoneNumber', 'publicPhoneNumber');

  const contacts = extractContacts({ bio, externalUrl, publicEmail, publicPhone });

  lead.full_name = pick(item, 'fullName', 'full_name', 'nickname', 'authorMeta.nickName') ?? lead.full_name;
  lead.bio = bio || lead.bio;
  lead.category = pick(item, 'businessCategoryName', 'categoryName', 'category', 'commerceCategory');
  lead.is_business = !!pick(item, 'isBusinessAccount', 'is_business_account', 'isBusiness');
  lead.is_verified = !!(pick(item, 'verified', 'isVerified', 'is_verified') ?? lead.is_verified);
  lead.is_private = !!(pick(item, 'private', 'isPrivate', 'is_private') ?? lead.is_private);
  lead.followers = pick(item, 'followersCount', 'follower_count', 'fans', 'authorMeta.fans');
  lead.following = pick(item, 'followsCount', 'following_count', 'following', 'authorMeta.following');
  lead.posts_count = pick(item, 'postsCount', 'media_count', 'videos', 'authorMeta.video');
  lead.profile_pic_url = pick(item, 'profilePicUrlHD', 'profilePicUrl', 'profile_pic_url', 'profile_pic_url_hd', 'avatarLarger', 'avatarMedium', 'avatar', 'authorMeta.avatar') ?? lead.profile_pic_url;
  lead.email = contacts.email;
  lead.phone = contacts.phone;
  lead.website = contacts.website;
  lead.isLinkHub = contacts.isLinkHub;
  lead.enriched = true;

  return lead;
}

export function normalizePost(item, platform, username) {
  const caption = pick(item, 'caption', 'text', 'description', 'body') ?? '';

  let hashtags = pick(item, 'hashtags');
  if (!hashtags || !Array.isArray(hashtags)) {
    hashtags = [...(caption.matchAll(/#([a-zA-Z0-9_À-ɏ]+)/g))].map((m) => m[1]);
  }

  const location = pick(item, 'locationName', 'location.name', 'location', 'locationLabel', 'place');
  const locStr = typeof location === 'object' ? pick(location, 'name', 'city') : location;

  const images = [];
  const displayUrl = pick(item, 'displayUrl', 'imageUrl', 'thumbnailUrl', 'coverImageUrl');
  if (displayUrl) images.push(displayUrl);
  const mediaList = pick(item, 'images', 'media', 'childPosts', 'videoMeta.coverUrl');
  if (Array.isArray(mediaList)) {
    for (const m of mediaList) {
      const url = typeof m === 'string' ? m : pick(m, 'url', 'displayUrl', 'photo_image.uri', 'src');
      if (url && !images.includes(url)) images.push(url);
    }
  }

  return {
    platform,
    username,
    post_url: pick(item, 'url', 'postUrl', 'shortCode', 'webVideoUrl', 'topLevelUrl') ?? null,
    caption: caption.slice(0, 5000),
    hashtags: hashtags.slice(0, 30),
    location: typeof locStr === 'string' ? locStr : null,
    image_urls: images.slice(0, 5),
    likes: pick(item, 'likesCount', 'likes', 'diggCount', 'reactionsCount') ?? null,
    comments_count: pick(item, 'commentsCount', 'comments', 'commentCount') ?? null,
    posted_at: pick(item, 'timestamp', 'date', 'postedAt', 'createTime', 'time') ?? null,
  };
}

// ---- Macchina a stati: ogni fase avvia actor e ritorna subito ----

function addCandidate(candidates, c, platform) {
  if (!c) return;
  const existing = candidates[c.username];
  if (existing) {
    if (!existing.source.includes(c.source)) existing.source += `+${c.source}`;
    if (c.source_profile && !existing.source_profile.includes(c.source_profile)) {
      existing.source_profile += `, ${c.source_profile}`;
    }
  } else {
    candidates[c.username] = { platform, ...c };
  }
}

/**
 * Avvia la pipeline: salva lo stato iniziale e lancia la prima fase.
 * Ritorna subito — il progresso avviene via webhook.
 */
export async function startPipeline(jobId, params, { token, webhookUrl }) {
  const { platform, sources, handles, filters, enrich } = params;
  const limits = effectiveLimits({ handles, limits: params.limits });
  const actors = ACTORS[platform];

  const state = {
    phase: 'init',
    platform,
    sources,
    handles,
    filters,
    enrich,
    limits,
    candidates: {},
    runIds: [],
    failedBatches: 0,
  };

  await setPipelineState(jobId, state);
  await _nextPhase(jobId, state, actors, token, webhookUrl);
}

async function _nextPhase(jobId, state, actors, token, webhookUrl) {
  const { platform, sources, handles, limits } = state;

  if (state.phase === 'init') {
    // Decide la prima sotto-fase della scoperta
    if (sources.includes('comments')) {
      if (platform === 'instagram' || platform === 'facebook') {
        state.phase = 'discovery:posts';
        await _startDiscoveryPosts(jobId, state, actors, token, webhookUrl);
      } else if (platform === 'tiktok') {
        state.phase = 'discovery:comments';
        await _startDiscoveryCommentsDirect(jobId, state, actors, token, webhookUrl);
      }
    } else if (sources.includes('followers') && ['instagram', 'facebook'].includes(platform)) {
      state.phase = 'discovery:followers';
      await _startDiscoveryFollowers(jobId, state, actors, token, webhookUrl);
    } else {
      await _failPipeline(jobId, 'Nessuna fonte valida selezionata.');
    }
    return;
  }

  if (state.phase === 'discovery:posts') {
    // Post completati → avvia commenti
    state.phase = 'discovery:comments';
    await _startDiscoveryCommentsFromPosts(jobId, state, actors, token, webhookUrl);
    return;
  }

  if (state.phase === 'discovery:comments') {
    // Commenti completati → avvia follower o passa ad arricchimento
    if (sources.includes('followers') && ['instagram', 'facebook'].includes(platform)) {
      state.phase = 'discovery:followers';
      await _startDiscoveryFollowers(jobId, state, actors, token, webhookUrl);
    } else {
      await _startEnrichmentOrFinalize(jobId, state, actors, token, webhookUrl);
    }
    return;
  }

  if (state.phase === 'discovery:followers') {
    await _startEnrichmentOrFinalize(jobId, state, actors, token, webhookUrl);
    return;
  }

  if (state.phase === 'enrichment') {
    await _startLeadPostsOrFinalize(jobId, state, actors, token, webhookUrl);
    return;
  }

  if (state.phase === 'lead_posts') {
    await _finalize(jobId, state);
    return;
  }
}

// ---- Fasi di scoperta ----

async function _startDiscoveryPosts(jobId, state, actors, token, webhookUrl) {
  await updateJob(jobId, { stage: 'post', progress: 5, message: `Cerco i post di ${state.handles.length} profili...`, status: 'running' });

  const { runId } = await startActorWithWebhook(
    actors.posts.id,
    actors.posts.buildInput({ handles: state.handles, limits: state.limits }),
    { token, webhookUrl },
  );

  state.runIds.push(runId);
  await registerApifyRun(runId, jobId, 'discovery:posts');
  await setPipelineState(jobId, state);
}

async function _startDiscoveryCommentsDirect(jobId, state, actors, token, webhookUrl) {
  await updateJob(jobId, { stage: 'commenti', progress: 15, message: `Estraggo i commenti dai video di ${state.handles.length} profili...`, status: 'running' });

  const { runId } = await startActorWithWebhook(
    actors.comments.id,
    actors.comments.buildInput({ handles: state.handles, limits: state.limits }),
    { token, webhookUrl },
  );

  state.runIds.push(runId);
  await registerApifyRun(runId, jobId, 'discovery:comments');
  await setPipelineState(jobId, state);
}

async function _startDiscoveryCommentsFromPosts(jobId, state, actors, token, webhookUrl) {
  const postUrls = state._postUrls ?? [];
  if (!postUrls.length) {
    throw new Error('Nessun post trovato per i profili indicati. Controlla che gli handle siano corretti e i profili pubblici.');
  }

  await updateJob(jobId, { stage: 'commenti', progress: 20, message: `Estraggo i commenti da ${postUrls.length} post...`, status: 'running' });

  const { runId } = await startActorWithWebhook(
    actors.comments.id,
    actors.comments.buildInput({ postUrls, limits: state.limits }),
    { token, webhookUrl },
  );

  state.runIds.push(runId);
  delete state._postUrls;
  await registerApifyRun(runId, jobId, 'discovery:comments');
  await setPipelineState(jobId, state);
}

async function _startDiscoveryFollowers(jobId, state, actors, token, webhookUrl) {
  await updateJob(jobId, { stage: 'follower', progress: 40, message: `Estraggo i follower di ${state.handles.length} profili...`, status: 'running' });

  const { runId } = await startActorWithWebhook(
    actors.followers.id,
    actors.followers.buildInput({ handles: state.handles, limits: state.limits }),
    { token, webhookUrl },
  );

  state.runIds.push(runId);
  await registerApifyRun(runId, jobId, 'discovery:followers');
  await setPipelineState(jobId, state);
}

// ---- Arricchimento ----

async function _startEnrichmentOrFinalize(jobId, state, actors, token, webhookUrl) {
  const candidateCount = Object.keys(state.candidates).length;
  if (!candidateCount) {
    await _failPipeline(jobId, 'Nessun candidato trovato. Possibili cause: profili privati o inesistenti, post senza commenti.');
    return;
  }

  const list = Object.values(state.candidates).slice(0, state.limits.maxLeads);
  state._cappedCandidates = list.map(c => c.username);
  state._discoveredCount = candidateCount;

  if (state.enrich && actors.profiles) {
    state.phase = 'enrichment';
    const batches = chunk(list, HARD_LIMITS.enrichBatchSize);
    state._enrichBatchCount = batches.length;
    state._enrichDone = 0;

    await updateJob(jobId, { stage: 'arricchimento', progress: 50, message: `Arricchisco ${list.length} profili in ${batches.length} batch...`, status: 'running' });

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const keys = state.platform === 'facebook'
        ? batch.map(b => b.profile_url)
        : batch.map(b => b.username);

      const { runId } = await startActorWithWebhook(
        actors.profiles.id,
        actors.profiles.buildInput({ handles: keys }),
        { token, webhookUrl },
      );

      state.runIds.push(runId);
      await registerApifyRun(runId, jobId, 'enrichment', i);
    }

    await setPipelineState(jobId, state);
  } else {
    await _startLeadPostsOrFinalize(jobId, state, actors, token, webhookUrl);
  }
}

async function _startLeadPostsOrFinalize(jobId, state, actors, token, webhookUrl) {
  const cappedUsernames = state._cappedCandidates ?? Object.keys(state.candidates).slice(0, state.limits.maxLeads);
  const list = cappedUsernames.map(u => state.candidates[u]).filter(Boolean);

  await updateJob(jobId, { stage: 'finalizzazione', progress: 88, message: 'Applico filtri e calcolo i punteggi...', status: 'running' });

  for (const lead of list) {
    lead.profile_url = profileUrl(state.platform, lead.username, lead.profile_url);
    lead.score = scoreLead(lead);
  }
  const filtered = list.filter(l => passesFilters(l, state.filters)).sort((a, b) => b.score - a.score);

  state._beforeFilters = list.length;
  state._discoveredCount = state._discoveredCount ?? Object.keys(state.candidates).length;

  await insertLeads(jobId, filtered);

  // Svuota candidati dallo state: sono nel DB ormai
  state.candidates = {};
  state._cappedCandidates = undefined;

  if (state.enrich && actors.leadPosts && filtered.length > 0) {
    state.phase = 'lead_posts';
    const batches = chunk(filtered, HARD_LIMITS.leadPostBatchSize);
    state._postBatchCount = batches.length;
    state._postBatchDone = 0;
    state._postsScraped = 0;

    await updateJob(jobId, { stage: 'post lead', progress: 90, message: `Scarico gli ultimi post di ${filtered.length} lead...`, status: 'running' });

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const keys = state.platform === 'facebook'
        ? batch.map(l => l.profile_url)
        : batch.map(l => l.username);

      const { runId } = await startActorWithWebhook(
        actors.leadPosts.id,
        actors.leadPosts.buildInput({ handles: keys, postsPerLead: HARD_LIMITS.postsPerLead }),
        { token, webhookUrl },
      );

      state.runIds.push(runId);
      await registerApifyRun(runId, jobId, 'lead_posts', i);
    }

    await setPipelineState(jobId, state);
  } else {
    await _finalize(jobId, state);
  }
}

// ---- Finalizzazione ----

async function _finalize(jobId, state) {
  const postsScraped = state._postsScraped ?? 0;
  const counts = await countLeads(jobId);

  const stats = {
    discovered: state._discoveredCount ?? Object.keys(state.candidates).length,
    afterCap: state._beforeFilters ?? counts.total,
    kept: counts.total,
    withEmail: counts.withEmail,
    withWebsite: counts.withSite,
    postsScraped,
    apifyRuns: state.runIds,
  };

  await updateJob(jobId, {
    status: 'done',
    stage: 'completato',
    progress: 100,
    message: `${counts.total} lead salvati (${counts.withEmail} con email, ${postsScraped} post)`,
    stats,
    finished_at: new Date().toISOString(),
  });

  state.phase = 'done';
  // Svuota candidati dallo state per ridurre la dimensione del JSON
  state.candidates = {};
  state._filteredList = undefined;
  state._cappedCandidates = undefined;
  await setPipelineState(jobId, state);
}

async function _failPipeline(jobId, message) {
  await updateJob(jobId, {
    status: 'error',
    error: message,
    message: `Errore: ${message}`,
    finished_at: new Date().toISOString(),
  });
}

/**
 * Gestisce un webhook Apify: processa i risultati della run completata
 * e fa avanzare la pipeline allo stato successivo.
 */
export async function handleApifyWebhook(runRecord, webhookData, { token, webhookUrl }) {
  const { job_id: jobId, stage, batch_index: batchIndex } = runRecord;
  const status = webhookData.resource?.status;
  const datasetId = webhookData.resource?.defaultDatasetId;

  if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    await updateApifyRunStatus(runRecord.run_id, 'failed');
    const state = await getPipelineState(jobId);

    // Se è un batch di arricchimento/post, un fallimento non blocca tutto
    if (stage === 'enrichment' || stage === 'lead_posts') {
      state.failedBatches = (state.failedBatches || 0) + 1;
      const stageKey = stage === 'enrichment' ? '_enrichDone' : '_postBatchDone';
      state[stageKey] = (state[stageKey] || 0) + 1;
      const totalKey = stage === 'enrichment' ? '_enrichBatchCount' : '_postBatchCount';

      if (state[stageKey] >= state[totalKey]) {
        const actors = ACTORS[state.platform];
        await setPipelineState(jobId, state);
        await _nextPhase(jobId, state, actors, token, webhookUrl);
      } else {
        await setPipelineState(jobId, state);
      }
      return;
    }

    await _failPipeline(jobId, `Actor terminato con stato ${status}. Run ID: ${runRecord.run_id}`);
    return;
  }

  if (status !== 'SUCCEEDED') return;

  await updateApifyRunStatus(runRecord.run_id, 'succeeded');
  const state = await getPipelineState(jobId);
  if (!state || state.phase === 'done') return;

  const actors = ACTORS[state.platform];
  const items = datasetId ? await fetchDatasetItems(datasetId, { token }) : [];

  // Processa i risultati in base alla fase
  if (stage === 'discovery:posts') {
    const platform = state.platform;
    const postUrls = [...new Set(
      items.map(p => {
        const url = pick(p, 'url', 'postUrl', 'shortCode', 'topLevelUrl');
        if (!url) return null;
        if (platform === 'instagram' && !url.startsWith('http')) return `https://www.instagram.com/p/${url}/`;
        return url;
      }).filter(Boolean)
    )];
    state._postUrls = postUrls;
    await setPipelineState(jobId, state);
    await _nextPhase(jobId, state, actors, token, webhookUrl);

  } else if (stage === 'discovery:comments') {
    const platform = state.platform;
    for (const c of items) {
      const sourceProfile = platform === 'tiktok'
        ? (pick(c, 'videoWebUrl', 'submittedVideoUrl') ?? 'video')
        : (pick(c, 'postUrl', 'url', 'facebookUrl') ?? 'post');
      addCandidate(state.candidates, candidateFromComment(c, platform, sourceProfile), platform);
    }
    await setPipelineState(jobId, state);
    await _nextPhase(jobId, state, actors, token, webhookUrl);

  } else if (stage === 'discovery:followers') {
    const platform = state.platform;
    const perProfile = new Map();
    for (const f of items) {
      const cand = candidateFromFollower(f, state.handles[0], platform);
      if (!cand) continue;
      const key = cand.source_profile ?? '_';
      const count = perProfile.get(key) ?? 0;
      if (count >= state.limits.followersPerProfile) continue;
      perProfile.set(key, count + 1);
      addCandidate(state.candidates, cand, platform);
    }
    await setPipelineState(jobId, state);
    await _nextPhase(jobId, state, actors, token, webhookUrl);

  } else if (stage === 'enrichment') {
    const platform = state.platform;
    for (const item of items) {
      const key = platform === 'facebook'
        ? normalizeFacebook(pick(item, 'pageUrl', 'url', 'facebookUrl'))?.key
        : normalizeHandle(pick(item, 'username', 'authorMeta.name', 'uniqueId'));
      const lead = key && state.candidates[key];
      if (lead) applyProfileData(lead, item, platform);
    }

    state._enrichDone = (state._enrichDone || 0) + 1;
    const pct = 50 + Math.round((state._enrichDone / state._enrichBatchCount) * 40);
    const failed = state.failedBatches || 0;
    await updateJob(jobId, { stage: 'arricchimento', progress: pct, message: `Arricchimento: ${state._enrichDone}/${state._enrichBatchCount} batch${failed ? ` (${failed} falliti)` : ''}...`, status: 'running' });

    if (state._enrichDone >= state._enrichBatchCount) {
      await setPipelineState(jobId, state);
      await _nextPhase(jobId, state, actors, token, webhookUrl);
    } else {
      await setPipelineState(jobId, state);
    }

  } else if (stage === 'lead_posts') {
    const platform = state.platform;
    const posts = [];
    for (const item of items) {
      let owner;
      if (platform === 'facebook') {
        owner = normalizeFacebook(pick(item, 'pageUrl', 'facebookUrl', 'url'))?.key;
      } else if (platform === 'tiktok') {
        owner = normalizeHandle(pick(item, 'authorMeta.name', 'uniqueId', 'author.uniqueId'));
      } else {
        owner = normalizeHandle(pick(item, 'ownerUsername', 'owner.username', 'username'));
      }
      if (!owner) continue;
      posts.push(normalizePost(item, platform, owner));
    }

    if (posts.length) {
      await insertLeadPosts(jobId, posts);
      state._postsScraped = (state._postsScraped || 0) + posts.length;
    }

    state._postBatchDone = (state._postBatchDone || 0) + 1;
    const pct = 90 + Math.round((state._postBatchDone / state._postBatchCount) * 8);
    const failed = state.failedBatches || 0;
    await updateJob(jobId, { stage: 'post lead', progress: pct, message: `Post lead: ${state._postBatchDone}/${state._postBatchCount} batch${failed ? ` (${failed} falliti)` : ''}...`, status: 'running' });

    if (state._postBatchDone >= state._postBatchCount) {
      await setPipelineState(jobId, state);
      await _nextPhase(jobId, state, actors, token, webhookUrl);
    } else {
      await setPipelineState(jobId, state);
    }
  }
}
