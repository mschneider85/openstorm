# OpenStorm

Blockprogrammierung für LEGO MINDSTORMS EV3 auf dem iPad, ohne Mac, ohne Kabel und ohne bezahlten Apple-Developer-Account.

- **Programm**: Programmieren mit Blöcken wie in LEGO Education EV3 Classroom (Scratch), mit denselben Kategorien und Farben: Motoren, Fahren, Anzeige, Klang, Ereignisse, Steuerung, Sensoren, Operatoren, Variablen und Listen, Meine Blöcke. Alle Ereignisblöcke („Wenn Programm startet“, „Wenn Berührungssensor gedrückt“, „Wenn ich Nachricht empfange“ …) laufen gleichzeitig.
- **Geräte**: Zeigt, was an den Ports 1–4 und A–D steckt, mit Live-Werten und umschaltbarem Modus. Motoren lassen sich per Antippen und Halten bewegen. Außerdem gibt es Statusleuchte, Ton und Anzeige zum Ausprobieren.
- **Simulator**: Ein virtueller EV3 im Browser. Sensorwerte stellt man unter „Geräte“ ein, Töne sind hörbar, und die Anzeige wird nachgebildet.

Programme laufen auf zwei Arten:
- **▶ Start:** Das Programm läuft in der App und steuert den EV3 live. Die gerade aktiven Blöcke leuchten auf. Das iPad muss dafür verbunden bleiben.
- **⇩ Auf EV3:** Die App übersetzt das Programm in die Maschinensprache des EV3 (`.rbf`, wie die originale LEGO-Software) und speichert es auf dem Stein. Dort läuft es ohne iPad.

### Unterschiede zu EV3 Classroom

- **Bilder und Klänge:** Die Bilder (Augen, Smiley, Pfeile …) und Klänge (Hupe, Sirene, Erfolg …) sind eigene, denn die von LEGO dürfen nicht mitgeliefert werden. Die Klänge lädt die App beim ersten Abspielen in den Ordner `OpenStorm` auf dem EV3.
- **Listen auf dem EV3:** Wenn das Programm auf dem Stein läuft (⇩ Auf EV3), können Listen nur Zahlen enthalten. Texte sind dort höchstens 255 Zeichen lang, „Zeichen … von“ und „enthält“ sehen nur die ersten 127.
- **Infrarotsensor:** Der Infrarotsensor und die Fernbedienung aus dem EV3-Home-Set haben zusätzliche Blöcke unter „Sensoren“.
- **Nicht nachgebaut:** Wetter, Musik-Erweiterung sowie Messwerte aufzeichnen und darstellen.

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
4. SD-Karte wählen und schreiben. Die Frage nach „OS-Anpassungen“ mit *Nein* beantworten; bei eigenen Images ist das ohnehin ausgegraut.
5. **Heim-WLAN eintragen (empfohlen):**
   - Die SD-Karte nach dem Schreiben kurz aus- und wieder einstecken. Windows zeigt dann ein Laufwerk **„bootfs“**.
   - Darin die Datei **`openstorm-wlan.txt`** mit dem Editor öffnen.
   - `WLAN_NAME=` und `WLAN_PASSWORT=` ausfüllen und speichern.
   - Ohne Eintrag oder wenn das WLAN nicht erreichbar ist, öffnet der Pi sein eigenes WLAN **„OpenStorm“** (Passwort `openstorm`). Während das iPad damit verbunden ist, hat es kein Internet.
6. SD-Karte in den Pi stecken und Strom anschließen, über eine Powerbank oder den USB-Port des EV3.
   Nach etwa 1 Minute ist die Brücke bereit.

**Die grüne Leuchte am Pi:**
- **langsames Blinken:** bereit, aber kein EV3 verbunden
- **Dauerlicht:** mit dem EV3 verbunden

Wenn etwas nicht klappt:
- **http://openstorm.local/log** zeigt das Protokoll der Brücke, des WLANs und von Bluetooth.
- Wartungs-Login per Tastatur oder SSH (`ssh openstorm@openstorm.local`): Benutzer `openstorm`, Passwort `openstorm`.

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

### 5. Programme auf dem EV3

- **Übertragen:** Oben auf **„⇩ Auf EV3“** tippen. Die App fragt danach, ob das Programm gleich starten soll.
- **Am Stein starten:** *Datei-Navigation* (zweiter Reiter) → Ordner mit dem Projektnamen → Programm. Mit der Zurück-Taste stoppen.
- **Zurückholen:** *Projekte* → **„Programme auf dem EV3 anzeigen“** → **Öffnen**. Das geht, weil OpenStorm neben jedem Programm eine unsichtbare Kopie der Blöcke ablegt (`.openstorm`).
- Programme aus der originalen LEGO-Software lassen sich so nicht öffnen. Auf dem Stein liegt von ihnen nur das übersetzte Programm, nicht die Blöcke.
- Auf dem EV3 hat „in der App ausgeben“ keine Wirkung. Rekursive eigene Blöcke (ein Block ruft sich selbst auf) gehen dort nicht. Eine Variable muss entweder immer Text oder immer eine Zahl enthalten.

**Hinweise:**
- Projekte werden im Browser gespeichert, und zwar getrennt für jede Adresse. Nutze darum immer dieselbe Adresse, also `openstorm.local`.
- **Updates:** Gibt es eine neue Version, meldet die App das beim Start. Unter *Verbindung → Brücke aktualisieren* tippst du auf **„Jetzt aktualisieren“**. Der Pi lädt das Update von GitHub und installiert es. Dabei kommen auch neue Pakete, Dienste und WLAN-Einstellungen mit. Danach startet nur die Brücke neu, nicht der ganze Pi, und die App lädt sich selbst neu.
  - Dauer: Ändern sich nur Brücke und App, tauscht der Pi nur diese aus. Das dauert wenige Sekunden. Ändert sich die Einrichtung (Pakete, Dienste, WLAN), läuft das Installationsskript, das kann einige Minuten dauern. Den Pi währenddessen nicht ausschalten.
  - Der Pi muss dafür im Heim-WLAN mit Internet sein.
  - Das Pi-Image braucht man nur für die Ersteinrichtung. Ein komplettes Systemupdate aller Pakete (`apt upgrade`) macht OpenStorm bewusst nicht, weil es auf dem Pi Zero sehr lange dauert.

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
| `pi-image.yml` | SD-Karten-Image inkl. Web-App als Release `pi-image`, Update-Paket für laufende Pis als Release `pi-update` |
| `ios.yml` | iPad-App als neuestes Release (nur bei Änderungen in `app/`) |

Die Brücke lässt sich auch auf einem vorhandenen Raspberry Pi OS installieren: `sudo sh bridge/install-pi.sh`.
Ihr Protokoll zeigt `journalctl -u openstorm-bridge -f`.

## Aufbau

```
app/
  src/ev3/          EV3-Protokoll: Bytecode-Assembler, Direct Commands, Dateiübertragung, Simulator
  src/transport/    Verbindungen: Pi-Brücke (Web Bluetooth), iOS-Plugin, Web Serial
  src/blocks/       Block-Definitionen, Werkzeugleiste, Code-Generator (App) und rbf.ts (Compiler für den EV3)
  src/runtime/      führt den erzeugten Code aus (Start/Stopp, parallele Abläufe)
  src/ui/           Editor, Geräte-Seite, Dialoge
  ios/App/App/      Xcode-Projekt; EV3Plugin.swift ist das Bluetooth-Plugin
  test/             Vitest-Tests; ev3vm.ts bildet die EV3-VM nach (Prüfung wie die Firmware + Ausführung)
bridge/
  openstorm_bridge.py      Webserver + WebSocket (WLAN) und BLE-Dienst ⇄ RFCOMM (EV3),
                           koppelt den EV3 mit PIN 1234, steuert die Status-Leuchte
  OpenStorm-Hotspot.nmconnection   eigenes WLAN, falls kein Heim-WLAN eingerichtet ist
  openstorm-wlan.txt       Vorlage auf der SD-Karte für Heim-WLAN (wlan-setup.sh liest sie)
  install-pi.sh            Installation auf Raspberry Pi OS (auch für den Image-Build)
```

## Ideen für später

- Brücke auf einem ESP32 (startet in einer Sekunde, verträgt hartes Ausschalten)
- weitere Blöcke: Gyro zurücksetzen, Datenprotokollierung, Nachrichten zwischen Steinen
