import * as Blockly from 'blockly/core';
import { COLORS, LIST_TYPE } from './definitions';

const n = (value: number) => ({ shadow: { type: 'math_number', fields: { NUM: value } } });
const t = (text: string) => ({ shadow: { type: 'text', fields: { TEXT: text } } });
const block = (type: string, inputs?: Record<string, object>, fields?: Record<string, unknown>, extra?: object) => ({
  kind: 'block',
  type,
  ...(inputs ? { inputs } : {}),
  ...(fields ? { fields } : {}),
  ...extra,
});
const label = (text: string) => ({ kind: 'label', text });

/** The categories and their order follow LEGO Education EV3 Classroom. */
export const toolbox: Blockly.utils.toolbox.ToolboxDefinition = {
  kind: 'categoryToolbox',
  contents: [
    {
      kind: 'category',
      name: 'Motoren',
      colour: COLORS.motors,
      contents: [
        block('ev3_motor_run_for', { AMOUNT: n(1) }, { PORT: 'A' }),
        block('ev3_motor_start_dir', undefined, { PORT: 'A' }),
        block('ev3_motor_stop', undefined, { PORT: 'A' }),
        block('ev3_motor_set_speed', { SPEED: n(75) }, { PORT: 'A' }),
        block('ev3_motor_run_for_speed', { AMOUNT: n(1), SPEED: n(75) }, { PORT: 'A' }),
        block('ev3_motor_start_speed', { SPEED: n(75) }, { PORT: 'A' }),
        block('ev3_motor_start_power', { POWER: n(75) }, { PORT: 'A' }),
        block('ev3_motor_set_stop', undefined, { PORT: 'A' }),
        block('ev3_motor_reset', undefined, { PORT: 'A' }),
        block('ev3_motor_degrees', undefined, { PORT: 'A', MODE: 'degrees' }),
        block('ev3_motor_degrees', undefined, { PORT: 'A', MODE: 'speed' }),
      ],
    },
    {
      kind: 'category',
      name: 'Fahren',
      colour: COLORS.movement,
      contents: [
        block('ev3_move_for', { AMOUNT: n(10) }),
        block('ev3_move_steer_for', { STEERING: n(30), AMOUNT: n(10) }),
        block('ev3_move_start'),
        block('ev3_move_steer_start', { STEERING: n(30) }),
        block('ev3_move_stop'),
        block('ev3_move_set_speed', { SPEED: n(50) }),
        block('ev3_move_set_motors'),
        block('ev3_move_set_stop'),
        block('ev3_move_set_rotation', { DISTANCE: n(17.6) }),
        label('Mit eigener Geschwindigkeit'),
        block('ev3_move_steer_for_speed', { STEERING: n(0), AMOUNT: n(10), SPEED: n(50) }),
        block('ev3_move_tank_for', { AMOUNT: n(10), LEFT: n(50), RIGHT: n(50) }),
        block('ev3_move_steer_start_speed', { STEERING: n(0), SPEED: n(50) }),
        block('ev3_move_tank_start', { LEFT: n(50), RIGHT: n(50) }),
      ],
    },
    {
      kind: 'category',
      name: 'Anzeige',
      colour: COLORS.display,
      contents: [
        block('ev3_image_for', { SECONDS: n(2) }),
        block('ev3_image'),
        block('ev3_write_line', { TEXT: t('Hallo'), LINE: n(1) }),
        block('ev3_write_xy', { TEXT: t('Hallo'), X: n(0), Y: n(0) }),
        block('ev3_display_clear'),
        block('ev3_led'),
        label('Zeichnen'),
        block('ev3_draw_pixel', { X: n(89), Y: n(64) }),
        block('ev3_draw_line', { X1: n(0), Y1: n(0), X2: n(177), Y2: n(127) }),
        block('ev3_draw_circle', { X: n(89), Y: n(64), R: n(30) }),
        block('ev3_draw_rect', { X: n(10), Y: n(10), W: n(60), H: n(40) }),
        block('ev3_display_invert'),
      ],
    },
    {
      kind: 'category',
      name: 'Klang',
      colour: COLORS.sound,
      contents: [
        block('ev3_sound_play'),
        block('ev3_sound_start'),
        block('ev3_beep_for', { NOTE: n(60), SECONDS: n(0.2) }),
        block('ev3_beep_start', { NOTE: n(60) }),
        block('ev3_sound_stop'),
        block('ev3_volume_set', { VOLUME: n(100) }),
      ],
    },
    {
      kind: 'category',
      name: 'Ereignisse',
      colour: COLORS.events,
      contents: [
        block('ev3_start'),
        block('ev3_when_color', undefined, { PORT: '3', COLOR: '5' }),
        block('ev3_when_touch', undefined, { PORT: '1' }),
        block('ev3_when_distance', { VALUE: n(15) }, { PORT: '4', OP: 'LT' }),
        block('ev3_when_angle', { VALUE: n(90) }, { PORT: '2', OP: 'GT' }),
        block('ev3_when_button'),
        block('ev3_when'),
        block('ev3_when_timer', { SECONDS: n(5) }),
        block('ev3_when_message'),
        block('ev3_broadcast'),
        block('ev3_broadcast_wait'),
      ],
    },
    {
      kind: 'category',
      name: 'Steuerung',
      colour: COLORS.control,
      contents: [
        block('ev3_wait', { SECONDS: n(1) }),
        block('controls_repeat_ext', { TIMES: n(10) }),
        block('ev3_forever'),
        block('controls_if'),
        block('controls_if', undefined, undefined, { extraState: { hasElse: true } }),
        block('ev3_wait_until'),
        block('controls_whileUntil', undefined, { MODE: 'UNTIL' }),
        block('ev3_stop'),
        block('ev3_stop_other'),
      ],
    },
    {
      kind: 'category',
      name: 'Sensoren',
      colour: COLORS.sensors,
      contents: [
        label('Farbsensor'),
        block('ev3_reflected_is', { VALUE: n(50) }, { PORT: '3' }),
        block('ev3_reflected', undefined, { PORT: '3' }),
        block('ev3_light_calibrate', { VALUE: n(5) }, { PORT: '3' }),
        block('ev3_wait_color', undefined, { PORT: '3', COLOR: '5' }),
        block('ev3_color_is', undefined, { PORT: '3', COLOR: '5' }),
        block('ev3_color_value', undefined, { PORT: '3' }),
        block('ev3_ambient_is', { VALUE: n(50) }, { PORT: '3' }),
        block('ev3_ambient', undefined, { PORT: '3' }),
        label('Taster'),
        block('ev3_wait_touch', undefined, { PORT: '1' }),
        block('ev3_touch_is', undefined, { PORT: '1' }),
        label('Abstand'),
        block('ev3_wait_distance', { VALUE: n(15) }, { PORT: '4', OP: 'LT' }),
        block('ev3_distance_is', { VALUE: n(15) }, { PORT: '4', OP: 'LT' }),
        block('ev3_distance', undefined, { PORT: '4' }),
        label('Gyrosensor'),
        block('ev3_wait_angle', { VALUE: n(90) }, { PORT: '2', OP: 'GT' }),
        block('ev3_angle_is', { VALUE: n(90) }, { PORT: '2', OP: 'GT' }),
        block('ev3_angle', undefined, { PORT: '2' }),
        block('ev3_angle_reset', undefined, { PORT: '2' }),
        block('ev3_rate', undefined, { PORT: '2' }),
        label('Stein-Tasten'),
        block('ev3_wait_button'),
        block('ev3_button_is'),
        block('ev3_button_value'),
        label('Zeit'),
        block('ev3_timer'),
        block('ev3_timer_reset'),
        label('Infrarotsensor'),
        block('ev3_infrared', undefined, { PORT: '4' }),
        block('ev3_ir_beacon', undefined, { PORT: '4' }),
        block('ev3_ir_remote', undefined, { PORT: '4' }),
        block('ev3_ir_remote_is', undefined, { PORT: '4' }),
      ],
    },
    {
      kind: 'category',
      name: 'Operatoren',
      colour: COLORS.operators,
      contents: [
        block('math_random_int', { FROM: n(1), TO: n(10) }),
        block('math_arithmetic', { A: n(0), B: n(0) }, { OP: 'ADD' }),
        block('math_arithmetic', { A: n(0), B: n(0) }, { OP: 'MINUS' }),
        block('math_arithmetic', { A: n(0), B: n(0) }, { OP: 'MULTIPLY' }),
        block('math_arithmetic', { A: n(0), B: n(0) }, { OP: 'DIVIDE' }),
        block('logic_compare', { A: n(0), B: n(50) }, { OP: 'LT' }),
        block('logic_compare', { A: n(0), B: n(50) }, { OP: 'EQ' }),
        block('logic_compare', { A: n(0), B: n(50) }, { OP: 'GT' }),
        block('logic_operation', undefined, { OP: 'AND' }),
        block('logic_operation', undefined, { OP: 'OR' }),
        block('logic_negate'),
        block('text_join', { ADD0: t('Apfel '), ADD1: t('Banane') }),
        block('ev3_letter_of', { INDEX: n(1), TEXT: t('Apfel') }),
        block('ev3_length_of', { TEXT: t('Apfel') }),
        block('ev3_contains', { TEXT: t('Apfel'), PART: t('a') }),
        block('math_modulo', { DIVIDEND: n(10), DIVISOR: n(3) }),
        block('math_round', { NUM: n(3.5) }, { OP: 'ROUND' }),
        block('ev3_math', { NUM: n(9) }, { OP: 'abs' }),
      ],
    },
    { kind: 'category', name: 'Variablen', colour: COLORS.variables, custom: 'EV3_VARIABLES' },
    { kind: 'category', name: 'Meine Blöcke', colour: COLORS.myBlocks, custom: 'PROCEDURE' },
    {
      kind: 'category',
      name: 'Messwerte',
      colour: COLORS.datalog,
      contents: [
        label('Nur mit ▶ Start in der App'),
        block('ev3_log', { VALUE: { ...n(0), block: { type: 'ev3_reflected', fields: { PORT: '3' } } } }, { NAME: 'Licht' }),
        block('ev3_log', { VALUE: { ...n(0), block: { type: 'ev3_distance', fields: { PORT: '4' } } } }, { NAME: 'Abstand' }),
        block('ev3_log', { VALUE: n(0) }),
        block('ev3_log_clear'),
      ],
    },
  ],
};

/** Variables and lists, as in Scratch: buttons to create them, then their blocks. */
function variablesFlyout(workspace: Blockly.WorkspaceSvg): Blockly.utils.toolbox.FlyoutItemInfoArray {
  const map = workspace.getVariableMap();
  const byName = (type: string) => [...map.getVariablesOfType(type)].sort(Blockly.Variables.compareByName);
  const items: Blockly.utils.toolbox.FlyoutItemInfoArray = [{ kind: 'button', text: 'Variable anlegen', callbackkey: 'EV3_CREATE_VARIABLE' }];

  const variables = byName('');
  for (const v of variables) items.push(block('variables_get', undefined, { VAR: { id: v.getId() } }) as Blockly.utils.toolbox.BlockInfo);
  if (variables.length) {
    const VAR = { id: variables[0].getId() };
    items.push(
      block('variables_set', { VALUE: n(0) }, { VAR }) as Blockly.utils.toolbox.BlockInfo,
      block('math_change', { DELTA: n(1) }, { VAR }) as Blockly.utils.toolbox.BlockInfo,
    );
  }

  items.push({ kind: 'button', text: 'Liste anlegen', callbackkey: 'EV3_CREATE_LIST' });
  const lists = byName(LIST_TYPE);
  for (const l of lists) items.push(block('ev3_list_value', undefined, { LIST: { id: l.getId() } }) as Blockly.utils.toolbox.BlockInfo);
  if (lists.length) {
    const LIST = { id: lists[0].getId() };
    const blocks: [string, Record<string, object>?][] = [
      ['ev3_list_add', { ITEM: n(10) }],
      ['ev3_list_delete', { INDEX: n(1) }],
      ['ev3_list_clear'],
      ['ev3_list_insert', { ITEM: n(10), INDEX: n(1) }],
      ['ev3_list_replace', { INDEX: n(1), ITEM: n(10) }],
      ['ev3_list_item', { INDEX: n(1) }],
      ['ev3_list_index', { ITEM: n(10) }],
      ['ev3_list_length'],
      ['ev3_list_contains', { ITEM: n(10) }],
    ];
    for (const [type, inputs] of blocks) items.push(block(type, inputs, { LIST }) as Blockly.utils.toolbox.BlockInfo);
  }
  return items;
}

/** Registers the dynamic "Variablen" category; call once after injecting the workspace. */
export function installToolbox(workspace: Blockly.WorkspaceSvg): void {
  workspace.registerToolboxCategoryCallback('EV3_VARIABLES', variablesFlyout);
  workspace.registerButtonCallback('EV3_CREATE_VARIABLE', (b) => Blockly.Variables.createVariableButtonHandler(b.getTargetWorkspace()));
  workspace.registerButtonCallback('EV3_CREATE_LIST', (b) => {
    const ws = b.getTargetWorkspace();
    Blockly.Variables.promptName('Name der neuen Liste:', '', (name) => {
      name = name?.trim() ?? '';
      if (!name) return;
      if (Blockly.Variables.nameUsedWithAnyType(name, ws)) {
        Blockly.dialog.alert(`Den Namen „${name}“ gibt es schon.`);
        return;
      }
      ws.getVariableMap().createVariable(name, LIST_TYPE);
      ws.refreshToolboxSelection();
    });
  });
}

/** Gives Blockly's built-in blocks the colours of the matching category. */
export const theme = Blockly.Theme.defineTheme('openstorm', {
  name: 'openstorm',
  base: Blockly.Themes.Classic,
  blockStyles: {
    loop_blocks: { colourPrimary: COLORS.control },
    logic_blocks: { colourPrimary: COLORS.operators },
    math_blocks: { colourPrimary: COLORS.operators },
    text_blocks: { colourPrimary: COLORS.operators },
    variable_blocks: { colourPrimary: COLORS.variables },
    variable_dynamic_blocks: { colourPrimary: COLORS.variables },
    procedure_blocks: { colourPrimary: COLORS.myBlocks },
  } as unknown as Record<string, Blockly.Theme.BlockStyle>,
  componentStyles: {
    workspaceBackgroundColour: '#f7f7f4',
    toolboxBackgroundColour: '#fcfcfa',
    toolboxForegroundColour: '#1b1d1b',
    flyoutBackgroundColour: '#f0f0eb',
    flyoutForegroundColour: '#1b1d1b',
    flyoutOpacity: 0.97,
    scrollbarColour: '#c8c8c0',
    scrollbarOpacity: 0.8,
    insertionMarkerColour: '#000000',
    insertionMarkerOpacity: 0.2,
  },
  fontStyle: { family: 'system-ui, -apple-system, sans-serif', weight: '600', size: 12 },
  startHats: true,
});
