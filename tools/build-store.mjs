#!/usr/bin/env node
// Global Visions track store: static page generator.
// Reads store-src/tracks.json and writes every page under /store and /it/store,
// plus the store block of /sitemap.xml. Zero dependencies, Node 22+.
// Run: node tools/build-store.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://globalvisions.it";
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, "store-src/tracks.json"), "utf8"));
const TRACKS = DATA.tracks;
const UPDATED = DATA.updated;
const LANGS = ["en", "it"];

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const base = (lang) => (lang === "it" ? "/it/store/" : "/store/");
const home = (lang) => (lang === "it" ? "/it/" : "/");
const other = (lang) => (lang === "it" ? "en" : "it");
const price = (amount, currency, lang) =>
  new Intl.NumberFormat(lang === "it" ? "it-IT" : "en-IE", {
    style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(amount);
const km = (m, lang) =>
  `${new Intl.NumberFormat(lang === "it" ? "it-IT" : "en-GB", { maximumFractionDigits: 2 }).format(m / 1000)} km`;
const isAvailable = (t) => t.status === "available";
const write = (rel, content) => {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const jsonForScript = (obj) => JSON.stringify(obj).replace(/</g, "\\u003c");

// ---------------------------------------------------------------- icons
const ICON = {
  steam: `<svg class="steam-glyph" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="15.6" cy="9.2" r="3.1" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="15.6" cy="9.2" r="1.2" fill="currentColor"/><circle cx="8.6" cy="15.6" r="2.1" fill="currentColor"/><path d="M8.6 15.6 L13.4 11.2 M1.8 13.2 L8.6 15.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  logo: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>`,
  play: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`,
};

// ---------------------------------------------------------------- strings
const T = {
  en: {
    locale: "en_US", altLocale: "it_IT", skip: "Skip to content", navLabel: "Store",
    nav: { tracks: "Tracks", commercial: "Commercial", account: "My tracks", signin: "Sign in through Steam", home: "Global Visions, home", langName: "Italiano" },
    footer: { tagline: 'Tracks for Assetto Corsa, <em>made to be driven.</em>', licence: "Licence", refunds: "Refunds", cookies: "Cookies", privacy: "Privacy", legal: "Global Visions OÜ · Sepapaja tn 6, 15551 Tallinn, Estonia · Registry code 16697227 · VAT EE102615704" },
    ogAlt: "Global Visions: tracks for Assetto Corsa.",
    grid: {
      title: "Assetto Corsa tracks | Global Visions Store",
      desc: "Downloadable tracks for Assetto Corsa with Custom Shaders Patch lights, animations and evolving grip. Licence tied to your Steam account, sign in through Steam.",
      tag: "Track store",
      h1: ["Circuits for Assetto Corsa,", "made to be driven."],
      lede: "Downloadable tracks with Custom Shaders Patch features: working lights, trackside animations, grip that evolves and timing that matches the venue. Your licence is tied to your Steam account, so there is no key to type and nothing to lose.",
      gridTitle: "Tracks", from: "From", soon: "Coming soon", available: "Available", layouts: (n) => `${n} layout${n === 1 ? "" : "s"}`,
      emptyNote: "The first circuits are being prepared. Check back soon or write to us to hear when they go live.",
      howTag: "How it works", howTitle: ["Three steps", "from the store to the grid."],
      steps: [
        ["Sign in through Steam", "Steam only tells us your Steam ID. No password, no new account."],
        ["Pay with Stripe", "Cards, Apple Pay and Google Pay. VAT is calculated for your country."],
        ["Download and race", "Your tracks stay in My tracks. Install on up to two PCs."],
      ],
      venueTitle: "Run a sim centre or a karting venue?",
      venueText: "Commercial licences cover several machines at your venue and do not need a Steam account.",
      venueCta: "Commercial licences",
    },
    track: {
      titleSuffix: "Assetto Corsa track | Global Visions Store",
      crumbs: "Breadcrumb", store: "Store", gallery: "Screenshots", openImage: "Open image", video: "Video", videoSoon: "Video coming with the release",
      specs: "Specifications", length: "Length", layouts: "Layouts", location: "Location", requires: "Requires",
      buyTitle: "Choose your licence", personal: "Personal", commercial: "Commercial",
      personalNote: (n) => `One Steam account, up to ${n} PCs`, commercialNote: (n) => `For venues, up to ${n} machines, no Steam account`,
      priceSoon: "Price at launch", vat: "VAT calculated at checkout for your country.",
      buySoon: "Coming soon",
      policies: 'By buying you accept the <a href="{licence}">licence</a> and the <a href="{refunds}">refund policy</a>.',
      online: "Online races", onlineText: "Servers that run our race-server check only let in drivers with a valid licence for this track, so your lobbies stay clean.",
      about: "About the track", close: "Close", prev: "Previous image", next: "Next image",
    },
    account: {
      title: "My tracks | Global Visions Store", desc: "Your Assetto Corsa tracks, downloads and machines.",
      tag: "Account", h1: ["My tracks"],
      signinTitle: "Sign in to see your tracks",
      signinText: "We use Steam to know who you are. Steam only shares your Steam ID with us, never your password or email.",
      venue: "Commercial venue?", venueLink: "Sign in with your licence key",
    },
    commercial: {
      title: "Commercial licences for sim centres | Global Visions Store",
      desc: "Assetto Corsa track licences for sim centres, karting venues and events. Tied to your machines with a licence key, no Steam account needed.",
      tag: "Commercial", h1: ["Commercial licences", "for sim centres and venues."],
      lede: "For sim centres, karting venues, schools and events where customers drive on your machines. The licence is tied to your machines through a licence key, not to one Steam account.",
      points: [
        ["Tied to your machines", "Each commercial licence covers a set number of machines, shown on the track page."],
        ["No Steam account needed", "Activate with a licence key on each machine. Staff can rotate drivers freely."],
        ["Same track, same updates", "You get the same builds and fixes as personal buyers."],
      ],
      buyTitle: "Buy a commercial licence", trackLabel: "Track", noneOnSale: "No tracks on sale yet", buy: "Continue to payment",
      keyTitle: "Already a customer?", keyText: "Sign in with the licence key you received after payment.", keyLabel: "Licence key", keyButton: "Sign in",
      moreTitle: "Need more machines or a custom deal?", moreText: "Larger venues, events and championships: tell us what you need.",
      write: "Write to us", call: "Book a call",
    },
    admin: { title: "Admin | Global Visions Store", desc: "Store administration.", h1: ["Store admin"] },
    licence: { title: "Licence terms | Global Visions Store", desc: "What you can do with a Global Visions track for Assetto Corsa: personal and commercial licences, machine limits, online checks and copy tracing.", h1: "Licence terms" },
    refunds: { title: "Refund policy | Global Visions Store", desc: "How refunds work for Global Visions tracks: EU withdrawal right for digital content, when we refund anyway, and what happens to the licence.", h1: "Refund policy" },
    cookies: { title: "Cookie policy | Global Visions Store", desc: "The few cookies the Global Visions track store uses: language preference and strictly necessary sign in cookies. No analytics or marketing cookies.", h1: "Cookie policy" },
    updated: "Last updated: 16 November 2026",
    js: {
      setup: "The store is being set up. Sign in and purchases will open soon.",
      demo: "Demo mode: data is simulated, nothing is charged.", demoExit: "Exit demo",
      buySignin: "Sign in through Steam to buy", buyPersonal: "Buy personal licence", buyCommercial: "Commercial licence", buySoon: "Coming soon", redirecting: "Opening secure checkout...",
      myTracks: "My tracks", signedAs: "Signed in as", signout: "Sign out", steamId: "Steam ID", venueSession: "Commercial venue",
      finalising: "Finalising your licence...", finalised: "Your licence is ready.", slow: "Payment received, the licence is taking longer than usual. Refresh in a minute; the receipt is in your email.",
      keyTitle: "Your licence key", keyNote: "Save it now. For security we show it only once. You need it to activate each machine and to sign in.", copy: "Copy", copied: "Copied",
      none: "You have no tracks yet.", browse: "Browse tracks",
      personal: "Personal", commercial: "Commercial", active: "Active", refunded: "Refunded", disabled: "Disabled",
      refundedNote: "This licence was refunded. The track no longer passes the licence check and downloads are closed.",
      disabledNote: "This licence is disabled, for example during a payment dispute. Write to hello@globalvisions.it and we will sort it out.",
      bought: "Bought", download: "Download", preparing: "Preparing download...", demoDownload: "Demo: the download would start now.",
      machines: "Machines", machineN: "PC", firstSeen: "first seen", lastSeen: "last seen", activeNow: "in use now", noMachines: "No machines yet. The track registers a machine the first time it loads.",
      slots: (u, m) => `${u} of ${m} machines used`,
      release: "Free this machine", confirm: "Confirm", released: "Machine freed.", cooldown: "You can free another machine from",
      keyInvalid: "That key was not recognised. Check it and try again.",
      errors: {
        login_required: "Please sign in through Steam first.", not_found: "Not found.", not_owner: "This licence belongs to another account.",
        licence_inactive: "This licence is not active.", track_unavailable: "This track is not on sale right now.", price_not_configured: "This track is not on sale yet.",
        release_cooldown: "You freed a machine recently.", bad_origin: "Request blocked. Reload the page and try again.", rate_limited: "Too many requests. Wait a moment and try again.",
        server_error: "Something went wrong on our side. Try again in a minute.", unreachable: "The store is not reachable right now. Try again in a minute.",
        unauthorized: "Admin token not accepted.",
      },
      admin: {
        tokenLabel: "Admin token", tokenHelp: "Kept only in this browser tab (sessionStorage).", enter: "Open", forget: "Forget token",
        licences: "Licences", search: "Search", steam: "Steam ID", track: "Track", status: "Status", any: "Any", q: "Licence or order id",
        id: "Licence", type: "Type", machines: "Machines", created: "Created", actions: "Actions",
        revoke: "Revoke", reactivate: "Reactivate", reset: "Reset machines", done: "Done.", empty: "No licences found.",
        stats: "Per track", downloads: "Downloads", total: "Licences", activeCol: "Active", refundedCol: "Refunded",
        trace: "Trace a copy", copyId: "Copy id", traceBtn: "Trace", notFound: "No copy with that id.", order: "Order",
        confirmRevoke: "Revoke this licence?", confirmReset: "Release every machine of this licence?",
      },
    },
  },
  it: {
    locale: "it_IT", altLocale: "en_US", skip: "Vai al contenuto", navLabel: "Negozio",
    nav: { tracks: "Tracciati", commercial: "Aziende", account: "I miei tracciati", signin: "Accedi con Steam", home: "Global Visions, home", langName: "English" },
    footer: { tagline: 'Tracciati per Assetto Corsa, <em>fatti per essere guidati.</em>', licence: "Licenza", refunds: "Rimborsi", cookies: "Cookie", privacy: "Privacy", legal: "Global Visions OÜ · Sepapaja tn 6, 15551 Tallinn, Estonia · Codice di registro 16697227 · Partita IVA EE102615704" },
    ogAlt: "Global Visions: tracciati per Assetto Corsa.",
    grid: {
      title: "Tracciati per Assetto Corsa | Global Visions Store",
      desc: "Tracciati da scaricare per Assetto Corsa con luci, animazioni e grip che cambia grazie al Custom Shaders Patch. Licenza legata al tuo account Steam.",
      tag: "Negozio tracciati",
      h1: ["Circuiti per Assetto Corsa,", "fatti per essere guidati."],
      lede: "Tracciati da scaricare con le funzioni del Custom Shaders Patch: luci che funzionano, animazioni a bordo pista, grip che cambia e cronometraggio fedele al circuito. La licenza è legata al tuo account Steam: niente chiavi da digitare, niente da perdere.",
      gridTitle: "Tracciati", from: "Da", soon: "In arrivo", available: "Disponibile", layouts: (n) => `${n} ${n === 1 ? "configurazione" : "configurazioni"}`,
      emptyNote: "I primi circuiti sono in preparazione. Torna a trovarci o scrivici per sapere quando escono.",
      howTag: "Come funziona", howTitle: ["Tre passaggi", "dal negozio alla griglia."],
      steps: [
        ["Accedi con Steam", "Steam ci comunica solo il tuo Steam ID. Nessuna password, nessun nuovo account."],
        ["Paga con Stripe", "Carte, Apple Pay e Google Pay. L'IVA viene calcolata per il tuo paese."],
        ["Scarica e corri", "I tuoi tracciati restano in I miei tracciati. Puoi installarli su due PC."],
      ],
      venueTitle: "Gestisci un centro simulatori o un kartodromo?",
      venueText: "Le licenze per aziende coprono più postazioni nella tua sede e non richiedono un account Steam.",
      venueCta: "Licenze per aziende",
    },
    track: {
      titleSuffix: "tracciato per Assetto Corsa | Global Visions Store",
      crumbs: "Percorso", store: "Negozio", gallery: "Immagini", openImage: "Apri immagine", video: "Video", videoSoon: "Il video arriva con l'uscita",
      specs: "Caratteristiche", length: "Lunghezza", layouts: "Configurazioni", location: "Luogo", requires: "Serve",
      buyTitle: "Scegli la licenza", personal: "Personale", commercial: "Aziende",
      personalNote: (n) => `Un account Steam, fino a ${n} PC`, commercialNote: (n) => `Per centri e circuiti, fino a ${n} postazioni, senza account Steam`,
      priceSoon: "Prezzo all'uscita", vat: "IVA calcolata al pagamento in base al tuo paese.",
      buySoon: "In arrivo",
      policies: 'Acquistando accetti la <a href="{licence}">licenza</a> e la <a href="{refunds}">politica di rimborso</a>.',
      online: "Gare online", onlineText: "I server che usano il nostro controllo fanno entrare solo i piloti con una licenza valida per questo tracciato: le lobby restano pulite.",
      about: "Il tracciato", close: "Chiudi", prev: "Immagine precedente", next: "Immagine successiva",
    },
    account: {
      title: "I miei tracciati | Global Visions Store", desc: "I tuoi tracciati per Assetto Corsa, i download e le postazioni.",
      tag: "Account", h1: ["I miei tracciati"],
      signinTitle: "Accedi per vedere i tuoi tracciati",
      signinText: "Usiamo Steam per sapere chi sei. Steam ci comunica solo il tuo Steam ID, mai la password o l'email.",
      venue: "Sei un'azienda?", venueLink: "Accedi con la chiave di licenza",
    },
    commercial: {
      title: "Licenze per centri simulatori e kartodromi | Global Visions Store",
      desc: "Licenze dei tracciati per Assetto Corsa pensate per centri simulatori, kartodromi ed eventi. Legate alle tue postazioni con una chiave, senza account Steam.",
      tag: "Aziende", h1: ["Licenze per aziende,", "centri simulatori e kartodromi."],
      lede: "Per centri simulatori, kartodromi, scuole ed eventi in cui i clienti guidano sulle tue postazioni. La licenza è legata alle tue macchine tramite una chiave, non a un singolo account Steam.",
      points: [
        ["Legata alle tue postazioni", "Ogni licenza copre un numero preciso di postazioni, indicato nella pagina del tracciato."],
        ["Senza account Steam", "Si attiva con una chiave su ogni postazione. I piloti possono alternarsi liberamente."],
        ["Stesso tracciato, stessi aggiornamenti", "Ricevi le stesse versioni e le stesse correzioni dei clienti privati."],
      ],
      buyTitle: "Acquista una licenza per aziende", trackLabel: "Tracciato", noneOnSale: "Ancora nessun tracciato in vendita", buy: "Vai al pagamento",
      keyTitle: "Sei già cliente?", keyText: "Accedi con la chiave di licenza che hai ricevuto dopo il pagamento.", keyLabel: "Chiave di licenza", keyButton: "Accedi",
      moreTitle: "Ti servono più postazioni o un accordo su misura?", moreText: "Grandi centri, eventi e campionati: raccontaci di cosa hai bisogno.",
      write: "Scrivici", call: "Prenota una call",
    },
    admin: { title: "Amministrazione | Global Visions Store", desc: "Amministrazione del negozio.", h1: ["Amministrazione negozio"] },
    licence: { title: "Condizioni di licenza | Global Visions Store", desc: "Cosa puoi fare con un tracciato Global Visions per Assetto Corsa: licenze personali e per aziende, limite di postazioni, controlli online e tracciamento delle copie.", h1: "Condizioni di licenza" },
    refunds: { title: "Politica di rimborso | Global Visions Store", desc: "Come funzionano i rimborsi dei tracciati Global Visions: diritto di recesso UE per i contenuti digitali, quando rimborsiamo comunque e cosa succede alla licenza.", h1: "Politica di rimborso" },
    cookies: { title: "Cookie | Global Visions Store", desc: "I pochi cookie usati dal negozio tracciati Global Visions: preferenza della lingua e cookie strettamente necessari per l'accesso. Nessun cookie di statistica o di marketing.", h1: "Cookie" },
    updated: "Ultimo aggiornamento: 16 novembre 2026",
    js: {
      setup: "Il negozio è in preparazione. Accesso e acquisti apriranno a breve.",
      demo: "Modalità demo: i dati sono simulati, non viene addebitato nulla.", demoExit: "Esci dalla demo",
      buySignin: "Accedi con Steam per acquistare", buyPersonal: "Acquista la licenza personale", buyCommercial: "Licenza per aziende", buySoon: "In arrivo", redirecting: "Apro il pagamento sicuro...",
      myTracks: "I miei tracciati", signedAs: "Accesso come", signout: "Esci", steamId: "Steam ID", venueSession: "Azienda",
      finalising: "Sto preparando la tua licenza...", finalised: "La tua licenza è pronta.", slow: "Pagamento ricevuto, la licenza ci sta mettendo più del solito. Ricarica tra un minuto; la ricevuta è nella tua email.",
      keyTitle: "La tua chiave di licenza", keyNote: "Salvala adesso. Per sicurezza la mostriamo una sola volta. Ti serve per attivare ogni postazione e per accedere.", copy: "Copia", copied: "Copiata",
      none: "Non hai ancora tracciati.", browse: "Guarda i tracciati",
      personal: "Personale", commercial: "Aziende", active: "Attiva", refunded: "Rimborsata", disabled: "Disattivata",
      refundedNote: "Questa licenza è stata rimborsata. Il tracciato non supera più il controllo e i download sono chiusi.",
      disabledNote: "Questa licenza è disattivata, per esempio durante una contestazione del pagamento. Scrivi a hello@globalvisions.it e la sistemiamo.",
      bought: "Acquistata il", download: "Scarica", preparing: "Preparo il download...", demoDownload: "Demo: qui partirebbe il download.",
      machines: "Postazioni", machineN: "PC", firstSeen: "prima volta", lastSeen: "ultima volta", activeNow: "in uso ora", noMachines: "Ancora nessuna postazione. Il tracciato registra la postazione la prima volta che si carica.",
      slots: (u, m) => `${u} su ${m} postazioni usate`,
      release: "Libera questa postazione", confirm: "Conferma", released: "Postazione liberata.", cooldown: "Potrai liberare un'altra postazione dal",
      keyInvalid: "Chiave non riconosciuta. Controllala e riprova.",
      errors: {
        login_required: "Prima accedi con Steam.", not_found: "Non trovato.", not_owner: "Questa licenza appartiene a un altro account.",
        licence_inactive: "Questa licenza non è attiva.", track_unavailable: "Questo tracciato al momento non è in vendita.", price_not_configured: "Questo tracciato non è ancora in vendita.",
        release_cooldown: "Hai liberato una postazione da poco.", bad_origin: "Richiesta bloccata. Ricarica la pagina e riprova.", rate_limited: "Troppe richieste. Aspetta un momento e riprova.",
        server_error: "Qualcosa è andato storto da parte nostra. Riprova tra un minuto.", unreachable: "Il negozio al momento non risponde. Riprova tra un minuto.",
        unauthorized: "Token di amministrazione non accettato.",
      },
      admin: {
        tokenLabel: "Token di amministrazione", tokenHelp: "Resta solo in questa scheda del browser (sessionStorage).", enter: "Apri", forget: "Dimentica il token",
        licences: "Licenze", search: "Cerca", steam: "Steam ID", track: "Tracciato", status: "Stato", any: "Tutti", q: "Id licenza o ordine",
        id: "Licenza", type: "Tipo", machines: "Postazioni", created: "Creata", actions: "Azioni",
        revoke: "Revoca", reactivate: "Riattiva", reset: "Azzera postazioni", done: "Fatto.", empty: "Nessuna licenza trovata.",
        stats: "Per tracciato", downloads: "Download", total: "Licenze", activeCol: "Attive", refundedCol: "Rimborsate",
        trace: "Rintraccia una copia", copyId: "Id copia", traceBtn: "Rintraccia", notFound: "Nessuna copia con questo id.", order: "Ordine",
        confirmRevoke: "Revocare questa licenza?", confirmReset: "Liberare tutte le postazioni di questa licenza?",
      },
    },
  },
};

// Function-valued strings cannot go to JSON: resolve the ones the client needs.
const clientStrings = (lang) => {
  const j = T[lang].js;
  return { ...j, slots: j.slots(1, 2).replace("1", "{u}").replace("2", "{m}") };
};

// ---------------------------------------------------------------- page shell
const PAGES = {
  grid: "", account: "account/", commercial: "commercial/", licence: "licence/",
  refunds: "refunds/", cookies: "cookies/", admin: "admin/",
};
const url = (lang, rel) => `${base(lang)}${rel}`;

function head({ lang, rel, title, desc, robots, jsonld, ogImageAlt }) {
  const canonical = SITE + url(lang, rel);
  const en = SITE + url("en", rel);
  const it = SITE + url("it", rel);
  const t = T[lang];
  const og = `${SITE}/og/og-${lang}.png`;
  return `<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <script>document.documentElement.className = document.documentElement.className.replace("no-js", "js");</script>

  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <meta name="robots" content="${robots}" />
  <meta name="theme-color" content="#0a0a0a" />
  <meta name="color-scheme" content="dark" />
  <meta name="format-detection" content="telephone=no" />

  <link rel="canonical" href="${canonical}" />
  <link rel="alternate" hreflang="en" href="${en}" />
  <link rel="alternate" hreflang="it" href="${it}" />
  <link rel="alternate" hreflang="x-default" href="${en}" />

  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/favicon.ico" sizes="32x32" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />

  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Global Visions" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:locale" content="${t.locale}" />
  <meta property="og:locale:alternate" content="${t.altLocale}" />
  <meta property="og:image" content="${og}" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${esc(ogImageAlt || t.ogAlt)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${og}" />

  <link rel="preload" href="/assets/fonts/instrument-serif-latin.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="/assets/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="/styles.css" />
  <link rel="stylesheet" href="/store/store.css" />
${jsonld ? `\n  <script type="application/ld+json">\n${JSON.stringify(jsonld, null, 2).replace(/^/gm, "  ")}\n  </script>\n` : ""}
  <script>window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };</script>
  <script defer src="/_vercel/insights/script.js"></script>
</head>`;
}

function nav(lang, rel, page) {
  const t = T[lang].nav;
  const b = base(lang);
  const cur = (p) => (page === p ? ' aria-current="page"' : "");
  const loginHref = `/api/store/auth/steam/login?next=${encodeURIComponent(url(lang, page === "admin" ? "account/" : rel))}&amp;lang=${lang}`;
  return `<header class="nav">
    <a href="${home(lang)}" class="nav__logo" data-magnetic aria-label="${t.home}">
      <span class="nav__logo-mark">${ICON.logo}</span>
      <span class="nav__logo-text">Global Visions</span>
    </a>
    <nav class="nav__links" aria-label="${T[lang].navLabel}">
      <a href="${b}" class="nav__link"${cur("grid")}>${t.tracks}</a>
      <a href="${b}commercial/" class="nav__link"${cur("commercial")}>${t.commercial}</a>
      <a href="${b}account/" class="nav__link"${cur("account")}>${t.account}</a>
      <a href="${loginHref}" class="nav__link nav__link--cta store-auth" id="store-auth" data-magnetic>${ICON.steam}<span class="store-auth__label">${t.signin}</span></a>
      <a href="${url(other(lang), rel)}" class="nav__lang" hreflang="${other(lang)}" lang="${other(lang)}" data-lang="${other(lang)}" aria-label="${t.langName}" title="${t.langName}">${other(lang).toUpperCase()}</a>
    </nav>
  </header>`;
}

function subnav(lang, page) {
  const t = T[lang].nav;
  const b = base(lang);
  const cur = (p) => (page === p ? ' aria-current="page"' : "");
  return `<nav class="store-subnav" aria-label="${T[lang].navLabel}">
      <a href="${b}"${cur("grid")}>${t.tracks}</a>
      <a href="${b}commercial/"${cur("commercial")}>${t.commercial}</a>
      <a href="${b}account/"${cur("account")}>${t.account}</a>
    </nav>`;
}

function footer(lang, rel) {
  const t = T[lang].footer;
  const b = base(lang);
  const privacy = lang === "it" ? "/it/privacy.html" : "/privacy.html";
  const enCur = lang === "en" ? ' aria-current="true"' : ' data-lang="en" lang="en"';
  const itCur = lang === "it" ? ' aria-current="true"' : ' data-lang="it" lang="it"';
  return `<footer class="footer">
    <div class="footer__row">
      <span>© <span id="year">2026</span> Global Visions OÜ</span>
      <span class="footer__dot">·</span>
      <a href="${b}licence/">${t.licence}</a>
      <span class="footer__dot">·</span>
      <a href="${b}refunds/">${t.refunds}</a>
      <span class="footer__dot">·</span>
      <a href="${b}cookies/">${t.cookies}</a>
      <span class="footer__dot">·</span>
      <a href="${privacy}">${t.privacy}</a>
      <span class="footer__dot">·</span>
      <span><a href="${url("en", rel)}" hreflang="en"${enCur}>EN</a> / <a href="${url("it", rel)}" hreflang="it"${itCur}>IT</a></span>
    </div>
    <p class="footer__tagline">${t.tagline}</p>
    <p class="footer__legal">${t.legal}</p>
  </footer>`;
}

function page({ lang, rel, page: pageId, title, desc, robots = "index, follow, max-image-preview:large", jsonld, main, extra = {} }) {
  const cfg = {
    lang, page: pageId, base: base(lang), home: home(lang), path: url(lang, rel),
    tracks: TRACKS.map((t) => ({ track_id: t.track_id, name: t.name, status: t.status })),
    s: clientStrings(lang), ...extra,
  };
  return `<!DOCTYPE html>
<html lang="${lang}" class="no-js">
${head({ lang, rel, title, desc, robots, jsonld })}
<body class="store store--${pageId}" data-store-page="${pageId}">
  <a class="skip-link" href="#main">${T[lang].skip}</a>
  <canvas id="grid-canvas" aria-hidden="true"></canvas>
  <div class="progress" aria-hidden="true"></div>
  <div class="cursor" aria-hidden="true"></div>
  <div class="cursor-dot" aria-hidden="true"></div>

  ${nav(lang, rel, pageId)}

  <main id="main">
    ${subnav(lang, pageId)}
    <div class="store-notice" id="store-notice" role="status" aria-live="polite" hidden></div>
${main}
  </main>

  ${footer(lang, rel)}

  <div class="store-toast" id="store-toast" role="status" aria-live="polite"></div>
  <script type="application/json" id="store-i18n">${jsonForScript(cfg)}</script>
  <script src="/assets/js/anime.min.js" defer></script>
  <script src="/script.js" defer></script>
  <script src="/store/store.js" defer></script>
</body>
</html>
`;
}

const titleLines = (lines, accentLast = true) => lines.map((l, i) =>
  (accentLast && i === lines.length - 1 && lines.length > 1)
    ? `<span class="line line--accent"><em data-split>${esc(l)}</em></span>`
    : `<span class="line"><span data-split>${esc(l)}</span></span>`).join("\n          ");

const breadcrumbLd = (items) => ({
  "@type": "BreadcrumbList",
  itemListElement: items.map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item: SITE + item })),
});

// ---------------------------------------------------------------- pages
function gridPage(lang) {
  const t = T[lang].grid;
  const b = base(lang);
  const cards = TRACKS.map((tr) => {
    const avail = isAvailable(tr);
    const p = tr.prices?.personal;
    const priceHtml = avail && p
      ? `<span class="track-card__price"><span>${t.from}</span> ${esc(price(p.amount, p.currency, lang))}</span>`
      : `<span class="track-card__price track-card__price--soon">${t.soon}</span>`;
    return `<li class="track-card" data-card>
          <a href="${b}${tr.track_id}/" class="track-card__link">
            <span class="track-card__media"><img src="${esc(tr.poster)}" alt="" width="1600" height="900" loading="lazy" decoding="async" /></span>
            <span class="badge ${avail ? "badge--ok" : "badge--soon"}">${avail ? t.available : t.soon}</span>
            <span class="track-card__body">
              <span class="track-card__name">${esc(tr.name)}</span>
              <span class="track-card__meta">${esc(tr.location)} · ${km(tr.length_m, lang)} · ${t.layouts(tr.layouts.length)}</span>
              ${priceHtml}
            </span>
          </a>
        </li>`;
  }).join("\n        ");
  const anyAvailable = TRACKS.some(isAvailable);
  const main = `
    <section class="section store-hero" aria-labelledby="store-title">
      <div class="section__head">
        <span class="section__tag" data-reveal>${t.tag}</span>
        <h1 class="section__title store-h1" id="store-title">
          ${titleLines(t.h1)}
        </h1>
        <p class="section__lede" data-fade>${esc(t.lede)}</p>
      </div>
      <h2 class="visually-hidden">${t.gridTitle}</h2>
      <ul class="track-grid">
        ${cards}
      </ul>
      ${anyAvailable ? "" : `<p class="store-empty-note" data-fade>${esc(t.emptyNote)} <a href="mailto:hello@globalvisions.it">hello@globalvisions.it</a></p>`}
    </section>

    <section class="section" aria-labelledby="how-title">
      <div class="section__head">
        <span class="section__tag" data-reveal>${t.howTag}</span>
        <h2 class="section__title" id="how-title">
          ${titleLines(t.howTitle)}
        </h2>
      </div>
      <ol class="store-steps">
        ${t.steps.map(([h, p], i) => `<li class="store-step" data-card><span class="store-step__num" aria-hidden="true">0${i + 1}</span><h3>${esc(h)}</h3><p>${esc(p)}</p></li>`).join("\n        ")}
      </ol>
      <div class="store-venue" data-fade>
        <div>
          <h3>${esc(t.venueTitle)}</h3>
          <p>${esc(t.venueText)}</p>
        </div>
        <a href="${b}commercial/" class="btn btn--ghost" data-magnetic><span>${t.venueCta}</span>${ICON.arrow}</a>
      </div>
    </section>`;
  const available = TRACKS.filter(isAvailable);
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage", "@id": `${SITE}${b}#webpage`, url: SITE + b, name: t.title, description: t.desc,
        inLanguage: lang, isPartOf: { "@id": `${SITE}/#website` }, publisher: { "@id": `${SITE}/#organization` },
      },
      ...(available.length ? [{
        "@type": "ItemList", itemListElement: available.map((tr, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}${b}${tr.track_id}/`, name: tr.name })),
      }] : []),
    ],
  };
  return page({ lang, rel: "", page: "grid", title: t.title, desc: t.desc, jsonld, main });
}

function trackPage(lang, tr) {
  const t = T[lang].track;
  const g = T[lang].grid;
  const b = base(lang);
  const rel = `${tr.track_id}/`;
  const avail = isAvailable(tr);
  const pp = tr.prices.personal;
  const pc = tr.prices.commercial;
  const title = `${tr.name}, ${t.titleSuffix}`;
  const desc = tr.summary[lang];
  const shots = tr.screenshots.map((src, i) =>
    `<li><button type="button" class="gallery__thumb${i === 0 ? " is-active" : ""}" data-index="${i}" aria-label="${t.openImage} ${i + 1}"><img src="${esc(src)}" alt="" width="1600" height="900" loading="lazy" decoding="async" /></button></li>`).join("\n            ");
  const video = tr.video
    ? `<video class="track-video" controls preload="none" playsinline poster="${esc(tr.video.poster)}"><source src="${esc(tr.video.mp4)}" type="video/mp4" /></video>`
    : `<div class="track-video track-video--soon"><img src="${esc(tr.poster)}" alt="" width="1600" height="900" loading="lazy" /><span>${ICON.play}${esc(t.videoSoon)}</span></div>`;
  const radio = (type, pr, note) => `<label class="licence-option">
              <input type="radio" name="licence-type" value="${type}"${type === "personal" ? " checked" : ""}${avail ? "" : " disabled"} />
              <span class="licence-option__body">
                <span class="licence-option__name">${type === "personal" ? t.personal : t.commercial}</span>
                <span class="licence-option__note">${esc(note)}</span>
                <span class="licence-option__price">${avail ? esc(price(pr.amount, pr.currency, lang)) : t.priceSoon}</span>
              </span>
            </label>`;
  const policies = t.policies.replace("{licence}", `${b}licence/`).replace("{refunds}", `${b}refunds/`);
  const main = `
    <section class="section track-page" aria-labelledby="track-title">
      <nav class="crumbs" aria-label="${t.crumbs}">
        <a href="${b}">${t.store}</a><span aria-hidden="true">/</span><span aria-current="page">${esc(tr.name)}</span>
      </nav>
      <div class="track-head">
        <div class="track-head__text">
          <span class="section__tag" data-reveal>${esc(tr.location)} · ${km(tr.length_m, lang)}${avail ? "" : ` · ${g.soon}`}</span>
          <h1 class="section__title store-h1" id="track-title">
            <span class="line"><span data-split>${esc(tr.name)}</span></span>
          </h1>
          <p class="section__lede" data-fade>${esc(tr.summary[lang])}</p>
        </div>
      </div>

      <div class="track-layout">
        <div class="track-media" data-fade>
          <h2 class="visually-hidden">${t.gallery}</h2>
          <button type="button" class="gallery__main" id="gallery-main" data-index="0" aria-label="${t.openImage} 1">
            <img src="${esc(tr.screenshots[0])}" alt="${esc(tr.name)}" width="1600" height="900" decoding="async" fetchpriority="high" />
          </button>
          <ul class="gallery__thumbs">
            ${shots}
          </ul>
          <h3 class="track-sub">${t.video}</h3>
          ${video}
        </div>

        <aside class="buy-panel" data-fade aria-labelledby="buy-title">
          <h2 class="buy-panel__title" id="buy-title">${t.buyTitle}</h2>
          <fieldset class="licence-options">
            <legend class="visually-hidden">${t.buyTitle}</legend>
            ${radio("personal", pp, t.personalNote(pp.max_machines))}
            ${radio("commercial", pc, t.commercialNote(pc.max_machines))}
          </fieldset>
          <button type="button" class="btn btn--primary btn--block" id="buy-btn"${avail ? "" : " disabled"} data-magnetic>
            <span id="buy-label">${avail ? T[lang].js.buySignin : t.buySoon}</span>${ICON.arrow}
          </button>
          <p class="buy-panel__status" id="buy-status" role="status" aria-live="polite"></p>
          ${avail ? `<p class="buy-panel__fine">${t.vat}</p>` : ""}
          <p class="buy-panel__fine">${policies}</p>
        </aside>
      </div>

      <div class="track-details">
        <div class="track-about" data-fade>
          <h2>${t.about}</h2>
          ${tr.description[lang].map((p) => `<p>${esc(p)}</p>`).join("\n          ")}
          <h3>${t.online}</h3>
          <p>${esc(t.onlineText)}</p>
        </div>
        <div class="track-specs" data-fade>
          <h2>${t.specs}</h2>
          <dl>
            <div><dt>${t.length}</dt><dd>${km(tr.length_m, lang)}</dd></div>
            <div><dt>${t.layouts}</dt><dd>${tr.layouts.map(esc).join(", ")}</dd></div>
            <div><dt>${t.location}</dt><dd>${esc(tr.location)}</dd></div>
            <div><dt>${t.requires}</dt><dd>${esc(tr.requirements[lang])}</dd></div>
          </dl>
        </div>
      </div>
    </section>

    <dialog class="lightbox" id="lightbox" aria-label="${t.gallery}">
      <img id="lightbox-img" src="" alt="" />
      <div class="lightbox__bar">
        <button type="button" class="lightbox__btn" id="lightbox-prev" aria-label="${t.prev}">&larr;</button>
        <span id="lightbox-count" aria-live="polite"></span>
        <button type="button" class="lightbox__btn" id="lightbox-next" aria-label="${t.next}">&rarr;</button>
        <button type="button" class="lightbox__btn" id="lightbox-close" aria-label="${t.close}">&times;</button>
      </div>
    </dialog>`;
  const crumbs = breadcrumbLd([[t.store, b], [tr.name, `${b}${rel}`]]);
  const graph = [crumbs];
  if (avail) {
    graph.unshift({
      "@type": "Product", name: `${tr.name} for Assetto Corsa`, description: tr.summary[lang],
      image: tr.screenshots.map((s) => SITE + s), brand: { "@type": "Brand", name: "Global Visions" }, sku: tr.track_id,
      offers: [["personal", pp], ["commercial", pc]].map(([type, pr]) => ({
        "@type": "Offer", name: type === "personal" ? t.personal : t.commercial, price: String(pr.amount), priceCurrency: pr.currency,
        availability: "https://schema.org/InStock", url: `${SITE}${b}${rel}`,
        seller: { "@type": "Organization", name: "Global Visions OÜ", "@id": `${SITE}/#organization` },
      })),
    });
  }
  return page({
    lang, rel, page: "track", title, desc,
    robots: avail ? "index, follow, max-image-preview:large" : "noindex, follow",
    jsonld: { "@context": "https://schema.org", "@graph": graph },
    main,
    extra: { track: { track_id: tr.track_id, status: tr.status, screenshots: tr.screenshots, name: tr.name } },
  });
}

function accountPage(lang) {
  const t = T[lang].account;
  const b = base(lang);
  const main = `
    <section class="section store-account" aria-labelledby="account-title">
      <div class="section__head">
        <span class="section__tag" data-reveal>${t.tag}</span>
        <h1 class="section__title store-h1" id="account-title">
          ${titleLines(t.h1)}
        </h1>
      </div>
      <div class="checkout-status" id="checkout-status" role="status" aria-live="polite" hidden></div>
      <div class="account-who" id="account-who" hidden></div>
      <div class="signin-panel" id="signin-panel" hidden>
        <h2>${t.signinTitle}</h2>
        <p>${esc(t.signinText)}</p>
        <a class="btn btn--primary steam-btn" id="signin-steam" href="/api/store/auth/steam/login?next=${encodeURIComponent(`${b}account/`)}&amp;lang=${lang}">${ICON.steam}<span>${T[lang].nav.signin}</span></a>
        <p class="signin-panel__venue">${t.venue} <a href="${b}commercial/#key-login">${t.venueLink}</a></p>
      </div>
      <h2 class="visually-hidden">${T[lang].nav.account}</h2>
      <div class="licence-list" id="licence-list" aria-live="polite"></div>
    </section>`;
  return page({ lang, rel: "account/", page: "account", title: t.title, desc: t.desc, robots: "noindex, follow", main });
}

function commercialPage(lang) {
  const t = T[lang].commercial;
  const b = base(lang);
  const avail = TRACKS.filter(isAvailable);
  const options = avail.length
    ? avail.map((tr) => `<option value="${tr.track_id}">${esc(tr.name)} (${esc(price(tr.prices.commercial.amount, tr.prices.commercial.currency, lang))}, ${tr.prices.commercial.max_machines} ${lang === "it" ? "postazioni" : "machines"})</option>`).join("")
    : `<option value="">${t.noneOnSale}</option>`;
  const main = `
    <section class="section" aria-labelledby="com-title">
      <div class="section__head">
        <span class="section__tag" data-reveal>${t.tag}</span>
        <h1 class="section__title store-h1" id="com-title">
          ${titleLines(t.h1)}
        </h1>
        <p class="section__lede" data-fade>${esc(t.lede)}</p>
      </div>
      <ul class="store-steps store-steps--plain">
        ${t.points.map(([h, p]) => `<li class="store-step" data-card><h2 class="store-step__h">${esc(h)}</h2><p>${esc(p)}</p></li>`).join("\n        ")}
      </ul>
    </section>

    <section class="section com-actions" aria-label="${t.buyTitle}">
      <form class="store-form store-card" id="com-buy" data-fade>
        <h2>${t.buyTitle}</h2>
        <label for="com-track">${t.trackLabel}</label>
        <select id="com-track" name="track_id"${avail.length ? "" : " disabled"}>${options}</select>
        <button type="submit" class="btn btn--primary btn--block"${avail.length ? "" : " disabled"}><span>${t.buy}</span>${ICON.arrow}</button>
        <p class="form-status" id="com-buy-status" role="status" aria-live="polite"></p>
        <p class="buy-panel__fine">${T[lang].track.policies.replace("{licence}", `${b}licence/`).replace("{refunds}", `${b}refunds/`)}</p>
      </form>
      <form class="store-form store-card" id="key-login" data-fade>
        <h2>${t.keyTitle}</h2>
        <p>${esc(t.keyText)}</p>
        <label for="licence-key">${t.keyLabel}</label>
        <input id="licence-key" name="licence_key" type="text" autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="GVC-XXXX-XXXX-XXXX-XXXX" required pattern="[A-Za-z0-9-]{10,40}" />
        <button type="submit" class="btn btn--ghost btn--block"><span>${t.keyButton}</span></button>
        <p class="form-status" id="key-status" role="status" aria-live="polite"></p>
      </form>
      <div class="store-card store-venue store-venue--col" data-fade>
        <h2>${t.moreTitle}</h2>
        <p>${esc(t.moreText)}</p>
        <div class="store-venue__actions">
          <a href="mailto:hello@globalvisions.it?subject=${encodeURIComponent(lang === "it" ? "Licenza per aziende" : "Commercial licence")}" class="btn btn--ghost">${t.write}</a>
          <a href="https://cal.com/globalvisions/30min" target="_blank" rel="noopener" class="btn btn--ghost">${t.call}</a>
        </div>
      </div>
    </section>`;
  return page({
    lang, rel: "commercial/", page: "commercial", title: t.title, desc: t.desc, main,
    jsonld: { "@context": "https://schema.org", "@graph": [breadcrumbLd([[T[lang].track.store, b], [t.tag, `${b}commercial/`]])] },
  });
}

function adminPage(lang) {
  const t = T[lang].admin;
  const a = T[lang].js.admin;
  const main = `
    <section class="section store-admin" aria-labelledby="admin-title">
      <div class="section__head">
        <h1 class="section__title store-h1" id="admin-title">
          ${titleLines(t.h1, false)}
        </h1>
      </div>
      <form class="store-form store-card" id="admin-token-form">
        <label for="admin-token">${a.tokenLabel}</label>
        <input id="admin-token" type="password" autocomplete="off" required />
        <p class="buy-panel__fine">${a.tokenHelp}</p>
        <button type="submit" class="btn btn--primary"><span>${a.enter}</span></button>
        <p class="form-status" id="admin-token-status" role="status" aria-live="polite"></p>
      </form>
      <div id="admin-app" hidden>
        <p><button type="button" class="btn btn--ghost" id="admin-forget">${a.forget}</button></p>
        <div class="store-card">
          <h2>${a.licences}</h2>
          <form class="store-form store-form--row" id="admin-search">
            <div><label for="as-steam">${a.steam}</label><input id="as-steam" name="steam_id" inputmode="numeric" autocomplete="off" /></div>
            <div><label for="as-track">${a.track}</label><select id="as-track" name="track_id"><option value="">${a.any}</option>${TRACKS.map((tr) => `<option value="${tr.track_id}">${esc(tr.name)}</option>`).join("")}</select></div>
            <div><label for="as-status">${a.status}</label><select id="as-status" name="status"><option value="">${a.any}</option><option value="active">active</option><option value="refunded">refunded</option><option value="disabled">disabled</option></select></div>
            <div><label for="as-q">${a.q}</label><input id="as-q" name="q" autocomplete="off" /></div>
            <div><button type="submit" class="btn btn--primary"><span>${a.search}</span></button></div>
          </form>
          <p class="form-status" id="admin-status" role="status" aria-live="polite"></p>
          <div class="table-wrap" id="admin-licences"></div>
        </div>
        <div class="store-card">
          <h2>${a.stats}</h2>
          <div class="table-wrap" id="admin-stats"></div>
        </div>
        <form class="store-card store-form" id="admin-trace">
          <h2>${a.trace}</h2>
          <label for="trace-id">${a.copyId}</label>
          <input id="trace-id" autocomplete="off" placeholder="cp_..." required />
          <button type="submit" class="btn btn--ghost"><span>${a.traceBtn}</span></button>
          <div id="trace-result" role="status" aria-live="polite"></div>
        </form>
      </div>
    </section>`;
  return page({ lang, rel: "admin/", page: "admin", title: t.title, desc: t.desc, robots: "noindex, nofollow", main });
}

// ---------------------------------------------------------------- policies
const POLICY = {
  licence: {
    en: `
      <p>These terms explain what you can do with a track bought from the Global Visions store. They are written to be read. If anything is unclear, write to <a href="mailto:hello@globalvisions.it">hello@globalvisions.it</a>.</p>
      <h2>Who we are</h2>
      <p>The store is run by <strong>Global Visions OÜ</strong>, Sepapaja tn 6, 15551 Tallinn, Estonia, registry code 16697227, VAT EE102615704.</p>
      <h2>What you buy</h2>
      <p>You buy a licence to use a track in Assetto Corsa, not the track itself. The track, its models, textures, scripts and data remain the property of Global Visions OÜ and of its licensors. There are two kinds of licence.</p>
      <h2>Personal licence</h2>
      <ul>
        <li>It is tied to one Steam account, identified by its Steam ID.</li>
        <li>You can install the track on the PCs you use, up to the number of machines shown on the track page (usually two), and use it on that many machines at the same time.</li>
        <li>If you change PC, you can free a machine from <a href="/store/account/">My tracks</a>. There is a short waiting time between two releases, shown on that page.</li>
        <li>It is for private use. Paid sessions, rentals and venues need a commercial licence.</li>
      </ul>
      <h2>Commercial licence</h2>
      <ul>
        <li>It is for businesses: sim centres, karting venues, schools, events and similar.</li>
        <li>It is tied to a licence key and to a set number of machines at your venue, shown on the track page. It does not need a Steam account.</li>
        <li>Your customers and staff may drive the track on those machines, including in paid sessions.</li>
      </ul>
      <h2>What you may not do</h2>
      <ul>
        <li>Share, resell, rent out or give away the track files or your licence.</li>
        <li>Upload the track, or parts of it, anywhere, including mod sites and private servers' download links.</li>
        <li>Extract, convert or reuse models, textures, sounds or scripts in other tracks, games or mods.</li>
        <li>Remove the licence file, change the scripts or try to get around the licence checks.</li>
      </ul>
      <h2>Online checks</h2>
      <p>When the track loads, and from time to time while you drive, a script in the track asks our licence server whether your licence is active. It sends only the licence id, your Steam ID (or the commercial licence key) and an opaque machine identifier generated by the track. If our server cannot be reached, the track keeps working for a grace period, so an outage on our side never stops you from driving.</p>
      <p>Race servers that use our server check let in only drivers with a valid licence for the track. Which servers use it is the server owner's choice.</p>
      <h2>Copy tracing</h2>
      <p>Every download carries a unique copy identifier. If a copy appears where it should not, we can tell which licence it came from and disable that licence.</p>
      <h2>Updates and support</h2>
      <p>The fixes and updates we publish for a track are included in your licence. If the track does not work on a supported setup, write to us and we will help, quickly.</p>
      <h2>When a licence ends</h2>
      <p>A licence ends if the purchase is refunded, and it is suspended while a chargeback is open. We may disable a licence that breaks these terms, after writing to you whenever the situation allows it.</p>
      <h2>Circuits and trademarks</h2>
      <p>Circuit names and logos belong to their owners and are used with their authorisation or only to identify the venue. <!-- TODO(legal): list the authorisation for each circuit before it goes on sale. --></p>
      <h2>Law</h2>
      <p>These terms are governed by Estonian law. If you are a consumer, you keep the protection given by the law of the country where you live.</p>`,
    it: `
      <p>Queste condizioni spiegano cosa puoi fare con un tracciato acquistato nel negozio Global Visions. Le abbiamo scritte per essere lette. Se qualcosa non è chiaro, scrivi a <a href="mailto:hello@globalvisions.it">hello@globalvisions.it</a>.</p>
      <h2>Chi siamo</h2>
      <p>Il negozio è gestito da <strong>Global Visions OÜ</strong>, Sepapaja tn 6, 15551 Tallinn, Estonia, codice di registro 16697227, partita IVA EE102615704.</p>
      <h2>Cosa acquisti</h2>
      <p>Acquisti una licenza d'uso del tracciato in Assetto Corsa, non il tracciato in sé. Il tracciato, con modelli, texture, script e dati, resta di proprietà di Global Visions OÜ e dei suoi licenzianti. Le licenze sono di due tipi.</p>
      <h2>Licenza personale</h2>
      <ul>
        <li>È legata a un account Steam, identificato dal suo Steam ID.</li>
        <li>Puoi installare il tracciato sui PC che usi, fino al numero di postazioni indicato nella pagina del tracciato (di solito due), e usarlo su quel numero di postazioni contemporaneamente.</li>
        <li>Se cambi PC puoi liberare una postazione da <a href="/it/store/account/">I miei tracciati</a>. Tra una liberazione e l'altra c'è una breve attesa, indicata in quella pagina.</li>
        <li>È per uso privato. Sessioni a pagamento, noleggi e centri simulatori richiedono una licenza per aziende.</li>
      </ul>
      <h2>Licenza per aziende</h2>
      <ul>
        <li>È pensata per le attività: centri simulatori, kartodromi, scuole, eventi e simili.</li>
        <li>È legata a una chiave di licenza e a un numero preciso di postazioni nella tua sede, indicato nella pagina del tracciato. Non serve un account Steam.</li>
        <li>Clienti e personale possono guidare il tracciato su quelle postazioni, anche in sessioni a pagamento.</li>
      </ul>
      <h2>Cosa non puoi fare</h2>
      <ul>
        <li>Condividere, rivendere, noleggiare o regalare i file del tracciato o la tua licenza.</li>
        <li>Caricare il tracciato, o parti di esso, da qualsiasi parte, compresi siti di mod e link di download di server privati.</li>
        <li>Estrarre, convertire o riutilizzare modelli, texture, suoni o script in altri tracciati, giochi o mod.</li>
        <li>Togliere il file di licenza, modificare gli script o provare ad aggirare i controlli.</li>
      </ul>
      <h2>Controlli online</h2>
      <p>Quando il tracciato si carica, e ogni tanto mentre guidi, uno script del tracciato chiede al nostro server se la licenza è attiva. Invia solo l'id della licenza, il tuo Steam ID (o la chiave della licenza per aziende) e un identificativo anonimo della postazione generato dal tracciato. Se il nostro server non risponde, il tracciato continua a funzionare per un periodo di tolleranza: un nostro guasto non ti impedisce mai di guidare.</p>
      <p>I server di gara che usano il nostro controllo fanno entrare solo i piloti con una licenza valida per quel tracciato. Usarlo o no è una scelta di chi gestisce il server.</p>
      <h2>Tracciamento delle copie</h2>
      <p>Ogni download contiene un identificativo unico della copia. Se una copia compare dove non dovrebbe, possiamo risalire alla licenza da cui proviene e disattivarla.</p>
      <h2>Aggiornamenti e assistenza</h2>
      <p>Le correzioni e gli aggiornamenti che pubblichiamo per un tracciato sono compresi nella licenza. Se il tracciato non funziona su una configurazione supportata, scrivici e ti aiutiamo in fretta.</p>
      <h2>Quando una licenza termina</h2>
      <p>La licenza termina se l'acquisto viene rimborsato ed è sospesa finché è aperta una contestazione del pagamento. Possiamo disattivare una licenza che viola queste condizioni, dopo averti scritto ogni volta che la situazione lo consente.</p>
      <h2>Circuiti e marchi</h2>
      <p>Nomi e loghi dei circuiti appartengono ai rispettivi titolari e sono usati con la loro autorizzazione o solo per indicare il luogo. <!-- TODO(legal): list the authorisation for each circuit before it goes on sale. --></p>
      <h2>Legge applicabile</h2>
      <p>Queste condizioni sono regolate dalla legge estone. Se sei un consumatore, mantieni le tutele previste dalla legge del paese in cui vivi.</p>`,
  },
  refunds: {
    en: `
      <h2>Digital content and the 14-day right</h2>
      <p>EU law gives consumers 14 days to withdraw from an online purchase. For digital content delivered straight away, that right ends when the delivery starts, if you agreed to it. At checkout you ask us to make the track available immediately and you confirm that you lose the right of withdrawal from that moment.</p>
      <h2>When we refund anyway</h2>
      <ul>
        <li><strong>Within 14 days, if you have not downloaded the track.</strong> Write to us and we refund in full.</li>
        <li><strong>At any time, if a technical problem we cannot fix stops the track from working</strong> on a supported setup: Assetto Corsa on PC with Content Manager and the Custom Shaders Patch version shown on the track page.</li>
        <li>Commercial licences follow the same rules, unless a written agreement says otherwise.</li>
      </ul>
      <h2>How to ask</h2>
      <p>Write to <a href="mailto:hello@globalvisions.it">hello@globalvisions.it</a> from the email you used at checkout, or tell us your Steam ID and the order number from your receipt. We answer within two working days.</p>
      <h2>What happens next</h2>
      <p>Refunds go back to the original payment method through Stripe and usually arrive in 5 to 10 working days. A refunded licence is revoked: downloads close and the track no longer passes the licence check, in game or on race servers.</p>
      <h2>Chargebacks</h2>
      <p>If you open a dispute with your bank, the licence is disabled while the dispute is open. Please write to us first: it is faster for everyone.</p>`,
    it: `
      <h2>Contenuti digitali e diritto di recesso</h2>
      <p>La normativa europea dà ai consumatori 14 giorni per recedere da un acquisto online. Per i contenuti digitali consegnati subito, questo diritto si perde quando la consegna inizia, se l'hai accettato. Al pagamento ci chiedi di rendere disponibile il tracciato immediatamente e confermi che da quel momento perdi il diritto di recesso.</p>
      <h2>Quando rimborsiamo comunque</h2>
      <ul>
        <li><strong>Entro 14 giorni, se non hai scaricato il tracciato.</strong> Scrivici e ti rimborsiamo per intero.</li>
        <li><strong>In qualsiasi momento, se un problema tecnico che non riusciamo a risolvere impedisce al tracciato di funzionare</strong> su una configurazione supportata: Assetto Corsa su PC con Content Manager e la versione del Custom Shaders Patch indicata nella pagina del tracciato.</li>
        <li>Le licenze per aziende seguono le stesse regole, salvo accordi scritti diversi.</li>
      </ul>
      <h2>Come chiederlo</h2>
      <p>Scrivi a <a href="mailto:hello@globalvisions.it">hello@globalvisions.it</a> dall'email usata al pagamento, oppure indicaci il tuo Steam ID e il numero d'ordine della ricevuta. Rispondiamo entro due giorni lavorativi.</p>
      <h2>Cosa succede poi</h2>
      <p>Il rimborso torna sul metodo di pagamento originale tramite Stripe e di solito arriva in 5-10 giorni lavorativi. Una licenza rimborsata viene revocata: i download si chiudono e il tracciato non supera più il controllo della licenza, né in gioco né sui server di gara.</p>
      <h2>Contestazioni con la banca</h2>
      <p>Se apri una contestazione con la tua banca, la licenza resta disattivata finché la contestazione è aperta. Scrivici prima: è più veloce per tutti.</p>`,
  },
  cookies: {
    en: `
      <p>The track store uses very few cookies, and only ones it cannot work without or that you set yourself. That is why there is no cookie banner.</p>
      <div class="table-wrap"><table class="policy-table">
        <thead><tr><th scope="col">Cookie</th><th scope="col">What it does</th><th scope="col">When it is set</th><th scope="col">Duration</th></tr></thead>
        <tbody>
          <tr><td><code>lang</code></td><td>Remembers whether you want the site in English or Italian.</td><td>Only when you use the EN/IT switch.</td><td>12 months</td></tr>
          <tr><td><code>gv_session</code></td><td>Keeps you signed in. It holds your Steam ID (or your commercial licence) in a signed form. Strictly necessary. HttpOnly, not readable by scripts.</td><td>Only when you sign in through Steam or with a licence key.</td><td>30 days, or until you sign out</td></tr>
          <tr><td><code>gv_state</code></td><td>Protects the Steam sign in against forged requests. Strictly necessary.</td><td>During sign in through Steam.</td><td>10 minutes</td></tr>
        </tbody>
      </table></div>
      <h2>Stripe</h2>
      <p>Payment happens on Stripe Checkout, on stripe.com. Stripe uses its own cookies there to process the payment and prevent fraud, under <a href="https://stripe.com/cookie-settings" rel="noopener">Stripe's cookie policy</a>.</p>
      <h2>Steam</h2>
      <p>When you sign in, you go to steamcommunity.com, which uses its own cookies under Valve's policies. We receive only your Steam ID.</p>
      <h2>No analytics or marketing cookies</h2>
      <p>We count visits with Vercel Web Analytics, which uses no cookies and stores nothing on your device. We do not use advertising or tracking cookies. Fonts and scripts are served from our own domain.</p>
      <h2>Removing cookies</h2>
      <p>Signing out deletes <code>gv_session</code>. You can delete any cookie from your browser settings at any time. More on how we handle data in the <a href="/privacy.html">privacy policy</a>.</p>`,
    it: `
      <p>Il negozio dei tracciati usa pochissimi cookie, solo quelli senza cui non potrebbe funzionare o che imposti tu. Per questo non c'è un banner dei cookie.</p>
      <div class="table-wrap"><table class="policy-table">
        <thead><tr><th scope="col">Cookie</th><th scope="col">A cosa serve</th><th scope="col">Quando viene impostato</th><th scope="col">Durata</th></tr></thead>
        <tbody>
          <tr><td><code>lang</code></td><td>Ricorda se vuoi il sito in inglese o in italiano.</td><td>Solo quando usi il selettore EN/IT.</td><td>12 mesi</td></tr>
          <tr><td><code>gv_session</code></td><td>Mantiene l'accesso. Contiene il tuo Steam ID (o la licenza per aziende) in forma firmata. Strettamente necessario. HttpOnly, non leggibile dagli script.</td><td>Solo quando accedi con Steam o con una chiave di licenza.</td><td>30 giorni, o finché non esci</td></tr>
          <tr><td><code>gv_state</code></td><td>Protegge l'accesso con Steam da richieste contraffatte. Strettamente necessario.</td><td>Durante l'accesso con Steam.</td><td>10 minuti</td></tr>
        </tbody>
      </table></div>
      <h2>Stripe</h2>
      <p>Il pagamento avviene su Stripe Checkout, su stripe.com. Lì Stripe usa i propri cookie per elaborare il pagamento e prevenire le frodi, secondo la <a href="https://stripe.com/cookie-settings" rel="noopener">politica sui cookie di Stripe</a>.</p>
      <h2>Steam</h2>
      <p>Quando accedi passi da steamcommunity.com, che usa i propri cookie secondo le regole di Valve. A noi arriva solo il tuo Steam ID.</p>
      <h2>Nessun cookie di statistica o marketing</h2>
      <p>Contiamo le visite con Vercel Web Analytics, che non usa cookie e non salva nulla sul tuo dispositivo. Non usiamo cookie pubblicitari o di tracciamento. Font e script arrivano dal nostro dominio.</p>
      <h2>Cancellare i cookie</h2>
      <p>Uscendo cancelli <code>gv_session</code>. Puoi eliminare qualsiasi cookie dalle impostazioni del browser quando vuoi. Il modo in cui trattiamo i dati è spiegato nell'<a href="/it/privacy.html">informativa privacy</a>.</p>`,
  },
};

function policyPage(lang, key) {
  const t = T[lang][key];
  const b = base(lang);
  const body = POLICY[key][lang].replace(/href="\/store\//g, `href="${b}`);
  const main = `
    <div class="legal store-legal">
      <!-- TODO(legal): review before launch -->
      <h1 data-fade>${t.h1}</h1>
      <p class="legal__meta" data-fade>${T[lang].updated}</p>
      <div data-fade>
${body}
        <p><a href="${b}" class="btn btn--ghost legal__back">${T[lang].track.store}</a></p>
      </div>
    </div>`;
  return page({
    lang, rel: PAGES[key], page: key, title: t.title, desc: t.desc, main,
    jsonld: { "@context": "https://schema.org", "@graph": [breadcrumbLd([[T[lang].track.store, b], [t.h1, `${b}${PAGES[key]}`]])] },
  });
}

// ---------------------------------------------------------------- build
const out = [];
for (const lang of LANGS) {
  const prefix = lang === "it" ? "it/store/" : "store/";
  const files = {
    "index.html": gridPage(lang),
    "account/index.html": accountPage(lang),
    "commercial/index.html": commercialPage(lang),
    "admin/index.html": adminPage(lang),
    "licence/index.html": policyPage(lang, "licence"),
    "refunds/index.html": policyPage(lang, "refunds"),
    "cookies/index.html": policyPage(lang, "cookies"),
  };
  for (const tr of TRACKS) files[`${tr.track_id}/index.html`] = trackPage(lang, tr);
  for (const [rel, html] of Object.entries(files)) {
    if (/—/.test(html)) throw new Error(`em dash found in ${prefix}${rel}`);
    write(prefix + rel, html);
    out.push(prefix + rel);
  }
}

// Sitemap: replace the store block, keep everything else.
const sitemapFile = path.join(ROOT, "sitemap.xml");
let sitemap = fs.readFileSync(sitemapFile, "utf8");
const indexable = ["", "commercial/", "licence/", "refunds/", "cookies/", ...TRACKS.filter(isAvailable).map((t) => `${t.track_id}/`)];
const entries = indexable.flatMap((rel) => LANGS.map((lang) => `  <url>
    <loc>${SITE}${url(lang, rel)}</loc>
    <lastmod>${UPDATED}</lastmod>
    <xhtml:link rel="alternate" hreflang="en" href="${SITE}${url("en", rel)}" />
    <xhtml:link rel="alternate" hreflang="it" href="${SITE}${url("it", rel)}" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${url("en", rel)}" />
  </url>`)).join("\n");
const block = `  <!-- store:start (generated by tools/build-store.mjs) -->\n${entries}\n  <!-- store:end -->`;
if (sitemap.includes("<!-- store:start")) {
  sitemap = sitemap.replace(/  <!-- store:start[\s\S]*?<!-- store:end -->/, block);
} else {
  sitemap = sitemap.replace("</urlset>", `${block}\n</urlset>`);
}
fs.writeFileSync(sitemapFile, sitemap);

console.log(`Wrote ${out.length} pages and updated sitemap.xml`);
