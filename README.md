# OpenStorm

Blockprogrammierung für LEGO MINDSTORMS EV3 auf dem iPad, ohne Mac, ohne Kabel und ohne bezahlten Apple-Developer-Account.

- **Programm**: Programmieren mit Blöcken wie in Scratch, in den Farben der EV3-Software: Ablauf, Motoren, Anzeige und Ton, Sensoren, Rechnen, Variablen und eigene Blöcke. Mehrere „Programmstart“-Blöcke laufen gleichzeitig.
- **Geräte**: Zeigt, was an den Ports 1–4 und A–D steckt, mit Live-Werten und umschaltbarem Modus. Motoren lassen sich per Antippen und Halten bewegen. Außerdem gibt es Statusleuchte, Ton und Anzeige zum Ausprobieren.
- **Simulator**: Ein virtueller EV3 im Browser. Sensorwerte stellt man unter „Geräte“ ein, Töne sind hörbar, und die Anzeige wird nachgebildet.

Programme laufen in der App und steuern den EV3 live per Bluetooth über *Direct Commands*. Das iPad muss also während des Programms verbunden bleiben.

## So funktioniert es

```
iPad (Bluefy-Browser)  ──BLE──▶  Raspberry Pi Zero W  ──Bluetooth──▶  EV3
       OpenStorm-Web-App           „OpenStorm-Brücke“
```

Safari auf dem iPad kann kein Bluetooth. Die kostenlose App **Bluefy** aus dem App Store kann es, allerdings nur Bluetooth LE. Der EV3 spricht nur das ältere Bluetooth Classic. Ein Raspberry Pi Zero W übersetzt zwischen beiden.

## Einrichtung

### 1. Raspberry Pi vorbereiten (einmalig)

1. Das fertige Image herunterladen:
   **https://github.com/mschneider85/openstorm/releases/download/pi-image/openstorm-pi.img.xz**
2. Den [Raspberry Pi Imager](https://www.raspberrypi.com/software/) öffnen und unter *Gerät* „Raspberry Pi Zero“ wählen.
3. Unter *Betriebssystem* ganz unten **„Eigenes Image“** wählen und die heruntergeladene Datei angeben. Entpacken ist nicht nötig.
4. Die SD-Karte wählen und schreiben. Die Frage nach „OS-Anpassungen“ mit *Nein* beantworten.
5. Die SD-Karte in den Pi stecken und Strom anschließen, über eine Powerbank oder den USB-Port des EV3.
   Nach etwa 40 Sekunden ist die Brücke bereit. Sie braucht kein WLAN.

Wartungs-Login für Tastatur und Bildschirm: Benutzer `openstorm`, Passwort `openstorm`.

### 2. EV3 einstellen (einmalig)

*Einstellungen (Schraubenschlüssel) → Bluetooth:*
- **Bluetooth** an
- **Sichtbarkeit** an
- **iPhone/iPad/iPod** aus

### 3. iPad (einmalig)

1. **[Bluefy – Web BLE Browser](https://apps.apple.com/app/id1492822055)** aus dem App Store installieren.
2. In Bluefy diese Adresse öffnen: **https://mschneider85.github.io/openstorm/**
3. Ein Lesezeichen setzen, damit die Seite beim nächsten Mal mit einem Tipp da ist.

### 4. Verbinden

1. In OpenStorm oben rechts auf **„Nicht verbunden“** tippen und dann **„Brücke suchen …“**.
2. Im Bluefy-Fenster **„OpenStorm“** auswählen.
3. **Beim ersten Mal:** Die Brücke sucht EV3-Steine in der Nähe. Deinen EV3 auswählen, dann fragt der EV3 nach dem Code `1234` – bestätigen.
4. **Ab dem zweiten Mal** verbindet die Brücke automatisch mit dem zuletzt benutzten EV3.

Updates der App kommen automatisch, sobald neuer Code auf GitHub liegt.

## Weitere Verbindungswege

| Gerät | Verbindung |
|---|---|
| iPad mit Bluefy | über die Pi-Brücke (siehe oben) |
| PC/Mac mit Chrome oder Edge | über die Pi-Brücke (Web Bluetooth) oder direkt über den Bluetooth-COM-Port des gekoppelten EV3 (Web Serial) |
| Jeder Browser | Simulator |
| iPad mit selbst installierter App | natives Bluetooth-Plugin (siehe unten) |

### Optional: native iPad-App per Sideloading

Die App lässt sich auch als echte iPad-App installieren. Sie spricht dann ohne Brücke direkt mit dem EV3 (dafür am EV3 **iPhone/iPad/iPod an**). Das braucht aber einen PC, ein Kabel, eine Apple-ID und muss alle 7 Tage erneuert werden.

- Neueste Version: **https://github.com/mschneider85/openstorm/releases/latest/download/OpenStorm.ipa**
- Installieren z. B. mit [Sideloadly](https://sideloadly.io) oder SideStore. Auf dem PC wird der Apple-USB-Treiber gebraucht (`AppleMobileDeviceSupport64.msi` aus dem iTunes-Installer von apple.com).
- Auf dem iPad den *Entwicklermodus* einschalten und unter *VPN & Geräteverwaltung* der Apple-ID vertrauen.

## Entwickeln (Linux/WSL/Windows)

```bash
cd app
npm install
npm run dev     # http://localhost:5173, mit Simulator testen
npm test        # Protokoll-, Brücken-, Simulator- und Programmtests
npm run build   # Web-App nach app/dist

cd ../bridge
python3 -m unittest -v   # Tests der Pi-Brücke
```

Bei jedem Push auf `main` baut GitHub automatisch:

| Workflow | Ergebnis |
|---|---|
| `pages.yml` | Web-App auf https://mschneider85.github.io/openstorm/ |
| `pi-image.yml` | SD-Karten-Image als Release `pi-image` (nur bei Änderungen in `bridge/`) |
| `ios.yml` | iPad-App als neuestes Release (nur bei Änderungen in `app/`) |

Die Brücke lässt sich auch auf einem vorhandenen Raspberry Pi OS installieren: `sudo sh bridge/install-pi.sh`.
Ihr Protokoll zeigt `journalctl -u openstorm-bridge -f`.

## Aufbau

```
app/
  src/ev3/          EV3-Protokoll: Bytecode-Encoder, Direct Commands, Simulator
  src/transport/    Verbindungen: Pi-Brücke (Web Bluetooth), iOS-Plugin, Web Serial
  src/blocks/       Block-Definitionen, Werkzeugleiste, Code-Generator
  src/runtime/      führt den erzeugten Code aus (Start/Stopp, parallele Abläufe)
  src/ui/           Editor, Geräte-Seite, Dialoge
  ios/App/App/      Xcode-Projekt; EV3Plugin.swift ist das Bluetooth-Plugin
  test/             Vitest-Tests
bridge/
  openstorm_bridge.py      BLE-Dienst (iPad) ⇄ RFCOMM (EV3), koppelt den EV3 mit PIN 1234
  install-pi.sh            Installation auf Raspberry Pi OS (auch für den Image-Build)
```

## Ideen für später

- Programme in EV3-Bytecode (`.rbf`) übersetzen und auf den Stein laden, damit sie ohne iPad laufen
- Brücke auf einem ESP32 (startet in einer Sekunde, verträgt hartes Ausschalten)
- weitere Blöcke: Gyro zurücksetzen, Datenprotokollierung, Nachrichten zwischen Steinen
