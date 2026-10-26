# Handoff — OpenCode-Free-Modelle in DSH Desktop unter Windows

**Stand:** 2026-10-26 · **Paket:** `dsh-9router@0.1.0` · **Repo:** `jahdaganj04ki-a11y/dsh-9router`
**Branch:** `arena/fb266ccb-dsh-9router` (Commit `ba30e1f`) · **PR:** [#1](https://github.com/jahdaganj04ki-a11y/dsh-9router/pull/1), offen gegen `main`

Dieses Dokument ist eine Übergabe. Es beantwortet zwei Fragen getrennt:

- **Abschnitt 0–4** — wie jemand die Free-Modelle von OpenCode in der aktuellen Windows-Version von
  [dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) zum Laufen bringt und prüft, ob sie laufen.
- **Abschnitt 5–11** — was darunter passiert, wo die Grenzen liegen und was eine Person wissen muss, die
  das Plugin weiterpflegt.

Ausführliche Bedienungsanleitung: [README.md](../README.md) (Deutsch) und [README.en.md](../README.en.md).
Beweiskette für die Gateway-Prüfungen: [gate.md](gate.md).

> [!IMPORTANT]
> **Was hier gemessen wurde und was nicht.** Der Plugin-Code ist vollständig getestet: 86 Tests, alle offline und
> deterministisch (`npm test`), inklusive eines lokalen Gate-Servers, der jede der sechs Prüfungen der
> Free-Lane nachbildet (`test/gate-server.mjs`). **Nicht** ausgeführt wurde die Installation auf einem echten
> Windows-Rechner und eine echte Anfrage an `opencode.ai` — die Entwicklungsumgebung war eine Linux-Sandbox
> ohne Windows-Host und ohne Netzwerkweg zu OpenCode. Alle Windows-Pfade, Menüpunkte und Kommandos in diesem
> Dokument sind deshalb aus dem Quellcode von DSH Desktop v0.12.1 und aus den veröffentlichten npm-Paketen
> abgeleitet; die Belege stehen in Abschnitt 11. Abschnitt 4 ist als Erstinbetriebnahme-Checkliste genau dafür
> gebaut: Sie sagt Ihnen an jeder Stelle, welche Ausgabe Sie erwarten dürfen.

---

## 0. Kurzfassung

1. **DSH Desktop v0.12.1** (Windows x64, `dsh-desktop-windows-x64-setup.exe`) installieren und einmal starten.
2. In der App: **Plugins → Install**. Als Quelle
   `github:jahdaganj04ki-a11y/dsh-9router#arena/fb266ccb-dsh-9router`
   eintragen (oder einen absoluten Pfad, siehe Abschnitt 3).
3. **Einmal neu starten** — Menü **Harness → Restart** (Strg+Umschalt+R) reicht. Die Menüleiste ist unter
   Windows ausgeblendet, bis **Alt** gedrückt wird; das Tastenkürzel funktioniert auch so.
4. Im Modell-Picker erscheint die Gruppe **OpenCode Free**. Ein Modell daraus wählen, Reasoning auf `low`,
   einen kurzen Prompt senden.
5. Läuft etwas nicht: **Harness → Show Harness Log**, nach `[dsh-9router]` suchen, dann Abschnitt 7.

Es ist **keine Konfiguration nötig**. Kein API-Key, kein Build-Schritt, kein zusätzliches Paket, kein Node
auf dem Rechner: Die Voreinstellungen beschreiben die anonyme Free-Lane vollständig.

---

## 1. Was übergeben wird

| Artefakt | Ort | Stand |
|---|---|---|
| Plugin (lieferfähig) | Repo-Wurzel: `index.js`, `lib/`, `types/`, `cordis.patch.yml` | 4 710 Zeilen Code, reines ESM, keine Abhängigkeiten |
| Diagnosewerkzeug | `scripts/probe.mjs` | läuft ohne `node_modules`, nur Node-Bordmittel |
| Tests | `test/*.test.mjs`, `test/gate-server.mjs` | 2 560 Zeilen, **86/86 grün**, ~2,4 s, offline |
| Doku | `README.md` (DE), `README.en.md` (EN), `docs/gate.md`, `docs/handoff.md` | vollständig |
| Typen | `types/index.d.ts` | 268 Zeilen, JSDoc plus `.d.ts` |
| Lizenz | `LICENSE` | MIT |
| Git | Branch `arena/fb266ccb-dsh-9router`, PR #1 | Arbeitsbaum sauber, gepusht |

`node_modules/` und `package-lock.json` sind gitignored und **nicht** Teil der Lieferung: Sie enthalten
`@deepseek-ai/dsh-llm@0.2.1-rc.2`, `@deepseek-ai/cordis@4.0.5`, `wreq-js` und `js-yaml`, die nur für die
Tests installiert wurden. Das Lockfile ist bewusst nicht eingecheckt, weil es genau diese nicht deklarierten
Testpakete festschreiben würde.

Der Tarball (`npm pack`) enthält 17 Dateien, 78,8 kB gepackt / 257,9 kB entpackt, **ohne** `node_modules`
und ohne `test/` — dafür **mit** `scripts/probe.mjs`, damit die Diagnose aus der installierten Kopie heraus
funktioniert (Abschnitt 7).

### 1.1 Korrekturen, die diese Übergabe am Bestand vorgenommen hat

Beim Nachmessen der Windows-Anleitung sind vier Stellen aufgefallen, die vorher falsch oder unvollständig
waren. Sie sind in diesem Commit korrigiert — wer eine ältere Fassung der READMEs vor sich hat, sollte
diese Liste lesen:

1. **`DSH_HOME` fehlte in Weg B** (`README.md`, `README.en.md`). Ohne die Variable arbeitet `dsh plugin`
   an `~\.dsh` — einem anderen Baum als dem des Desktops. Die Installation wäre „erfolgreich" und das
   Plugin trotzdem nirgends sichtbar. Ergänzt um die Variable, um die PATH-Bedingung für pnpm und um
   Variante B2 (Electron-Programm als Node, CLI aus dem `app.asar`), die ohne eigenes Node auskommt.
2. **Die Diagnose-Lesart für 429 war unbrauchbar** — teils mehrdeutig, teils verdreht. In `docs/gate.md`,
   in der Ausgabe von `scripts/probe.mjs` und in beiden READMEs stand, ein 200 der Standard-Cipher-Fassung
   bedeute erschöpftes Kontingent. Das
   Gegenteil ist der Fall: Antwortet die Standard-Cipher-Fassung 200, während die vollständige Anfrage 429
   bekommt, ist die **Cipher-Liste** die Variable. Erschöpftes Kontingent ist der Fall, in dem *beide* 429
   liefern und zugleich jede Ablation abgelehnt wird. Alle vier Stellen korrigiert, überall durch dieselbe
   Entscheidungstabelle ersetzt (7.3).
3. **Die Menüleiste ist unter Windows ausgeblendet** (`autoHideMenuBar: true`), bis **Alt** gedrückt wird.
   Ohne diesen Hinweis findet niemand das Menü **Harness** mit **Restart** und **Show Harness Log**.
4. **Nur `add`, `install` und `i` durchlaufen die Kompatibilitätsprüfung** des Plugin-Managers; `update`,
   `remove` und `why` sind wörtliche pnpm-Durchgriffe. Für ein Update ist deshalb ein erneutes `add` mit
   demselben Spec der verlässliche Weg (3.4).

---

## 2. Zielumgebung, nachgemessen

### 2.1 Versionen

| Bauteil | Wert | Beleg |
|---|---|---|
| DSH Desktop | **v0.12.1** (2026-10-20), Windows **x64** only | GitHub-Releases; `package.json` `version` |
| Installer | NSIS, `dsh-desktop-windows-x64-setup.exe`, `oneClick: false`, Installationsordner wählbar | `package.json` `build.nsis`, `build.win.target` |
| Harness-Laufzeit | `@deepseek-ai/dsh@0.2.1-rc.2` (gepinnt) | `package.json` des Desktops |
| Gegen diese Schnittstelle gebaut | `@deepseek-ai/dsh-llm@0.2.1-rc.2` (`LlmAdapter`, `LlmRuntime`) | dessen `lib/types/*.d.ts` |
| Node im Paket | `>= 20` | `package.json` `engines.node` |

Windows **ARM64** und Linux werden von DSH Desktop selbst nicht ausgeliefert — dafür ist hier nichts zu tun.

### 2.2 Pfade unter Windows

| Was | Wo |
|---|---|
| Installationsverzeichnis (Default, im Installer änderbar) | `%LOCALAPPDATA%\Programs\DSH Desktop\` |
| Hauptprogramm | `%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe` |
| Gebündelte Laufzeit | `…\DSH Desktop\resources\app.asar\node_modules\…` |
| CLI-Einstiegspunkt | `…\app.asar\node_modules\@deepseek-ai\dsh\lib\bin.js` |
| Benutzerdaten (`userData`) | `%APPDATA%\dsh-desktop\` |
| Harness-Home (`DSH_HOME`) | `%APPDATA%\dsh-desktop\harness\` |
| **Profil der Desktop-App** | `%APPDATA%\dsh-desktop\harness\profiles\web\` |
| Installiertes Plugin | `…\profiles\web\node_modules\dsh-9router\` |
| Benutzer-Patch-Ebene (editierbar) | `…\profiles\web\cordis.patch.yml` |
| Markt-Zustand (`disabled`-Liste) | `…\profiles\web\.dsh-market\state.json` |
| Laufzeit-Shims (`node.cmd`, `pnpm.cmd`) | `%APPDATA%\dsh-desktop\harness\.desktop-bin\` |
| Katalog-Cache dieses Plugins | `%APPDATA%\dsh-desktop\harness\cache\opencode-free-catalog.json` |
| Startprotokoll | über Menü **Harness → Show Harness Log** (`harness.log`) |

`%APPDATA%` ist `C:\Users\<Name>\AppData\Roaming`. Der Harness-Home ist historisch kleingeschrieben und
bleibt über Umbenennungen der App stabil; ein Upgrade sieht deshalb nie wie eine Neuinstallation aus.

### 2.3 Eigenheiten der Desktop-Laufzeit, die für jede Anleitung wichtig sind

1. **Der Desktop bringt kein eigenes Node mit.** Alles läuft auf dem Electron-Programm mit
   `ELECTRON_RUN_AS_NODE=1`. Für Handarbeit heißt das: entweder ein eigenes Node ≥ 20 verwenden, oder die
   Shims in `.desktop-bin\` (die der Desktop selbst schreibt, sobald er einmal eine Paketaktion ausgeführt
   hat), oder Variante B2 in Abschnitt 3.2.
2. **`DSH_HOME` entscheidet, welcher Baum gemeint ist.** Ohne die Variable fällt das CLI auf `~\.dsh`
   zurück — ein völlig anderer Baum als der des Desktops. Jede manuelle Kommandozeilenaktion **muss**
   `set "DSH_HOME=%APPDATA%\dsh-desktop\harness"` vorausstellen. Der Desktop setzt die Variable für seine
   eigenen Prozesse; eine selbst geöffnete Eingabeaufforderung erbt sie nicht.
   *(Das ist die Korrektur, die diese Übergabe an der README-Anleitung vorgenommen hat — siehe 3.2.)*
3. **`dsh plugin` braucht pnpm auf dem PATH.** Fehlt es, endet der Lauf mit Exit-Code 127 und der Meldung
   `dsh: pnpm was not found`. Der Desktop hängt dafür `.desktop-bin` vor den PATH.
4. **`dsh.profile.bundles` in der Profil-`package.json` nicht von Hand editieren.** Der Desktop baut diese
   Liste bei jedem Start aus den Installationsdatensätzen neu. Editierbar ist die Patch-Ebene
   `cordis.patch.yml` — dort gehören Konfiguration und ein `disabled: true` hin.

Und eine fünfte, für die Fehlersuche: Im **Safe Mode** lädt der Desktop ausschließlich installations-eigene
Bundles. Dieses Plugin ist dort per Design **nicht** geladen; die Gruppe „OpenCode Free" fehlt dann also zu
Recht. Nach „Exit Safe Mode and restart" ist sie wieder da.

Und eine sechste, die jede Anleitung betrifft, die ein Menü nennt: Das Hauptfenster setzt unter Windows
`autoHideMenuBar: true`. Die Menüleiste mit dem Menü **Harness** ist also ausgeblendet, bis **Alt** gedrückt
wird. Die Tastenkürzel funktionieren unabhängig davon — **Strg+Umschalt+R** startet den Harness neu,
**Strg+U** sucht nach Updates.

### 2.4 Versionsprüfung bei der Installation — nachgerechnet

Der Plugin-Manager prüft vor pnpm, ob das Plugin zur Laufzeit passt. Die Regel (aus
`@deepseek-ai/dsh-app-boot@0.2.1-rc.2`, `unmetRequirements`):

- Ein eigenes `engines.dsh` entscheidet **allein**; Peer-Abhängigkeiten werden dann ignoriert.
  Dieses Paket setzt **bewusst kein** `engines.dsh` (Abschnitt 9.3).
- Ohne `engines.dsh` wird jeder Peer namens `@deepseek-ai/dsh` oder `@deepseek-ai/dsh-*` gegen die
  **Version der dsh-Laufzeit** geprüft (nicht gegen die Version des jeweiligen Pakets), mit
  `includePrerelease: true`. `@deepseek-ai/cordis` fällt nicht unter dieses Muster und wird von der Prüfung
  ignoriert.

Damit ergibt sich für `dsh-9router@0.1.0` — mit der Originalfunktion aus app-boot gegen unser
`package.json` nachgerechnet:

| dsh-Laufzeit | Ergebnis |
|---|---|
| `0.2.1-rc.2` (**von DSH Desktop v0.12.1 gepinnt**) | kompatibel |
| `0.2.1-rc.4` (`next`) | kompatibel |
| `0.2.1`, `0.2.2` | kompatibel |
| `0.3.0` (hypothetisch, zukünftig) | **abgelehnt** (`incompatible-version`) |
| `0.1.0-rc.6` (älter) | abgelehnt |

Abhilfe bei einer Ablehnung, zwei Wege — der erste ist der saubere:

```bat
:: 1) Peer-Bereiche in package.json auf die neue Laufzeit erweitern und neu installieren.
:: 2) Oder die Exemption für genau diese Kombination erteilen (schreibt compatibility.json im Profil):
dsh plugin --profile web allow-version dsh-9router@0.1.0 --dsh-version 0.3.0 --accept-risk
:: zurücknehmen:
dsh plugin --profile web revoke-version dsh-9router@0.1.0 --dsh-version 0.3.0
:: anzeigen:
dsh plugin --profile web version-exemptions
```

Die CLI gibt bei einer Ablehnung exakt diese Zeile selbst aus. Eine Exemption gilt nur für das exakte
Paket **und** die exakte Laufzeitversion.

---

## 3. Installation

Drei Wege, alle führen in dasselbe Profil. **Weg A ist der empfohlene**: Er überlässt dem Desktop die
Umgebung (PATH, Shims, `DSH_HOME`, Lock-Recovery) und braucht weder Node noch pnpm noch git auf dem Rechner.

### 3.1 Weg A — Plugin-Seite in DSH Desktop (empfohlen)

1. DSH Desktop starten.
2. Seitenleiste **Plugins** (bzw. **Settings → Plugins**) öffnen.
3. **Install** wählen und als Quelle eine der vier akzeptierten Formen angeben:

   | Form | Beispiel |
   |---|---|
   | Git-Kurzform | `github:jahdaganj04ki-a11y/dsh-9router#arena/fb266ccb-dsh-9router` |
   | Git-URL | `https://github.com/jahdaganj04ki-a11y/dsh-9router.git#arena/fb266ccb-dsh-9router` |
   | Absoluter Pfad auf einen Ordner | `C:\Users\<Name>\Downloads\dsh-9router` |
   | Absoluter Tarball-Pfad | `C:\Users\<Name>\Downloads\dsh-9router-0.1.0.tgz` |

   Zwei Regeln aus dem Spec-Parser des Plugin-Managers: **Relativpfade werden abgelehnt**
   (`a local path must be absolute`), und eine URL muss entweder auf ein Git-Repo oder auf ein `.tgz`/`.tar.gz`
   zeigen. Die `#branch`-Angabe ist erlaubt und nötig, solange PR #1 nicht in `main` gemergt ist.
4. **Einmal neu starten.** Der Installer meldet selbst, falls eine Änderung nicht sofort wirkt
   (`nextStep` im Ergebnis); Menü **Harness → Restart** (Strg+Umschalt+R) genügt, ein kompletter Neustart
   der App ist der sichere Weg.
5. Kontrolle: Modell-Picker → Gruppe **OpenCode Free**.

Warum Git-Quellen hier unkritisch sind: pnpm blockiert bei git-gehosteten Paketen normalerweise
`prepare`-Skripte, bis sie in `pnpm-workspace.yaml` unter `allowBuilds` freigegeben sind — die CLI warnt
explizit davor. Dieses Paket hat **kein** `prepare`-Skript und keinen Build-Schritt, also gibt es nichts
freizugeben. Ebenso wenig gibt es ein natives Binding, das auf Windows scheitern könnte (Abschnitt 9.3).

### 3.2 Weg B — Kommandozeile

**Variante B1 — eigenes Node ≥ 20 und pnpm vorhanden.** Die CLI-Version muss zur Laufzeit passen, weil die
Kompatibilitätsprüfung die Version des CLI-eigenen `dsh-app-boot` als Laufzeitversion liest. Beachten:
`@deepseek-ai/dsh` zieht den gesamten Harness-Baum als globale Abhängigkeit nach — wer das nicht will, nimmt
Weg A oder Variante B2:

```bat
npm i -g @deepseek-ai/dsh@0.2.1-rc.2 pnpm

set "DSH_HOME=%APPDATA%\dsh-desktop\harness"
set "PATH=%DSH_HOME%\.desktop-bin;%PATH%"
cd /d "%DSH_HOME%\profiles\web"
dsh plugin --profile web add -w github:jahdaganj04ki-a11y/dsh-9router#arena/fb266ccb-dsh-9router
```

**Variante B2 — nur Bordmittel des Desktops**: kein eigenes Node, kein global installiertes pnpm. Für eine
Git-Quelle muss allerdings `git` auf dem Rechner sein, weil pnpm klont — sonst Weg C nehmen. Das ist exakt
der Aufruf, den der Desktop intern ausführt: das Electron-Programm als Node, mit dem CLI aus dem `app.asar`:

```bat
set "DSH_HOME=%APPDATA%\dsh-desktop\harness"
set "ELECTRON_RUN_AS_NODE=1"
set "PATH=%DSH_HOME%\.desktop-bin;%PATH%"
cd /d "%DSH_HOME%\profiles\web"

"%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe" ^
  "%LOCALAPPDATA%\Programs\DSH Desktop\resources\app.asar\node_modules\@deepseek-ai\dsh\lib\bin.js" ^
  plugin --profile web add -w github:jahdaganj04ki-a11y/dsh-9router#arena/fb266ccb-dsh-9router
```

Liegt die App woanders (der Installer lässt die Wahl), hilft ein Rechtsklick auf den Startmenü-Eintrag →
**Dateipfad öffnen**. Die Shims in `.desktop-bin` schreibt der Desktop erst, nachdem er selbst einmal eine
Paketaktion ausgeführt hat — wer ganz frisch beginnt, nimmt Weg A oder B1.

Das `-w` ist **Pflicht**, keine Vorliebe: Das Profilverzeichnis enthält eine `pnpm-workspace.yaml`, pnpm
behandelt es also als Workspace-Root, und ohne das Flag folgt `ERR_PNPM_ADDING_TO_ROOT`.

**Kontrolle, ob das Plugin im Loader-Baum hängt** (mit denselben Umgebungsvariablen wie oben):

```bat
"%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe" ^
  "%LOCALAPPDATA%\Programs\DSH Desktop\resources\app.asar\node_modules\@deepseek-ai\dsh\lib\bin.js" ^
  --profile web --dump-config | findstr opencode-free
```

Erwartet:

```yaml
- id: opencode-free
  name: dsh-9router
```

Fehlt die Zeile, ist das Paket zwar installiert, aber nicht als Bundle registriert — dann hängt die
Patch-Ebene nicht. Der Plugin-Manager schreibt den Bundle-Eintrag beim `add` selbst; die README des
Pakets enthält dieselbe `insert`-Zeile für den Fall, dass sie von Hand nachgetragen werden muss.

### 3.3 Weg C — Tarball (offline, ohne git, ohne Fork)

```bat
:: auf einem Rechner mit dem Repo und Node/npm
cd /d C:\pfad\zum\dsh-9router
npm pack
:: -> dsh-9router-0.1.0.tgz
```

Den Tarball anschließend per Weg A (absoluter Pfad) oder Weg B installieren. Er enthält alles Nötige
einschließlich `scripts/probe.mjs`, aber kein `node_modules` — das Paket hat keine Abhängigkeiten, also
muss auch nichts nachgeladen werden.

### 3.4 Update und Entfernen

Der Plugin-Manager behandelt nur `add`, `install` und `i` selbst — dort laufen die
Kompatibilitätsprüfung, die Bundle-Registrierung und die Diagnosemeldungen. Alles andere wird wörtlich an
pnpm im Profilverzeichnis durchgereicht. Daraus folgt für die Praxis:

```bat
:: Erneut installieren bzw. aktualisieren: derselbe Spec, wieder über `add`
:: (gleiche Umgebung wie Weg B)
dsh plugin --profile web add -w github:jahdaganj04ki-a11y/dsh-9router#arena/fb266ccb-dsh-9router

:: Entfernen — ein pnpm-Durchgriff, räumt Paket und Abhängigkeitseintrag ab
dsh plugin --profile web remove dsh-9router

:: Warum ist es überhaupt da?
dsh plugin --profile web why dsh-9router
```

Für **Upgrade und Neuinstallation** ist laut Desktop-Reparatur-Agent die UI der vorgesehene Weg
(Plugin-Markt bzw. „Upgrade" im Safe Mode); ein erneutes `add` mit demselben Spec tut es auf der
Kommandozeile, weil es dieselbe Prüfung und Registrierung durchläuft. `pnpm update` ist dagegen ein reiner
Durchgriff ohne Kompatibilitätsprüfung und bei einer Git-Quelle der weniger verlässliche Weg.

Wer nur den Ordner löscht, hinterlässt eine Patch-Ebene, die auf ein fehlendes Paket zeigt — deshalb
`remove` statt Handarbeit.

**Deaktivieren ohne Entfernen** — zwei Dateien, sonst widerspricht sich die UI:

1. `…\profiles\web\cordis.patch.yml` (Liste auf oberster Ebene, bei Bedarf anlegen):
   ```yaml
   - id: opencode-free
     disabled: true
   ```
2. Den Paketnamen `dsh-9router` in das `disabled`-Array von `…\profiles\web\.dsh-market\state.json` eintragen.

---

## 4. Inbetriebnahme und Verifikation

Eine Checkliste mit erwarteter Ausgabe. Jeder Punkt ist unabhängig prüfbar.

| # | Prüfung | Erwartung |
|---|---|---|
| 1 | Neustart (Menü **Harness → Restart**, Strg+Umschalt+R) | App kommt hoch, kein Safe Mode |
| 2 | Menü **Harness → Show Harness Log**, in `harness.log` nach `[dsh-9router]` suchen | eine Info-Zeile, siehe unten |
| 3 | Modell-Picker öffnen | Gruppe **OpenCode Free** mit Modellen |
| 4 | **Einstellungen → Modelle** | Zeile **OpenCode Free**, Endpunkt `https://opencode.ai/inference/v1/chat/completions`, „verfügbare Modelle abrufen" liefert die Live-Liste |
| 5 | Modell wählen, Reasoning `low`, kurzer Prompt („Antworte mit genau einem Wort: ok") | eine Antwort, kein `FreeTierError` |
| 6 | Ein Modell mit Vision (z. B. `space-bunny-free`) plus ein Bild | entweder Antwort oder ein klarer 503-Hinweis — siehe Abschnitt 8 |
| 7 | `%APPDATA%\dsh-desktop\harness\cache\opencode-free-catalog.json` | existiert nach dem ersten Listing |

Die Zeile aus Punkt 2 sieht mit Voreinstellungen so aus (Format aus `index.js`):

```
[dsh-9router] provider "opencode-free" on https://opencode.ai/inference/v1/chat/completions —
fingerprint on (opencode/latest/2.0.26/cli), transport auto,
catalog live (https://opencode.ai/inference/v1/models), credential OPENCODE_API_KEY or anonymous
```

Fehlt sie, ist das Plugin nicht geladen (Abschnitt 7, Fall 1). Steht dort `fingerprint off` oder
`transport native`, weicht die Konfiguration von der Voreinstellung ab — dann ist die Free-Lane
voraussichtlich nicht erreichbar.

**Erstprüfung ohne Desktop** — dasselbe, aber direkt gegen die Lane, und ohne Node-Installation lauffähig,
weil `probe.mjs` ausschließlich Node-Bordmittel importiert:

```bat
cd /d "%APPDATA%\dsh-desktop\harness\profiles\web\node_modules\dsh-9router"
"%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd" scripts\probe.mjs
```

Das Skript holt die Modell-Liste und stellt **eine** vollständige Anfrage. Es sagt am Ende selbst, was zu
tun ist, wenn etwas abgelehnt wurde.

---

## 5. Was das Plugin unter der Haube tut (Kurzform)

Die Free-Modelle von OpenCode funktionieren außerhalb von OpenCode normalerweise nicht: Die Lane lehnt
fremde Clients ab. Die Ablehnung ist keine einzelne Prüfung, sondern **sechs** unabhängige; jede muss
bestanden werden. Vollständig, mit Belegen und Messwerten: [gate.md](gate.md).

| # | Gate | Worauf es ankommt | Fehler bei Verfehlung |
|---|---|---|---|
| 1 | Pfad | `POST https://opencode.ai/inference/v1/{chat/completions\|responses\|messages}` — `/zen/v1` beantwortet nur noch das Listing | 403 |
| 2 | User-Agent | exakt `opencode/latest/2.0.26/cli`; eine UA, die `deepseek-harness` **enthält**, wird unabhängig von Position und Groß-/Kleinschreibung abgewiesen | 403 |
| 3 | Session-Header | `x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`, `x-session-id` tragen **einen** gemeinsamen Wert; dazu `x-opencode-client`, `x-opencode-project`, `Authorization: Bearer public`; `x-opencode-request` muss **fehlen** (v1-Rest) | 403 |
| 4 | Session-ID-Form | `ses_` + 12 Hex + 14 Base62, wobei die Hex-Ziffern `~(ms·0x1000 + Zähler) & 0xffffffffffff` sind; kleiner Zähler (1…16), aus `Date.now()` geprägt. Das 48-Bit-Feld läuft alle 2³⁶ ms über, die dekodierte Zeit ist also `ms mod 2^36` | 403 |
| 5 | Rumpf | `stream:true`; die Werkzeuge `read` **und** `shell` mit Beschreibung und Parameterschema **wörtlich** aus dem CLI v2.0.26; `<env>`-Marker im System-Prompt; niemals `tool_choice:"none"` | 429 |
| 6 | TLS-ClientHello | die 17 Cipher-Suites der BoringSSL-Familie in Reihenfolge, ohne GREASE (JA4-Cipher-Hash `5b57614c22b0`). **Node erzeugt das nativ** über `tls.connect({ciphers})` — byte für byte gegen einen echten ClientHello verifiziert, deshalb keine native Abhängigkeit | 429 |

Die Kontingentgrenze pro Session ist der Grund für `lib/fingerprint.js`' `SessionStore`: eine Unterhaltung
behält eine stabile Session, eine echte vom Host vergebene ID wird unverändert weitergereicht.

Kollidierende Werkzeuge (der Host bringt ein eigenes `read` oder `shell` mit) werden nicht verworfen: Passt
der Aufruf in die offizielle Definition, wird sie an der Stelle übernommen; sonst wird das Host-Werkzeug nach
`<key>_client[N]` umbenannt und auf der Antwortseite zurückbenannt — für alle drei Lanes
(Chat-Delta/Message, Responses-Item/Event, Anthropic-Content-Block).

**Lane-Routing** nach Modellfamilie, Snapshot-Eintrag schlägt Familienregel:

| Muster | Lane |
|---|---|
| `muse-spark*`, `gpt*`, `grok*` | `responses` |
| `claude*`, `union*` | `messages` |
| alles andere | `chat/completions` |

**Korrektes Einstellen der Modelle** — die vom Auftrag geforderten Optionen, und wo sie im Harness landen:

| Größe | Quelle | Ziel im Harness |
|---|---|---|
| Endpunkt | Lane-Routing + `baseURL` | `defaultBaseURL` der Provider-Zeile, pro Anfrage aufgelöst |
| Kontextfenster | `models.dev` ∩ Snapshot | `LlmModelContext.contextWindow` |
| Maximale Ausgabe | Snapshot pro Modell | `LlmResolvedModelInfo.defaultMaxTokens` (**nicht** `context` — dort passt es laut `dsh-llm@0.2.1-rc.2` nicht hin) |
| Vision | `inputModalities` aus dem Katalog, `vision: auto` | steuert, ob der Harness eigene Bild-Platzhalter einsetzt; Text-Deklaration ist der sichere Pfad |
| Reasoning | erlaubte Stufen pro Modell | `reasoning.efforts[].{id,name,description}` + `defaultEffort`; Werte außerhalb der erlaubten Menge konvergieren auf die nächste erlaubte Stufe, bei Gleichstand **nach unten** |

Dazu die Lane-eigenen Ablehnungen, die der Adapter in brauchbare Fehler übersetzt bzw. vorab vermeidet:
`role:"developer"` → `400 [1214]` (wird in `system` gefaltet); `max_completion_tokens` →
„Endpoint is unavailable" (deshalb `max_tokens`, auf Responses `max_output_tokens`, auf Messages
verpflichtend); `reasoning_effort:"auto"` → Feld entfällt; leeres `reasoning_content` in der Historie →
`400 missing_required_parameter` (ein Leerzeichen wird injiziert); `reasoning`-Items aus Vorrunden auf der
Responses-Lane → ganzes Item entfällt.

**Die Modelliste ist nicht hartkodiert.** `lib/discovery.js` schneidet OpenCodes `/models` (welche IDs
existieren) mit `models.dev` (Kosten und Kapazitäten); Kosten 0 ist die einzige maschinenlesbare Aussage
darüber, dass ein Modell zum kostenlosen Angebot gehört. TTL, Datei-Cache und ein Snapshot als Ausweg, wenn
beide Quellen unerreichbar sind — ein Offline-Rechner sieht dann immer noch eine Liste statt nichts.
`jev-1.13-free` liegt zwar auf der Lane, wird aber bewusst nicht angeboten: Es ist ein
Entscheidungs-Endpunkt und kein Chat-Modell.

---

## 6. Konfiguration

Alles ist optional; die leere Konfiguration ist die vorgesehene Haltung.

**Wo sie steht.** Nicht im installierten Paket (`node_modules` ist laut Desktop-Reparatur-Agent tabu),
sondern in der Benutzer-Patch-Ebene `%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml`:

```yaml
- id: opencode-free
  config:
    vision: 'off'
    transport:
      mode: impersonate
```

Zwei Regeln des Patch-Dialekts, die man kennen muss: Ein Eintrag ohne `insert` **ersetzt** die angegebenen
Felder des gleichnamigen Eintrags, und `config` wird **als Ganzes ersetzt, nicht tiefengefügt**. Da die
mitgelieferte Bundle-Ebene gar kein `config` setzt (alles ist in `cordis.patch.yml` des Pakets
auskommentiert), ist das hier harmlos — und `resolveConfig()` ergänzt alle weggelassenen Felder mit
geprüften Voreinstellungen. Ein Tippfehler in einem Feldnamen führt zu einer Fehlermeldung **beim Laden**
des Plugins, die das Feld beim Namen nennt, statt drei Turns später als undurchsichtiger Provider-Fehler
aufzutauchen.

**Welchen Knopf man wann anfasst:**

| Feld | Voreinstellung | Ändern, wenn … |
|---|---|---|
| `baseURL` | `https://opencode.ai` | die Lane umzieht (kam bereits einmal vor: `/zen/v1` → `/inference/v1`) |
| `apiKeyEnv` | `OPENCODE_API_KEY` | ein eigener Key unter anderem Namen liegt; `''` = niemals suchen |
| `fingerprint.userAgent` | `opencode/latest/2.0.26/cli` | OpenCode eine neue CLI-Version veröffentlicht und die Prüfung nachzieht — ohne Release dieses Pakets möglich |
| `fingerprint.definitions` | wörtliche `read`/`shell`-Definitionen | sich die Werkzeugdefinitionen upstream ändern |
| `fingerprint.tools` / `envMarker` | `true` / `true` | nur für Experimente — beides ist Teil von Gate 5 |
| `transport.mode` | `auto` | `native` zum Beweis, dass das TLS-Gate greift; `wreq` nur mit selbst installiertem `wreq-js` |
| `transport.cipherList` | geprüfte 17 Suites | upstream die Cipher-Familie wechselt |
| `vision` | `auto` | Bilder stabil 503 liefern → `off`; alle Modelle sollen Bilder anbieten → `on` |
| `catalog.ttlMs` / `cachePath` | 1 h / `<dsh home>\cache\…` | die Liste häufiger oder seltener erneuert werden soll |
| `maxTokens`, `defaultContextWindow`, `defaultMaxTokens` | – / 262 144 / 32 768 | ein Modell ohne Katalogeintrag andere Annahmen braucht |
| `retryPolicy` | Voreinstellung des Harness | 429-Lastfahrten geglättet oder abgestellt werden sollen |

**Einen API-Key unter Windows setzen** (behebt geteiltes Kontingent, ändert nichts an den Gates):

```bat
setx OPENCODE_API_KEY "oc-…"
```

`setx` gilt erst für **neu gestartete** Prozesse — DSH Desktop danach vollständig schließen und neu öffnen.
Der Suchauftrag im Plugin ist: Credential-Store des Harness (dorthin schreibt die Modelle-Seite),
dann Launch-Environment, dann Prozessumgebung. Kein Key ist kein Fehler: Es wählt die anonyme Lane.

---

## 7. Fehlerdiagnose

### 7.1 Erstens: Log

Menü **Harness → Show Harness Log** öffnet den Ordner mit `harness.log` — unter Windows üblicherweise
`%APPDATA%\dsh-desktop\logs\harness.log`; die Menüleiste erscheint erst nach **Alt**, der Menüpunkt ist die
verbindliche Auskunft über den Ort. Die Datei sammelt über mehrere
Starts; gesucht wird der Abschnitt des letzten regulären Starts. Zeilen mit `[harness-log]` sind Warnungen
und Fehler der Harness-Laufzeit, `[dsh-9router]` sind Meldungen dieses Plugins. Nicht die ganze Datei
lesen — `findstr` reicht:

```bat
findstr /C:"[dsh-9router]" "%APPDATA%\dsh-desktop\logs\harness.log"
findstr /C:"failed to apply loader entry" "%APPDATA%\dsh-desktop\logs\harness.log"
```

### 7.2 Zweitens: Symptom → Ursache → Maßnahme

| Symptom | Wahrscheinliche Ursache | Maßnahme |
|---|---|---|
| Gruppe „OpenCode Free" fehlt ganz | Plugin nicht geladen: Safe Mode aktiv, Bundle nicht registriert, oder Ladefehler | `--dump-config \| findstr opencode-free` (3.2); Log nach `failed to apply loader entry` durchsuchen; Safe Mode verlassen |
| `403 FreeTierError` | eines der **Identitäts-Gates** 1–4 hat sich geändert | `probe.mjs --ablate` → die Ablation, die unerwartet 200 liefert, nennt das nicht mehr durchgesetzte Gate; `fingerprint.userAgent` / `definitions` per Konfiguration nachziehen |
| `429 FreeUsageLimitError` | **drei** mögliche Ursachen — die Lane antwortet für erschöpftes Kontingent, einen abgelehnten Rumpf und eine abgelehnte Cipher-Liste gleich | `probe.mjs --ablate` ausführen und die Tabelle in 7.3 lesen; sie trennt die drei Fälle |
| `429`, und im Probe-Lauf liefert die Standard-Cipher-Fassung 200 | **Cipher-Liste** ist die Variable (Gate 6 hat sich geändert) | `transport.cipherList` neu vermessen |
| `429`, und eine Rumpf-Ablation liefert 200 | **Body-Gate** 5 hat sich geändert — diese Ablation nennt die neue erwartete Form | `fingerprint.definitions` / `tools` / `envMarker` anpassen |
| `429`, jede Ablation abgelehnt, `/models` antwortet | **Kontingent erschöpft** — erwarteter Betriebszustand, kein Defekt | später erneut, eigener `OPENCODE_API_KEY` |
| `Endpoint is unavailable` | `max_completion_tokens` wurde gesendet | sollte der Adapter verhindern → installierte Version prüfen (`dsh plugin --profile web why dsh-9router`) |
| `400 [1214]` | `role:"developer"` im Rumpf | wird in `system` gefaltet; bei Auftreten Version und Konfiguration prüfen |
| `400 [1210]` | `reasoning_effort` außerhalb der erlaubten Menge | Reasoning-Stufe im Picker auf eine erlaubte setzen; der Adapter konvergiert sonst selbst |
| Bilder schlagen mit 503 fehl | Free-Lane lehnt Bild-Eingabe zeitweise ab | `vision: 'off'`; der Harness projiziert dann auf Text |
| Ein freies Modell fehlt im Picker | Katalog veraltet oder `models.dev` unerreichbar | Cache löschen: `del "%APPDATA%\dsh-desktop\harness\cache\opencode-free-catalog.json"`, neu starten; Snapshot liefert danach trotzdem eine Liste |
| `Client network socket disconnected before secure TLS connection was established` | Firewall, Proxy oder TLS-Inspection im Netzweg | Netz prüfen; in der Entwicklungsumgebung war das der Normalfall, weil `opencode.ai` nicht erreichbar war |
| Antwort kommt, aber ohne Begründungstext | `reasoningEcho: false` gesetzt | auf `true` zurück |

### 7.3 Drittens: das Probe-Skript

```bat
cd /d "%APPDATA%\dsh-desktop\harness\profiles\web\node_modules\dsh-9router"
"%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd" scripts\probe.mjs
"%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd" scripts\probe.mjs --ablate
"%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd" scripts\probe.mjs --model space-bunny-free
"%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd" scripts\probe.mjs --transport native
"%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd" scripts\probe.mjs --json
```

Entscheidend ist das **Paar** aus der vollständigen Anfrage (Spalte „vollständig") und der Wiederholung mit
Nodes Standard-Ciphern (Zeile `native OpenSSL ciphers`, nur mit `--ablate`):

| vollständig | Standard-Cipher | Ablationen | Bedeutung | Maßnahme |
|---|---|---|---|---|
| 200 | abgelehnt | alle abgelehnt | **Normalfall**: Plugin korrekt, TLS-Gate greift | keine |
| 200 | 200 | alle abgelehnt | TLS-Gate wird aus diesem Netz nicht durchgesetzt (oft ein TLS-terminierender Proxy) | keine — nicht als „Gate 6 ist weg" lesen |
| 403 | – | – | **Identitäts-Gate** 1–4 verschoben | die Ablation mit 200 nennt es; `fingerprint.*` nachziehen |
| 429 | 200 | – | **Cipher-Liste** ist die Variable | `transport.cipherList` neu vermessen |
| 429 | 429 | eine Rumpf-Ablation 200 | **erwarteter Rumpf** verschoben | `fingerprint.definitions` / `tools` / `envMarker` anpassen |
| 429 | 429 | alle abgelehnt, Listing antwortet | **Kontingent erschöpft** | später erneut, `OPENCODE_API_KEY` |

Die letzte Zeile ist eine Ausschlussdiagnose: Erschöpftes Kontingent und ein abgelehnter Rumpf antworten
beide mit 429. Trennen lässt sich das nur darüber, dass eine Kontingent-Ablehnung nicht von der Anfrage
abhängt — jede Ablation wird ebenfalls abgelehnt, das nicht kontingentierte `/models`-Listing antwortet
weiter, und dieselbe Anfrage aus einem anderen Netz oder mit eigenem Key läuft.

`--json` ist für Vergleiche über die Zeit gedacht.

> [!NOTE]
> Das Skript spricht die echte Free-Lane an. Jede erfolgreiche Anfrage verbraucht gemeinsames anonymes
> Kontingent. Die meisten ablatierten Anfragen werden abgewiesen, bevor sie ein Modell erreichen, und
> kosten deshalb nichts — trotzdem bewusst ausführen, nicht in einer Schleife.

---

## 8. Grenzen, ehrlich benannt

- **Die Gates gehören upstream und können sich ändern.** Sie haben es bereits zweimal getan
  (v1 → v2 am 2026-10-14, TLS-Gate bestätigt am 2026-10-26). `probe.mjs --ablate` lokalisiert die Änderung,
  und `fingerprint.*` sowie `transport.cipherList` sind konfigurierbar, damit ein Deployment reagieren kann,
  ohne auf einen Release zu warten.
- **Das anonyme Kontingent ist geteilt und nach Quelle begrenzt.** 429 ist ein erwarteter Betriebszustand.
- **Bild-Eingabe war auf der Free-Lane zeitweise 503.** Deshalb `vision: auto` als Voreinstellung.
- **Ein bezahlter Key hebelt die Gates 1–6 für Free-Modell-IDs nicht aus.** Upstream gated sie auch auf der
  keyed Lane hinter der attestierten Free-Identität.
- **Im Safe Mode ist das Plugin nicht geladen** — by Design, keine Störung.
- **Rechtliches und ToS:** Das Umsetzen einer Client-Identität kann gegen die Nutzungsbedingungen des
  Anbieters verstoßen. Vor produktivem Einsatz selbst prüfen. Dieses Paket ist MIT-lizenziert und kommt
  ohne jede Gewährleistung. Es ist ein unabhängiges Community-Projekt, nicht getragen von OpenCode,
  DeepSeek oder Dataelem.

---

## 9. Für Weiterentwickler:innen

### 9.1 Landkarte

| Datei | Zeilen | Verantwortung |
|---|---|---|
| `index.js` | 327 | Cordis-Einstieg: `name`, `inject: ['llm']`, `apply(ctx, config)`; träger Transport, Credential-Auflösung, drei Registrierungen, alles fiber-gebunden über `ctx.effect` |
| `lib/fingerprint.js` | 886 | die sechs Gates auf Client-Seite: UA, Session-Prägung, `SessionStore`, Header, wörtliche `read`/`shell`-Definitionen, Umbenennung und Rückbenennung, `<env>`-Marker |
| `lib/adapter.js` | 676 | `OpenCodeFreeAdapter extends LlmAdapter`; `endpointFor()`, `describeFailure()`, `classifyStreamError()` |
| `lib/catalog.js` | 538 | `SNAPSHOT_MODELS` mit Lane, Kontext, Ausgabe, Modalitäten, Stufen; `resolveEffort`, `laneForModel`, `isFreeModelId` |
| `lib/discovery.js` | 373 | `/models` ∩ `models.dev` (Kosten 0), TTL, Datei-Cache, Snapshot-Ausweg |
| `lib/request.js` | 473 | Harness-Rumpf → Drahtformat, für alle drei Lanes |
| `lib/stream.js` | 534 | SSE → `StreamChunk`, drei Zustandsautomaten |
| `lib/transport.js` | 361 | natives TLS-Cipher-Impersonat, opt-in `wreq-js` |
| `lib/config.js` | 248 | Konfiguration prüfen und vervollständigen |
| `test/gate-server.mjs` | 426 | lokaler Gegenpart, der jedes Gate durchsetzt — die Tests laufen deshalb offline |

Tests: `npm test` (= `node --test test/*.test.mjs`). **Nicht** `node --test test/` — das läuft mit
`MODULE_NOT_FOUND` in die Verzeichnisform.

### 9.2 Invarianten, die nicht gebrochen werden dürfen

1. **Niemals `attributionHeaders()` auf dieser Lane senden.** Der Harness verlangt es von einem Adapter,
   dieses Plugin verweigert es bewusst: Die gerenderte UA enthält `deepseek-harness`, und genau das wird
   case-insensitiv an beliebiger Position mit 403 beantwortet. Das ist der Grund, warum bestehende
   Harness-Integrationen an der Free-Lane scheitern. Der Zielkonflikt ist in `README.md` und `gate.md`
   dokumentiert — nicht stillschweigend „reparieren".
2. **`stream()` liest denselben aufgelösten Katalog wie `prepareCall`/`resolveModel`**, nicht
   `catalog.peek()`. Sonst werden Bilder still verworfen.
3. **Der `<env>`-Marker und die Werkzeug-Gates sind unabhängig.** Der Marker gilt nicht nur im
   Werkzeug-Zweig.
4. **Der abschließende `finish`-Chunk wird zurückgehalten**, bis feststeeht, ob der Stream leer war: Ein
   200-Stream ohne `choices` ist als `EMPTY_RESPONSE` zu melden (steht in
   `DEFAULT_RETRYABLE_CODES`), und nach `finish` darf nichts mehr kommen.
5. **5xx müssen als `SERVER` berichtet werden** — nur dann greift die Wiederholungsrichtlinie des Harness
   (`DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`).
6. **Die Entry-`id` `opencode-free` ist gleichzeitig der Einstellungs-Namensraum**
   (`ctx.fiber.entry?.options.id`). Umbenennen verwaist alles, was ein Benutzer darunter gespeichert hat.
7. **Session-IDs aus `Date.now()` prägen**, nicht aus einem Digest: Die Form stimmt dann zwar, aber
   digest-abgeleitete IDs fallen in Messreihen zu etwa 9/10 durch.

### 9.3 Bewusste Entscheidungen, die wie Versehen aussehen

- **Keine `dependencies`, keine `optionalDependencies`, kein `prepare`.** Eine optionale Abhängigkeit wird
  beim Install trotzdem aufgelöst; ein natives Plattform-Binding
  (`@wreq-js/binding-win32-x64-msvc`) ist genau das, was eine Windows-Installation in ein
  Electron-gebündeltes Node am ehesten ausbremst. Der ausgelieferte Transport braucht kein natives Modul —
  Node erzeugt die Cipher-Liste selbst. Wer den vollen Browser-Fingerprint will, installiert `wreq-js`
  selbst ins Profil (`pnpm add -w wreq-js`) und setzt `transport.mode: wreq`; fehlt das Paket, meldet sich
  der Modus mit klarer Meldung, statt still zu degradieren.
- **Kein `engines.dsh`.** Ein eigenes `engines.dsh` würde die Peer-Prüfung komplett ersetzen und damit
  enger machen, als die Peer-Bereiche es sind (Abschnitt 2.4).
- **Weite, optionale Peer-Bereiche** (`peerDependenciesMeta.*.optional: true`), damit dieselbe Fassung
  gegen `0.2.0-rc.1` bis `0.2.2` lädt. Achtung bei `npm install <peer>` im Repo: npm **verengt**
  `peerDependencies` dabei auf die installierte Version — danach von Hand wiederherstellen.
- **`package-lock.json` ist gitignored**, weil es die nur für Tests installierten Pakete festschreiben
  würde, die das Paket selbst nicht deklariert.

### 9.4 Bekannte Fallstricke aus der Entwicklung

- `override` vor einer Klassenmethode ist TypeScript-only und in reinem JS ein Syntaxfehler.
- `wreq-js`: `createSession()` liefert ein **Promise** (ohne `await` entsteht ein Objekt ohne `fetch` →
  `session.fetch is not a function`), und das rustls-Backend lehnt TLS-1.3-Suite-Namen in `cipherList` mit
  `NO_CIPHER_MATCH` ab → `tls12CipherSubset()` und eine `typeof session.fetch === 'function'`-Prüfung.
- Ein Cordis-Integrationstest hängt 300 s, wenn eine ungefangene `ReferenceError` den HTTP-Server offen
  lässt: immer `t.after(() => server.close())`.
- `pip install pyyaml` ist in verwalteten Umgebungen blockiert (PEP 668); `js-yaml` aus npm tut es auch.

---

## 10. Offene Punkte

In Reihenfolge ihres Wertes:

1. **Live-Verifikation auf einem echten Windows-Rechner** — der eine Punkt, den diese Übergabe nicht
   leisten konnte (Abschnitt 0, Kasten). Konkret: Weg A durchklicken, Checkliste aus Abschnitt 4 abarbeiten,
   `probe.mjs` und `probe.mjs --ablate` einmal ausführen und die Ausgabe hier eintragen. Erst danach ist
   „nutzbar in der aktuellen Windows-Version" belegt und nicht nur hergeleitet.
2. **PR #1 entscheiden.** Solange er offen ist, muss jede Installationsanleitung den Branch in der
   Git-Spec mitführen. Nach einem Merge genügt `github:<fork>/dsh-9router`.
3. **Kontingent-Verfolgung über Prozessgrenzen hinweg.** Die Session-ID trägt die Kontingentgrenze; ein
   Zähler pro Session und ein Backoff, der 429 nicht sofort wiederholt, wären ein echter Gewinn. Die Idee
   stammt aus dem archivierten `randomix777/dsh-opencode-zen` (dort Quota-Tracker), dessen Drahtschicht
   dieses Paket ersetzt.
4. **Anzeigename und Locale.** `displayName` ist eine Zeichenkette ohne Lokalisierung; die UI des Harness
   ist mehrsprachig (u. a. `zh-CN`). Bei Bedarf `displayName` pro Locale.
5. **UA-Version im Blick behalten.** `opencode/latest/2.0.26/cli` altert. Die Prüfung verlangt aktuell
   Major ≥ 2 und den genauen String; sobald OpenCode nachzieht, ist `fingerprint.userAgent` der erste
   Kandidat — per Konfiguration änderbar, kein Release nötig.
6. **`transport.mode: wreq` unter Windows vermessen.** Bewusst nicht ausgeliefert (9.3); wer es anbietet,
   sollte das native Binding auf einem Windows-x64-Electron prüfen, bevor es empfohlen wird.

---

## 11. Quellen und Messdaten

**Grundlage dieser Übergabe — aus dem Quellcode gelesen, nicht geraten:**

- `dataelement/dsh-desktop` v0.12.1: `src/main/index.ts` (`userData`, `dshHome`, `dshEntryPath()`,
  `bundledNodePath()`, Menü **Harness**), `src/main/runtime/profile-plugin-command.ts` (`.desktop-bin`-Shims,
  Umgebungsvariablen für Paketaktionen), `src/main/runtime/electron-node-executable.ts` (kein eigenes Node),
  `src/main/runtime/harness-runtime.ts` (`DSH_HOME` für den Harness-Prozess), `src/main/repair-agent.ts`
  (Pfade, `cordis.patch.yml` als Benutzerebene, `dsh.profile.bundles` nicht editieren, Deaktivieren in zwei
  Dateien, Safe Mode lädt keine Drittplugins), `package.json` `build` (NSIS, x64, `oneClick: false`).
- `@deepseek-ai/dsh-app-boot@0.2.1-rc.2`: `unmetRequirements()`, `evaluatePluginCompatibility()`,
  `pluginCompatibilityWarning()`, `resolveProfileDir()`, `PROFILE_TEMPLATES`, Beschreibung des
  Patch-Dialekts („config is replaced wholesale, not deep-merged").
- `@deepseek-ai/dsh-home-paths@0.2.1-rc.2`: `DSH_HOME`-Vorrang, Default `~/.dsh`, `dshCachePath()`.
- `@deepseek-ai/dsh-plugin-manager@0.2.1-rc.2`: `parseInstallSpec()` (vier Spec-Formen, Relativpfade
  abgelehnt), `dependencySpec()`, Bundle-Registrierung in `dsh.profile.bundles`.
- `@deepseek-ai/dsh@0.2.1-rc.2`: `lib/plugin-*.js` (pnpm fehlt → Exit 127; `allow-version`-Syntax;
  `prepare`-Warnung für git-gehostete Plugins), `lib/bin.js` (Hilfebeispiele, `--dump-config`).
- `@deepseek-ai/dsh-llm@0.2.1-rc.2`: `LlmAdapter`-, `LlmRuntime`-, `StreamChunk`-, `GenerateOptions`- und
  `LlmResolvedModelInfo`-Vertrag, `DEFAULT_RETRYABLE_CODES`, `LlmModelContext` hat **nur** `contextWindow`.
- `@deepseek-ai/dsh-client-ui-settings-models`: Modelle-Seite zeigt Zeilen konfigurierbarer Provider;
  Profil-`headers` haben keinen Editor (sie gehören in die Patch-Ebene).

**Drahtseite — gemessen von anderen, datiert, mit Auflösung von Widersprüchen in `gate.md`:**

- `anomalyco/opencode` (offizieller Client): `packages/ai/src/providers/opencode.ts` (Endpunkt,
  `TypeSafe-Danger-Zone-Images: true`), `packages/core/src/session/model-request.ts` (maßgeblicher
  Header-Satz), `packages/core/src/session/affinity.ts` (`affinity = parentID ?? fork?.sessionID ?? id`).
- `decolua/9router` — Live-Messungen vom **2026-10-26**, die entscheidende Quelle: `/inference/v1`,
  UA, Session-Prägung, Zählergrenze, wörtliche Werkzeugdefinitionen, `<env>`-Marker,
  `tool_choice:"none"` → 403, TLS-ClientHello-Messung (JA4-Cipher-Hash `5b57614c22b0`, Umsortieren
  besteht, kein GREASE), Kapazitäten und Reasoning-Stufen pro Modell. Dieses Repo ist nach jenem Projekt
  benannt.
- `Ebony-Vinyl/dsh-our-free-model`, `docs/free-lane-wire.md` — TLS-MITM-Mitschnitt plus
  Byte-für-Byte-Ablation, 2026-10-14 (v1) und 2026-10-16 (v2): Herkunft der
  `deepseek-harness`-in-UA-Ablehnung und der v1→v2-Änderungstabelle.
- `TheHiddenDeveloper/zen-proxy` — unabhängige Nachprüfung 2026-10-15, Quelle der Lane-Ablehnungen.
- `randomix777/dsh-opencode-zen` — am 2026-06 archiviert mit dem Hinweis, die Free-Stufe sei
  OpenCode-exklusiv geworden; Ziel `/zen/v1`, `...attributionHeaders()` im Header-Satz, keines der sechs
  Gates umgesetzt. Dessen Quota-Tracker und Katalog-Cache sind die Idee wert, die Drahtschicht ersetzt
  dieses Paket.

**Eigene Messungen in dieser Arbeit:**

- Node erzeugt die 17-Suite-Cipher-Liste **nativ** und ohne GREASE: ein echter ClientHello wurde von einem
  `net`-Server gelesen und Suite für Suite verglichen (`test/transport.test.mjs`). Deshalb braucht dieses
  Paket kein natives Modul für Gate 6.
- Die Kompatibilitätsmatrix in Abschnitt 2.4 wurde mit der Originalfunktion aus `dsh-app-boot` gegen unser
  `package.json` gerechnet, nicht abgeschätzt.
- 86 Tests gegen einen lokalen Gate-Server, der jede der sechs Prüfungen durchsetzt.

**Zwei aufgelöste Widersprüche** (ausführlich in `gate.md`): `/zen/v1` gegen `/inference/v1` — die jüngere,
direkt gemessene Quelle gewinnt; fehlende Werkzeuge ergeben 403 oder 429 — die jüngere Messung (429)
gewinnt, und `describeFailure()` erklärt beide Status, ohne sich auf einen zu verlassen.
