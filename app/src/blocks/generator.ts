import * as Blockly from 'blockly/core';
import { javascriptGenerator, Order } from 'blockly/javascript';
import { LIST_TYPE } from './definitions';

type Gen = typeof javascriptGenerator;
type B = Blockly.Block;

const gen = javascriptGenerator;

/** Blocks that start a stack of blocks (Scratch "hat" blocks). */
export const HAT_TYPES = [
  'ev3_start', 'ev3_when_color', 'ev3_when_touch', 'ev3_when_distance', 'ev3_when_angle',
  'ev3_when_button', 'ev3_when', 'ev3_when_timer', 'ev3_when_message',
];

/** `'BC'` → `["B","C"]` */
const ports = (b: B, field = 'PORT') => JSON.stringify(b.getFieldValue(field).split(''));
const str = (s: string) => JSON.stringify(s);
const field = (b: B, name: string) => str(b.getFieldValue(name));
const num = (b: B, g: Gen, name: string, fallback = '0') => g.valueToCode(b, name, Order.NONE) || fallback;
const val = (b: B, g: Gen, name: string) => g.valueToCode(b, name, Order.NONE) || "''";
const bool = (b: B, name: string) => (b.getFieldValue(name) === 'TRUE' ? 'true' : 'false');
const awaited = (code: string): [string, Order] => [`(await ${code})`, Order.ATOMIC];
const call = (code: string): [string, Order] => [code, Order.FUNCTION_CALL];
const dir = (b: B) => (b.getFieldValue('DIR') === 'ccw' ? '-1' : '1');
const list = (b: B, g: Gen) => g.getVariableName(b.getFieldValue('LIST'));
const key = (b: B) => str(b.id);

/** Reading of a sensor as an expression (used by "ist …?", "warte bis …" and events). */
const reading = {
  distance: (b: B) => `api.distance(${field(b, 'PORT')}, ${field(b, 'UNIT')})`,
  angle: (b: B) => `api.angle(${field(b, 'PORT')})`,
};

/** A "warte bis … < > = / ändert sich" block. */
const waitValue = (read: string) => (b: B, g: Gen) =>
  `await api.waitValue(() => ${read}, ${field(b, 'OP')}, ${num(b, g, 'VALUE')});\n`;

/** An "ist … < > = …?" block. */
const isValue = (read: (b: B) => string) => (b: B, g: Gen): [string, Order] =>
  call(`api.compare(await ${read(b)}, ${field(b, 'OP')}, ${num(b, g, 'VALUE')})`);

const blocks: Record<string, (b: B, g: Gen) => string | [string, Order] | null> = {
  ev3_wait: (b, g) => `await api.wait(${num(b, g, 'SECONDS')});\n`,
  ev3_wait_until: (b, g) =>
    `while (!(${g.valueToCode(b, 'COND', Order.NONE) || 'false'})) {\n${g.INDENT}await api.sleep(20);\n}\n`,
  ev3_forever: (b, g) => {
    const body = g.addLoopTrap(g.statementToCode(b, 'DO'), b);
    return `while (true) {\n${body}}\n`;
  },
  ev3_stop: (b) => `api.stop(${field(b, 'WHAT')});\n`,
  ev3_stop_other: () => 'api.stopOthers();\n',
  ev3_broadcast: (b) => `api.broadcast(${field(b, 'MESSAGE')});\n`,
  ev3_broadcast_wait: (b) => `await api.broadcastWait(${field(b, 'MESSAGE')});\n`,

  // Motoren
  ev3_motor_run_for: (b, g) => `await api.motorRunFor(${ports(b)}, ${dir(b)}, ${num(b, g, 'AMOUNT', '1')}, ${field(b, 'UNIT')});\n`,
  ev3_motor_run_for_speed: (b, g) =>
    `await api.motorRunForSpeed(${ports(b)}, ${num(b, g, 'AMOUNT', '1')}, ${field(b, 'UNIT')}, ${num(b, g, 'SPEED', '75')});\n`,
  ev3_motor_start_dir: (b) => `await api.motorStartDir(${ports(b)}, ${dir(b)});\n`,
  ev3_motor_start_speed: (b, g) => `await api.motorOn(${ports(b)}, ${num(b, g, 'SPEED', '75')});\n`,
  ev3_motor_start_power: (b, g) => `await api.motorStartPower(${ports(b)}, ${num(b, g, 'POWER', '75')});\n`,
  ev3_motor_stop: (b) => `await api.motorStop(${ports(b)});\n`,
  ev3_motor_set_speed: (b, g) => `api.motorSetSpeed(${ports(b)}, ${num(b, g, 'SPEED', '75')});\n`,
  ev3_motor_set_stop: (b) => `api.motorSetStop(${ports(b)}, ${field(b, 'ACTION')});\n`,
  ev3_motor_reset: (b) => `await api.motorReset(${field(b, 'PORT')});\n`,
  ev3_motor_degrees: (b) =>
    awaited(`api.${b.getFieldValue('MODE') === 'speed' ? 'motorSpeed' : 'motorDegrees'}(${field(b, 'PORT')})`),

  // Fahren
  ev3_move_for: (b, g) => `await api.moveFor(${field(b, 'DIR')}, ${num(b, g, 'AMOUNT', '10')}, ${field(b, 'UNIT')});\n`,
  ev3_move_start: (b) => `await api.moveStart(${field(b, 'DIR')});\n`,
  ev3_move_steer_for: (b, g) =>
    `await api.moveSteerFor(${num(b, g, 'STEERING')}, ${num(b, g, 'AMOUNT', '10')}, ${field(b, 'UNIT')});\n`,
  ev3_move_steer_start: (b, g) => `await api.moveSteerStart(${num(b, g, 'STEERING')});\n`,
  ev3_move_stop: () => 'await api.moveStop();\n',
  ev3_move_set_speed: (b, g) => `api.moveSetSpeed(${num(b, g, 'SPEED', '50')});\n`,
  ev3_move_set_motors: (b) => `api.moveSetMotors(${field(b, 'PORTS')});\n`,
  ev3_move_set_stop: (b) => `api.moveSetStop(${field(b, 'ACTION')});\n`,
  ev3_move_set_rotation: (b, g) => `api.moveSetRotation(${num(b, g, 'DISTANCE', '17.6')}, ${field(b, 'UNIT')});\n`,
  ev3_move_steer_for_speed: (b, g) =>
    `await api.moveSteerFor(${num(b, g, 'STEERING')}, ${num(b, g, 'AMOUNT', '10')}, ${field(b, 'UNIT')}, ${num(b, g, 'SPEED', '50')});\n`,
  ev3_move_tank_for: (b, g) =>
    `await api.moveTankFor(${num(b, g, 'AMOUNT', '10')}, ${field(b, 'UNIT')}, ${num(b, g, 'LEFT', '50')}, ${num(b, g, 'RIGHT', '50')});\n`,
  ev3_move_steer_start_speed: (b, g) => `await api.moveSteerStart(${num(b, g, 'STEERING')}, ${num(b, g, 'SPEED', '50')});\n`,
  ev3_move_tank_start: (b, g) => `await api.moveTankStart(${num(b, g, 'LEFT', '50')}, ${num(b, g, 'RIGHT', '50')});\n`,

  // Anzeige
  ev3_image_for: (b, g) => `await api.imageFor(${field(b, 'IMAGE')}, ${num(b, g, 'SECONDS', '2')});\n`,
  ev3_image: (b) => `await api.image(${field(b, 'IMAGE')});\n`,
  ev3_write_line: (b, g) => `await api.writeLine(${val(b, g, 'TEXT')}, ${num(b, g, 'LINE', '1')});\n`,
  ev3_write_xy: (b, g) => `await api.writeAt(${val(b, g, 'TEXT')}, ${num(b, g, 'X')}, ${num(b, g, 'Y')}, ${field(b, 'FONT')});\n`,
  ev3_display_clear: () => 'await api.displayClear();\n',
  ev3_led: (b) => `await api.led(${field(b, 'PATTERN')});\n`,
  ev3_draw_pixel: (b, g) => `await api.drawPixel(${num(b, g, 'X')}, ${num(b, g, 'Y')}, ${b.getFieldValue('INK')});\n`,
  ev3_draw_line: (b, g) =>
    `await api.drawLine(${num(b, g, 'X1')}, ${num(b, g, 'Y1')}, ${num(b, g, 'X2')}, ${num(b, g, 'Y2')}, ${b.getFieldValue('INK')});\n`,
  ev3_draw_circle: (b, g) =>
    `await api.drawCircle(${num(b, g, 'X')}, ${num(b, g, 'Y')}, ${num(b, g, 'R', '10')}, ${bool(b, 'FILL')}, ${b.getFieldValue('INK')});\n`,
  ev3_draw_rect: (b, g) =>
    `await api.drawRect(${num(b, g, 'X')}, ${num(b, g, 'Y')}, ${num(b, g, 'W', '10')}, ${num(b, g, 'H', '10')}, ${bool(b, 'FILL')}, ${b.getFieldValue('INK')});\n`,
  ev3_display_invert: () => 'await api.invert();\n',

  // Klang
  ev3_sound_play: (b) => `await api.sound(${field(b, 'SOUND')}, true);\n`,
  ev3_sound_start: (b) => `await api.sound(${field(b, 'SOUND')}, false);\n`,
  ev3_beep_for: (b, g) => `await api.beep(${num(b, g, 'NOTE', '60')}, ${num(b, g, 'SECONDS', '0.2')});\n`,
  ev3_beep_start: (b, g) => `await api.beep(${num(b, g, 'NOTE', '60')}, null);\n`,
  ev3_sound_stop: () => 'await api.stopSound();\n',
  ev3_volume_set: (b, g) => `api.setVolume(${num(b, g, 'VOLUME', '100')});\n`,

  // Sensoren
  ev3_reflected_is: isValue((b) => `api.reflected(${field(b, 'PORT')})`),
  ev3_reflected: (b) => awaited(`api.reflected(${field(b, 'PORT')})`),
  ev3_light_calibrate: (b, g) => `api.calibrateLight(${field(b, 'WHICH')}, ${field(b, 'PORT')}, ${num(b, g, 'VALUE')});\n`,
  ev3_wait_color: (b) => `await api.waitFor(() => api.colorIs(${field(b, 'PORT')}, ${b.getFieldValue('COLOR')}));\n`,
  ev3_color_is: (b) => awaited(`api.colorIs(${field(b, 'PORT')}, ${b.getFieldValue('COLOR')})`),
  ev3_color_value: (b) => awaited(`api.color(${field(b, 'PORT')})`),
  ev3_ambient_is: isValue((b) => `api.ambient(${field(b, 'PORT')})`),
  ev3_ambient: (b) => awaited(`api.ambient(${field(b, 'PORT')})`),
  ev3_wait_touch: (b) => `await api.waitTouch(${field(b, 'PORT')}, ${field(b, 'EVENT')});\n`,
  ev3_touch_is: (b) =>
    b.getFieldValue('STATE') === 'released'
      ? [`!(await api.touch(${field(b, 'PORT')}))`, Order.LOGICAL_NOT]
      : awaited(`api.touch(${field(b, 'PORT')})`),
  ev3_wait_distance: (b, g) => waitValue(reading.distance(b))(b, g),
  ev3_distance_is: isValue(reading.distance),
  ev3_distance: (b) => awaited(reading.distance(b)),
  ev3_wait_angle: (b, g) => waitValue(reading.angle(b))(b, g),
  ev3_angle_is: isValue(reading.angle),
  ev3_angle: (b) => awaited(reading.angle(b)),
  ev3_angle_reset: (b) => `await api.resetAngle(${field(b, 'PORT')});\n`,
  ev3_rate: (b) => awaited(`api.rate(${field(b, 'PORT')})`),
  ev3_wait_button: (b) =>
    `await api.waitFor(async () => ${b.getFieldValue('STATE') === 'released' ? '!' : ''}(await api.button(${field(b, 'BUTTON')})));\n`,
  ev3_button_is: (b) =>
    b.getFieldValue('STATE') === 'released'
      ? [`!(await api.button(${field(b, 'BUTTON')}))`, Order.LOGICAL_NOT]
      : awaited(`api.button(${field(b, 'BUTTON')})`),
  ev3_button_value: () => awaited('api.buttonNumber()'),
  ev3_timer: () => call('api.timer()'),
  ev3_timer_reset: () => 'api.resetTimer();\n',
  ev3_infrared: (b) => awaited(`api.sensor(${field(b, 'PORT')}, 0)`),
  ev3_ir_beacon: (b) => awaited(`api.irBeacon(${field(b, 'PORT')}, ${b.getFieldValue('CHANNEL')}, ${field(b, 'WHAT')})`),
  ev3_ir_remote: (b) => awaited(`api.irRemote(${field(b, 'PORT')}, ${b.getFieldValue('CHANNEL')})`),
  ev3_ir_remote_is: (b) =>
    [`((await api.irRemote(${field(b, 'PORT')}, ${b.getFieldValue('CHANNEL')})) === ${b.getFieldValue('BUTTON')})`, Order.ATOMIC],

  // Operatoren
  ev3_letter_of: (b, g) => call(`api.letterOf(${num(b, g, 'INDEX', '1')}, ${val(b, g, 'TEXT')})`),
  ev3_length_of: (b, g) => call(`api.lengthOf(${val(b, g, 'TEXT')})`),
  ev3_contains: (b, g) => call(`api.contains(${val(b, g, 'TEXT')}, ${val(b, g, 'PART')})`),
  ev3_math: (b, g) => call(`api.math(${field(b, 'OP')}, ${num(b, g, 'NUM')})`),

  // Listen
  ev3_list_add: (b, g) => `${list(b, g)}.push(${val(b, g, 'ITEM')});\n`,
  ev3_list_delete: (b, g) => `api.listDelete(${list(b, g)}, ${num(b, g, 'INDEX', '1')});\n`,
  ev3_list_clear: (b, g) => `${list(b, g)}.length = 0;\n`,
  ev3_list_insert: (b, g) => `api.listInsert(${list(b, g)}, ${val(b, g, 'ITEM')}, ${num(b, g, 'INDEX', '1')});\n`,
  ev3_list_replace: (b, g) => `api.listReplace(${list(b, g)}, ${num(b, g, 'INDEX', '1')}, ${val(b, g, 'ITEM')});\n`,
  ev3_list_item: (b, g) => call(`api.listItem(${list(b, g)}, ${num(b, g, 'INDEX', '1')})`),
  ev3_list_index: (b, g) => call(`api.listIndex(${list(b, g)}, ${val(b, g, 'ITEM')})`),
  ev3_list_length: (b, g) => [`${list(b, g)}.length`, Order.MEMBER],
  ev3_list_contains: (b, g) => [`(api.listIndex(${list(b, g)}, ${val(b, g, 'ITEM')}) > 0)`, Order.ATOMIC],
  ev3_list_value: (b, g) => call(`api.listText(${list(b, g)})`),

  ev3_print: (b, g) => `api.print(${val(b, g, 'VALUE')});\n`,

  // Older OpenStorm blocks
  ev3_motor_on: (b, g) => `await api.motorOn(${ports(b)}, ${num(b, g, 'SPEED', '50')});\n`,
  ev3_motor_for: (b, g) =>
    `await api.motorFor(${ports(b)}, ${num(b, g, 'SPEED', '50')}, ${num(b, g, 'AMOUNT', '1')}, ${field(b, 'UNIT')}, ${bool(b, 'BRAKE')});\n`,
  ev3_motor_off: (b) => `await api.motorOff(${ports(b)}, ${bool(b, 'BRAKE')});\n`,
  ev3_steer_on: (b, g) => `await api.steerOn(${ports(b)}, ${num(b, g, 'STEERING')}, ${num(b, g, 'SPEED', '50')});\n`,
  ev3_steer_for: (b, g) =>
    `await api.steerFor(${ports(b)}, ${num(b, g, 'STEERING')}, ${num(b, g, 'SPEED', '50')}, ${num(b, g, 'AMOUNT', '1')}, ${field(b, 'UNIT')}, ${bool(b, 'BRAKE')});\n`,
  ev3_display_text: (b, g) => `await api.displayText(${val(b, g, 'TEXT')}, ${num(b, g, 'LINE', '1')});\n`,
  ev3_tone: (b, g) =>
    `await api.tone(${num(b, g, 'FREQ', '440')}, ${num(b, g, 'SECONDS', '0.5')}, ${num(b, g, 'VOLUME', '50')}, ${bool(b, 'WAIT')});\n`,
  ev3_touch: (b) => awaited(`api.touch(${field(b, 'PORT')})`),
  ev3_color: (b) => awaited(`api.sensor(${field(b, 'PORT')}, ${b.getFieldValue('MODE')})`),
  ev3_ultrasonic: (b) => awaited(`api.sensor(${field(b, 'PORT')}, 0)`),
  ev3_gyro: (b) => awaited(`api.sensor(${field(b, 'PORT')}, ${b.getFieldValue('MODE')})`),
  ev3_button: (b) => awaited(`api.button(${field(b, 'BUTTON')})`),
};

/** The condition of an event block, evaluated over and over by the runtime. */
function hatCondition(b: B, g: Gen): string {
  const port = field(b, 'PORT');
  switch (b.type) {
    case 'ev3_when_color':
      return b.getFieldValue('COLOR') === 'change'
        ? `api.changed(${key(b)}, await api.color(${port}), 0)`
        : `await api.colorIs(${port}, ${b.getFieldValue('COLOR')})`;
    case 'ev3_when_touch':
      return b.getFieldValue('EVENT') === 'pressed'
        ? `await api.touch(${port})`
        : `api.released(${key(b)}, await api.touch(${port}))`;
    case 'ev3_when_distance':
    case 'ev3_when_angle': {
      const read = b.type === 'ev3_when_angle' ? reading.angle(b) : reading.distance(b);
      const op = b.getFieldValue('OP');
      return op === 'CHANGE'
        ? `api.changed(${key(b)}, await ${read}, ${num(b, g, 'VALUE')})`
        : `api.compare(await ${read}, ${str(op)}, ${num(b, g, 'VALUE')})`;
    }
    case 'ev3_when_button':
      return b.getFieldValue('EVENT') === 'released'
        ? `api.released(${key(b)}, await api.button(${field(b, 'BUTTON')}))`
        : `await api.button(${field(b, 'BUTTON')})`;
    case 'ev3_when_timer':
      return `api.timer() > ${num(b, g, 'SECONDS', '0')}`;
    default:
      return g.valueToCode(b, 'COND', Order.NONE) || 'false';
  }
}

let installed = false;

/** Registers the EV3 blocks and makes all generated code async-aware. */
export function installGenerator(): void {
  if (installed) return;
  installed = true;
  Object.assign(gen.forBlock, blocks);
  for (const type of HAT_TYPES) gen.forBlock[type] = () => '';

  gen.STATEMENT_PREFIX = 'await api.step(%1);\n';
  gen.INFINITE_LOOP_TRAP = 'await api.tick();\n';
  gen.addReservedWords('api,__threads');

  // "Meine Blöcke" contain awaits, so they become async functions. They get the
  // `api` of the calling stack, so that stopping a stack also stops its blocks.
  const withApi = (code: string) => code.replace('(', '(api, ').replace('(api, )', '(api)');
  for (const type of ['procedures_defreturn', 'procedures_defnoreturn']) {
    const original = gen.forBlock[type];
    gen.forBlock[type] = function (block, g) {
      original.call(this, block, g);
      const name = g.getProcedureName(block.getFieldValue('NAME'));
      const def = (g as unknown as { definitions_: Record<string, string> }).definitions_;
      def['%' + name] = def['%' + name].replace(
        new RegExp(`^((?:\\/\\/.*\\n)*)function ${name}\\(`),
        (_, comments: string) => `${comments}async function ${name}(api, `,
      ).replace(`function ${name}(api, )`, `function ${name}(api)`);
      return null;
    };
  }
  const callReturn = gen.forBlock['procedures_callreturn'];
  gen.forBlock['procedures_callreturn'] = function (block, g) {
    const [code] = callReturn.call(this, block, g) as [string, Order];
    return [`(await ${withApi(code)})`, Order.ATOMIC];
  };
  const callNoReturn = gen.forBlock['procedures_callnoreturn'];
  gen.forBlock['procedures_callnoreturn'] = function (block, g) {
    return `await ${withApi(callNoReturn.call(this, block, g) as string)}`;
  };
}

/**
 * Compiles a workspace into the body of an async function taking `api`.
 * Every event block becomes its own stack; loose blocks are ignored.
 */
export function compile(workspace: Blockly.Workspace): { code: string; threads: number } {
  installGenerator();
  gen.init(workspace);
  const threads: string[] = [];
  for (const block of workspace.getTopBlocks(true)) {
    if (!block.isEnabled()) continue;
    if (HAT_TYPES.includes(block.type)) {
      const body = gen.prefixLines(stackCode(block), gen.INDENT);
      const fn = `async (api) => {\n${body}}`;
      if (block.type === 'ev3_start') threads.push(`{ kind: 'start', body: ${fn} }`);
      else if (block.type === 'ev3_when_message') threads.push(`{ kind: 'message', name: ${field(block, 'MESSAGE')}, body: ${fn} }`);
      else threads.push(`{ kind: 'when', cond: async (api) => (${hatCondition(block, gen)}), body: ${fn} }`);
    } else if (block.type.startsWith('procedures_def')) {
      gen.blockToCode(block);
    }
  }
  // Scratch starts variables at 0 and lists empty.
  const init = Blockly.Variables.allUsedVarModels(workspace)
    .map((v) => `${gen.getVariableName(v.getId())} = ${v.getType() === LIST_TYPE ? '[]' : '0'};\n`)
    .join('');
  const body = `${init}const __threads = [\n${threads.map((t) => gen.prefixLines(t, gen.INDENT) + ',\n').join('')}];\nawait api.runThreads(__threads);\n`;
  return { code: gen.finish(body), threads: threads.length };
}

/** Code of the blocks below an event block. */
function stackCode(hat: B): string {
  const next = hat.getNextBlock();
  return next ? (gen.blockToCode(next) as string) : '';
}
