# OpenStorm

Blockprogrammierung für LEGO MINDSTORMS EV3 auf dem iPad, ohne Mac, ohne Kabel und ohne bezahlten Apple-Developer-Account.

- **Programm**: Programmieren mit Blöcken wie in Scratch, in den Farben der EV3-Software: Ablauf, Motoren, Anzeige und Ton, Sensoren, Rechnen, Variablen und eigene Blöcke. Mehrere „Programmstart“-Blöcke laufen gleichzeitig.
- **Geräte**: Zeigt, was an den Ports 1–4 und A–D steckt, mit Live-Werten und umschaltbarem Modus. Motoren lassen sich per Antippen und Halten bewegen. Außerdem gibt es Statusleuchte, Ton und Anzeige zum Ausprobieren.
- **Simulator**: Ein virtueller EV3 im Browser. Sensorwerte stellt man unter „Geräte“ ein, Töne sind hörbar, und die Anzeige wird nachgebildet.

Programme laufen in der App und steuern den EV3 live per Bluetooth über *Direct Commands*. Das iPad muss also während des Programms verbunden bleiben.

## So funktioniert es

```
iPad (Safari)  ──WLAN──▶  Raspberry Pi Zero W  ──Bluetooth──▶  EV3
                          „OpenStorm-Brücke“
                          liefert auch die App aus
```

Safari auf dem iPad kann kein Bluetooth, und der EV3 spricht nur Bluetooth Classic. Ein Raspberry Pi Zero W sitzt dazwischen:
- Er stellt die App unter **http://openstorm.local** bereit.
- Er leitet die Befehle per Bluetooth an den EV3 weiter.

Auf dem iPad muss **keine App installiert** werden.

## Einrichtung

### 1. Raspberry Pi vorbereiten (einmalig)

1. Das fertige Image herunterladen:
   **https://github.com/mschneider85/openstorm/releases/download/pi-image/openstorm-pi.img.xz**
2. Den [Raspberry Pi Imager](https://www.raspberrypi.com/software/) öffnen und unter *Gerät* „Raspberry Pi Zero“ wählen.
3. Unter *Betriebssystem* ganz unten **„Eigenes Image“** wählen und die heruntergeladene Datei angeben. Entpacken ist nicht nötig.
4. SD-Karte wählen. Bei der Frage nach **„OS-Anpassungen“**:
   - **Mit Heim-WLAN (empfohlen):** *Einstellungen bearbeiten* → WLAN-Name, Passwort und Land eintragen.
     Das iPad bleibt dann in deinem normalen WLAN.
   - **Ohne:** *Nein*. Der Pi öffnet dann sein eigenes WLAN **„OpenStorm“** (Passwort `openstorm`).
     Während das iPad damit verbunden ist, hat es kein Internet.
5. SD-Karte in den Pi stecken und Strom anschließen, über eine Powerbank oder den USB-Port des EV3.
   Nach etwa 40–60 Sekunden ist die Brücke bereit.
   Findet der Pi das eingetragene Heim-WLAN nicht, öffnet er automatisch sein eigenes.

**Die grüne Leuchte am Pi:**
- **langsames Blinken:** bereit, aber kein EV3 verbunden
- **Dauerlicht:** mit dem EV3 verbunden

Wartungs-Login: Benutzer `openstorm`, Passwort `openstorm`, sofern im Imager nichts anderes eingestellt wurde.

### 2. EV3 einstellen (einmalig)

*Einstellungen (Schraubenschlüssel) → Bluetooth:*
- **Bluetooth** an
- **Sichtbarkeit** an
- **iPhone/iPad/iPod** aus

Den EV3 **nicht** in den Bluetooth-Einstellungen des iPads koppeln, das übernimmt der Pi.

### 3. iPad (einmalig)

1. In **Safari** **http://openstorm.local** öffnen.
   - Mit dem eigenen WLAN des Pi geht auch **http://10.42.0.1**.
2. *Teilen* (□↑) → **„Zum Home-Bildschirm“**. OpenStorm hat dann ein eigenes Symbol und startet im Vollbild.

### 4. Verbinden

- **Beim ersten Mal:**
  1. Oben rechts auf **„Nicht verbunden“** tippen, dann auf **„Verbinden“**.
  2. Die Brücke sucht EV3-Steine in der Nähe. Deinen EV3 auswählen.
  3. Der EV3 fragt nach dem Code `1234` – bestätigen.
- **Danach** verbindet sich OpenStorm beim Öffnen **automatisch** mit diesem EV3.
- Im Verbindungsdialog steht, ob die Brücke erreichbar und der EV3 verbunden ist.

**Hinweise:**
- Projekte werden im Browser gespeichert, und zwar getrennt für jede Adresse. Nutze darum immer dieselbe Adresse, also `openstorm.local`.
- Neue Versionen der App kommen mit einem neuen Pi-Image auf den Pi.

## Weitere Verbindungswege

| Gerät | Verbindung |
|---|---|
| iPad mit Safari | über die Pi-Brücke per WLAN (siehe oben) |
| iPad mit [Bluefy](https://apps.apple.com/de/app/id1492822055) | über die Pi-Brücke per Bluetooth LE: https://mschneider85.github.io/openstorm/ |
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
python3 -m unittest -v   # Tests der Pi-Brücke (test_web braucht aiohttp)
```

Bei jedem Push auf `main` baut GitHub automatisch:

| Workflow | Ergebnis |
|---|---|
| `pages.yml` | Web-App auf https://mschneider85.github.io/openstorm/ |
| `pi-image.yml` | SD-Karten-Image inkl. Web-App als Release `pi-image` |
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
  openstorm_bridge.py      Webserver + WebSocket (WLAN) und BLE-Dienst ⇄ RFCOMM (EV3),
                           koppelt den EV3 mit PIN 1234, steuert die Status-Leuchte
  OpenStorm-Hotspot.nmconnection   eigenes WLAN, falls kein Heim-WLAN eingerichtet ist
  install-pi.sh            Installation auf Raspberry Pi OS (auch für den Image-Build)
```

## Ideen für später

- Programme in EV3-Bytecode (`.rbf`) übersetzen und auf den Stein laden, damit sie ohne iPad laufen
- Brücke auf einem ESP32 (startet in einer Sekunde, verträgt hartes Ausschalten)
- weitere Blöcke: Gyro zurücksetzen, Datenprotokollierung, Nachrichten zwischen Steinen
