import * as Blockly from 'blockly/core';
import { IMAGE_OPTIONS, LINES } from '../ev3/display';
import { SOUND_OPTIONS } from '../ev3/sounds';

/** Category colours as in LEGO Education EV3 Classroom (Scratch). */
export const COLORS = {
  motors: '#0090f5',
  movement: '#ff4ccd',
  display: '#9966ff',
  sound: '#cf63cf',
  events: '#ffbf00',
  control: '#ffab19',
  sensors: '#5cb1d6',
  operators: '#59c059',
  variables: '#ff8c1a',
  lists: '#ff661a',
  myBlocks: '#ff6680',
  datalog: '#0fbd8c',
  app: '#7a8794',
};

/** Variable type of lists ("Liste anlegen"). */
export const LIST_TYPE = 'List';

const MOTOR = [['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D']];
const MOTOR_OR_GROUP = [...MOTOR, ['B+C', 'BC'], ['A+D', 'AD'], ['A+B', 'AB'], ['C+D', 'CD'], ['alle', 'ABCD']];
/** Left motor first. */
const MOVE_PAIRS = [['B+C', 'BC'], ['C+B', 'CB'], ['A+D', 'AD'], ['D+A', 'DA'], ['A+B', 'AB'], ['B+A', 'BA'], ['C+D', 'CD'], ['D+C', 'DC']];
const LEGACY_PAIR = [['B+C', 'BC'], ['A+D', 'AD'], ['A+B', 'AB'], ['C+D', 'CD']];
const SENSOR = [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']];
const DIRECTION = [['↻', 'cw'], ['↺', 'ccw']];
const MOTOR_UNIT = [['Umdrehungen', 'rotations'], ['Grad', 'degrees'], ['Sekunden', 'seconds']];
const MOVE_UNIT = [['cm', 'cm'], ['Zoll', 'in'], ['Umdrehungen', 'rotations'], ['Grad', 'degrees'], ['Sekunden', 'seconds']];
const MOVE_DIRECTION = [['⬆ vorwärts', 'fwd'], ['⬇ rückwärts', 'back'], ['↻ nach rechts drehen', 'right'], ['↺ nach links drehen', 'left']];
const STOP_ACTION = [['halten', 'hold'], ['auslaufen', 'coast']];
const COMPARE = [['<', 'LT'], ['=', 'EQ'], ['>', 'GT']];
/** For events and "warte bis": additionally react to a change. */
const COMPARE_CHANGE = [...COMPARE, ['ändert sich um mehr als', 'CHANGE']];
const DISTANCE_UNIT = [['cm', 'cm'], ['Zoll', 'in']];
const TOUCH_EVENT = [['gedrückt', 'pressed'], ['losgelassen', 'released'], ['angestoßen', 'bumped']];
const TOUCH_STATE = [['gedrückt', 'pressed'], ['losgelassen', 'released']];
const BUTTONS = [['Mitte', 'enter'], ['links', 'left'], ['rechts', 'right'], ['oben', 'up'], ['unten', 'down'], ['beliebige', 'any']];
const BUTTON_STATE = [['gedrückt', 'pressed'], ['losgelassen', 'released']];
const INK = [['schwarz', '1'], ['weiß', '0']];
const FILL = [['gefüllt', 'TRUE'], ['Umriss', 'FALSE']];
const FONT = [
  ['normal schwarz', '0,1'], ['fett schwarz', '1,1'], ['groß schwarz', '2,1'],
  ['normal weiß', '0,0'], ['fett weiß', '1,0'], ['groß weiß', '2,0'],
];
export const COLOR_OPTIONS = [
  ['Schwarz', '1'], ['Blau', '2'], ['Grün', '3'], ['Gelb', '4'],
  ['Rot', '5'], ['Weiß', '6'], ['Braun', '7'], ['keine Farbe', '0'],
];
const LED = [
  ['grün', 'green'], ['rot', 'red'], ['orange', 'orange'],
  ['grün pulsierend', 'green_pulse'], ['rot pulsierend', 'red_pulse'], ['orange pulsierend', 'orange_pulse'],
  ['grün blinkend', 'green_flash'], ['rot blinkend', 'red_flash'], ['orange blinkend', 'orange_flash'],
  ['aus', 'off'],
];
const IR_CHANNEL = [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']];
/** Button codes of the infrared remote (firmware values 0-11). */
export const IR_BUTTONS = [
  ['keine', '0'], ['links oben', '1'], ['links unten', '2'], ['rechts oben', '3'], ['rechts unten', '4'],
  ['beide oben', '5'], ['links oben + rechts unten', '6'], ['links unten + rechts oben', '7'], ['beide unten', '8'],
  ['Peilsignal-Taste', '9'], ['beide links', '10'], ['beide rechts', '11'],
];
const MATH_FUNCTIONS = [
  ['Betrag', 'abs'], ['abrunden', 'floor'], ['aufrunden', 'ceiling'], ['Wurzel', 'sqrt'],
  ['sin', 'sin'], ['cos', 'cos'], ['tan', 'tan'], ['asin', 'asin'], ['acos', 'acos'], ['atan', 'atan'],
  ['ln', 'ln'], ['log', 'log'], ['e ^', 'exp'], ['10 ^', 'pow10'],
];

const dropdown = (name: string, options: (string[] | [string, string])[]) => ({ type: 'field_dropdown', name, options });
const number = (name: string) => ({ type: 'input_value', name, check: 'Number' });
const value = (name: string) => ({ type: 'input_value', name });
const condition = (name: string) => ({ type: 'input_value', name, check: 'Boolean' });
const text = (name: string, value: string) => ({ type: 'field_input', name, text: value });

const statement = { previousStatement: null, nextStatement: null, inputsInline: true };
const hat = { nextStatement: null, inputsInline: true, hat: 'cap' };
const reporter = (check: string | null) => ({ output: check, inputsInline: true });

type Def = Record<string, unknown> & { type: string };

/** Blocks of one category with the same colour. */
const group = (colour: string, defs: Def[]) => defs.map((d) => ({ colour, ...d }));

export function defineBlocks(): void {
  // Decisions belong to the orange control category, as in EV3 Classroom.
  for (const type of ['controls_if', 'controls_flow_statements']) {
    const block = Blockly.Blocks[type];
    const init = block.init;
    block.init = function (this: Blockly.Block) {
      init.call(this);
      this.setStyle('loop_blocks');
    };
  }

  Blockly.common.defineBlocksWithJsonArray([
    // --- Motoren --------------------------------------------------------------------
    ...group(COLORS.motors, [
      {
        type: 'ev3_motor_run_for',
        message0: 'Motor %1 %2 für %3 %4',
        args0: [dropdown('PORT', MOTOR_OR_GROUP), dropdown('DIR', DIRECTION), number('AMOUNT'), dropdown('UNIT', MOTOR_UNIT)],
        ...statement,
        tooltip: 'Dreht den Motor um die gewählte Strecke. Die Geschwindigkeit stellt „setze Geschwindigkeit“ ein (anfangs 75 %).',
      },
      {
        type: 'ev3_motor_run_for_speed',
        message0: 'Motor %1 für %2 %3 mit %4 %% Geschwindigkeit',
        args0: [dropdown('PORT', MOTOR_OR_GROUP), number('AMOUNT'), dropdown('UNIT', MOTOR_UNIT), number('SPEED')],
        ...statement,
        tooltip: 'Negative Geschwindigkeit dreht gegen den Uhrzeigersinn.',
      },
      {
        type: 'ev3_motor_start_dir',
        message0: 'starte Motor %1 %2',
        args0: [dropdown('PORT', MOTOR_OR_GROUP), dropdown('DIR', DIRECTION)],
        ...statement,
      },
      {
        type: 'ev3_motor_start_speed',
        message0: 'starte Motor %1 mit %2 %% Geschwindigkeit',
        args0: [dropdown('PORT', MOTOR_OR_GROUP), number('SPEED')],
        ...statement,
      },
      {
        type: 'ev3_motor_start_power',
        message0: 'starte Motor %1 mit %2 %% Leistung',
        args0: [dropdown('PORT', MOTOR_OR_GROUP), number('POWER')],
        ...statement,
        tooltip: 'Gleichbleibende Leistung ohne Regelung: der Motor wird unter Last langsamer.',
      },
      {
        type: 'ev3_motor_stop',
        message0: 'stoppe Motor %1',
        args0: [dropdown('PORT', MOTOR_OR_GROUP)],
        ...statement,
      },
      {
        type: 'ev3_motor_set_speed',
        message0: 'setze Geschwindigkeit von Motor %1 auf %2 %%',
        args0: [dropdown('PORT', MOTOR_OR_GROUP), number('SPEED')],
        ...statement,
      },
      {
        type: 'ev3_motor_set_stop',
        message0: 'Motor %1 beim Stoppen %2',
        args0: [dropdown('PORT', MOTOR_OR_GROUP), dropdown('ACTION', STOP_ACTION)],
        ...statement,
        tooltip: '„halten“ bremst und hält die Position, „auslaufen“ lässt den Motor frei drehen.',
      },
      {
        type: 'ev3_motor_reset',
        message0: 'setze gezählte Grad von Motor %1 auf 0',
        args0: [dropdown('PORT', MOTOR)],
        ...statement,
      },
      {
        type: 'ev3_motor_degrees',
        message0: 'Motor %1 %2',
        args0: [dropdown('PORT', MOTOR), dropdown('MODE', [['gezählte Grad', 'degrees'], ['Geschwindigkeit', 'speed']])],
        ...reporter('Number'),
      },
    ]),

    // --- Fahren ---------------------------------------------------------------------
    ...group(COLORS.movement, [
      {
        type: 'ev3_move_for',
        message0: 'fahre %1 für %2 %3',
        args0: [dropdown('DIR', MOVE_DIRECTION), number('AMOUNT'), dropdown('UNIT', MOVE_UNIT)],
        ...statement,
        tooltip: 'Fährt mit den Fahrmotoren (anfangs B links, C rechts) und der Fahrgeschwindigkeit (anfangs 50 %).',
      },
      {
        type: 'ev3_move_start',
        message0: 'starte Fahren %1',
        args0: [dropdown('DIR', MOVE_DIRECTION)],
        ...statement,
      },
      {
        type: 'ev3_move_steer_for',
        message0: 'fahre mit Lenkung %1 für %2 %3',
        args0: [number('STEERING'), number('AMOUNT'), dropdown('UNIT', MOVE_UNIT)],
        ...statement,
        tooltip: 'Lenkung: 0 = geradeaus, 50 = Kurve nach rechts, 100 = auf der Stelle drehen, negativ = nach links.',
      },
      {
        type: 'ev3_move_steer_start',
        message0: 'starte Fahren mit Lenkung %1',
        args0: [number('STEERING')],
        ...statement,
      },
      {
        type: 'ev3_move_stop',
        message0: 'stoppe Fahren',
        ...statement,
      },
      {
        type: 'ev3_move_set_speed',
        message0: 'setze Fahrgeschwindigkeit auf %1 %%',
        args0: [number('SPEED')],
        ...statement,
      },
      {
        type: 'ev3_move_set_motors',
        message0: 'setze Fahrmotoren auf %1',
        args0: [dropdown('PORTS', MOVE_PAIRS)],
        ...statement,
        tooltip: 'Der erste Anschluss ist der linke Motor, der zweite der rechte.',
      },
      {
        type: 'ev3_move_set_stop',
        message0: 'Fahrmotoren beim Stoppen %1',
        args0: [dropdown('ACTION', STOP_ACTION)],
        ...statement,
      },
      {
        type: 'ev3_move_set_rotation',
        message0: 'setze 1 Motorumdrehung auf %1 %2',
        args0: [number('DISTANCE'), dropdown('UNIT', DISTANCE_UNIT)],
        ...statement,
        tooltip: 'Wie weit der Roboter bei einer Radumdrehung fährt: Raddurchmesser × 3,14 (großes Rad: 17,6 cm).',
      },
      {
        type: 'ev3_move_steer_for_speed',
        message0: 'fahre mit Lenkung %1 für %2 %3 mit %4 %% Geschwindigkeit',
        args0: [number('STEERING'), number('AMOUNT'), dropdown('UNIT', MOVE_UNIT), number('SPEED')],
        ...statement,
      },
      {
        type: 'ev3_move_tank_for',
        message0: 'fahre für %1 %2 mit %3 %% und %4 %% Geschwindigkeit',
        args0: [number('AMOUNT'), dropdown('UNIT', MOVE_UNIT), number('LEFT'), number('RIGHT')],
        ...statement,
        tooltip: 'Erste Geschwindigkeit für den linken, zweite für den rechten Motor.',
      },
      {
        type: 'ev3_move_steer_start_speed',
        message0: 'starte Fahren mit Lenkung %1 mit %2 %% Geschwindigkeit',
        args0: [number('STEERING'), number('SPEED')],
        ...statement,
      },
      {
        type: 'ev3_move_tank_start',
        message0: 'starte Fahren mit %1 %% und %2 %% Geschwindigkeit',
        args0: [number('LEFT'), number('RIGHT')],
        ...statement,
      },
    ]),

    // --- Anzeige ----------------------------------------------------------------------
    ...group(COLORS.display, [
      {
        type: 'ev3_image_for',
        message0: 'zeige Bild %1 für %2 Sekunden',
        args0: [dropdown('IMAGE', IMAGE_OPTIONS), number('SECONDS')],
        ...statement,
      },
      {
        type: 'ev3_image',
        message0: 'zeige Bild %1',
        args0: [dropdown('IMAGE', IMAGE_OPTIONS)],
        ...statement,
      },
      {
        type: 'ev3_write_line',
        message0: 'schreibe %1 in Zeile %2',
        args0: [value('TEXT'), number('LINE')],
        ...statement,
        tooltip: `Zeilen 1 bis ${LINES}, jede 10 Pixel hoch.`,
      },
      {
        type: 'ev3_write_xy',
        message0: 'schreibe %1 bei x: %2 y: %3 %4',
        args0: [value('TEXT'), number('X'), number('Y'), dropdown('FONT', FONT)],
        ...statement,
        tooltip: 'Die Anzeige ist 178 Pixel breit (x) und 128 Pixel hoch (y); 0,0 ist oben links.',
      },
      {
        type: 'ev3_display_clear',
        message0: 'Anzeige löschen',
        ...statement,
      },
      {
        type: 'ev3_led',
        message0: 'setze Statusleuchte auf %1',
        args0: [dropdown('PATTERN', LED)],
        ...statement,
      },
      {
        type: 'ev3_draw_pixel',
        message0: 'zeichne Punkt bei x: %1 y: %2 %3',
        args0: [number('X'), number('Y'), dropdown('INK', INK)],
        ...statement,
      },
      {
        type: 'ev3_draw_line',
        message0: 'zeichne Linie von x: %1 y: %2 bis x: %3 y: %4 %5',
        args0: [number('X1'), number('Y1'), number('X2'), number('Y2'), dropdown('INK', INK)],
        ...statement,
      },
      {
        type: 'ev3_draw_circle',
        message0: 'zeichne Kreis bei x: %1 y: %2 Radius %3 %4 %5',
        args0: [number('X'), number('Y'), number('R'), dropdown('FILL', FILL), dropdown('INK', INK)],
        ...statement,
      },
      {
        type: 'ev3_draw_rect',
        message0: 'zeichne Rechteck bei x: %1 y: %2 Breite %3 Höhe %4 %5 %6',
        args0: [number('X'), number('Y'), number('W'), number('H'), dropdown('FILL', FILL), dropdown('INK', INK)],
        ...statement,
      },
      {
        type: 'ev3_display_invert',
        message0: 'Anzeige umkehren',
        ...statement,
        tooltip: 'Macht Schwarz zu Weiß und Weiß zu Schwarz.',
      },
    ]),

    // --- Klang ----------------------------------------------------------------------
    ...group(COLORS.sound, [
      {
        type: 'ev3_sound_play',
        message0: 'spiele Klang %1 bis fertig',
        args0: [dropdown('SOUND', SOUND_OPTIONS)],
        ...statement,
      },
      {
        type: 'ev3_sound_start',
        message0: 'starte Klang %1',
        args0: [dropdown('SOUND', SOUND_OPTIONS)],
        ...statement,
      },
      {
        type: 'ev3_beep_for',
        message0: 'spiele Ton %1 für %2 Sekunden',
        args0: [number('NOTE'), number('SECONDS')],
        ...statement,
        tooltip: 'Tonhöhe als Notennummer: 60 = c′, 62 = d′, 64 = e′ … (jede Zahl ein Halbton).',
      },
      {
        type: 'ev3_beep_start',
        message0: 'starte Ton %1',
        args0: [number('NOTE')],
        ...statement,
        tooltip: 'Der Ton klingt, bis „stoppe alle Klänge“ oder ein anderer Klang kommt.',
      },
      {
        type: 'ev3_sound_stop',
        message0: 'stoppe alle Klänge',
        ...statement,
      },
      {
        type: 'ev3_volume_set',
        message0: 'setze Lautstärke auf %1 %%',
        args0: [number('VOLUME')],
        ...statement,
      },
    ]),

    // --- Ereignisse ---------------------------------------------------------------------
    ...group(COLORS.events, [
      {
        type: 'ev3_start',
        message0: 'Wenn Programm startet',
        ...hat,
        tooltip: 'Alles, was hier angehängt ist, läuft beim Start. Mehrere Ereignisblöcke laufen gleichzeitig.',
      },
      {
        type: 'ev3_when_color',
        message0: 'Wenn Farbsensor %1 %2 sieht',
        args0: [dropdown('PORT', SENSOR), dropdown('COLOR', [...COLOR_OPTIONS, ['eine andere Farbe', 'change']])],
        ...hat,
      },
      {
        type: 'ev3_when_touch',
        message0: 'Wenn Berührungssensor %1 %2',
        args0: [dropdown('PORT', SENSOR), dropdown('EVENT', TOUCH_EVENT)],
        ...hat,
      },
      {
        type: 'ev3_when_distance',
        message0: 'Wenn Abstand von Ultraschall %1 %2 %3 %4',
        args0: [dropdown('PORT', SENSOR), dropdown('OP', COMPARE_CHANGE), number('VALUE'), dropdown('UNIT', DISTANCE_UNIT)],
        ...hat,
      },
      {
        type: 'ev3_when_angle',
        message0: 'Wenn Winkel von Gyrosensor %1 %2 %3',
        args0: [dropdown('PORT', SENSOR), dropdown('OP', COMPARE_CHANGE), number('VALUE')],
        ...hat,
      },
      {
        type: 'ev3_when_button',
        message0: 'Wenn Stein-Taste %1 %2',
        args0: [dropdown('BUTTON', BUTTONS), dropdown('EVENT', BUTTON_STATE)],
        ...hat,
      },
      {
        type: 'ev3_when',
        message0: 'Wenn %1',
        args0: [condition('COND')],
        ...hat,
        tooltip: 'Startet jedes Mal, wenn die Bedingung wahr wird.',
      },
      {
        type: 'ev3_when_timer',
        message0: 'Wenn Zeit > %1',
        args0: [number('SECONDS')],
        ...hat,
      },
      {
        type: 'ev3_when_message',
        message0: 'Wenn ich %1 empfange',
        args0: [text('MESSAGE', 'Nachricht1')],
        ...hat,
      },
      {
        type: 'ev3_broadcast',
        message0: 'sende %1',
        args0: [text('MESSAGE', 'Nachricht1')],
        ...statement,
        tooltip: 'Startet alle „Wenn ich … empfange“-Blöcke mit dieser Nachricht und macht sofort weiter.',
      },
      {
        type: 'ev3_broadcast_wait',
        message0: 'sende %1 und warte',
        args0: [text('MESSAGE', 'Nachricht1')],
        ...statement,
        tooltip: 'Wartet, bis alle Empfänger fertig sind.',
      },
    ]),

    // --- Steuerung ------------------------------------------------------------------
    ...group(COLORS.control, [
      {
        type: 'ev3_wait',
        message0: 'warte %1 Sekunden',
        args0: [number('SECONDS')],
        ...statement,
      },
      {
        type: 'ev3_wait_until',
        message0: 'warte bis %1',
        args0: [condition('COND')],
        ...statement,
      },
      {
        type: 'ev3_forever',
        message0: 'wiederhole fortlaufend %1 %2',
        args0: [{ type: 'input_dummy' }, { type: 'input_statement', name: 'DO' }],
        previousStatement: null,
      },
      {
        type: 'ev3_stop',
        message0: 'stoppe %1',
        args0: [dropdown('WHAT', [['alles', 'all'], ['diesen Ablauf', 'this'], ['und beende das Programm', 'exit']])],
        previousStatement: null,
        tooltip: '„alles“ und „beende das Programm“ beenden das Programm, „diesen Ablauf“ nur diesen Block-Stapel.',
      },
      {
        type: 'ev3_stop_other',
        message0: 'stoppe andere Abläufe',
        ...statement,
      },
    ]),

    // --- Sensoren -----------------------------------------------------------------------
    ...group(COLORS.sensors, [
      {
        type: 'ev3_reflected_is',
        message0: 'ist reflektiertes Licht von %1 %2 %3 %% ?',
        args0: [dropdown('PORT', SENSOR), dropdown('OP', COMPARE), number('VALUE')],
        ...reporter('Boolean'),
      },
      {
        type: 'ev3_reflected',
        message0: 'reflektiertes Licht von %1 in %%',
        args0: [dropdown('PORT', SENSOR)],
        ...reporter('Number'),
      },
      {
        type: 'ev3_light_calibrate',
        message0: 'setze %1 für reflektiertes Licht von %2 auf %3 %%',
        args0: [dropdown('WHICH', [['Minimum', 'min'], ['Maximum', 'max']]), dropdown('PORT', SENSOR), number('VALUE')],
        ...statement,
        tooltip: 'Kalibrieren: der gemessene Minimum-Wert wird zu 0 %, der Maximum-Wert zu 100 %.',
      },
      {
        type: 'ev3_wait_color',
        message0: 'warte bis Farbsensor %1 %2 sieht',
        args0: [dropdown('PORT', SENSOR), dropdown('COLOR', COLOR_OPTIONS)],
        ...statement,
      },
      {
        type: 'ev3_color_is',
        message0: 'sieht Farbsensor %1 %2 ?',
        args0: [dropdown('PORT', SENSOR), dropdown('COLOR', COLOR_OPTIONS)],
        ...reporter('Boolean'),
      },
      {
        type: 'ev3_color_value',
        message0: 'Farbe von Farbsensor %1',
        args0: [dropdown('PORT', SENSOR)],
        ...reporter('Number'),
        tooltip: '0 keine, 1 Schwarz, 2 Blau, 3 Grün, 4 Gelb, 5 Rot, 6 Weiß, 7 Braun',
      },
      {
        type: 'ev3_ambient_is',
        message0: 'ist Umgebungslicht von %1 %2 %3 %% ?',
        args0: [dropdown('PORT', SENSOR), dropdown('OP', COMPARE), number('VALUE')],
        ...reporter('Boolean'),
      },
      {
        type: 'ev3_ambient',
        message0: 'Umgebungslicht von %1 in %%',
        args0: [dropdown('PORT', SENSOR)],
        ...reporter('Number'),
      },
      {
        type: 'ev3_wait_touch',
        message0: 'warte bis Berührungssensor %1 %2',
        args0: [dropdown('PORT', SENSOR), dropdown('EVENT', TOUCH_EVENT)],
        ...statement,
      },
      {
        type: 'ev3_touch_is',
        message0: 'ist Berührungssensor %1 %2 ?',
        args0: [dropdown('PORT', SENSOR), dropdown('STATE', TOUCH_STATE)],
        ...reporter('Boolean'),
      },
      {
        type: 'ev3_wait_distance',
        message0: 'warte bis Abstand von Ultraschall %1 %2 %3 %4',
        args0: [dropdown('PORT', SENSOR), dropdown('OP', COMPARE_CHANGE), number('VALUE'), dropdown('UNIT', DISTANCE_UNIT)],
        ...statement,
      },
      {
        type: 'ev3_distance_is',
        message0: 'ist Abstand von Ultraschall %1 %2 %3 %4 ?',
        args0: [dropdown('PORT', SENSOR), dropdown('OP', COMPARE), number('VALUE'), dropdown('UNIT', DISTANCE_UNIT)],
        ...reporter('Boolean'),
      },
      {
        type: 'ev3_distance',
        message0: 'Abstand von Ultraschall %1 in %2',
        args0: [dropdown('PORT', SENSOR), dropdown('UNIT', DISTANCE_UNIT)],
        ...reporter('Number'),
      },
      {
        type: 'ev3_wait_angle',
        message0: 'warte bis Winkel von Gyrosensor %1 %2 %3',
        args0: [dropdown('PORT', SENSOR), dropdown('OP', COMPARE_CHANGE), number('VALUE')],
        ...statement,
      },
      {
        type: 'ev3_angle_is',
        message0: 'ist Winkel von Gyrosensor %1 %2 %3 ?',
        args0: [dropdown('PORT', SENSOR), dropdown('OP', COMPARE), number('VALUE')],
        ...reporter('Boolean'),
      },
      {
        type: 'ev3_angle',
        message0: 'Winkel von Gyrosensor %1',
        args0: [dropdown('PORT', SENSOR)],
        ...reporter('Number'),
      },
      {
        type: 'ev3_angle_reset',
        message0: 'setze Winkel von Gyrosensor %1 auf 0',
        args0: [dropdown('PORT', SENSOR)],
        ...statement,
      },
      {
        type: 'ev3_rate',
        message0: 'Drehrate von Gyrosensor %1 in °/s',
        args0: [dropdown('PORT', SENSOR)],
        ...reporter('Number'),
      },
      {
        type: 'ev3_wait_button',
        message0: 'warte bis Stein-Taste %1 %2',
        args0: [dropdown('BUTTON', BUTTONS), dropdown('STATE', BUTTON_STATE)],
        ...statement,
      },
      {
        type: 'ev3_button_is',
        message0: 'ist Stein-Taste %1 %2 ?',
        args0: [dropdown('BUTTON', BUTTONS), dropdown('STATE', BUTTON_STATE)],
        ...reporter('Boolean'),
      },
      {
        type: 'ev3_button_value',
        message0: 'gedrückte Stein-Taste',
        ...reporter('Number'),
        tooltip: '0 keine, 1 links, 2 Mitte, 3 rechts, 4 oben, 5 unten',
      },
      {
        type: 'ev3_timer',
        message0: 'Zeit',
        ...reporter('Number'),
        tooltip: 'Sekunden seit dem Programmstart oder dem letzten „setze Zeit zurück“.',
      },
      {
        type: 'ev3_timer_reset',
        message0: 'setze Zeit zurück',
        ...statement,
      },
      {
        type: 'ev3_infrared',
        message0: 'Nähe von Infrarotsensor %1 in %%',
        args0: [dropdown('PORT', SENSOR)],
        ...reporter('Number'),
      },
      {
        type: 'ev3_ir_beacon',
        message0: 'Peilsignal Kanal %1 an Infrarotsensor %2 %3',
        args0: [dropdown('CHANNEL', IR_CHANNEL), dropdown('PORT', SENSOR), dropdown('WHAT', [['Richtung', 'heading'], ['Abstand', 'distance']])],
        ...reporter('Number'),
        tooltip: 'Richtung -25 (links) bis 25 (rechts), Abstand 0 bis 100.',
      },
      {
        type: 'ev3_ir_remote',
        message0: 'Fernbedienung Kanal %1 an Infrarotsensor %2',
        args0: [dropdown('CHANNEL', IR_CHANNEL), dropdown('PORT', SENSOR)],
        ...reporter('Number'),
        tooltip: '0 keine Taste, 1 links oben, 2 links unten, 3 rechts oben, 4 rechts unten, 9 Peilsignal-Taste …',
      },
      {
        type: 'ev3_ir_remote_is',
        message0: 'ist auf Kanal %1 an Infrarotsensor %2 %3 gedrückt?',
        args0: [dropdown('CHANNEL', IR_CHANNEL), dropdown('PORT', SENSOR), dropdown('BUTTON', IR_BUTTONS.slice(1))],
        ...reporter('Boolean'),
      },
    ]),

    // --- Operatoren -----------------------------------------------------------------
    ...group(COLORS.operators, [
      {
        type: 'ev3_letter_of',
        message0: 'Zeichen %1 von %2',
        args0: [number('INDEX'), value('TEXT')],
        ...reporter('String'),
      },
      {
        type: 'ev3_length_of',
        message0: 'Länge von %1',
        args0: [value('TEXT')],
        ...reporter('Number'),
      },
      {
        type: 'ev3_contains',
        message0: '%1 enthält %2 ?',
        args0: [value('TEXT'), value('PART')],
        ...reporter('Boolean'),
      },
      {
        type: 'ev3_math',
        message0: '%1 von %2',
        args0: [dropdown('OP', MATH_FUNCTIONS), number('NUM')],
        ...reporter('Number'),
        tooltip: 'sin, cos und tan rechnen in Grad.',
      },
    ]),

    // --- Listen -------------------------------------------------------------------------
    ...group(COLORS.lists, [
      listBlock('ev3_list_add', 'füge %1 zu %2 hinzu', [value('ITEM'), listField()]),
      listBlock('ev3_list_delete', 'lösche %1 aus %2', [number('INDEX'), listField()]),
      listBlock('ev3_list_clear', 'lösche alles aus %1', [listField()]),
      listBlock('ev3_list_insert', 'füge %1 bei %2 in %3 ein', [value('ITEM'), number('INDEX'), listField()]),
      listBlock('ev3_list_replace', 'ersetze Element %1 von %2 durch %3', [number('INDEX'), listField(), value('ITEM')]),
      { type: 'ev3_list_item', message0: 'Element %1 von %2', args0: [number('INDEX'), listField()], ...reporter(null) },
      { type: 'ev3_list_index', message0: 'Nummer von %1 in %2', args0: [value('ITEM'), listField()], ...reporter('Number') },
      { type: 'ev3_list_length', message0: 'Länge von %1', args0: [listField()], ...reporter('Number') },
      { type: 'ev3_list_contains', message0: '%1 enthält %2 ?', args0: [listField(), value('ITEM')], ...reporter('Boolean') },
      { type: 'ev3_list_value', message0: '%1', args0: [listField()], ...reporter('String'), tooltip: 'Alle Elemente der Liste, mit Leerzeichen getrennt.' },
    ]),

    // --- Messwerte (only in the app) -----------------------------------------------------
    ...group(COLORS.datalog, [
      {
        type: 'ev3_log',
        message0: 'zeichne %1 als %2 auf',
        args0: [number('VALUE'), text('NAME', 'Messwert')],
        ...statement,
        tooltip: 'Fügt den Wert dem Diagramm unter „Messwerte“ hinzu. Gleiche Namen bilden eine Linie (höchstens 8).',
      },
      {
        type: 'ev3_log_clear',
        message0: 'lösche alle Messwerte',
        ...statement,
      },
    ]),

    // --- App -------------------------------------------------------------------------
    {
      type: 'ev3_print',
      message0: 'in der App ausgeben %1',
      args0: [value('VALUE')],
      ...statement,
      colour: COLORS.app,
      tooltip: 'Zeigt einen Wert in der Ausgabe unten in der App an.',
    },

    // --- Ältere OpenStorm-Blöcke ---------------------------------------------------
    // Not in the toolbox any more; they stay so that existing programs still load and run.
    ...group(COLORS.motors, [
      {
        type: 'ev3_motor_on',
        message0: 'Motor %1 an, Geschwindigkeit %2 %%',
        args0: [dropdown('PORT', MOTOR_OR_GROUP), number('SPEED')],
        ...statement,
      },
      {
        type: 'ev3_motor_for',
        message0: 'Motor %1 Geschwindigkeit %2 %% für %3 %4 , dann %5',
        args0: [dropdown('PORT', MOTOR_OR_GROUP), number('SPEED'), number('AMOUNT'), dropdown('UNIT', MOTOR_UNIT), dropdown('BRAKE', [['bremsen', 'TRUE'], ['ausrollen', 'FALSE']])],
        ...statement,
      },
      {
        type: 'ev3_motor_off',
        message0: 'Motor %1 aus, %2',
        args0: [dropdown('PORT', MOTOR_OR_GROUP), dropdown('BRAKE', [['bremsen', 'TRUE'], ['ausrollen', 'FALSE']])],
        ...statement,
      },
    ]),
    ...group(COLORS.movement, [
      {
        type: 'ev3_steer_on',
        message0: 'Lenken %1 Richtung %2 Geschwindigkeit %3 %%',
        args0: [dropdown('PORT', LEGACY_PAIR), number('STEERING'), number('SPEED')],
        ...statement,
      },
      {
        type: 'ev3_steer_for',
        message0: 'Lenken %1 Richtung %2 Geschwindigkeit %3 %% für %4 %5 , dann %6',
        args0: [dropdown('PORT', LEGACY_PAIR), number('STEERING'), number('SPEED'), number('AMOUNT'), dropdown('UNIT', MOTOR_UNIT), dropdown('BRAKE', [['bremsen', 'TRUE'], ['ausrollen', 'FALSE']])],
        ...statement,
      },
    ]),
    ...group(COLORS.display, [
      {
        type: 'ev3_display_text',
        message0: 'Anzeige: schreibe %1 in Zeile %2',
        args0: [value('TEXT'), number('LINE')],
        ...statement,
      },
    ]),
    ...group(COLORS.sound, [
      {
        type: 'ev3_tone',
        message0: 'Ton %1 Hz für %2 s, Lautstärke %3 %% %4',
        args0: [number('FREQ'), number('SECONDS'), number('VOLUME'), dropdown('WAIT', [['und warten', 'TRUE'], ['ohne warten', 'FALSE']])],
        ...statement,
      },
    ]),
    ...group(COLORS.sensors, [
      { type: 'ev3_touch', message0: 'Berührungssensor %1 gedrückt?', args0: [dropdown('PORT', SENSOR)], ...reporter('Boolean') },
      {
        type: 'ev3_color',
        message0: 'Farbsensor %1 %2',
        args0: [dropdown('PORT', SENSOR), dropdown('MODE', [['Farbe (Nummer)', '2'], ['reflektiertes Licht %', '0'], ['Umgebungslicht %', '1']])],
        ...reporter('Number'),
      },
      { type: 'ev3_ultrasonic', message0: 'Ultraschall %1 Abstand in cm', args0: [dropdown('PORT', SENSOR)], ...reporter('Number') },
      {
        type: 'ev3_gyro',
        message0: 'Gyrosensor %1 %2',
        args0: [dropdown('PORT', SENSOR), dropdown('MODE', [['Winkel °', '0'], ['Drehrate °/s', '1']])],
        ...reporter('Number'),
      },
      {
        type: 'ev3_button',
        message0: 'Stein-Taste %1 gedrückt?',
        args0: [dropdown('BUTTON', BUTTONS)],
        ...reporter('Boolean'),
      },
    ]),
  ]);
}

function listField() {
  return { type: 'field_variable', name: 'LIST', variable: 'Liste', variableTypes: [LIST_TYPE], defaultType: LIST_TYPE };
}

function listBlock(type: string, message0: string, args0: object[]): Def {
  return { type, message0, args0, ...statement };
}
