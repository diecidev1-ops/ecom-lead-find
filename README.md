# Lead Finder — Instagram / TikTok

Inserisci dei profili di riferimento (competitor, brand, influencer del tuo settore) e il tool
estrae gli account che ci interagiscono, li arricchisce con bio/categoria/contatti e ti dà
una lista ordinata per qualità, esportabile in CSV.

I dati arrivano da [Apify](https://apify.com). Serve un account Apify (a consumo).

---

## Avvio rapido

```bash
# 1. Dipendenze (già installate)
npm install

# 2. Configura il token Apify
copy .env.example .env
#    poi apri .env e incolla il token da https://console.apify.com/settings/integrations

# 3. Avvia
npm start
```

Apri **http://localhost:3000**. Se il token è valido vedi "Apify connesso" in alto a destra.

---

## Cosa funziona davvero, e cosa no

Questa è la parte più importante: **le tre piattaforme non sono equivalenti.**

| Piattaforma | Fonte | Stato | Note |
|---|---|---|---|
| Instagram | Chi commenta | ✅ Affidabile | Actor ufficiale Apify. Lead più "caldi": si sono esposti attivamente. |
| Instagram | Follower | ⚠️ Limitato | Solo actor di terze parti. Profili privati esclusi, volumi limitati. |
| Instagram | Chi mette like | ❌ Non implementato | Instagram ha nascosto le liste di like: nessuna fonte affidabile. |
| TikTok | Chi commenta | ✅ Funziona | |
| TikTok | Follower | ❌ Non implementato | Non estraibile in modo affidabile. |
| Facebook | Chi commenta | ⚠️ Funziona, resa bassa | Actor ufficiale, ma vedi sotto: i commentatori sono profili personali. |
| Facebook | Follower | ⚠️ Funziona, resa bassa | Idem. |
| Facebook | Pagine per settore+zona | 🔵 **Non implementato, ma è il migliore** | Vedi sotto. |

### Facebook: leggi prima di usarlo

Su Facebook chi commenta o segue una pagina sono quasi sempre **profili personali**, e gli
actor restituiscono per loro solo `profileName`, `profileUrl`, `profilePicture`. Niente bio,
niente email, niente sito — la documentazione Apify lo dice: *"Facebook profiles contain less data"*.

Quindi la pipeline Facebook attuale ti darà **soprattutto nomi e link**. Non è rotta: è il
massimo che quella fonte offre.

**Il recupero parziale:** l'arricchimento usa `apify/facebook-pages-scraper`, che dà dati
completi solo se il candidato è a sua volta una **Pagina** business. Sono pochi, ma è
esattamente quello che serve — e li ritrovi in cima alla lista grazie al punteggio, con la
colonna "Tipo" che segna `Pagina` o `Persona`.

**L'alternativa che rende molto di più:** `apify/facebook-search-scraper` accetta
**parole chiave + località** e restituisce direttamente pagine business con email, telefono,
sito, indirizzo, categoria, rating e stato pubblicitario — in **un solo passaggio**, senza
arricchimento. Per trovare negozi da contattare è la fonte migliore tra tutte e tre le
piattaforme. Non è implementato perché cambia il modello: non parti da un profilo di
riferimento ma da settore+zona. Se lo vuoi, va aggiunto un actor in `src/config.js` e un ramo
in `pipeline.js`.

### Sulle email
Su Instagram solo gli account **business/creator** espongono un'email pubblica: su una lista di
follower normali parliamo del **5–15%**. Se il tuo target sono aziende/negozi va benissimo; se
sono consumatori privati, la colonna email sarà quasi vuota e il canale reale resta il DM.
Usa il filtro "Solo account business" per non pagare l'arricchimento di profili inutili.

Sulle **pagine** Facebook invece la percentuale è molto più alta: sono le pagine stesse a
pubblicare i contatti. Ma vale solo per le Pagine, non per i profili personali.

---

## Come usarlo bene

1. **Parti dai commenti, non dai follower.** Chi commenta è un lead più caldo e la fonte è più affidabile.
2. **Usa le parole chiave.** Se cerchi e-commerce, filtra su `shop, store, boutique, spedizioni`.
   Riduce drasticamente il rumore.
3. **Fai sempre "Stima costo" prima di avviare.** Ti dice quanti post/commenti/profili verranno
   processati.
4. **Prova in piccolo.** Primo giro: 1 profilo, 3 post, 20 commenti. Guarda la qualità, poi alza.
5. **L'arricchimento è la voce di costo principale** (un profilo = una chiamata). Il tetto
   "Max lead totali" si applica *prima* dell'arricchimento: è la tua leva di spesa.

### Il punteggio (0–100)
Ordina i lead per contattabilità e pertinenza: email (+35), sito proprio (+15), account
business (+10), segnali e-commerce nella bio, keyword che hai scelto (+12), fascia follower
1k–100k (+5), provenienza dai commenti (+5). È un'euristica per far galleggiare in cima i
lead migliori, non un verdetto.

---

## Prima di usarlo sul serio: GDPR

Se contatti persone nell'UE, raccogliere i loro dati per outreach commerciale ti mette in capo
obblighi reali: base giuridica, informativa privacy al primo contatto, diritto di opposizione.

- **B2B** (scrivere a un negozio sulla sua email pubblica aziendale): zona molto più difendibile.
- **B2C a freddo** (email a persone fisiche): è la zona più esposta.

Non è un divieto — è marketing comune — ma è bene saperlo prima di costruirci sopra un processo.
Va inoltre detto che lo scraping è contrario ai Termini di Servizio delle piattaforme: il rischio
concreto è verso il tuo account, non penale.

---

## Struttura

```
server.js           API REST + serve il frontend
src/
  config.js         ID degli actor Apify e limiti  <- l'unico file da toccare se un actor cambia
  apify.js          client API Apify (avvio run, polling, download dataset)
  pipeline.js       orchestrazione: scoperta -> arricchimento -> contatti -> filtri
  extract.js        estrazione email/telefono/sito dalla bio, scoring, filtri
  store.js          SQLite (modulo nativo di Node, nessuna dipendenza da compilare)
public/             interfaccia (HTML/CSS/JS, zero framework)
data/leads.db       il tuo database di lead (escluso da git)
```

### Se un actor smette di funzionare
Gli actor Apify di terze parti cambiano o muoiono. La pipeline lavora su un formato
normalizzato interno e legge i campi in modo difensivo (prova più nomi possibili), quindi
per sostituire un actor **basta cambiare `src/config.js`**: ID e funzione `buildInput`.

Actor attualmente usati:
- `apify/instagram-post-scraper` — trova i post di un profilo
- `apify/instagram-comment-scraper` — commenti (ufficiale)
- `apify/instagram-profile-scraper` — arricchimento profili (ufficiale)
- `louisdeconinck/instagram-followers-scraper` — follower (terze parti)
- `clockworks/tiktok-comments-scraper` — commenti TikTok
- `apify/facebook-posts-scraper` — post di una pagina (ufficiale)
- `apify/facebook-comments-scraper` — commenti (ufficiale)
- `apify/facebook-followers-following-scraper` — follower (ufficiale)
- `apify/facebook-pages-scraper` — arricchimento pagine (ufficiale)

Nota: gli actor Facebook vogliono `startUrls` come array di **oggetti** `{url}`, non di
stringhe, e identificano i profili con l'**URL** (incluso `profile.php?id=NNN`), non con un
handle. Per questo `extract.js` ha un percorso di normalizzazione separato per Facebook.

---

## Limiti di sicurezza

Sono limiti veri, applicati **lato server** (non solo nella UI): max 10 profili per job,
50 post per profilo, 200 commenti per post, 5000 follower per profilo, 5000 lead per job.
Servono a evitare che un errore di battitura ti bruci il credito Apify. Si cambiano in
`src/config.js` → `HARD_LIMITS`.

## Note

- Le stime di costo in `COST_HINTS` sono **ordini di grandezza**, non un preventivo: i prezzi
  reali degli actor cambiano nel tempo. Il consumo vero è su console.apify.com.
- Il CSV è protetto da formula injection e ha il BOM UTF-8 (Excel legge gli accenti correttamente).
- Se riavvii il server durante un job, il job viene marcato come interrotto: la run su Apify
  potrebbe però continuare. Controlla su console.apify.com.
- Deploy serverless su Vercel con Supabase (Postgres) per la persistenza.
