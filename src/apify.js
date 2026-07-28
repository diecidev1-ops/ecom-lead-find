// Client minimale per l'API Apify. Usa la fetch nativa di Node, niente SDK.

const BASE = 'https://api.apify.com/v2';

export class ApifyError extends Error {
  constructor(message, { status, actorId, runId } = {}) {
    super(message);
    this.name = 'ApifyError';
    this.status = status;
    this.actorId = actorId;
    this.runId = runId;
  }
}

async function apiFetch(path, { token, method = 'GET', body } = {}) {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 500);
    try {
      detail = JSON.parse(text)?.error?.message ?? detail;
    } catch {
      /* il body non era JSON, teniamo il testo grezzo */
    }
    throw new ApifyError(`Apify ha risposto ${res.status}: ${detail}`, { status: res.status });
  }

  return res.json();
}

/**
 * Avvia un actor con un webhook per la notifica di completamento.
 * NON fa polling: ritorna subito con il runId. Usato dalla pipeline serverless.
 * Il webhook viene registrato atomicamente con l'avvio della run tramite query param.
 */
export async function startActorWithWebhook(actorId, input, { token, webhookUrl }) {
  const webhooks = Buffer.from(JSON.stringify([{
    eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'],
    requestUrl: webhookUrl,
  }])).toString('base64');

  const { data: run } = await apiFetch(`/acts/${actorId}/runs?webhooks=${webhooks}`, {
    token,
    method: 'POST',
    body: input,
  });

  return { runId: run.id };
}

/** Verifica che il token sia valido, restituisce lo username Apify. */
export async function checkToken(token) {
  const { data } = await apiFetch('/users/me', { token });
  return { username: data?.username, plan: data?.plan?.id ?? null };
}

/**
 * Avvia un actor, aspetta che finisca, restituisce gli item del dataset.
 * onProgress viene chiamato a ogni polling per poter aggiornare la UI.
 */
// maxWaitMs generoso: in estrazione di massa una singola run di follower puo'
// macinare decine di migliaia di record e superare abbondantemente i 20 minuti.
export async function runActor(actorId, input, { token, signal, onProgress, pollMs = 5000, maxWaitMs = 90 * 60 * 1000 } = {}) {
  const { data: run } = await apiFetch(`/acts/${actorId}/runs`, { token, method: 'POST', body: input });
  const runId = run.id;
  const startedAt = Date.now();

  while (true) {
    if (signal?.aborted) {
      // Non lasciamo run orfane a bruciare credito.
      await apiFetch(`/actor-runs/${runId}/abort`, { token, method: 'POST' }).catch(() => {});
      throw new ApifyError('Job annullato dall\'utente', { actorId, runId });
    }

    const { data: current } = await apiFetch(`/actor-runs/${runId}`, { token });
    onProgress?.({ status: current.status, runId, actorId });

    if (current.status === 'SUCCEEDED') {
      const items = await fetchDatasetItems(current.defaultDatasetId, { token });
      return { items, runId, stats: current.stats ?? {}, usage: current.usageTotalUsd ?? null };
    }

    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(current.status)) {
      throw new ApifyError(
        `L'actor ${actorId} e' terminato con stato ${current.status}. ` +
          `Dettagli: https://console.apify.com/actors/runs/${runId}`,
        { actorId, runId },
      );
    }

    if (Date.now() - startedAt > maxWaitMs) {
      await apiFetch(`/actor-runs/${runId}/abort`, { token, method: 'POST' }).catch(() => {});
      throw new ApifyError(`L'actor ${actorId} ha superato il tempo massimo di attesa`, { actorId, runId });
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Scarica tutti gli item paginando: i dataset grandi non arrivano in una botta sola. */
export async function fetchDatasetItems(datasetId, { token, pageSize = 1000 }) {
  const out = [];
  let offset = 0;

  while (true) {
    const page = await apiFetch(`/datasets/${datasetId}/items?clean=true&offset=${offset}&limit=${pageSize}`, { token });
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return out;
}
