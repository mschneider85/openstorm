import * as Blockly from 'blockly/core';
import { COLORS } from './definitions';

const n = (value: number) => ({ shadow: { type: 'math_number', fields: { NUM: value } } });
const t = (text: string) => ({ shadow: { type: 'text', fields: { TEXT: text } } });
const block = (type: string, inputs?: Record<string, object>, fields?: Record<string, unknown>) => ({
  kind: 'block',
  type,
  ...(inputs ? { inputs } : {}),
  ...(fields ? { fields } : {}),
});

export const toolbox: Blockly.utils.toolbox.ToolboxDefinition = {
  kind: 'categoryToolbox',
  contents: [
    {
      kind: 'category',
      name: 'Ablauf',
      colour: COLORS.flow,
      contents: [
        block('ev3_start'),
        block('ev3_wait', { SECONDS: n(1) }),
        block('ev3_wait_until', { COND: { block: { type: 'ev3_touch' } } }),
        block('ev3_forever'),
        block('controls_repeat_ext', { TIMES: n(4) }),
        block('controls_whileUntil'),
        block('controls_if'),
        { ...block('controls_if'), extraState: { hasElse: true } },
        block('controls_flow_statements'),
      ],
    },
    {
      kind: 'category',
      name: 'Motoren',
      colour: COLORS.action,
      contents: [
        block('ev3_motor_for', { SPEED: n(50), AMOUNT: n(1) }),
        block('ev3_motor_on', { SPEED: n(50) }),
        block('ev3_motor_off'),
        block('ev3_steer_for', { STEERING: n(0), SPEED: n(50), AMOUNT: n(1) }),
        block('ev3_steer_on', { STEERING: n(0), SPEED: n(50) }),
        block('ev3_motor_reset'),
      ],
    },
    {
      kind: 'category',
      name: 'Anzeige & Ton',
      colour: COLORS.action,
      contents: [
        block('ev3_display_text', { TEXT: t('Hallo'), LINE: n(1) }),
        block('ev3_display_clear'),
        block('ev3_tone', { FREQ: n(440), SECONDS: n(0.5), VOLUME: n(50) }),
        block('ev3_led'),
      ],
    },
    {
      kind: 'category',
      name: 'Sensoren',
      colour: COLORS.sensor,
      contents: [
        block('ev3_touch', undefined, { PORT: '1' }),
        block('ev3_color', undefined, { PORT: '3' }),
        block('ev3_color_is', undefined, { PORT: '3' }),
        block('ev3_ultrasonic', undefined, { PORT: '4' }),
        block('ev3_infrared', undefined, { PORT: '4' }),
        block('ev3_gyro', undefined, { PORT: '2' }),
        block('ev3_motor_degrees'),
        block('ev3_button'),
        block('ev3_timer'),
        block('ev3_timer_reset'),
      ],
    },
    {
      kind: 'category',
      name: 'Rechnen & Logik',
      colour: COLORS.data,
      contents: [
        block('math_number'),
        block('math_arithmetic', { A: n(1), B: n(1) }),
        block('logic_compare', { A: n(0), B: n(10) }),
        block('logic_operation'),
        block('logic_negate'),
        block('logic_boolean'),
        block('math_random_int', { FROM: n(1), TO: n(10) }),
        block('math_round', { NUM: n(3.5) }),
        block('math_single', { NUM: n(-5) }),
        block('math_modulo', { DIVIDEND: n(10), DIVISOR: n(3) }),
        block('text'),
        block('text_join'),
      ],
    },
    { kind: 'category', name: 'Variablen', colour: COLORS.data, custom: 'VARIABLE' },
    { kind: 'category', name: 'Eigene Blöcke', colour: COLORS.myBlocks, custom: 'PROCEDURE' },
    {
      kind: 'category',
      name: 'Erweitert',
      colour: COLORS.advanced,
      contents: [block('ev3_print', { VALUE: t('Hallo') })],
    },
  ],
};

/** Gives Blockly's built-in blocks the colours of the matching EV3 category. */
export const theme = Blockly.Theme.defineTheme('openstorm', {
  name: 'openstorm',
  base: Blockly.Themes.Classic,
  blockStyles: {
    loop_blocks: { colourPrimary: COLORS.flow },
    logic_blocks: { colourPrimary: COLORS.data },
    math_blocks: { colourPrimary: COLORS.data },
    text_blocks: { colourPrimary: COLORS.data },
    variable_blocks: { colourPrimary: COLORS.data },
    variable_dynamic_blocks: { colourPrimary: COLORS.data },
    procedure_blocks: { colourPrimary: COLORS.myBlocks },
  } as unknown as Record<string, Blockly.Theme.BlockStyle>,
  componentStyles: {
    workspaceBackgroundColour: '#f4f6f8',
    toolboxBackgroundColour: '#ffffff',
    flyoutBackgroundColour: '#eef1f4',
    flyoutOpacity: 0.97,
    scrollbarColour: '#c5ccd3',
  },
  fontStyle: { family: 'system-ui, -apple-system, sans-serif', weight: '600', size: 12 },
  startHats: true,
});
