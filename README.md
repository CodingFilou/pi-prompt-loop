# pi-prompt-loop

**Ein Prompt. Pi arbeitet weiter, bis die Aufgabe erledigt ist.**

Eine kleine Extension für [Pi](https://pi.dev): Wenn der Agent seine Antwort beendet, aber den Auftrag noch nicht abgeschlossen hat, bekommt er unsichtbar den Auftrag zum Weiterarbeiten. Kein Aufgaben-Framework, kein Dashboard und keine zusätzlichen Prüfer-Agenten.

```text
/loop Schreibe dieses Projekt vollständig in Rust um.
```

Der Loop endet bei einer Fertigmeldung, einer echten Blockade, einem Sicherheitslimit oder deinem Stop. „Fertig“ bleibt die Einschätzung des Modells, keine unabhängige Garantie.

## Installieren

Voraussetzungen: **Pi 1.4.0** (damit getestet) und **Git** für die Installation aus GitHub. Die Extension nutzt APIs von Pi 1.4 und ist nicht für ältere Pi-Versionen getestet.

Im normalen Terminal:

```sh
pi install git:github.com/CodingFilou/pi-prompt-loop
```

Danach Pi starten oder im bereits laufenden Pi `/reload` ausführen.

Eine bestimmte Version installieren:

```sh
pi install git:github.com/CodingFilou/pi-prompt-loop@v0.1.0
```

Kein Build und keine separat zu installierenden Laufzeitbibliotheken nötig. Die verwendeten Pi-Bibliotheken werden vom Host bereitgestellt.

> Bereits eine manuelle Kopie dieser Extension unter `~/.pi/agent/extensions/loop/` installiert? Vor einem zusätzlichen Paketinstall diese Kopie aus dem Extension-Verzeichnis verschieben, damit `/loop` nicht doppelt geladen wird. Auf einer frischen Installation ist das nicht nötig.

## Verwenden

Pi im gewünschten Projektverzeichnis starten und die Aufgabe eingeben:

```text
/loop Schreibe dieses Projekt vollständig in Rust um.
/loop Behebe die Testfehler und prüfe das Ergebnis.
```

Der Agent wird angewiesen:

- den ursprünglichen Auftrag vollständig zu bearbeiten, nicht nur einen Plan oder eine Teillösung zu liefern;
- normale technische Entscheidungen selbst zu treffen und bei unwesentlichen Unklarheiten ohne Rückfrage weiterzuarbeiten;
- Testfehler und gewöhnliche Implementierungsprobleme zu bearbeiten, statt sie sofort als Blockade zurückzugeben;
- vor dem Abschluss den gesamten Auftrag und passende Prüfergebnisse zu kontrollieren;
- echte, selbst nicht behebbare Hindernisse konkret zu benennen und keine Testergebnisse zu erfinden.

Auftragsgrenzen und erforderliche Zustimmungen bleiben bestehen. Fehlende Zugangsdaten oder eine zwingend benötigte, nicht verfügbare Umgebung kann auch ein Loop nicht ersetzen.

### Befehle und Limits

```text
/loop [--max N] [--minutes N] <Aufgabe>
/loop status
/loop stop
/loop test
/loop help
```

- Standard: **30 Modellrunden des Hauptagenten / 30 Minuten**.
- `--max`: ganze Zahl von **1 bis 100**.
- `--minutes`: ganze Zahl von **1 bis 120**.
- Optionen stehen vor der Aufgabe; `--` beendet die Optionsauswertung.
- Auch Antworten mit Tool-Aufrufen zählen als Runde. Mehrere Tools in einer Antwort zählen zusammen als eine Runde.
- Drei identische Zwischenantworten ohne weitere Tool-Arbeit stoppen den Loop ebenfalls.

Für längere Aufgaben beispielsweise:

```text
/loop --max 100 --minutes 120 Schreibe dieses Projekt vollständig in Rust um.
```

Die Limits können auch vor Abschluss der Aufgabe greifen. Sie sind kein Token- oder Kostenbudget.

## Darstellung

Im Chat steht die eigentliche Aufgabe, nicht die interne Steuerung. Der Footer zeigt beispielsweise:

```text
↻ Loop · 3/30 Runden · 0:12 / 30:00
```

Der interne Abschlussbefehl wird lesbar dargestellt:

```text
✓ Fertig
Änderung umgesetzt. Die relevanten Tests sind erfolgreich.
```

Oder bei einem echten Hindernis:

```text
■ Blockiert – deine Rückmeldung ist nötig
Für den erforderlichen Integrationstest fehlen die Zugangsdaten.
```

Keine UUIDs oder technischen Abschlussmarker. `/loop status` zeigt die Aufgabe und nach dem Ende die letzte Zusammenfassung. Die Dauer aktualisiert sich an Rundenübergängen und bei Statusabfragen; es gibt keinen zusätzlichen Animationstimer.

## Stop und Sitzungswechsel

**`Esc`** nutzt Pis normalen Abbruch. **`/loop stop`** beendet die automatische Fortsetzung und fordert den Abbruch der laufenden Arbeit an. Zeit- und Rundenlimits fordern ebenfalls einen Abbruch an. Bereits ausgeführte Änderungen werden nicht zurückgenommen.

Eine neue normale Eingabe beendet die automatische Fortsetzung. Sitzungswechsel, Baumnavigation, `/reload` und Programmende räumen Timer und Abschluss-Tool auf. Es gibt bewusst keinen automatischen Wiederanlauf nach Neustart oder Wiederaufnahme einer Sitzung.

Nicht gleichzeitig mit einem anderen automatischen Weiterarbeits-Loop für denselben Auftrag betreiben.

## Prüfen

In Pi:

```text
/loop test
```

Die 43 Selbsttests simulieren Extension-API und Uhr. Sie prüfen unter anderem Fortsetzungen, Limits, Stop, Abschlussdarstellung und Tool-Aktivierung. Keine Modell-, Netzwerk- oder Shell-Aufrufe, keine Dateiänderungen. Sie ersetzen keinen echten Funktionstest mit einem Modell.

Kleiner Modell-Funktionstest:

```text
/loop --max 3 --minutes 1 Berechne 2 + 2. Keine Shell-Befehle ausführen und keine Dateien ändern.
/loop status
```

Erwartung: Ergebnis 4 und Abschluss „Fertig“. Der interne `loop_finish`-Aufruf ist ein Tool-Aufruf; deshalb nicht pauschal alle Tools für diesen Test verbieten.

## Windows und andere Systeme

Der Loop selbst startet keine Shell und verändert keine Shell-Einstellungen. Er verwendet die Tools der Pi-Sitzung.

Wenn auf Windows kein funktionierendes Bash vorhanden ist, kann in Pis `~/.pi/agent/settings.json` das native PowerShell-Tool gewählt werden:

```json
{
  "defaultTools": ["-bash", "+powershell"]
}
```

Das ist eine Einstellung für Agenten-Tools, nicht für manuelle `!`-/`!!`-Befehle. Die Extension und ihre Selbsttests wurden mit Pi 1.4.0 unter Windows geprüft; separate Linux-/macOS-Livetests sind nicht erfolgt.

## Aktualisieren und entfernen

Für die unversionierte Git-Installation:

```sh
pi update git:github.com/CodingFilou/pi-prompt-loop
pi remove git:github.com/CodingFilou/pi-prompt-loop
```

Nach einem Update im laufenden Pi `/reload` ausführen. Ein mit Tag oder Commit gepinntes Paket bleibt auf diesem Stand. Beim Entfernen die gleiche Quelle wie bei der Installation angeben, einschließlich eines eventuell verwendeten Tags.

## Technische Grenzen

- Das Modell meldet den Abschluss strukturiert über `loop_finish` mit `done` oder `blocked`. Das Tool ist nur während eines aktiven Loops aktiviert und ausschließlich für das Modell erreichbar.
- Ein Abschluss zählt erst nach einem erfolgreichen Tool-Ergebnis in einer abgeschlossenen Runde. Andere aktive Tools werden beim Ein-/Ausschalten nicht zurückgesetzt.
- Interne Kontrollnachrichten sind im Terminal ausgeblendet, bleiben aber Teil von Modellkontext und Sitzung. Sie sind nicht geheim und können in Rohdaten/Exports erscheinen.
- Der Loop verwendet das aktuelle Modell, die aktuelle Sitzung und die vorhandenen Tools. Er startet keine separaten Agenten und prüft Abschlussbehauptungen nicht unabhängig.
- Runden- und Zeitlimits begrenzen nicht sämtliche Nutzung: Provider-Retries, Kompaktierung und Modellaufrufe innerhalb anderer Tools können zusätzliche Kosten verursachen.
- **Keine Sandbox oder Berechtigungskontrolle.** Normale Pi-/Benutzerrechte gelten. Nur auf vertrauenswürdige Projekte anwenden; vor Codeänderungen einen sauberen Git-Stand oder ein Backup anlegen.
- Ein Abbruch kann abgeschlossene Aktionen oder unabhängig gestartete Hintergrundprozesse nicht rückgängig machen.
- Alte finale Loop-Marker werden nur in der Terminaldarstellung ausgeblendet; gespeicherte Sitzungen werden nicht umgeschrieben.

## Dateien

- `index.ts`: Extension und Darstellung.
- `self-test.ts`: nur bei `/loop test` geladene Simulationstests.
- `package.json`: Pi-Paketmanifest; nur `index.ts` wird als Extension geladen.

## Lizenz

[MIT](LICENSE)
