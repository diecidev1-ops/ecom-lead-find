// Estrazione contatti dalla bio + normalizzazione + scoring dei lead.

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Numeri di telefono: volutamente conservativo. Meglio pochi numeri giusti
// che una colonna piena di date, prezzi e conteggi follower.
const PHONE_RE = /(?:\+|00)\d{1,3}[\s.-]?(?:\(?\d{1,4}\)?[\s.-]?){1,4}\d{2,4}/g;

const URL_RE = /(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s,;]*)?/gi;

// Domini che NON sono il sito del lead: sono social o aggregatori.
const NON_SITE_HOSTS = [
  'instagram.com', 'tiktok.com', 'facebook.com', 'fb.com', 'youtube.com', 'youtu.be',
  'twitter.com', 'x.com', 'threads.net', 'threads.com', 'snapchat.com', 'pinterest.com',
  'wa.me', 'api.whatsapp.com', 'whatsapp.com', 't.me', 'telegram.me',
  'linkedin.com', 'spotify.com', 'apple.com', 'amazon.com',
];

// Aggregatori di link: non sono il sito vero, ma segnalano comunque un profilo attivo.
const LINK_HUBS = ['linktr.ee', 'beacons.ai', 'bio.link', 'linkin.bio', 'lnk.bio', 'campsite.bio', 'stan.store', 'komi.io'];

// Segnali che il profilo e' un e-commerce / brand che vende.
const ECOM_SIGNALS = [
  'shop', 'store', 'negozio', 'boutique', 'brand', 'ecommerce', 'e-commerce',
  'spedizion', 'shipping', 'ordina', 'order now', 'acquista', 'buy now',
  'sconto', 'discount', 'saldi', 'collezione', 'collection', 'nuovo arrivo', 'new drop',
  'made in italy', 'handmade', 'artigian',
];

const SHOP_PLATFORM_SIGNALS = ['shopify', 'myshopify.com', 'woocommerce', 'etsy.com', 'bigcartel', 'squarespace', 'prestashop'];

/** Toglie @, URL completi e spazi: "@nike" / "instagram.com/nike/" -> "nike". */
export function normalizeHandle(raw) {
  if (!raw) return null;
  let h = String(raw).trim();

  h = h.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  h = h.replace(/^(?:instagram|tiktok|facebook)\.com\//i, '');
  h = h.split(/[?#]/)[0];
  h = h.replace(/\/+$/, '').split('/')[0];
  h = h.replace(/^@/, '').trim().toLowerCase();

  // Un handle valido non contiene spazi né caratteri strani.
  if (!/^[a-z0-9._]{1,60}$/.test(h)) return null;
  return h;
}

/**
 * Facebook identifica i profili con URL, non con handle, e ne esistono due forme:
 *   https://www.facebook.com/nomepagina         -> slug
 *   https://www.facebook.com/profile.php?id=123 -> id numerico
 * normalizeHandle() scarterebbe la seconda, quindi Facebook ha un percorso suo.
 * Restituisce { key, url } oppure null.
 */
export function normalizeFacebook(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;

  s = s.replace(/^https?:\/\//i, '').replace(/^(www|m|web)\./i, '');

  // Chi incolla solo "nomepagina" invece dell'URL completo.
  if (!/^facebook\.com\//i.test(s) && !/^fb\.com\//i.test(s)) {
    const bare = s.replace(/^@/, '');
    if (!/^[a-zA-Z0-9._-]{1,60}$/.test(bare)) return null;
    return { key: bare.toLowerCase(), url: `https://www.facebook.com/${bare}` };
  }

  s = s.replace(/^(facebook|fb)\.com\//i, '');

  // Forma profile.php?id=NNN: l'id e' l'unica identita' stabile.
  const idMatch = s.match(/^profile\.php\?id=(\d+)/i);
  if (idMatch) {
    return { key: `id:${idMatch[1]}`, url: `https://www.facebook.com/profile.php?id=${idMatch[1]}` };
  }

  // Forma con slug: via query, fragment e sottopercorsi (/posts/..., /about).
  const slug = s.split(/[?#]/)[0].replace(/\/+$/, '').split('/')[0].replace(/^@/, '');
  if (!/^[a-zA-Z0-9._-]{1,60}$/.test(slug)) return null;
  if (['pages', 'groups', 'people', 'profile.php', 'watch', 'events'].includes(slug.toLowerCase())) return null;

  return { key: slug.toLowerCase(), url: `https://www.facebook.com/${slug}` };
}

/** Normalizza un input di riferimento in base alla piattaforma. */
export function normalizeTarget(platform, raw) {
  if (platform === 'facebook') return normalizeFacebook(raw)?.url ?? null;
  return normalizeHandle(raw);
}

export function profileUrl(platform, username, fallbackUrl = null) {
  if (platform === 'tiktok') return `https://www.tiktok.com/@${username}`;
  // Su Facebook l'URL e' l'identita': lo teniamo cosi' com'e'.
  if (platform === 'facebook') return fallbackUrl ?? `https://www.facebook.com/${username}`;
  return `https://www.instagram.com/${username}/`;
}

function cleanUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function hostOf(u) {
  try {
    return new URL(cleanUrl(u)).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Estrae email / telefono / sito da bio + campi strutturati.
 * I campi strutturati (public_email, externalUrl) hanno priorita' sui regex.
 */
export function extractContacts({ bio = '', externalUrl = null, publicEmail = null, publicPhone = null }) {
  const text = String(bio ?? '');

  const emails = [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
  const email = publicEmail?.toLowerCase() ?? emails[0] ?? null;

  const phones = [...new Set(text.match(PHONE_RE) ?? [])].map((p) => p.replace(/\s+/g, ' ').trim());
  const phone = publicPhone ?? phones[0] ?? null;

  // Sito: prima il campo ufficiale, poi la bio.
  const candidates = [];
  if (externalUrl) candidates.push(externalUrl);
  for (const m of text.match(URL_RE) ?? []) {
    if (!m.includes('@')) candidates.push(m); // scarta le email pescate come URL
  }

  let website = null;
  let linkHub = null;

  for (const c of candidates) {
    const host = hostOf(c);
    if (!host) continue;
    if (LINK_HUBS.some((h) => host.endsWith(h))) {
      linkHub ??= cleanUrl(c);
      continue;
    }
    if (NON_SITE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    website = cleanUrl(c);
    break;
  }

  return { email, phone, website: website ?? linkHub, isLinkHub: !website && !!linkHub, allEmails: emails };
}

/**
 * Punteggio 0-100 per ordinare i lead. Non e' una scienza esatta:
 * serve solo a far galleggiare in cima quelli contattabili e pertinenti.
 */
export function scoreLead(lead) {
  let score = 0;
  const bio = (lead.bio ?? '').toLowerCase();
  const haystack = `${bio} ${(lead.category ?? '').toLowerCase()} ${(lead.website ?? '').toLowerCase()}`;

  if (lead.email) score += 35;
  if (lead.website && !lead.isLinkHub) score += 15;
  else if (lead.website) score += 8;
  if (lead.phone) score += 5;
  if (lead.is_business) score += 10;
  if (lead.category) score += 5;

  if (SHOP_PLATFORM_SIGNALS.some((s) => haystack.includes(s))) score += 10;
  if (ECOM_SIGNALS.some((s) => bio.includes(s))) score += 8;

  const f = lead.followers ?? 0;
  if (f >= 1000 && f <= 100_000) score += 5;

  if ((lead.source ?? '').includes('comments')) score += 5;

  return Math.max(0, Math.min(100, score));
}

/** Applica i filtri scelti dall'utente. Restituisce true se il lead passa. */
export function passesFilters(lead, filters = {}) {
  const { onlyBusiness = false, onlyWithContact = false } = filters;

  if (onlyWithContact && !lead.email && !lead.phone && !lead.website) return false;
  if (onlyBusiness && !lead.is_business) return false;

  return true;
}
