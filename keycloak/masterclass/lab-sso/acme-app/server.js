// ACME Demo-Anwendung für das SSO-Lab.
// Eine Codebasis, zwei Instanzen (Timetracking / Reisekosten) – gesteuert über Umgebungsvariablen.
// Oberfläche zweisprachig (DE/EN): Sprache aus Accept-Language, umschaltbar per ?lang=de|en.
// Jede Instanz hat ihre EIGENE lokale Session (Cookie), unabhängig von der Keycloak-SSO-Session.
import express from 'express';
import session from 'express-session';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as client from 'openid-client';

const env = (name, fallback) => process.env[name] ?? fallback;

const APP_VARIANT = env('APP_VARIANT', 'timetracking'); // timetracking | travel
const APP_COLOR = env('APP_COLOR', '#1f6feb');
const PORT = Number(env('PORT', '3000'));
const BASE_URL = env('BASE_URL', 'http://localhost:8081'); // URL, unter der der Browser die App erreicht
const OIDC_ISSUER_INTERNAL = env('OIDC_ISSUER_INTERNAL', 'http://keycloak:8080/realms/lab-realm');
const CLIENT_ID = env('CLIENT_ID', '');
const CLIENT_SECRET = env('CLIENT_SECRET', '');
const SESSION_COOKIE_NAME = env('SESSION_COOKIE_NAME', 'acme_sid'); // Cookies auf localhost sind nicht portgetrennt!
const SESSION_SECRET = env('SESSION_SECRET', 'change-me');
const LANG_COOKIE_NAME = 'acme_lang'; // bewusst für beide Apps gleich – gilt dank localhost-Cookies für beide

// ---------------------------------------------------------------------------
// OIDC-Konfiguration
// Die Metadaten werden intern von keycloak:8080 geladen. Keycloak liefert dank
// KC_HOSTNAME + KC_HOSTNAME_BACKCHANNEL_DYNAMIC die Browser-Endpunkte (auth, logout, issuer)
// mit localhost:8080 und die Backend-Endpunkte (token, userinfo, jwks) mit keycloak:8080.
// client.discovery() würde am Issuer-Vergleich scheitern, daher bauen wir die Configuration selbst.
// ---------------------------------------------------------------------------
let oidcConfigPromise;
let jwks;

async function loadOidcConfig() {
  const res = await fetch(`${OIDC_ISSUER_INTERNAL}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Discovery failed: HTTP ${res.status}`);
  const metadata = await res.json();
  const config = new client.Configuration(metadata, CLIENT_ID, CLIENT_SECRET);
  client.allowInsecureRequests(config); // nur fürs Lab: HTTP statt HTTPS
  jwks = createRemoteJWKSet(new URL(metadata.jwks_uri)); // für die Prüfung von Logout-Tokens
  return config;
}

function getOidcConfig() {
  // Lazy-Init: Keycloak braucht beim Start etwas länger – bei Fehler beim nächsten Request erneut versuchen
  oidcConfigPromise ??= loadOidcConfig().catch((err) => {
    oidcConfigPromise = undefined;
    throw err;
  });
  return oidcConfigPromise;
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();

// Für den Backchannel-Logout muss die App ihre Sessions OHNE Browser-Cookie finden können:
// daher ein eigener Store-Zugriff und ein Index Keycloak-sid → lokale Session-IDs.
const store = new session.MemoryStore();
const sidIndex = new Map();

app.use(
  session({
    name: SESSION_COOKIE_NAME,
    secret: SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  }),
);

// Sprache bestimmen: ?lang=… (wird im Cookie gemerkt) > Cookie > Accept-Language
app.use((req, res, next) => {
  const cookieLang = /(?:^|;\s*)acme_lang=(de|en)/.exec(req.headers.cookie ?? '')?.[1];
  const queryLang = ['de', 'en'].includes(req.query.lang) ? req.query.lang : undefined;
  if (queryLang) res.cookie(LANG_COOKIE_NAME, queryLang, { sameSite: 'lax', maxAge: 365 * 24 * 3600 * 1000 });
  req.lang = queryLang ?? cookieLang ?? (req.acceptsLanguages('de', 'en') || 'en');
  next();
});

app.get('/', (req, res) => {
  const v = views(req.lang);
  if (!CLIENT_SECRET) return res.send(v.page(v.notConfigured()));
  const user = req.session.user;
  const flash = req.session.flash;
  delete req.session.flash;
  res.send(v.page(user ? v.home(req.session, flash) : v.login(flash)));
});

app.get('/login', async (req, res) => {
  const config = await getOidcConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  req.session.auth = { codeVerifier, state, nonce };

  const authUrl = client.buildAuthorizationUrl(config, {
    redirect_uri: `${BASE_URL}/callback`,
    scope: 'openid profile email',
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce,
    ui_locales: req.lang, // Keycloak-Login-Seite in derselben Sprache
  });
  res.redirect(authUrl.href);
});

app.get('/callback', async (req, res) => {
  const config = await getOidcConfig();
  const auth = req.session.auth;
  if (!auth) return res.redirect('/');
  delete req.session.auth;

  const tokens = await client.authorizationCodeGrant(config, new URL(req.originalUrl, BASE_URL), {
    pkceCodeVerifier: auth.codeVerifier,
    expectedState: auth.state,
    expectedNonce: auth.nonce,
  });

  // Ab hier lebt der Benutzer in der lokalen App-Session – Keycloak wird nicht mehr gefragt.
  req.session.user = tokens.claims();
  req.session.loginAt = Date.now();
  storeTokens(req.session, tokens);
  indexSession(req.session.user.sid, req.sessionID);
  res.redirect('/');
});

app.post('/refresh', async (req, res) => {
  if (!req.session.user) return res.redirect('/');
  const config = await getOidcConfig();
  try {
    const tokens = await client.refreshTokenGrant(config, req.session.refreshToken);
    storeTokens(req.session, tokens);
    req.session.flash = { type: 'ok', key: 'refreshOk' };
  } catch (err) {
    // Bewusst KEIN Logout: die App ignoriert den Fehler und bleibt „eingeloggt“.
    req.session.flash = { type: 'error', key: 'refreshFailed', detail: errorDetail(err) };
  }
  res.redirect('/');
});

app.post('/logout', async (req, res) => {
  const config = await getOidcConfig();
  const idToken = req.session.idToken;
  sidIndex.get(req.session.user?.sid)?.delete(req.sessionID);
  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE_NAME);
    // RP-initiated Logout: beendet die SSO-Session in Keycloak
    const logoutUrl = client.buildEndSessionUrl(config, {
      id_token_hint: idToken,
      post_logout_redirect_uri: `${BASE_URL}/`,
    });
    res.redirect(logoutUrl.href);
  });
});

// Bonus: OIDC Back-Channel Logout. Keycloak ruft diesen Endpoint direkt (Server-zu-Server) auf,
// sobald die SSO-Session beendet wird – ohne Browser, also ohne Session-Cookie.
app.post('/backchannel-logout', express.urlencoded({ extended: false }), async (req, res) => {
  const config = await getOidcConfig();
  let payload;
  try {
    ({ payload } = await jwtVerify(req.body.logout_token ?? '', jwks, {
      issuer: config.serverMetadata().issuer,
      audience: CLIENT_ID,
    }));
    if (!payload.events?.['http://schemas.openid.net/event/backchannel-logout']) throw new Error('events claim missing');
    if (payload.nonce) throw new Error('logout token must not contain a nonce');
    if (!payload.sid) throw new Error('sid missing (Backchannel logout session required?)');
  } catch (err) {
    console.warn(`Backchannel logout rejected: ${err.message}`);
    return res.status(400).json({ error: 'invalid_request', error_description: err.message });
  }

  const sessionIds = sidIndex.get(payload.sid) ?? new Set();
  sidIndex.delete(payload.sid);
  await Promise.all([...sessionIds].map((id) => new Promise((resolve) => store.destroy(id, resolve))));
  console.log(`Backchannel logout from Keycloak: sid=${payload.sid} → ${sessionIds.size} local session(s) terminated`);
  res.set('Cache-Control', 'no-store').sendStatus(200);
});

app.use((err, req, res, _next) => {
  console.error(err);
  const v = views(req.lang ?? 'en');
  res.status(500).send(v.page(v.error(err)));
});

app.listen(PORT, () => console.log(`${TEXT.en.title} listening on port ${PORT} (${BASE_URL})`));

function indexSession(sid, sessionId) {
  if (!sidIndex.has(sid)) sidIndex.set(sid, new Set());
  sidIndex.get(sid).add(sessionId);
}

function errorDetail(err) {
  return err.error_description ? `${err.error}: ${err.error_description}` : err.message;
}

function storeTokens(sess, tokens) {
  sess.idToken = tokens.id_token ?? sess.idToken;
  sess.accessToken = tokens.access_token;
  sess.refreshToken = tokens.refresh_token ?? sess.refreshToken;
  sess.accessTokenExpiresAt = Date.now() + (tokens.expiresIn() ?? 0) * 1000;
}

// ---------------------------------------------------------------------------
// Texte (DE/EN)
// ---------------------------------------------------------------------------
const TITLES = {
  timetracking: { de: 'ACME Timetracking', en: 'ACME Timetracking' },
  travel: { de: 'ACME Reisekostenabrechnung', en: 'ACME Travel Expenses' },
};

const TEXT = {
  de: {
    locale: 'de-DE',
    title: TITLES[APP_VARIANT].de,
    logout: 'Abmelden',
    welcome: (title) => `Willkommen bei ${title}`,
    pleaseLogin: 'Bitte melde dich mit deinem ACME-Konto an.',
    loginButton: 'Mit ACME-Login (Keycloak) anmelden',
    sessionInfo: 'Session-Info',
    user: 'Benutzer',
    client: 'Client',
    kcSession: 'Keycloak-Session (sid)',
    loginAt: 'Login in dieser App',
    tokenValidUntil: 'Access Token gültig bis',
    expired: 'abgelaufen',
    refreshButton: 'Token erneuern (Refresh)',
    idTokenClaims: 'ID-Token-Claims',
    refreshOk: 'Token erfolgreich erneuert – die Keycloak-Session ist aktiv.',
    refreshFailed: (detail) => `Keycloak lehnt den Refresh ab (${detail}).`,
    hello: (name, what) => `Hallo ${name}, hier sind deine ${what}.`,
    timetracking: {
      heading: 'Meine Zeitbuchungen – aktuelle Woche',
      what: 'Buchungen',
      cols: ['Tag', 'Projekt', 'Tätigkeit', 'Stunden'],
      total: 'Summe',
      rows: [
        ['Mo', 'KC-Masterclass', 'Vorbereitung Lab SSO', 6.5],
        ['Di', 'KC-Masterclass', 'Durchführung Tag 1', 8.0],
        ['Mi', 'KC-Masterclass', 'Durchführung Tag 2', 8.0],
        ['Do', 'Kunde Nordstern', 'Keycloak-Upgrade 26.x', 7.5],
        ['Fr', 'Intern', 'Weiterbildung', 4.0],
      ],
    },
    travel: {
      heading: 'Meine Reisekostenabrechnungen',
      what: 'Abrechnungen',
      cols: ['Nr.', 'Reise', 'Zeitraum', 'Betrag', 'Status'],
      rows: [
        ['RK-2026-041', 'Kundentermin Hamburg', '02.09.–03.09.', 412.8, 'Erstattet'],
        ['RK-2026-047', 'Konferenz München', '17.09.–19.09.', 896.4, 'Genehmigt'],
        ['RK-2026-052', 'Schulung Berlin', '29.09.–01.10.', 538.1, 'In Prüfung'],
      ],
    },
    notConfigured: {
      heading: 'Client noch nicht konfiguriert',
      intro: (title) => `Für <b>${title}</b> ist noch kein Client Secret hinterlegt.`,
      steps: (clientId) => [
        `Legt in Keycloak den Client <code>${clientId}</code> an.`,
        'Tragt das Secret (Tab <i>Credentials</i>) in der <code>docker-compose.yaml</code> bei <code>CLIENT_SECRET</code> ein.',
        'Startet die App neu: <code>docker compose up -d</code>',
      ],
    },
    error: 'Fehler',
    errorHint: 'Läuft Keycloak schon? Stimmen Client ID, Secret und Redirect URI?',
    home: 'Zur Startseite',
  },
  en: {
    locale: 'en-GB',
    title: TITLES[APP_VARIANT].en,
    logout: 'Sign out',
    welcome: (title) => `Welcome to ${title}`,
    pleaseLogin: 'Please sign in with your ACME account.',
    loginButton: 'Sign in with ACME Login (Keycloak)',
    sessionInfo: 'Session info',
    user: 'User',
    client: 'Client',
    kcSession: 'Keycloak session (sid)',
    loginAt: 'Login to this app',
    tokenValidUntil: 'Access token valid until',
    expired: 'expired',
    refreshButton: 'Refresh token',
    idTokenClaims: 'ID token claims',
    refreshOk: 'Token refreshed successfully – the Keycloak session is active.',
    refreshFailed: (detail) => `Keycloak rejects the refresh (${detail}).`,
    hello: (name, what) => `Hello ${name}, here are your ${what}.`,
    timetracking: {
      heading: 'My time bookings – current week',
      what: 'bookings',
      cols: ['Day', 'Project', 'Activity', 'Hours'],
      total: 'Total',
      rows: [
        ['Mon', 'KC Masterclass', 'Preparing lab SSO', 6.5],
        ['Tue', 'KC Masterclass', 'Training day 1', 8.0],
        ['Wed', 'KC Masterclass', 'Training day 2', 8.0],
        ['Thu', 'Customer Nordstern', 'Keycloak upgrade 26.x', 7.5],
        ['Fri', 'Internal', 'Professional development', 4.0],
      ],
    },
    travel: {
      heading: 'My travel expense claims',
      what: 'claims',
      cols: ['No.', 'Trip', 'Period', 'Amount', 'Status'],
      rows: [
        ['RK-2026-041', 'Customer meeting Hamburg', '2–3 Sep', 412.8, 'Reimbursed'],
        ['RK-2026-047', 'Conference Munich', '17–19 Sep', 896.4, 'Approved'],
        ['RK-2026-052', 'Training Berlin', '29 Sep–1 Oct', 538.1, 'In review'],
      ],
    },
    notConfigured: {
      heading: 'Client not configured yet',
      intro: (title) => `No client secret has been configured for <b>${title}</b> yet.`,
      steps: (clientId) => [
        `Create the client <code>${clientId}</code> in Keycloak.`,
        'Put the secret (tab <i>Credentials</i>) into <code>docker-compose.yaml</code> under <code>CLIENT_SECRET</code>.',
        'Restart the app: <code>docker compose up -d</code>',
      ],
    },
    error: 'Error',
    errorHint: 'Is Keycloak running yet? Are client ID, secret and redirect URI correct?',
    home: 'Back to start page',
  },
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function views(lang) {
  const t = TEXT[lang];
  const time = (ms) => new Date(ms).toLocaleTimeString(t.locale);
  const eur = (n) => n.toLocaleString(t.locale, { style: 'currency', currency: 'EUR' });

  function page(body) {
    return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.title)}</title>
<style>
  :root { --brand: ${APP_COLOR}; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #f4f5f7; color: #1d2330; }
  header { background: var(--brand); color: #fff; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  header h1 { margin: 0; font-size: 1.3rem; }
  header .right { display: flex; align-items: center; gap: 16px; }
  header .lang a { color: #fff; opacity: .7; text-decoration: none; font-size: .9rem; }
  header .lang a.active { opacity: 1; font-weight: bold; }
  main { max-width: 960px; margin: 24px auto; padding: 0 16px; display: grid; gap: 16px; }
  .card { background: #fff; border-radius: 8px; padding: 16px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card h2 { margin-top: 0; font-size: 1.1rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; }
  th { font-size: .85rem; color: #555; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
  dt { color: #555; } dd { margin: 0; font-family: ui-monospace, monospace; word-break: break-all; }
  button, .button { background: var(--brand); color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font-size: .95rem; cursor: pointer; text-decoration: none; display: inline-block; }
  button.secondary { background: #fff; color: var(--brand); border: 1px solid var(--brand); }
  header button { background: #fff; color: var(--brand); }
  form { display: inline; }
  .flash { padding: 10px 14px; border-radius: 6px; }
  .flash.ok { background: #e6f4ea; color: #1e6b34; }
  .flash.error { background: #fdecea; color: #9b1c1c; }
  .badge { padding: 2px 8px; border-radius: 10px; font-size: .8rem; background: #eef; }
  .expired { color: #9b1c1c; font-weight: bold; }
  pre { background: #f4f5f7; padding: 10px; overflow-x: auto; font-size: .8rem; }
</style>
</head>
<body>${body}</body>
</html>`;
  }

  function header(user) {
    const langSwitch = ['de', 'en']
      .map((l) => `<a href="/?lang=${l}" class="${l === lang ? 'active' : ''}">${l.toUpperCase()}</a>`)
      .join(' | ');
    const userPart = user
      ? `<span>${esc(user.name ?? user.preferred_username)}</span><form method="post" action="/logout"><button>${t.logout}</button></form>`
      : '';
    return `<header><h1>${esc(t.title)}</h1><div class="right"><span class="lang">${langSwitch}</span>${userPart}</div></header>`;
  }

  function flashView(flash) {
    if (!flash) return '';
    const text = flash.key === 'refreshFailed' ? t.refreshFailed(flash.detail) : t[flash.key];
    return `<div class="flash ${flash.type}">${esc(text)}</div>`;
  }

  function login(flash) {
    return `${header()}
<main>
  ${flashView(flash)}
  <div class="card">
    <h2>${esc(t.welcome(t.title))}</h2>
    <p>${t.pleaseLogin}</p>
    <a class="button" href="/login">${t.loginButton}</a>
  </div>
</main>`;
  }

  function home(sess, flash) {
    const user = sess.user;
    const expired = Date.now() > sess.accessTokenExpiresAt;
    return `${header(user)}
<main>
  ${flashView(flash)}
  ${APP_VARIANT === 'travel' ? travelContent(user) : timetrackingContent(user)}
  <div class="card">
    <h2>${t.sessionInfo}</h2>
    <dl>
      <dt>${t.user}</dt><dd>${esc(user.preferred_username)} (${esc(user.email)})</dd>
      <dt>${t.client}</dt><dd>${esc(CLIENT_ID)}</dd>
      <dt>${t.kcSession}</dt><dd>${esc(user.sid)}</dd>
      <dt>${t.loginAt}</dt><dd>${time(sess.loginAt)}</dd>
      <dt>${t.tokenValidUntil}</dt><dd class="${expired ? 'expired' : ''}">${time(sess.accessTokenExpiresAt)}${expired ? ` (${t.expired})` : ''}</dd>
    </dl>
    <p>
      <form method="post" action="/refresh"><button class="secondary">${t.refreshButton}</button></form>
    </p>
    <details><summary>${t.idTokenClaims}</summary><pre>${esc(JSON.stringify(user, null, 2))}</pre></details>
  </div>
</main>`;
  }

  function timetrackingContent(user) {
    const c = t.timetracking;
    const total = c.rows.reduce((sum, r) => sum + r[3], 0);
    return `<div class="card">
    <h2>${c.heading}</h2>
    <p>${esc(t.hello(user.given_name ?? user.preferred_username, c.what))}</p>
    <table>
      <tr>${c.cols.map((col) => `<th>${col}</th>`).join('')}</tr>
      ${c.rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3].toFixed(1)}</td></tr>`).join('')}
      <tr><th colspan="3">${c.total}</th><th>${total.toFixed(1)}</th></tr>
    </table>
  </div>`;
  }

  function travelContent(user) {
    const c = t.travel;
    return `<div class="card">
    <h2>${c.heading}</h2>
    <p>${esc(t.hello(user.given_name ?? user.preferred_username, c.what))}</p>
    <table>
      <tr>${c.cols.map((col) => `<th>${col}</th>`).join('')}</tr>
      ${c.rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${eur(r[3])}</td><td><span class="badge">${r[4]}</span></td></tr>`).join('')}
    </table>
  </div>`;
  }

  function notConfigured() {
    const c = t.notConfigured;
    return `${header()}
<main>
  <div class="card">
    <h2>${c.heading}</h2>
    <p>${c.intro(esc(t.title))}</p>
    <ol>${c.steps(esc(CLIENT_ID)).map((step) => `<li>${step}</li>`).join('')}</ol>
  </div>
</main>`;
  }

  function error(err) {
    return `${header()}
<main>
  <div class="card">
    <h2>${t.error}</h2>
    <div class="flash error">${esc(errorDetail(err))}</div>
    <p>${t.errorHint}</p>
    <a class="button" href="/">${t.home}</a>
  </div>
</main>`;
  }

  return { page, home, login, notConfigured, error };
}
