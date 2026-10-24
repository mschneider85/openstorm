import type * as Blockly from 'blockly/core';
import { javascriptGenerator, Order } from 'blockly/javascript';

type Gen = typeof javascriptGenerator;
type B = Blockly.Block;

const gen = javascriptGenerator;

/** `'BC'` → `["B","C"]` */
const ports = (b: B) => JSON.stringify(b.getFieldValue('PORT').split(''));
const str = (s: string) => JSON.stringify(s);
const num = (b: B, g: Gen, name: string, fallback = '0') => g.valueToCode(b, name, Order.NONE) || fallback;
const bool = (b: B, name: string) => (b.getFieldValue(name) === 'TRUE' ? 'true' : 'false');
const awaited = (code: string): [string, Order] => [`(await ${code})`, Order.ATOMIC];

const blocks: Record<string, (b: B, g: Gen) => string | [string, Order] | null> = {
  ev3_start: () => '',
  ev3_wait: (b, g) => `await api.wait(${num(b, g, 'SECONDS')});\n`,
  ev3_wait_until: (b, g) =>
    `while (!(${g.valueToCode(b, 'COND', Order.NONE) || 'false'})) {\n${g.INDENT}await api.sleep(20);\n}\n`,
  ev3_forever: (b, g) => {
    const body = g.addLoopTrap(g.statementToCode(b, 'DO'), b);
    return `while (true) {\n${body}}\n`;
  },

  ev3_motor_on: (b, g) => `await api.motorOn(${ports(b)}, ${num(b, g, 'SPEED', '50')});\n`,
  ev3_motor_for: (b, g) =>
    `await api.motorFor(${ports(b)}, ${num(b, g, 'SPEED', '50')}, ${num(b, g, 'AMOUNT', '1')}, ${str(b.getFieldValue('UNIT'))}, ${bool(b, 'BRAKE')});\n`,
  ev3_motor_off: (b) => `await api.motorOff(${ports(b)}, ${bool(b, 'BRAKE')});\n`,
  ev3_steer_on: (b, g) => `await api.steerOn(${ports(b)}, ${num(b, g, 'STEERING')}, ${num(b, g, 'SPEED', '50')});\n`,
  ev3_steer_for: (b, g) =>
    `await api.steerFor(${ports(b)}, ${num(b, g, 'STEERING')}, ${num(b, g, 'SPEED', '50')}, ${num(b, g, 'AMOUNT', '1')}, ${str(b.getFieldValue('UNIT'))}, ${bool(b, 'BRAKE')});\n`,
  ev3_motor_reset: (b) => `await api.motorReset(${str(b.getFieldValue('PORT'))});\n`,

  ev3_display_text: (b, g) =>
    `await api.displayText(${g.valueToCode(b, 'TEXT', Order.NONE) || "''"}, ${num(b, g, 'LINE', '1')});\n`,
  ev3_display_clear: () => 'await api.displayClear();\n',
  ev3_tone: (b, g) =>
    `await api.tone(${num(b, g, 'FREQ', '440')}, ${num(b, g, 'SECONDS', '0.5')}, ${num(b, g, 'VOLUME', '50')}, ${bool(b, 'WAIT')});\n`,
  ev3_led: (b) => `await api.led(${str(b.getFieldValue('PATTERN'))});\n`,

  ev3_touch: (b) => awaited(`api.touch(${str(b.getFieldValue('PORT'))})`),
  ev3_color: (b) => awaited(`api.sensor(${str(b.getFieldValue('PORT'))}, ${b.getFieldValue('MODE')})`),
  ev3_color_is: (b) => awaited(`api.colorIs(${str(b.getFieldValue('PORT'))}, ${b.getFieldValue('COLOR')})`),
  ev3_ultrasonic: (b) => awaited(`api.sensor(${str(b.getFieldValue('PORT'))}, 0)`),
  ev3_gyro: (b) => awaited(`api.sensor(${str(b.getFieldValue('PORT'))}, ${b.getFieldValue('MODE')})`),
  ev3_infrared: (b) => awaited(`api.sensor(${str(b.getFieldValue('PORT'))}, 0)`),
  ev3_motor_degrees: (b) =>
    awaited(
      `api.${b.getFieldValue('MODE') === 'speed' ? 'motorSpeed' : 'motorDegrees'}(${str(b.getFieldValue('PORT'))})`,
    ),
  ev3_button: (b) => awaited(`api.button(${str(b.getFieldValue('BUTTON'))})`),
  ev3_timer: () => ['api.timer()', Order.FUNCTION_CALL],
  ev3_timer_reset: () => 'api.resetTimer();\n',

  ev3_print: (b, g) => `api.print(${g.valueToCode(b, 'VALUE', Order.NONE) || "''"});\n`,
};

let installed = false;

/** Registers the EV3 blocks and makes all generated code async-aware. */
export function installGenerator(): void {
  if (installed) return;
  installed = true;
  Object.assign(gen.forBlock, blocks);

  gen.STATEMENT_PREFIX = 'await api.step(%1);\n';
  gen.INFINITE_LOOP_TRAP = 'await api.tick();\n';
  gen.addReservedWords('api,__threads');

  // User-defined blocks ("Eigene Blöcke") contain awaits, so they become async functions.
  for (const type of ['procedures_defreturn', 'procedures_defnoreturn']) {
    const original = gen.forBlock[type];
    gen.forBlock[type] = function (block, g) {
      original.call(this, block, g);
      const key = '%' + g.getProcedureName(block.getFieldValue('NAME'));
      const def = (g as unknown as { definitions_: Record<string, string> }).definitions_;
      def[key] = def[key].replace(/^((?:\/\/.*\n)*)function /, '$1async function ');
      return null;
    };
  }
  const callReturn = gen.forBlock['procedures_callreturn'];
  gen.forBlock['procedures_callreturn'] = function (block, g) {
    const [code] = callReturn.call(this, block, g) as [string, Order];
    return [`(await ${code})`, Order.ATOMIC];
  };
  const callNoReturn = gen.forBlock['procedures_callnoreturn'];
  gen.forBlock['procedures_callnoreturn'] = function (block, g) {
    return `await ${callNoReturn.call(this, block, g) as string}`;
  };
}

/**
 * Compiles a workspace into the body of an async function taking `api`.
 * Every start block becomes its own thread; loose blocks are ignored.
 */
export function compile(workspace: Blockly.Workspace): { code: string; threads: number } {
  installGenerator();
  gen.init(workspace);
  const threads: string[] = [];
  for (const block of workspace.getTopBlocks(true)) {
    if (!block.isEnabled()) continue;
    if (block.type === 'ev3_start') {
      threads.push(gen.blockToCode(block) as string);
    } else if (block.type.startsWith('procedures_def')) {
      gen.blockToCode(block);
    }
  }
  const body =
    'const __threads = [];\n' +
    threads.map((t) => `__threads.push(async () => {\n${gen.prefixLines(t, gen.INDENT)}});\n`).join('') +
    'await Promise.all(__threads.map((t) => t()));\n';
  return { code: gen.finish(body), threads: threads.length };
}
