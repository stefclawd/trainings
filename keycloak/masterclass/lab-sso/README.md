# Lab SSO

## DE

Ziel: Ihr lernt, wie Single Sign-On (SSO) in der Praxis funktioniert, indem ihr zwei typische Unternehmensanwendungen – **ACME Timetracking** und **ACME Reisekostenabrechnung** – über Keycloak verbindet und das SSO-Verhalten sowie das Session-Management beobachtet.

Beide Anwendungen sind kleine Node.js-Web-Apps (Quellcode in `acme-app/`), die sich per OpenID Connect (Authorization Code Flow) an Keycloak anmelden. Nach dem Login merkt sich jede App den Benutzer in ihrer **eigenen, lokalen Session** (Cookie) – genau wie die meisten echten Anwendungen. Zusätzlich merkt sich auch Keycloak den angemeldeten Benutzer in der **SSO-Session** (Cookies `KEYCLOAK_IDENTITY` / `KEYCLOAK_SESSION`). Genau diese SSO-Session sorgt dafür, dass ihr euch bei der zweiten App nicht erneut anmelden müsst. Es gibt also drei Sessions: eine pro App und eine in Keycloak.

Die Apps sind zweisprachig (DE/EN): Die Sprache richtet sich nach dem Browser und lässt sich oben rechts umschalten (`DE | EN`). Die Login-Seite von Keycloak erscheint in derselben Sprache.

Hinweis: Für diese Übung ist im Realm `lab-realm` die **Access Token Lifespan auf 15 Minuten** hochgesetzt (Standard: 5 Minuten, siehe `Realm settings` → `Tokens`). So bleibt genug Zeit, alle Schritte in Ruhe durchzuführen, bevor das Access Token abläuft.

| Anwendung                  | URL                   | Client / Zugangsdaten             |
|----------------------------|-----------------------|------------------------------------|
| Keycloak Admin Console     | http://localhost:8080 | `admin` / `admin`                  |
| Testbenutzer (für die Apps) | –                    | `testuser` / `testuser`            |
| ACME Timetracking          | http://localhost:8081 | `acme-timetracking` (vorkonfiguriert) |
| ACME Reisekostenabrechnung | http://localhost:8082 | `acme-travel` (legt ihr selbst an) |

1) Startet das Lab via `docker compose up --build`. Der Realm `lab-realm` mit dem Client `acme-timetracking` und einem Testbenutzer (`testuser` / `testuser`) wird automatisch importiert.
2) Prüft in der Keycloak Admin Console (http://localhost:8080), ob der Realm `lab-realm`, der Client `acme-timetracking` und der Testbenutzer vorhanden sind. Schaut euch die Einstellungen des Clients an (Redirect URI, Post Logout Redirect URI, Credentials).
3) Öffnet ACME Timetracking (http://localhost:8081), klickt auf `Mit ACME-Login (Keycloak) anmelden` – ihr werdet zur Login-Seite von Keycloak (Realm `lab-realm`) weitergeleitet. Meldet euch dort mit Benutzername `testuser` und Passwort `testuser` an (nicht mit dem Admin-Account!). Danach leitet Keycloak euch zurück in die App. Schaut euch die Box `Session-Info` an – insbesondere die Keycloak-Session-ID (`sid`).
4) Öffnet ACME Reisekostenabrechnung (http://localhost:8082) – die App meldet, dass noch kein Client konfiguriert ist. Legt den Client in der Admin Console im Realm `lab-realm` an:
   * Clients → `Create client`
   * Client type: `OpenID Connect`, Client ID: `acme-travel`, Name: `ACME Reisekostenabrechnung`
   * Client authentication: `On`, Authentication flow: nur `Standard flow`
   * Valid redirect URIs: `http://localhost:8082/callback`
   * Valid post logout redirect URIs: `http://localhost:8082/`
   * Web origins: `http://localhost:8082`
   * Speichern, im Tab `Credentials` das Client Secret kopieren
   * Tragt das Secret in der `docker-compose.yaml` beim Service `acme-travel` unter `CLIENT_SECRET` ein und startet die App neu: `docker compose up -d acme-travel`
5) Testet SSO: Öffnet ACME Reisekostenabrechnung (http://localhost:8082) in einem neuen Tab und klickt auf `Mit ACME-Login (Keycloak) anmelden`. Da ihr bereits über Timetracking bei Keycloak eingeloggt seid, solltet ihr ohne erneute Passworteingabe eingeloggt werden. Vergleicht die `sid` in beiden Apps.
6) Schaut euch die Sessions in der Admin Console für den Realm `lab-realm` an (`Sessions` bzw. beim Benutzer `testuser` → `Sessions`). Wie viele SSO-Sessions gibt es, welche Clients hängen daran?
7) Meldet euch in der ACME Reisekostenabrechnung ab (`Abmelden`) und prüft die Sessions in der Admin Console → die SSO-Session sollte weg sein.
8) Ladet ACME Timetracking neu. Seid ihr noch eingeloggt? → Wir haben eine **Zombie-Session**: Die lokale Session der App lebt weiter, obwohl die SSO-Session in Keycloak beendet ist.
9) Klickt in ACME Timetracking auf `Token erneuern (Refresh)`. Keycloak lehnt den Refresh ab (`Session not active`) – die App ignoriert das jedoch und bleibt „eingeloggt“.
10) Diskussion: Warum entsteht die Zombie-Session? Welche Möglichkeiten gibt es, sie zu vermeiden?

### Bonus: Zombie-Session per Backchannel-Logout beseitigen

Beim Backchannel-Logout (OIDC Back-Channel Logout) ruft Keycloak beim Beenden der SSO-Session jede beteiligte App **direkt von Server zu Server** auf und schickt ein signiertes Logout-Token (JWT) mit der `sid`. Die ACME-Apps bringen dafür bereits den Endpoint `/backchannel-logout` mit (siehe `acme-app/server.js`). Er prüft das Token und beendet alle lokalen Sessions mit dieser `sid`.

11) Öffnet in Keycloak den Client `acme-timetracking` → Tab `Settings` → Abschnitt `Logout settings`:
    * Front channel logout: `Off` (sonst verwendet Keycloak für diesen Client den Front-Channel statt des Backchannels)
    * Backchannel logout URL: `http://acme-timetracking:3000/backchannel-logout`
    * Backchannel logout session required: `On`
    * Speichern

    Achtung: Hier steht der **interne** Docker-Name und -Port, weil Keycloak die App selbst aufruft – nicht der Browser.
12) Verfolgt die Logs der Apps in einem eigenen Terminal: `docker compose logs -f acme-timetracking acme-travel`
13) Meldet euch in beiden Apps wieder an (SSO) und meldet euch dann in der ACME Reisekostenabrechnung ab. Im Log von `acme-timetracking` erscheint `Backchannel logout from Keycloak: sid=… → 1 local session(s) terminated`.
14) Ladet ACME Timetracking neu → ihr seid abgemeldet, keine Zombie-Session mehr.
15) Konfiguriert den Backchannel-Logout auch beim Client `acme-travel`: Backchannel logout URL `http://acme-travel:3000/backchannel-logout` und **Front channel logout `Off`** – bei im Admin-UI angelegten Clients ist der Front-Channel standardmäßig aktiv! Meldet euch in beiden Apps an und beendet die Session diesmal in der Admin Console (`Sessions` → `⋮` → `Sign out`). Was passiert in beiden Apps?
16) Diskussion:
    * Warum muss die App ihre Sessions über die `sid` finden können, und warum reicht ein Session-Cookie hier nicht?
    * Was passiert, wenn Keycloak die App nicht erreicht (Netzwerk, App down) oder wenn mehrere App-Instanzen laufen?
    * Wird ein Backchannel-Logout auch ausgelöst, wenn die SSO-Session in Keycloak einfach abläuft (Timeout)?
    * Was passiert beim `Sign out` in der Admin Console mit einem Client, der auf Front channel logout steht?

## EN

Goal: You will learn how Single Sign-On (SSO) works in practice by connecting two typical enterprise applications – **ACME Timetracking** and **ACME Travel Expenses** – through Keycloak and observing SSO behavior and session management.

Both applications are small Node.js web apps (source code in `acme-app/`) that log in to Keycloak via OpenID Connect (Authorization Code Flow). After login, each app keeps the user in its **own local session** (cookie) – just like most real-world applications. In addition, Keycloak also keeps the logged-in user in the **SSO session** (cookies `KEYCLOAK_IDENTITY` / `KEYCLOAK_SESSION`). This SSO session is what lets you into the second app without logging in again. So there are three sessions: one per app and one in Keycloak.

The apps are bilingual (DE/EN): the language follows your browser and can be switched in the top right corner (`DE | EN`). The Keycloak login page is shown in the same language.

Note: For this exercise, the **access token lifespan** in the realm `lab-realm` has been **increased to 15 minutes** (default: 5 minutes, see `Realm settings` → `Tokens`). This leaves enough time to complete all steps calmly before the access token expires.

| Application                | URL                   | Client / credentials                 |
|----------------------------|-----------------------|---------------------------------------|
| Keycloak Admin Console     | http://localhost:8080 | `admin` / `admin`                     |
| Test user (for the apps)   | –                     | `testuser` / `testuser`               |
| ACME Timetracking          | http://localhost:8081 | `acme-timetracking` (preconfigured)   |
| ACME Travel Expenses       | http://localhost:8082 | `acme-travel` (you create it yourself) |

1) Start the lab via `docker compose up --build`. The realm `lab-realm` with the client `acme-timetracking` and a test user (`testuser` / `testuser`) will be imported automatically.
2) Verify in the Keycloak Admin Console (http://localhost:8080) that the realm `lab-realm`, the client `acme-timetracking`, and the test user exist. Take a look at the client settings (redirect URI, post logout redirect URI, credentials).
3) Open ACME Timetracking (http://localhost:8081), click `Sign in with ACME Login (Keycloak)` – you will be redirected to the Keycloak login page (realm `lab-realm`). Log in there with username `testuser` and password `testuser` (not with the admin account!). Keycloak then redirects you back to the app. Look at the `Session info` box – especially the Keycloak session ID (`sid`).
4) Open ACME Travel Expenses (http://localhost:8082) – the app reports that no client is configured yet. Create the client in the Admin Console in the realm `lab-realm`:
   * Clients → `Create client`
   * Client type: `OpenID Connect`, Client ID: `acme-travel`, Name: `ACME Travel Expenses`
   * Client authentication: `On`, Authentication flow: only `Standard flow`
   * Valid redirect URIs: `http://localhost:8082/callback`
   * Valid post logout redirect URIs: `http://localhost:8082/`
   * Web origins: `http://localhost:8082`
   * Save, then copy the client secret from the `Credentials` tab
   * Put the secret into `docker-compose.yaml` for the service `acme-travel` under `CLIENT_SECRET` and restart the app: `docker compose up -d acme-travel`
5) Test SSO: Open ACME Travel Expenses (http://localhost:8082) in a new tab and click `Sign in with ACME Login (Keycloak)`. Since you are already logged in to Keycloak through Timetracking, you should be logged in without entering your password again. Compare the `sid` in both apps.
6) Check the sessions in the Admin Console for the `lab-realm` realm (`Sessions`, or user `testuser` → `Sessions`). How many SSO sessions are there, and which clients are attached?
7) Sign out of ACME Travel Expenses (`Sign out`) and check the sessions in the Admin Console → the SSO session should be gone.
8) Reload ACME Timetracking. Are you still logged in? → We have a **zombie session**: the app's local session lives on, although the SSO session in Keycloak has ended.
9) Click `Refresh token` in ACME Timetracking. Keycloak rejects the refresh (`Session not active`) – but the app ignores this and stays "logged in".
10) Discussion: Why does the zombie session occur? What options are there to avoid it?

### Bonus: Eliminate the zombie session with backchannel logout

With backchannel logout (OIDC Back-Channel Logout), Keycloak calls every involved app **directly, server to server**, when the SSO session ends and sends a signed logout token (JWT) containing the `sid`. The ACME apps already include the endpoint `/backchannel-logout` (see `acme-app/server.js`). It validates the token and ends all local sessions with that `sid`.

11) In Keycloak, open the client `acme-timetracking` → tab `Settings` → section `Logout settings`:
    * Front channel logout: `Off` (otherwise Keycloak uses front-channel instead of backchannel logout for this client)
    * Backchannel logout URL: `http://acme-timetracking:3000/backchannel-logout`
    * Backchannel logout session required: `On`
    * Save

    Note: This uses the **internal** Docker name and port, because Keycloak itself calls the app – not the browser.
12) Follow the app logs in a separate terminal: `docker compose logs -f acme-timetracking acme-travel`
13) Log in to both apps again (SSO), then log out of ACME Travel Expenses. The `acme-timetracking` log shows `Backchannel logout from Keycloak: sid=… → 1 local session(s) terminated`.
14) Reload ACME Timetracking → you are logged out, no more zombie session.
15) Configure backchannel logout for the client `acme-travel` as well: backchannel logout URL `http://acme-travel:3000/backchannel-logout` and **front channel logout `Off`** – for clients created in the admin UI, front-channel logout is enabled by default! Log in to both apps and this time end the session in the Admin Console (`Sessions` → `⋮` → `Sign out`). What happens in both apps?
16) Discussion:
    * Why does the app need to find its sessions by `sid`, and why isn't a session cookie enough here?
    * What happens if Keycloak cannot reach the app (network, app down) or if several app instances are running?
    * Is a backchannel logout also triggered when the SSO session in Keycloak simply expires (timeout)?
    * What happens on `Sign out` in the Admin Console with a client that is set to front channel logout?
