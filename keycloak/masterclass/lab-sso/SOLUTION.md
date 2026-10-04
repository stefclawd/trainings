# Lab SSO - Solution (Trainer Reference)

# DE

## Erwartete Beobachtungen

| Schritt | Erwartung |
|---------|-----------|
| 5 | Login in der ACME Reisekostenabrechnung ohne Passwortabfrage, beide Apps zeigen dieselbe `sid` |
| 6 | Eine SSO-Session für `testuser` mit zwei Clients (`acme-timetracking`, `acme-travel`) |
| 7 | Nach dem Abmelden in der Reisekostenabrechnung ist die SSO-Session in Keycloak weg |
| 8 | ACME Timetracking ist weiterhin „eingeloggt“ → Zombie-Session |
| 9 | `Token erneuern` / `Refresh token` liefert `invalid_grant: Session not active`, die App bleibt trotzdem eingeloggt |
| 13/14 | Log von `acme-timetracking`: `Backchannel logout from Keycloak: sid=… → 1 local session(s) terminated`, Timetracking ist abgemeldet |
| 15 | Mit Front channel logout `Off` und Backchannel-URL bei beiden Clients: `Sign out` in der Admin Console meldet beide Apps ab. Mit Front channel logout `On` bleibt die betroffene App eingeloggt (siehe Frage 4). |

---

## Diskussion Schritt 10: Warum entsteht die Zombie-Session?

- Es gibt **drei unabhängige Sessions**: je eine lokale Session pro App (Cookie) und die SSO-Session in Keycloak.
- Nach dem Login fragt die App Keycloak nicht mehr. Sie verlässt sich ausschließlich auf ihre eigene Session.
- Der Logout in der Reisekostenabrechnung (RP-initiated Logout) beendet nur die eigene App-Session und die SSO-Session in Keycloak. **Niemand informiert Timetracking**, also lebt dessen lokale Session weiter.
- Möglichkeiten, das zu vermeiden:
  - **Backchannel-Logout:** Keycloak ruft die App serverseitig auf (Bonus-Teil)
  - **Front-Channel-Logout:** Keycloak ruft die Logout-URLs der Apps per iframe im Browser auf
  - **Kurze App-Sessions** bzw. App-Session-Laufzeit ≤ SSO-Session-Laufzeit
  - **Regelmäßige Prüfung** über Token-Refresh oder Introspection und lokaler Logout, wenn Keycloak die Session ablehnt
  - Bei SPAs: Session-Status-Prüfung von keycloak.js (`checkLoginIframe`, vgl. Fundamentals Lab 3.2)

---

## Diskussion Schritt 16 (Bonus)

### 1. Warum muss die App ihre Sessions über die `sid` finden können, und warum reicht ein Session-Cookie nicht?

- Der Backchannel-Aufruf kommt **vom Keycloak-Server, nicht vom Browser**. Es wird kein Cookie mitgeschickt, und Keycloak kennt die Session-ID der App ohnehin nicht.
- Die einzige Information ist das Logout-Token mit `sid` (Keycloak-Session) und `sub` (Benutzer).
- Die App muss sich daher beim Login merken, welche lokale Session zu welcher `sid` gehört. In `acme-app/server.js` übernimmt das der `sidIndex`.
- Ohne `sid` (Option `Backchannel logout session required` = `Off`) könnte die App nur über `sub` **alle** Sessions des Benutzers beenden, also auch die auf anderen Geräten und Browsern.

### 2. Was passiert, wenn Keycloak die App nicht erreicht oder mehrere App-Instanzen laufen?

- **App nicht erreichbar:** Keycloak schickt den Aufruf einmal und schreibt bei einem Fehler eine Warnung ins Log. Der Logout in Keycloak ist trotzdem gültig, in der App bleibt die Zombie-Session. Backchannel-Logout ersetzt deshalb keine weiteren Absicherungen:
  - kurze App-Sessions
  - regelmäßiger Token-Refresh mit lokalem Logout bei Fehler (die Lab-App ignoriert den Fehler bewusst)
  - Introspection vor kritischen Aktionen
- **Mehrere Instanzen:** Der Aufruf landet über den Load Balancer bei **einer** Instanz. Liegen die Sessions nur im Speicher der Instanz (wie im Lab mit dem MemoryStore), beendet nur diese Instanz ihre Sessions. Sticky Sessions helfen nicht, weil der Aufruf von Keycloak keinem Browser zugeordnet ist. Lösungen:
  - gemeinsamer Session-Store (Redis, Datenbank) inkl. Zuordnung `sid` → Session
  - oder die empfangende Instanz verteilt den Logout per Pub/Sub an alle Instanzen

### 3. Wird ein Backchannel-Logout auch ausgelöst, wenn die SSO-Session einfach abläuft?

- **Nein.** Läuft die SSO-Session über *SSO Session Idle* oder *SSO Session Max* ab, räumt Keycloak sie auf, ohne die Clients zu benachrichtigen.
- Ein Backchannel-Logout wird nur bei einem **aktiven Logout** ausgelöst: Logout über eine App, über die Account Console, `Sign out` in der Admin Console oder über die Admin-REST-API.
- Konsequenz für die App: App-Session-Laufzeit ≤ SSO-Session-Laufzeit, oder regelmäßig per Refresh bzw. Introspection prüfen, ob die Keycloak-Session noch lebt.
- **Live-Demo:** `Realm settings` → `Sessions` → *SSO Session Idle* auf 1–2 Minuten setzen, in beiden Apps anmelden, warten. In den App-Logs erscheint kein Backchannel-Aufruf, Timetracking ist weiterhin eingeloggt, aber `Refresh token` schlägt fehl.

### 4. Was passiert beim `Sign out` in der Admin Console mit einem Client, der auf Front channel logout steht?

- **Nichts, der Client bleibt eingeloggt.**
- Front-Channel-Logout braucht den **Browser des Benutzers**: Keycloak rendert eine Seite mit iframes, die die Logout-URLs der Apps aufrufen.
- Beim `Sign out` durch den Admin ist der Browser des Benutzers nicht beteiligt. Der Admin arbeitet in seinem eigenen Browser bzw. über die REST-API, deshalb kann Keycloak die App nicht benachrichtigen.
- Steht ein Client auf Front channel logout, nutzt Keycloak den Backchannel **auch dann nicht**, wenn eine Backchannel-URL eingetragen ist.
- Fazit: Front-Channel funktioniert nur beim Logout durch den Benutzer selbst. Für Admin-Logout, gesperrte Benutzer oder Sicherheitsvorfälle braucht man den Backchannel.

---

## Typische Stolpersteine

| Problem | Ursache / Lösung |
|---------|------------------|
| Reisekostenabrechnung zeigt weiter „Client noch nicht konfiguriert“ | Secret nicht eingetragen oder Container nicht neu gestartet: `docker compose up -d acme-travel` |
| `invalid_redirect_uri` / „Ungültiger Parameter: redirect_uri“ | Valid redirect URI muss exakt `http://localhost:8082/callback` sein |
| Nach dem Logout landet man nicht wieder in der App | Valid post logout redirect URI `http://localhost:8082/` fehlt |
| `unauthorized_client` / `Invalid client credentials` | Falsches Secret kopiert oder Secret danach neu generiert |
| Backchannel-Logout greift bei `acme-travel` nicht | Front channel logout steht noch auf `On` (Default bei im Admin-UI angelegten Clients) |
| Backchannel-URL mit `localhost:8081` eingetragen | Keycloak ruft die App im Docker-Netzwerk auf → `http://acme-timetracking:3000/backchannel-logout` |
| Realm-Änderungen (z. B. Access Token Lifespan) fehlen | Realm-Import wird übersprungen, wenn der Realm schon existiert → `docker compose down -v` |
| Kein Backchannel-Aufruf im Log, obwohl alles konfiguriert ist | App-Image veraltet → `docker compose up -d --build` |

---

# EN

## Expected Observations

| Step | Expectation |
|------|-------------|
| 5 | Login to ACME Travel Expenses without a password prompt, both apps show the same `sid` |
| 6 | One SSO session for `testuser` with two clients (`acme-timetracking`, `acme-travel`) |
| 7 | After signing out of Travel Expenses, the SSO session in Keycloak is gone |
| 8 | ACME Timetracking is still "logged in" → zombie session |
| 9 | `Refresh token` returns `invalid_grant: Session not active`, but the app stays logged in |
| 13/14 | `acme-timetracking` log: `Backchannel logout from Keycloak: sid=… → 1 local session(s) terminated`, Timetracking is logged out |
| 15 | With front channel logout `Off` and a backchannel URL on both clients: `Sign out` in the Admin Console logs out both apps. With front channel logout `On`, the affected app stays logged in (see question 4). |

---

## Discussion Step 10: Why does the zombie session occur?

- There are **three independent sessions**: one local session per app (cookie) and the SSO session in Keycloak.
- After login, the app no longer asks Keycloak. It relies solely on its own session.
- Signing out of Travel Expenses (RP-initiated logout) only ends that app's own session and the SSO session in Keycloak. **Nobody informs Timetracking**, so its local session lives on.
- Ways to avoid it:
  - **Backchannel logout:** Keycloak calls the app server-side (bonus part)
  - **Front-channel logout:** Keycloak calls the apps' logout URLs via iframes in the browser
  - **Short app sessions**, or app session lifetime ≤ SSO session lifetime
  - **Regular checks** via token refresh or introspection, with a local logout when Keycloak rejects the session
  - For SPAs: session status check in keycloak.js (`checkLoginIframe`, see Fundamentals Lab 3.2)

---

## Discussion Step 16 (Bonus)

### 1. Why does the app need to find its sessions by `sid`, and why isn't a session cookie enough?

- The backchannel call comes **from the Keycloak server, not from the browser**. No cookie is sent, and Keycloak doesn't know the app's session ID anyway.
- The only information is the logout token with `sid` (Keycloak session) and `sub` (user).
- The app therefore has to remember at login which local session belongs to which `sid`. In `acme-app/server.js`, this is done by `sidIndex`.
- Without `sid` (option `Backchannel logout session required` = `Off`), the app could only use `sub` to end **all** of the user's sessions, including those on other devices and browsers.

### 2. What happens if Keycloak cannot reach the app or several app instances are running?

- **App unreachable:** Keycloak sends the call once and logs a warning on failure. The logout in Keycloak is still valid; the zombie session remains in the app. Backchannel logout therefore does not replace other safeguards:
  - short app sessions
  - regular token refresh with a local logout on failure (the lab app deliberately ignores the error)
  - introspection before critical actions
- **Several instances:** The call reaches **one** instance via the load balancer. If sessions are only held in that instance's memory (as in the lab with the MemoryStore), only that instance ends its sessions. Sticky sessions don't help, because Keycloak's call isn't tied to a browser. Solutions:
  - a shared session store (Redis, database) including the `sid` → session mapping
  - or the receiving instance broadcasts the logout to all instances via pub/sub

### 3. Is a backchannel logout also triggered when the SSO session simply expires?

- **No.** When the SSO session expires via *SSO Session Idle* or *SSO Session Max*, Keycloak cleans it up without notifying the clients.
- A backchannel logout is only triggered by an **active logout**: logout via an app, via the Account Console, `Sign out` in the Admin Console, or via the Admin REST API.
- Consequence for the app: app session lifetime ≤ SSO session lifetime, or regularly check via refresh or introspection whether the Keycloak session is still alive.
- **Live demo:** `Realm settings` → `Sessions` → set *SSO Session Idle* to 1–2 minutes, log in to both apps, wait. No backchannel call appears in the app logs, Timetracking is still logged in, but `Refresh token` fails.

### 4. What happens on `Sign out` in the Admin Console with a client set to front channel logout?

- **Nothing, the client stays logged in.**
- Front-channel logout needs the **user's browser**: Keycloak renders a page with iframes that call the apps' logout URLs.
- When the admin signs the user out, the user's browser isn't involved. The admin works in their own browser or via the REST API, so Keycloak cannot notify the app.
- If a client is set to front channel logout, Keycloak does **not** use the backchannel, even if a backchannel URL is configured.
- Conclusion: Front-channel only works when users log out themselves. For admin logout, disabled users or security incidents, you need the backchannel.

---

## Common Pitfalls

| Problem | Cause / Solution |
|---------|------------------|
| Travel Expenses still shows "Client not configured yet" | Secret not set or container not restarted: `docker compose up -d acme-travel` |
| `invalid_redirect_uri` / "Invalid parameter: redirect_uri" | Valid redirect URI must be exactly `http://localhost:8082/callback` |
| After logout you don't end up back in the app | Valid post logout redirect URI `http://localhost:8082/` is missing |
| `unauthorized_client` / `Invalid client credentials` | Wrong secret copied, or secret regenerated afterwards |
| Backchannel logout doesn't work for `acme-travel` | Front channel logout is still `On` (default for clients created in the admin UI) |
| Backchannel URL set to `localhost:8081` | Keycloak calls the app inside the Docker network → `http://acme-timetracking:3000/backchannel-logout` |
| Realm changes (e.g. access token lifespan) missing | Realm import is skipped if the realm already exists → `docker compose down -v` |
| No backchannel call in the log although everything is configured | App image outdated → `docker compose up -d --build` |
