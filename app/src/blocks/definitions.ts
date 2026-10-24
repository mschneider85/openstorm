import * as Blockly from 'blockly/core';

/** Category colours, modelled on the palette of the original EV3 software. */
export const COLORS = {
  flow: '#F29B30',
  action: '#3FA34D',
  sensor: '#E6B800',
  data: '#D9483B',
  advanced: '#2F6FB5',
  myBlocks: '#2BA5A0',
};

const MOTOR = [['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D']];
const MOTOR_OR_GROUP = [...MOTOR, ['B+C', 'BC'], ['A+D', 'AD'], ['alle', 'ABCD']];
const PAIR = [['B+C', 'BC'], ['A+D', 'AD'], ['A+B', 'AB'], ['C+D', 'CD']];
const SENSOR = [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']];
const UNIT = [['Umdrehungen', 'rotations'], ['Grad', 'degrees'], ['Sekunden', 'seconds']];
const BRAKE = [['bremsen', 'TRUE'], ['ausrollen', 'FALSE']];
export const COLOR_OPTIONS = [
  ['Schwarz', '1'], ['Blau', '2'], ['Grün', '3'], ['Gelb', '4'],
  ['Rot', '5'], ['Weiß', '6'], ['Braun', '7'], ['keine Farbe', '0'],
];

const dropdown = (name: string, options: string[][]) => ({ type: 'field_dropdown', name, options });
const number = (name: string) => ({ type: 'input_value', name, check: 'Number' });

const statement = { previousStatement: null, nextStatement: null, inputsInline: true };

export function defineBlocks(): void {
  // In the EV3 software, decisions ("Schalter") belong to the orange flow category.
  for (const type of ['controls_if', 'controls_flow_statements']) {
    const block = Blockly.Blocks[type];
    const init = block.init;
    block.init = function (this: Blockly.Block) {
      init.call(this);
      this.setStyle('loop_blocks');
    };
  }

  Blockly.common.defineBlocksWithJsonArray([
    // --- Ablauf ---------------------------------------------------------------
    {
      type: 'ev3_start',
      message0: '▶ Programmstart',
      nextStatement: null,
      colour: COLORS.flow,
      hat: 'cap',
      tooltip: 'Alles, was hier angehängt ist, läuft beim Start. Mehrere Startblöcke laufen gleichzeitig.',
    },
    {
      type: 'ev3_wait',
      message0: 'warte %1 Sekunden',
      args0: [number('SECONDS')],
      ...statement,
      colour: COLORS.flow,
    },
    {
      type: 'ev3_wait_until',
      message0: 'warte bis %1',
      args0: [{ type: 'input_value', name: 'COND', check: 'Boolean' }],
      ...statement,
      colour: COLORS.flow,
    },
    {
      type: 'ev3_forever',
      message0: 'wiederhole fortlaufend %1 %2',
      args0: [{ type: 'input_dummy' }, { type: 'input_statement', name: 'DO' }],
      previousStatement: null,
      colour: COLORS.flow,
    },

    // --- Aktion: Motoren ------------------------------------------------------
    {
      type: 'ev3_motor_on',
      message0: 'Motor %1 an, Geschwindigkeit %2 %%',
      args0: [dropdown('PORT', MOTOR_OR_GROUP), number('SPEED')],
      ...statement,
      colour: COLORS.action,
    },
    {
      type: 'ev3_motor_for',
      message0: 'Motor %1 Geschwindigkeit %2 %% für %3 %4 , dann %5',
      args0: [dropdown('PORT', MOTOR_OR_GROUP), number('SPEED'), number('AMOUNT'), dropdown('UNIT', UNIT), dropdown('BRAKE', BRAKE)],
      ...statement,
      colour: COLORS.action,
    },
    {
      type: 'ev3_motor_off',
      message0: 'Motor %1 aus, %2',
      args0: [dropdown('PORT', MOTOR_OR_GROUP), dropdown('BRAKE', BRAKE)],
      ...statement,
      colour: COLORS.action,
    },
    {
      type: 'ev3_steer_on',
      message0: 'Lenken %1 Richtung %2 Geschwindigkeit %3 %%',
      args0: [dropdown('PORT', PAIR), number('STEERING'), number('SPEED')],
      ...statement,
      colour: COLORS.action,
      tooltip: 'Richtung: 0 = geradeaus, 50 = Kurve, 100 = auf der Stelle drehen; negativ = nach links.',
    },
    {
      type: 'ev3_steer_for',
      message0: 'Lenken %1 Richtung %2 Geschwindigkeit %3 %% für %4 %5 , dann %6',
      args0: [dropdown('PORT', PAIR), number('STEERING'), number('SPEED'), number('AMOUNT'), dropdown('UNIT', UNIT), dropdown('BRAKE', BRAKE)],
      ...statement,
      colour: COLORS.action,
      tooltip: 'Richtung: 0 = geradeaus, 50 = Kurve, 100 = auf der Stelle drehen; negativ = nach links.',
    },
    {
      type: 'ev3_motor_reset',
      message0: 'Motor %1 Umdrehungszähler zurücksetzen',
      args0: [dropdown('PORT', MOTOR)],
      ...statement,
      colour: COLORS.action,
    },

    // --- Aktion: Anzeige, Ton, Licht -----------------------------------------
    {
      type: 'ev3_display_text',
      message0: 'Anzeige: schreibe %1 in Zeile %2',
      args0: [{ type: 'input_value', name: 'TEXT' }, number('LINE')],
      ...statement,
      colour: COLORS.action,
    },
    {
      type: 'ev3_display_clear',
      message0: 'Anzeige löschen',
      ...statement,
      colour: COLORS.action,
    },
    {
      type: 'ev3_tone',
      message0: 'Ton %1 Hz für %2 s, Lautstärke %3 %% %4',
      args0: [number('FREQ'), number('SECONDS'), number('VOLUME'), dropdown('WAIT', [['und warten', 'TRUE'], ['ohne warten', 'FALSE']])],
      ...statement,
      colour: COLORS.action,
    },
    {
      type: 'ev3_led',
      message0: 'Statusleuchte %1',
      args0: [
        dropdown('PATTERN', [
          ['grün', 'green'], ['rot', 'red'], ['orange', 'orange'],
          ['grün blinkend', 'green_flash'], ['rot blinkend', 'red_flash'], ['orange blinkend', 'orange_flash'],
          ['grün pulsierend', 'green_pulse'], ['rot pulsierend', 'red_pulse'], ['orange pulsierend', 'orange_pulse'],
          ['aus', 'off'],
        ]),
      ],
      ...statement,
      colour: COLORS.action,
    },

    // --- Sensoren -------------------------------------------------------------
    {
      type: 'ev3_touch',
      message0: 'Berührungssensor %1 gedrückt?',
      args0: [dropdown('PORT', SENSOR)],
      output: 'Boolean',
      colour: COLORS.sensor,
    },
    {
      type: 'ev3_color',
      message0: 'Farbsensor %1 %2',
      args0: [
        dropdown('PORT', SENSOR),
        dropdown('MODE', [['Farbe (Nummer)', '2'], ['reflektiertes Licht %', '0'], ['Umgebungslicht %', '1']]),
      ],
      output: 'Number',
      colour: COLORS.sensor,
    },
    {
      type: 'ev3_color_is',
      message0: 'Farbsensor %1 sieht %2 ?',
      args0: [dropdown('PORT', SENSOR), dropdown('COLOR', COLOR_OPTIONS)],
      output: 'Boolean',
      colour: COLORS.sensor,
    },
    {
      type: 'ev3_ultrasonic',
      message0: 'Ultraschall %1 Abstand in cm',
      args0: [dropdown('PORT', SENSOR)],
      output: 'Number',
      colour: COLORS.sensor,
    },
    {
      type: 'ev3_gyro',
      message0: 'Gyrosensor %1 %2',
      args0: [dropdown('PORT', SENSOR), dropdown('MODE', [['Winkel °', '0'], ['Drehrate °/s', '1']])],
      output: 'Number',
      colour: COLORS.sensor,
    },
    {
      type: 'ev3_infrared',
      message0: 'Infrarot %1 Nähe %%',
      args0: [dropdown('PORT', SENSOR)],
      output: 'Number',
      colour: COLORS.sensor,
    },
    {
      type: 'ev3_motor_degrees',
      message0: 'Motor %1 %2',
      args0: [dropdown('PORT', MOTOR), dropdown('MODE', [['Position in Grad', 'degrees'], ['Geschwindigkeit %', 'speed']])],
      output: 'Number',
      colour: COLORS.sensor,
    },
    {
      type: 'ev3_button',
      message0: 'Stein-Taste %1 gedrückt?',
      args0: [
        dropdown('BUTTON', [['Mitte', 'enter'], ['oben', 'up'], ['unten', 'down'], ['links', 'left'], ['rechts', 'right'], ['beliebige', 'any']]),
      ],
      output: 'Boolean',
      colour: COLORS.sensor,
    },
    {
      type: 'ev3_timer',
      message0: 'Zeit in Sekunden',
      output: 'Number',
      colour: COLORS.sensor,
    },
    {
      type: 'ev3_timer_reset',
      message0: 'Zeit zurücksetzen',
      ...statement,
      colour: COLORS.sensor,
    },

    // --- Erweitert ------------------------------------------------------------
    {
      type: 'ev3_print',
      message0: 'in der App ausgeben %1',
      args0: [{ type: 'input_value', name: 'VALUE' }],
      ...statement,
      colour: COLORS.advanced,
      tooltip: 'Zeigt einen Wert in der Ausgabe unten in der App an.',
    },
  ]);
}
