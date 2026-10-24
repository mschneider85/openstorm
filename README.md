# OpenStorm

Blockprogrammierung für LEGO MINDSTORMS EV3 auf dem iPad, ohne Mac und ohne bezahlten Apple-Developer-Account.

- **Programm**: Programmieren mit Blöcken wie in Scratch, in den Farben der EV3-Software: Ablauf, Motoren, Anzeige und Ton, Sensoren, Rechnen, Variablen und eigene Blöcke. Mehrere „Programmstart“-Blöcke laufen gleichzeitig.
- **Geräte**: Zeigt, was an den Ports 1–4 und A–D steckt, mit Live-Werten und umschaltbarem Modus. Motoren lassen sich per Antippen und Halten bewegen. Außerdem gibt es Statusleuchte, Ton und Anzeige zum Ausprobieren.
- **Simulator**: Ein virtueller EV3 im Browser. Sensorwerte stellt man unter „Geräte“ ein, Töne sind hörbar, und die Anzeige wird nachgebildet.

Programme laufen in der App und steuern den EV3 live per Bluetooth über *Direct Commands*. Das iPad muss also während des Programms verbunden bleiben.

## Verbindungswege

| Gerät | Verbindung |
|---|---|
| iPad | installierte OpenStorm-App, Bluetooth über das native Plugin (`ExternalAccessory`) |
| PC/Mac mit Chrome oder Edge | Web Serial über den Bluetooth-COM-Port des gekoppelten EV3 |
| Jeder Browser | Simulator |

## Entwickeln (Linux/WSL/Windows)

```bash
cd app
npm install
npm run dev     # http://localhost:5173, mit Simulator testen
npm test        # Protokoll-, Simulator- und Programmtests
npm run build   # Web-App nach app/dist
```

## iPad-App bauen und installieren (kostenlos)

### 1. Code liegt auf GitHub

Repository: https://github.com/mschneider85/openstorm (öffentlich, dadurch sind die Mac-Builds kostenlos)

### 2. App herunterladen

Jeder Push auf `main` startet den Workflow **„iOS-App bauen“** (`.github/workflows/ios.yml`). Unter *Actions* kann man ihn auch per Hand starten. Nach etwa 2–10 Minuten erscheint die App als neues Release. Die neueste Version gibt es immer hier, ohne GitHub-Anmeldung:

**https://github.com/mschneider85/openstorm/releases/latest/download/OpenStorm.ipa**

### 3. Mit Sideloadly aufs iPad

1. [Sideloadly](https://sideloadly.io) unter Windows installieren. Es braucht iTunes und iCloud in der Version von apple.com, nicht aus dem Microsoft Store.
2. Das iPad per USB anschließen und dem Computer vertrauen.
3. In Sideloadly die `OpenStorm.ipa` hineinziehen, deine normale Apple-ID eintragen und auf *Start* klicken.
4. Auf dem iPad:
   - *Einstellungen → Datenschutz & Sicherheit → Entwicklermodus* einschalten (danach startet das iPad neu).
   - *Einstellungen → Allgemein → VPN & Geräteverwaltung →* deine Apple-ID *→ Vertrauen*.

**Einschränkungen der kostenlosen Apple-ID:**
- Die App läuft 7 Tage. Danach musst du sie mit Sideloadly erneut aufspielen. Das dauert etwa eine Minute, und Projekte bleiben erhalten.
- Es sind höchstens 3 selbst installierte Apps gleichzeitig möglich.

### 4. EV3 verbinden

1. Am EV3: *Einstellungen (Schraubenschlüssel) → Bluetooth* und dort **Bluetooth**, **Sichtbarkeit** und **iPhone/iPad/iPod** einschalten.
2. In OpenStorm oben rechts auf „Nicht verbunden“ tippen und dann *Neuen EV3 koppeln …* wählen, oder den EV3 vorher in den iPad-Bluetooth-Einstellungen koppeln. Am EV3 bestätigen, der Code ist `1234`.
3. Beim gekoppelten EV3 auf *Verbinden* tippen.

Für die Verbindung vom PC aus (Chrome/Edge) muss **iPhone/iPad/iPod am EV3 ausgeschaltet** sein. Die Option ist entweder für Apple-Geräte oder für alle anderen aktiv.

## Aufbau

```
app/
  src/ev3/          EV3-Protokoll: Bytecode-Encoder, Direct Commands, Simulator
  src/transport/    Verbindungen: iOS-Plugin, Web Serial, Aufteilung des Byte-Stroms
  src/blocks/       Block-Definitionen, Werkzeugleiste, Code-Generator
  src/runtime/      führt den erzeugten Code aus (Start/Stopp, parallele Abläufe)
  src/ui/           Editor, Geräte-Seite, Dialoge
  ios/App/App/      Xcode-Projekt; EV3Plugin.swift ist das Bluetooth-Plugin
  test/             Vitest-Tests
```

## Ideen für später

- Programme in EV3-Bytecode (`.rbf`) übersetzen und auf den Stein laden, damit sie ohne iPad laufen
- weitere Blöcke: Gyro zurücksetzen, Datenprotokollierung, Nachrichten zwischen Steinen
- Direktverbindung per USB-Kabel am PC (WebHID)
