// Configurazione degli actor Apify usati dalla pipeline.
//
// Gli ID e gli schemi di input qui sotto sono stati verificati sullo store Apify.
// Se un actor cambia schema o smette di funzionare, si cambia SOLO questo file:
// il resto della pipeline lavora su un formato normalizzato interno.

export const ACTORS = {
  instagram: {
    // apify/instagram-post-scraper -> serve a trovare i post di un profilo,
    // da cui poi peschiamo i commenti.
    posts: {
      id: 'apify~instagram-post-scraper',
      buildInput: ({ handles, limits }) => ({
        username: handles,
        resultsLimit: limits.postsPerProfile,
        skipPinnedPosts: false,
        dataDetailLevel: 'basicData',
      }),
    },
    // apify/instagram-comment-scraper (ufficiale Apify)
    comments: {
      id: 'apify~instagram-comment-scraper',
      buildInput: ({ postUrls, limits }) => ({
        directUrls: postUrls,
        resultsLimit: limits.commentsPerPost,
      }),
    },
    followers: {
      id: 'coderx~instagram-followers-following-scraper-no-cookies-login',
      buildInput: ({ handles, limits }) => ({
        username: handles[0],
        scrape_type: 'followers',
        max_items: Math.max(50, limits.followersPerProfile),
      }),
    },
    // apify/instagram-profile-scraper -> arricchimento (bio, categoria, contatti)
    profiles: {
      id: 'apify~instagram-profile-scraper',
      buildInput: ({ handles }) => ({
        usernames: handles,
        includeAboutSection: false,
      }),
    },
    leadPosts: {
      id: 'apify~instagram-post-scraper',
      buildInput: ({ handles, postsPerLead }) => ({
        username: handles,
        resultsLimit: postsPerLead,
        skipPinnedPosts: true,
        dataDetailLevel: 'detailedData',
      }),
    },
  },

  // Facebook usa gli URL come identificativi, non gli handle, e tutti gli actor
  // vogliono startUrls come array di OGGETTI {url}, non di stringhe.
  facebook: {
    posts: {
      id: 'apify~facebook-posts-scraper',
      buildInput: ({ handles, limits }) => ({
        startUrls: handles.map((url) => ({ url })),
        resultsLimit: limits.postsPerProfile,
        captionText: false,
      }),
    },
    comments: {
      id: 'apify~facebook-comments-scraper',
      buildInput: ({ postUrls, limits }) => ({
        startUrls: postUrls.map((url) => ({ url })),
        resultsLimit: limits.commentsPerPost,
        includeNestedComments: false,
        viewOption: 'RANKED_UNFILTERED',
      }),
    },
    followers: {
      id: 'apify~facebook-followers-following-scraper',
      buildInput: ({ handles, limits }) => ({
        startUrls: handles.map((url) => ({ url })),
        resultsLimit: limits.followersPerProfile,
        followType: 'follower',
      }),
    },
    // Arricchimento: funziona a pieno solo sulle PAGINE (email, telefono, sito,
    // indirizzo). Sui profili personali restituisce pochissimo — ed e' proprio
    // questo che ci permette di separare le aziende dalle persone.
    profiles: {
      id: 'apify~facebook-pages-scraper',
      buildInput: ({ handles }) => ({
        startUrls: handles.map((url) => ({ url })),
      }),
    },
    leadPosts: {
      id: 'apify~facebook-posts-scraper',
      buildInput: ({ handles, postsPerLead }) => ({
        startUrls: handles.map((url) => ({ url })),
        resultsLimit: postsPerLead,
      }),
    },
  },

  tiktok: {
    // clockworks/tiktok-comments-scraper accetta i profili direttamente:
    // niente step separato per trovare i video.
    comments: {
      id: 'clockworks~tiktok-comments-scraper',
      buildInput: ({ handles, limits }) => ({
        profiles: handles,
        resultsPerPage: limits.postsPerProfile,
        commentsPerPost: limits.commentsPerPost,
        maxRepliesPerComment: 0,
        profileScrapeSections: ['videos'],
        profileSorting: 'latest',
        excludePinnedPosts: false,
      }),
    },
    profiles: {
      id: 'clockworks~tiktok-profile-scraper',
      buildInput: ({ handles }) => ({
        profiles: handles,
        resultsPerPage: 1,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
      }),
    },
    leadPosts: {
      id: 'clockworks~tiktok-profile-scraper',
      buildInput: ({ handles, postsPerLead }) => ({
        profiles: handles,
        resultsPerPage: postsPerLead,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
      }),
    },
  },
};

// agentx/telegram-member-scraper: estrae la lista membri di un gruppo/canale.
// Accetta link t.me, @username o username nudo, quindi non serve normalizzare.
export const TELEGRAM_ACTOR = {
  id: 'agentx~telegram-member-scraper',
  buildInput: ({ groupUrl, maxResults, deepSearch }) => ({
    telegram_url: groupUrl,
    max_results: maxResults,
    deep_search: !!deepSearch,
  }),
};

// truefetch/telegram-channel-message: scrapa i messaggi di un gruppo/canale pubblico.
// Restituisce per ogni messaggio un campo "sender" (@username o ID numerico).
// Lo usiamo per ricavare lead dagli autori dei messaggi.
// NOTA: su piano Apify FREE restituisce max 10 messaggi. Piani a pagamento illimitati.
export const TELEGRAM_MESSAGES_ACTOR = {
  id: 'truefetch~telegram-channel-message',
  buildInput: ({ groupUrl, maxResults }) => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return {
      telegram_url: groupUrl,
      max_results: maxResults,
      download_medias: 'text',
      start_date: thirtyDaysAgo,
    };
  },
};

// Piattaforme non supportate, con il motivo. Meglio dirlo che fingere.
export const UNSUPPORTED = {};

// Avvertenze mostrate nella UI: la fonte funziona, ma la resa e' bassa.
// Servono a far capire cosa aspettarsi PRIMA di spendere.
export const WARNINGS = {
  facebook:
    'Su Facebook chi commenta o segue una pagina sono quasi sempre profili PERSONALI, ' +
    'che non espongono email ne\' sito: otterrai soprattutto nome e link. ' +
    'I contatti completi arrivano solo dai candidati che sono a loro volta PAGINE business ' +
    '(pochi, ma li trovi in cima alla lista grazie al punteggio). ' +
    'Se cerchi negozi da contattare, la ricerca per settore+zona renderebbe molto di piu\'.',
};

export const SOURCE_LABELS = {
  comments: 'Chi commenta',
  followers: 'Follower',
};

// Limiti di sicurezza: servono a non far esplodere la bolletta Apify per errore.
// Tarati per l'estrazione di massa; "maxLeads" e' la vera leva di spesa (vedi sotto).
export const HARD_LIMITS = {
  maxHandles: 25,
  postsPerProfile: 100,
  commentsPerPost: 500,
  followersPerProfile: 30000,
  maxLeads: 120,
  enrichBatchSize: 500,
  enrichConcurrency: 4,
  postsPerLead: 2,
  leadPostBatchSize: 200,
};

export const DEFAULT_LIMITS = {
  postsPerProfile: 5,
  commentsPerPost: 30,
  followersPerProfile: 2500,
  maxLeads: 100,
};

export const PLATFORM_DEFAULTS = {
  tiktok: { postsPerProfile: 4 },
};

// Stime di costo MOLTO grezze, servono solo come ordine di grandezza.
// I prezzi reali degli actor cambiano: verifica sempre sulla pagina dell'actor.
// perThousandFollowers riflette coderx ($0.0011/risultato).
export const COST_HINTS = {
  perThousandPosts: 2.3,
  perThousandComments: 2.3,
  perThousandFollowers: 1.1,
  perThousandProfiles: 2.3,
};
