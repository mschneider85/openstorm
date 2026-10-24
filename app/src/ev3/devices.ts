/** Known EV3 device types and their modes (type numbers from the firmware). */
export interface DeviceInfo {
  name: string;
  modes: { name: string; unit: string }[];
}

export const TYPE_NONE = 126;
export const TYPE_PORT_ERROR = 125;

export const DEVICES: Record<number, DeviceInfo> = {
  1: { name: 'NXT-Berührungssensor', modes: [{ name: 'Gedrückt', unit: '' }] },
  7: {
    name: 'Großer Motor',
    modes: [
      { name: 'Grad', unit: '°' },
      { name: 'Umdrehungen', unit: 'U' },
      { name: 'Geschwindigkeit', unit: '%' },
    ],
  },
  8: {
    name: 'Mittlerer Motor',
    modes: [
      { name: 'Grad', unit: '°' },
      { name: 'Umdrehungen', unit: 'U' },
      { name: 'Geschwindigkeit', unit: '%' },
    ],
  },
  16: { name: 'Berührungssensor', modes: [{ name: 'Gedrückt', unit: '' }, { name: 'Zähler', unit: '' }] },
  29: {
    name: 'Farbsensor',
    modes: [
      { name: 'Reflektiert', unit: '%' },
      { name: 'Umgebung', unit: '%' },
      { name: 'Farbe', unit: '' },
    ],
  },
  30: {
    name: 'Ultraschallsensor',
    modes: [
      { name: 'Abstand', unit: 'cm' },
      { name: 'Abstand', unit: 'inch' },
      { name: 'Ultraschall hören', unit: '' },
    ],
  },
  32: {
    name: 'Gyrosensor',
    modes: [
      { name: 'Winkel', unit: '°' },
      { name: 'Rate', unit: '°/s' },
    ],
  },
  33: {
    name: 'Infrarotsensor',
    modes: [
      { name: 'Nähe', unit: '%' },
      { name: 'Signal', unit: '' },
      { name: 'Fernbedienung', unit: '' },
    ],
  },
};

export const COLOR_NAMES = ['Keine', 'Schwarz', 'Blau', 'Grün', 'Gelb', 'Rot', 'Weiß', 'Braun'];
export const COLOR_CSS = ['transparent', '#111', '#1e5bd8', '#1a9b3c', '#f2c500', '#d2232a', '#fff', '#7b4a1e'];

export function deviceName(type: number): string {
  if (type === TYPE_NONE) return 'Nicht verbunden';
  if (type === TYPE_PORT_ERROR) return 'Portfehler';
  return DEVICES[type]?.name ?? `Unbekanntes Gerät (Typ ${type})`;
}

export function isMotorType(type: number): boolean {
  return type === 7 || type === 8;
}
