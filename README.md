# dsh-9router

**Die kostenlosen OpenCode-Modelle als vollwertiger Provider in DSH Desktop (Windows) und DeepSeek Harness.**

Ohne API-Key, ohne Guthaben, ohne Proxy-Prozess: Dieses Plugin registriert die Free-Modelle von
[OpenCode](https://opencode.ai) als eigene Provider-Route im Harness, sodass sie ganz normal im
Modell-Picker auswählbar sind und einen vollständigen Agent-Loop fahren — mit Tool-Calls, Reasoning,
Context-Window, Output-Limit und Vision.

> [!IMPORTANT]
> **Warum das überhaupt ein Plugin braucht.** OpenCodes Free-Lane liefert seit September 2026 nur noch
> an Anfragen aus, die wie eine offizielle OpenCode-Client-Session aussehen. Jeder andere Client —
> DeepSeek Harness, pi-ai, das OpenAI-SDK, LiteLLM, claude-code-router — bekommt stattdessen
> `403 FreeTierError: "OpenCode's free tier can only be used from within OpenCode"`.
> Genau das ist die Fehlermeldung, die Sie bei anderen Agenten/Harnesses sehen.
> Dieses Plugin baut die erwartete Client-Identität nach. Alle sechs Gates sind in
> [`docs/gate.md`](docs/gate.md) einzeln belegt.

---

## Inhalt

- [Installation unter Windows](#installation-unter-windows)
- [Was das Plugin korrekt einstellt](#was-das-plugin-korrekt-einstellt)
- [Konfiguration](#konfiguration)
- [Die sechs Gates](#die-sechs-gates)
- [Diagnose: Welches Gate klemmt?](#diagnose-welches-gate-klemmt)
- [Modelle](#modelle)
- [Warum kein `attributionHeaders()`](#warum-kein-attributionheaders)
- [Tests](#tests)
- [Grenzen](#grenzen)

---

## Installation unter Windows

Voraussetzung: **DSH Desktop v0.12.x** (Windows x64). Diese Version pinnt
`@deepseek-ai/dsh@0.2.1-rc.2`; das Plugin ist gegen genau diese `LlmAdapter`-Schnittstelle gebaut und
deklariert sie als Peer-Abhängigkeit.

### Weg A — Über die Plugin-Seite in DSH Desktop (empfohlen)

1. DSH Desktop starten.
2. In der Seitenleiste **Plugins** öffnen (bzw. **Settings → Plugins**).
3. **Install** wählen und als Quelle entweder angeben:
   - die Git-Adresse `github:<ihr-fork>/dsh-9router`, oder
   - einen **absoluten** Pfad auf den entpackten Ordner, z. B.
     `C:\Users\<Name>\Downloads\dsh-9router`.
     Relativpfade werden abgelehnt — der Host weiß nicht, worauf sie sich beziehen sollen.
4. **DSH Desktop einmal neu starten.** Ohne HMR bleibt die laufende Komposition bis zum Neustart bestehen.
5. Im Modell-Picker erscheint die Gruppe **OpenCode Free**.

### Weg B — Über die Kommandozeile

DSH Desktop legt sein Profil unter `%APPDATA%\dsh-desktop\harness\profiles\web` an. Von dort:

```bat
cd /d "%APPDATA%\dsh-desktop\harness\profiles\web"
dsh plugin --profile web add -w github:<ihr-fork>/dsh-9router
```

Das `-w` ist **keine** Option, sondern Pflicht: Das Profilverzeichnis enthält eine
`pnpm-workspace.yaml`, pnpm behandelt es also als Workspace-Root. Ohne das Flag folgt
`ERR_PNPM_ADDING_TO_ROOT`.

Kontrolle, ob das Plugin wirklich im Loader-Baum hängt:

```bat
dsh --profile web --dump-config | findstr opencode-free
```

Erwartet:

```yaml
- id: opencode-free
  name: dsh-9router
```

### Kein Build-Schritt, keine native Abhängigkeit

Das Plugin ist reines ESM-JavaScript und wird **ohne** Kompilierung ausgeliefert. Es gibt kein
`prepare`-Script, also läuft beim Install aus einer Git-Quelle kein Build — weder ein TypeScript-
noch ein Bundler-Toolchain wird auf Ihrem Rechner benötigt.

Die TLS-Anpassung (siehe [Gate 6](#die-sechs-gates)) nutzt Node-Bordmittel und ist in
`test/transport.test.mjs` Byte für Byte gegen einen echten ClientHello verifiziert.

`wreq-js` ist deshalb **bewusst keine Abhängigkeit** — auch keine optionale. Eine optionale
Abhängigkeit wird beim `dsh plugin add` trotzdem aufgelöst und geladen, und ein natives
Plattform-Binding (`@wreq-js/binding-win32-x64-msvc`) ist genau das, was eine Windows-Installation in
ein Electron-gebundeltes Node am ehesten ausbremst oder scheitern lässt. Der ausgelieferte
Transport braucht kein natives Modul. Wer den vollen Browser-Fingerprint möchte, legt es selbst ins
Profil und schaltet den Modus um:

```bat
cd /d "%APPDATA%\dsh-desktop\harness\profiles\web"
pnpm add -w wreq-js
```

danach `transport.mode: wreq` in der Plugin-Konfiguration. Fehlt das Paket, meldet sich dieser Modus
mit einer klaren Fehlermeldung statt still zu degradieren; `auto` und `impersonate` laufen immer.

---

## Was das Plugin korrekt einstellt

Die Anforderung war nicht nur „die Modelle sind da", sondern „die Modelle nutzen die richtigen
Einstellungen und Einstelloptionen". Jede davon wird über die `LlmAdapter`-Verträge beantwortet, die
der Harness für genau diese Zwecke vorsieht — nicht über Ratespiele:

| Einstellung | Woher | Was der Harness damit macht |
|---|---|---|
| **Endpunkt** | Pro Modell aufgelöst. Dieselbe Basis-URL bedient drei Protokolle: `/inference/v1/chat/completions`, `/inference/v1/responses`, `/inference/v1/messages`. | Ein Responses-Modell auf `/chat/completions` degradiert nicht, sondern schlägt fehl. Die Lane wird deshalb je Modell bestimmt, mit Familien-Fallback für neue IDs. |
| **Context** | `resolveModel().context.contextWindow` aus Live-Katalog, sonst Snapshot. | Treibt Compaction und die `CONTEXT_WINDOW_EXCEEDED`-Prüfung. |
| **Max Output** | `resolveModel().defaultMaxTokens`, und je Request das Minimum aus Caller-, Deployment- und Modell-Limit. | Der Harness materialisiert das Limit, wenn ein Request keines nennt. Auf der Chat-Lane reist es als `max_tokens`, **nie** als `max_completion_tokens` — das beantwortet die Lane mit „Endpoint is unavailable". |
| **Reasoning** | `resolveModel().reasoning.efforts` als adaptereigene, geordnete Stufe-nach-oben-Liste plus `defaultEffort`. | Der Picker bietet nur deklarierte Stufen. Eine nicht deklarierte Stufe wird **vor** Provider-I/O auf die nächstliegende zulässige konvergiert, denn die Lane antwortet auf eine unbekannte Stufe mit `400 Invalid option`. `auto` wird verworfen statt gemappt — das Feld wegzulassen *ist* die Bedeutung von adaptiv. Ein Modell ohne Reasoning erhält niemals ein Effort-Feld. |
| **Vision** | `inputModalities` je Modell; `vision: auto` folgt dem Katalog. | Deklariert eine Route **kein** Image, ersetzt der Harness selbst jedes Bild durch einen deterministischen Platzhaltertext. Das ist der sichere Default, weil die Free-Lane Bild-Eingabe zeitweise mit 503 beantwortet. Mit `vision: on` kodiert das Plugin Bilder über `ctx.attachments.readImageRequest()` und sendet OpenCodes eigenen Opt-In-Header. |
| **Retry** | `providerRetryPolicy()` liefert die Codes `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`. | Nur diese Codes wiederholt `dsh-llm-retry`. Ein 5xx als `SERVER` zu melden statt unter einem eigenen Code ist deshalb kein Stil-, sondern ein Funktionsdetail. |
| **Token-Zählung** | Disjunkt: `inputTokens` ist nur der ungecachte Anteil. | OpenAI-artige `prompt_tokens` falten Cache-Treffer in sich selbst. Ohne Herausrechnen würde ein gecachter Verlauf seinen Input in jeder Runde doppelt zählen. |

Dazu kommt, was der Harness von einem GUI-tauglichen Adapter verlangt: `listModels()` muss die
Modelle aktiv anbieten, denn **der Picker verlangt Katalog-Mitgliedschaft** für Auswahl und Absenden.
Ein Adapter, der hier leer antwortet, ist unsichtbar — egal wie gut sein `stream()` funktioniert.

---

## Konfiguration

Null Konfiguration ist der vorgesehene Zustand: Die Defaults beschreiben die anonyme Free-Lane
vollständig. Alles darunter ist optional und gehört in `cordis.patch.yml` bzw. in den
`config:`-Block des Plugin-Eintrags.

```yaml
- insert:
    - id: opencode-free
      name: dsh-9router
      config:
        provider: opencode-free          # Route-Name im Modell-Picker
        displayName: OpenCode Free
        baseURL: https://opencode.ai     # bewusst nur der Origin; die Lane wird je Modell angehängt
        apiKeyEnv: OPENCODE_API_KEY      # dieselbe Variable, die OpenCode selbst nutzt
        maxTokens: 32768                 # Deployment-Limit; das kleinere Modell-Limit gewinnt
        defaultContextWindow: 262144
        vision: auto                     # auto | on | off
        catalog:
          enabled: true
          modelsUrl:
            - https://opencode.ai/inference/v1/models
            - https://opencode.ai/zen/v1/models
          devUrl: https://models.dev/api.json
          ttlMs: 3600000
          timeoutMs: 8000
          cachePath: ''                  # '' = <DSH-Home>/cache/opencode-free-catalog.json
        fingerprint:
          enabled: true
          userAgent: opencode/latest/2.0.26/cli
          client: cli
          project: global
          tools: true                    # read/shell wortgetreu injizieren
          envMarker: true                # <env>-Block an den System-Prompt anhängen
        transport:
          mode: auto                     # auto | impersonate | native | wreq
          cipherList: ''                 # '' = die verifizierte Liste
          timeoutMs: 120000
        retryPolicy:
          mode: normal
          maxRetries: 5
```

Wichtige Schalter:

- **`apiKeyEnv` leer oder Variable nicht gesetzt** → anonyme Free-Lane (`Bearer public`).
  Das ist kein Fehler, sondern der Normalfall. Gesetztes `OPENCODE_API_KEY` schaltet auf das
  private Kontingent; Free-Modell-IDs bleiben auch dann hinter der Free-Identität gated.
- **`transport.mode: native`** ist ein Diagnosewerkzeug, kein Betriebsmodus: Es sendet Nodes
  Standard-Cipher-Liste und wird von der Free-Lane mit 429 beantwortet.
- **`vision: off`** erzwingt die Text-Projektion des Harness für alle Modelle. Das ist der
  Ausweg, falls die Lane Bild-Eingabe wieder mit 503 beantwortet.
- **`fingerprint.enabled: false`** macht aus dem Plugin einen gewöhnlichen OpenAI-kompatiblen
  Client. Das funktioniert nur mit bezahltem Key; auf der Free-Lane folgt sofort 403.

---

## Die sechs Gates

Die Free-Lane prüft sechs voneinander unabhängige Dinge, und eine Anfrage muss **alle** bestehen.
Jeder Punkt ist in [`docs/gate.md`](docs/gate.md) mit Quelle und Ablationsergebnis belegt.

| # | Gate | Umsetzung |
|---|---|---|
| 1 | **Pfad** — `/inference/v1`, nicht `/zen/v1` | `endpointFor()` in `lib/adapter.js`; ein gepinnter Pfad wird respektiert |
| 2 | **User-Agent** — `opencode/<channel>/<version>/<client>`, major ≥ 2, **Vollstring-Vergleich** | `OPENCODE_USER_AGENT`; kein Suffix, kein Attribut |
| 3 | **Session-Header** — `x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`, `x-session-id`, alle vier **gleich**; `x-opencode-request` (v1) darf **nicht** mit | `fingerprintHeaders()` |
| 4 | **Session-ID-Form** — `ses_` + 12 gemintete Hex + 14 Base62; der dekodierte Zähler muss klein sein, der Zeitstempel aktuell | `mintSessionId()` / `SessionStore` |
| 5 | **Body-Form** — `stream: true`, `read` **und** `shell` mit wortgetreuer Beschreibung und Parameterschema, `<env>`-Marker im System-Prompt, niemals `tool_choice: "none"` | `applyFingerprintTools()` |
| 6 | **TLS-ClientHello** — die Cipher-Liste wird über ihren JA4-Hash erkannt | `lib/transport.js` |

Zwei Punkte verdienen besondere Aufmerksamkeit, weil sie kontraintuitiv sind:

**Zu Gate 4 — die Session-ID.** Der 12-Hex-Präfix ist `~(ms · 0x1000 + counter)`, maskiert auf
48 Bit. `ms · 0x1000` braucht bei heutigen Datumsangaben rund 53 Bit, das Feld fasst 48 — der
dekodierte Zeitwert ist also `ms mod 2^36` und das Feld läuft alle ~2,18 Jahre über. Upstream
vergleicht im selben überlaufenden Raum. Deshalb passiert ein mit `Date.now()` geminteter ID, während
ein aus einem Digest abgeleiteter ID **gleicher Form** fast immer abgelehnt wird: sein dekodierter
Wert ist gleichverteilt über 2^36 ms und landet nahezu immer außerhalb des Fensters. Wer das für
einen Bug hält und das Feld „repariert", bricht das Gate.

Zusätzlich gilt: Free-Kontingent wird **pro Session** abgerechnet. Eine frische ID je Request
brennt das Kontingent durch und äußert sich als `429 FreeUsageLimitError` mit wachsender
Reset-Verzögerung. `SessionStore` hält deshalb genau wie der echte CLI **eine** stabile Session pro
Konversation und gibt eine echte, bereits gültige OpenCode-ID unverändert weiter, damit deren
Cache-Affinität erhalten bleibt.

**Zu Gate 6 — TLS.** Gemessen am 2026-10-26 in einem Prozess, einem Ausgangs-IP, drei Transporten:
`node fetch`, `node https` und `node http2` liefern alle 429, Buns BoringSSL-`fetch` liefert 200 —
bei identischem Body und identischen Headern. JA4 identifiziert die Liste über ihren Cipher-Hash
(`5b57614c22b0`), und **nur** dieser Hash wird verglichen; Umsortieren derselben Liste passiert
weiterhin.

Node kann genau diese Liste nativ erzeugen: `tls.connect({ ciphers })` akzeptiert TLS-1.3-Suiten
neben den OpenSSL-Namen und sendet sie wortgetreu, in Reihenfolge, **ohne** eingefügtes GREASE.
`test/transport.test.mjs` parst dafür einen echten ClientHello von einem echten Socket und gleicht
die `cipher_suites` Feld für Feld ab. Die Impersonation braucht damit kein natives Modul — was für
ein DSH-Desktop-Plugin entscheidend ist, denn eine Binärabhängigkeit ist bei einer Installation in
ein Electron-gebundeltes Node unter Windows die wahrscheinlichste Fehlerquelle.

---

## Diagnose: Welches Gate klemmt?

Wenn die Free-Modelle nach einem OpenCode-Release plötzlich nicht mehr gehen, sagt Ihnen das
Probe-Skript, **welche** der sechs Prüfungen sich geändert hat — statt nur „403" auszugeben:

```bat
cd /d "%APPDATA%\dsh-desktop\harness\profiles\web\node_modules\dsh-9router"
node scripts\probe.mjs
node scripts\probe.mjs --ablate
node scripts\probe.mjs --model cat-jam-free
node scripts\probe.mjs --json
```

Der Normaldurchlauf holt die Modell-Liste und stellt **eine** vollständige Anfrage. `--ablate`
entfernt danach gezielt je ein Gate und erwartet eine Ablehnung — ein Gate, das dort mit 200
antwortet, wird upstream aktuell nicht durchgesetzt. Anschließend wird dieselbe Anfrage mit Nodes
Standard-Ciphern wiederholt: Bekommt die ablatierte Fassung 200 und die vollständige 429, ist es das
TLS-Gate.

> [!NOTE]
> Das Skript spricht die echte Free-Lane an. Jede erfolgreiche Anfrage verbraucht gemeinsames anonymes
> Kontingent, das nach Quelle begrenzt ist. Die meisten ablatierten Anfragen werden abgewiesen,
> bevor sie ein Modell erreichen, und kosten deshalb nichts. Führen Sie das Skript bewusst aus,
> nicht in einer Schleife.

Die Fehlermeldungen des Adapters sind absichtlich lang und nennen die wahrscheinliche Ursache:
Ein `403 FreeTierError` verweist auf die Identitäts-Gates, ein `429 FreeUsageLimitError`
unterscheidet erschöpftes Kontingent von einer Body- oder TLS-Ablehnung — denn die Lane antwortet
für beides mit 429.

---

## Modelle

Die Liste ist **nicht** hartkodiert. OpenCode bezeichnet die Free-Modelle als zeitlich befristet,
jede feste Liste veraltet also garantiert. `lib/discovery.js` schneidet deshalb zwei Quellen:

- **OpenCodes `/models`** sagt, welche IDs existieren — und sonst fast nichts.
- **`models.dev`** liefert Kosten und Kapazitäten pro Modell. Ein Kostenwert von 0 ist die einzige
  maschinenlesbare Aussage darüber, dass ein Modell zum kostenlosen Angebot gehört; OpenCodes eigene
  Liste trifft sie nicht.

Der Katalog ist der Schnitt: eine ID, die beide Quellen kennen und deren Kosten 0 sind. Daraus folgt,
dass ein eingestelltes Modell nicht im Picker auftaucht und ein bezahltes Modell niemals als
kostenlos angeboten wird. Der mitgelieferte Snapshot in `lib/catalog.js` liefert danach die
Kapazitäten, Modalitäten und Reasoning-Stufen, die die Liste nicht nennt, und dient als Ausweg, wenn
beide Quellen unerreichbar sind — ein Offline-Rechner sieht dann immer noch eine Liste statt nichts.

Aktuell im Snapshot (Auszug, sortiert nach Context):

| Modell | Lane | Context | Max Output | Vision | Reasoning |
|---|---|---|---|---|---|
| `muse-spark-1.3-contributor-free` | responses | 1 048 576 | 131 072 | ja | low…xhigh |
| `space-bunny-free` | chat | 1 048 576 | 524 288 | ja | low/high/max |
| `nemotron-3-ultra-free` | chat | 1 000 000 | 128 000 | – | low/high/max |
| `longcat-2.5-preview-free` | chat | 1 000 000 | 131 072 | ja | low/high/max |
| `nemotron-3.5-lightning-free` | chat | 262 144 | 262 144 | – | low/high/max |
| `union-alpha` | messages | 262 144 | 131 072 | ja | – |
| `north-mini-code-free` | chat | 256 000 | 64 000 | – | low/high/max |
| `big-pickle` | chat | 200 000 | 32 000 | – | low/high/max |
| `mimo-v2.6-flash-free` | chat | 200 000 | 32 000 | – | none…max |
| `deepseek-v4.1-flash-free` | chat | 200 000 | 128 000 | – | low/high/max |

`jev-1.13-free` liegt zwar auf der Lane, wird aber bewusst **nicht** angeboten: Es ist ein
Entscheidungs-Endpunkt, der eine Auswahl beantwortet und keinen Agent-Turn.

---

## Warum kein `attributionHeaders()`

Der Harness verlangt von einem Adapter, dass jede Provider-Anfrage `attributionHeaders()` trägt.
Dieser Adapter tut das **bewusst nicht**, und das ist ein echter Zielkonflikt, kein Versehen:

`attributionHeaders()` rendert die Produktidentität als
`deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`.
Die Free-Lane lehnt einen User-Agent ab, der `deepseek-harness` **enthält** —
groß/klein-unempfindlich und an beliebiger Position — und verlangt zusätzlich, dass die gesamte
Zeichenkette der OpenCode-v2-Form entspricht. Attributierung auf dieser Lane ist damit ein
garantiertes `403 FreeTierError`. Das ist, nebenbei, der Grund, warum bestehende
Harness-Integrationen an genau dieser Stelle scheitern: Sie spreaden `...attributionHeaders()` in
ihre Request-Header.

Jede Anfrage auf dieser Route trägt deshalb OpenCodes eigenen UA — mit und ohne Key. Eine
Deployment, das sich gegenüber einem Provider ausweisen muss, sollte diesen Provider über
`@deepseek-ai/dsh-llm-pi-ai` routen (das Attributierung normal sendet) und dieses Plugin nur für die
Free-Lane verwenden.

---

## Tests

```bash
npm test
```

85 Tests, alle offline und deterministisch. Drei Gruppen sind die tragenden:

- **`test/transport.test.mjs`** parst einen echten ClientHello von einem echten Socket und gleicht
  die Cipher-Liste Feld für Feld gegen die Zielliste ab — inklusive des Nachweises, dass Nodes
  Standardliste abweicht, denn sonst bewiese der Test nichts.
- **`test/gate-server.mjs`** ist ein lokaler Doppelgänger der Free-Lane, der **jedes** Gate
  durchsetzt und mit denselben Statuscodes und Fehlertypen ablehnt wie upstream.
- **`test/adapter-gate.test.mjs`** fährt echte Agent-Turns über den echten Adapter gegen diesen
  Doppelgänger, über alle drei Lanes. Ein bestandener Test ist hier ein Beleg, kein Vorsatz: Entfernt man
  dem Plugin eine einzige Eigenschaft, schlägt der Test fehl.
- **`test/integration.test.mjs`** mountet das Plugin in einen echten Cordis-Kontext neben dem echten
  `@deepseek-ai/dsh-llm`-Service und fährt einen Request durch `ctx.llm.stream()`. Das fängt
  Vertragsdrift: `LlmAdapter` ist eine abstrakte Klasse in einem Peer-Paket, `registerAdapter`
  validiert den Routen-Satz, und `prepareCall` lehnt eine Reasoning-Stufe ab, die das Modell nicht
  deklariert — alles Dinge, die ein Adapter-Unit-Test nicht sehen kann.

---

## Grenzen

Ehrlich benannt, damit niemand danach suchen muss:

- **Die Gates sind upstream-eigen und können sich ändern.** Sie haben sich bereits zweimal geändert
  (v1 → v2 am 2026-10-14, TLS-Gate bestätigt am 2026-10-26). `scripts/probe.mjs --ablate` ist dafür
  gebaut, die Änderung zu lokalisieren; `fingerprint.userAgent`, `fingerprint.definitions` und
  `transport.cipherList` sind konfigurierbar, damit ein Deployment reagieren kann, ohne auf einen
  Release zu warten.
- **Das anonyme Kontingent ist geteilt und nach Quelle begrenzt.** 429 ist hier ein erwarteter
  Betriebszustand, kein Defekt. Ein eigener `OPENCODE_API_KEY` behebt das.
- **Bild-Eingabe auf der Free-Lane war zeitweise 503.** Deshalb ist `vision: auto` der Default und
  die Text-Projektion des Harness der sichere Pfad.
- **Ein bezahlter Key ändert nichts an Gate 1–6 für Free-Modell-IDs.** Upstream gated diese auch auf
  der keyed Lane hinter der attestierten Free-Identität.
- **Rechtliches und ToS:** Das Umsetzen einer Client-Identität kann gegen die Nutzungsbedingungen des
  Anbieters verstoßen. Prüfen Sie das selbst, bevor Sie es produktiv einsetzen. Dieses Plugin ist
  MIT-lizenziert und kommt ohne jede Gewährleistung.

---

## Lizenz

MIT — siehe [LICENSE](LICENSE).

Dieses Plugin ist ein unabhängiges Community-Projekt. Es steht in keiner Verbindung zu OpenCode,
DeepSeek oder Dataelem und wird von keinem davon getragen.
