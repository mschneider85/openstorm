// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly/core';
import 'blockly/blocks';
import * as De from 'blockly/msg/de';
import { LIST_TYPE, defineBlocks } from '../src/blocks/definitions';
import { compile } from '../src/blocks/generator';
import { compileRbf } from '../src/blocks/rbf';
import { SimBrick } from '../src/ev3/simbrick';
import { ProgramRun } from '../src/runtime/runner';
import { Ev3Vm, type FakeBrick } from './ev3vm';

// Blocks of the EV3 Classroom palette, live (simulator) and as .rbf on the VM model.

Blockly.setLocale(De as unknown as Record<string, string>);
defineBlocks();

const num = (v: number) => ({ shadow: { type: 'math_number', fields: { NUM: v } } });
const text = (t: string) => ({ shadow: { type: 'text', fields: { TEXT: t } } });
const get = (id: string) => ({ block: { type: 'variables_get', fields: { VAR: { id } } } });
const chain = (...blocks: object[]): object =>
  blocks.reduceRight<object | undefined>((next, b) => ({ ...b, ...(next ? { next: { block: next } } : {}) }), undefined)!;
const start = (...blocks: object[]) => chain({ type: 'ev3_start' }, ...blocks);
const print = (value: object) => ({ type: 'ev3_print', inputs: { VALUE: value } });
const line = (value: object, n = 1) => ({ type: 'ev3_write_line', inputs: { TEXT: value, LINE: num(n) } });

function workspace(blocks: object[], variables: { name: string; id: string; type?: string }[] = []): Blockly.Workspace {
  const ws = new Blockly.Workspace();
  Blockly.serialization.workspaces.load({ variables, blocks: { languageVersion: 0, blocks } }, ws);
  return ws;
}

let brick: SimBrick;
afterEach(() => brick?.close());

async function live(ws: Blockly.Workspace, setup?: (b: SimBrick) => void) {
  brick = new SimBrick();
  setup?.(brick);
  const printed: string[] = [];
  const program = new ProgramRun(brick, compile(ws).code, { onStep: () => {}, onPrint: (t) => printed.push(t) });
  return { program, printed };
}

function vm(ws: Blockly.Workspace, fake: FakeBrick = {}): Ev3Vm {
  const machine = new Ev3Vm(compileRbf(ws).image, fake);
  machine.run();
  return machine;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('motors and movement', () => {
  const program = () =>
    workspace([
      start(
        { type: 'ev3_motor_set_speed', fields: { PORT: 'A' }, inputs: { SPEED: num(40) } },
        { type: 'ev3_motor_run_for', fields: { PORT: 'A', DIR: 'ccw', UNIT: 'degrees' }, inputs: { AMOUNT: num(90) } },
        { type: 'ev3_move_set_motors', fields: { PORTS: 'CB' } },
        { type: 'ev3_move_set_rotation', fields: { UNIT: 'cm' }, inputs: { DISTANCE: num(20) } },
        { type: 'ev3_move_for', fields: { DIR: 'fwd', UNIT: 'cm' }, inputs: { AMOUNT: num(10) } },
        { type: 'ev3_move_steer_for', fields: { UNIT: 'rotations' }, inputs: { STEERING: num(50), AMOUNT: num(1) } },
        { type: 'ev3_move_tank_for', fields: { UNIT: 'degrees' }, inputs: { AMOUNT: num(100), LEFT: num(50), RIGHT: num(25) } },
      ),
    ]);

  it('uses the set speeds, directions and movement motors on the brick', () => {
    expect(vm(program()).log).toEqual([
      'run A -40 90deg brake',
      // 10 cm with 20 cm per rotation = 180°; the left motor C has the higher port.
      'sync BC 50 turn 0 180deg brake',
      // Steering 50 to the right turns towards B, the right motor: mirrored.
      'sync BC 50 turn -100 360deg brake',
      // Left C 50 %, right B 25 %: B is the first motor, C runs faster.
      'sync BC 50 turn -50 100deg brake',
    ]);
  });

  it('moves the simulated motors the same way', async () => {
    const { program: run } = await live(program());
    await run.done;
    expect(Math.round(brick.motorPosition('A'))).toBe(-90);
    // C (left) drove 180 + 360 + 100; B (right) 180, stood still while steering 50, then 50.
    expect(Math.round(brick.motorPosition('C'))).toBe(640);
    expect(Math.round(brick.motorPosition('B'))).toBe(230);
  });
});

describe('events', () => {
  it('runs "Wenn Berührungssensor gedrückt" and messages, live', async () => {
    const ws = workspace([
      chain(
        { type: 'ev3_when_touch', fields: { PORT: '1', EVENT: 'pressed' } },
        { type: 'ev3_broadcast_wait', fields: { MESSAGE: 'los' } },
        print(text('fertig')),
        { type: 'ev3_stop', fields: { WHAT: 'all' } },
      ),
      chain({ type: 'ev3_when_message', fields: { MESSAGE: 'los' } }, { type: 'ev3_wait', inputs: { SECONDS: num(0.05) } }, print(text('empfangen'))),
    ]);
    const { program, printed } = await live(ws);
    await sleep(80);
    expect(printed).toEqual([]);
    brick.setSensorValue('1', 1);
    await program.done;
    expect(printed).toEqual(['empfangen', 'fertig']);
  });

  it('runs the same program on the brick', () => {
    const ws = workspace([
      chain(
        { type: 'ev3_when_touch', fields: { PORT: '1', EVENT: 'pressed' } },
        { type: 'ev3_broadcast_wait', fields: { MESSAGE: 'los' } },
        { type: 'ev3_led', fields: { PATTERN: 'red' } },
        { type: 'ev3_stop', fields: { WHAT: 'all' } },
      ),
      chain({ type: 'ev3_when_message', fields: { MESSAGE: 'los' } }, { type: 'ev3_wait', inputs: { SECONDS: num(0.05) } }, { type: 'ev3_led', fields: { PATTERN: 'green' } }),
    ]);
    const machine: Ev3Vm = new Ev3Vm(compileRbf(ws).image, { sensor: (port) => (port === 0 && machine.now >= 200 ? 1 : 0) });
    machine.run();
    expect(machine.log).toEqual(['led 1', 'led 2', 'program stop']);
    expect(machine.now).toBeGreaterThanOrEqual(250);
  });

  it('stops the other stacks', () => {
    const ws = workspace([
      start({ type: 'ev3_forever', inputs: { DO: { block: chain({ type: 'ev3_led', fields: { PATTERN: 'orange' } }, { type: 'ev3_wait', inputs: { SECONDS: num(0.1) } }) } } }),
      start({ type: 'ev3_wait', inputs: { SECONDS: num(0.25) } }, { type: 'ev3_stop_other' }, { type: 'ev3_led', fields: { PATTERN: 'off' } }),
    ]);
    expect(vm(ws).log).toEqual(['led 3', 'led 3', 'led 3', 'led 0']);
  });
});

describe('display and sound', () => {
  const ws = () =>
    workspace([
      start(
        { type: 'ev3_image', fields: { IMAGE: 'eyes_neutral' } },
        line(text('Hallo'), 3),
        { type: 'ev3_write_xy', fields: { FONT: '2,1' }, inputs: { TEXT: text('Groß'), X: num(10), Y: num(100) } },
        { type: 'ev3_draw_circle', fields: { FILL: 'FALSE', INK: '1' }, inputs: { X: num(20), Y: num(30), R: num(5) } },
        { type: 'ev3_volume_set', inputs: { VOLUME: num(30) } },
        { type: 'ev3_sound_play', fields: { SOUND: 'Hupe' } },
        { type: 'ev3_beep_for', inputs: { NOTE: num(69), SECONDS: num(0.1) } },
      ),
    ]);

  it('draws and plays on the brick', () => {
    const result = compileRbf(ws());
    expect(result.sounds).toEqual(['Hupe']);
    const log = vm(ws()).log;
    expect(log.filter((l) => !l.startsWith('draw 24'))).toEqual([
      'clear',
      'clear',
      'text 0,20 Hallo',
      'text 10,100 Gross',
      'draw 4 1 20 30 5',
      'play ../prjs/OpenStorm/Hupe 30',
      'tone 440 100 30',
    ]);
  });

  it('draws in the simulator', async () => {
    const { program } = await live(ws());
    await program.done;
    expect(brick.texts).toEqual(['Hallo', 'Groß']);
    expect(brick.screen.some((d) => d.op === 'circle' && d.r === 5)).toBe(true);
  });
});

describe('sensors', () => {
  it('reads the gyro angle without switching modes and resets it', () => {
    const ws = workspace([
      start(
        { type: 'ev3_angle_reset', fields: { PORT: '2' } },
        { type: 'ev3_wait_angle', fields: { PORT: '2', OP: 'GT' }, inputs: { VALUE: num(80) } },
        line({ block: { type: 'ev3_angle', fields: { PORT: '2' } } }),
        line({ block: { type: 'ev3_rate', fields: { PORT: '2' } } }, 2),
      ),
    ]);
    const machine: Ev3Vm = new Ev3Vm(compileRbf(ws).image, {
      values: (port, mode) => (port === 1 && mode === 3 ? [10 + machine.now, 7] : []),
    });
    machine.run();
    expect(machine.display).toEqual(['81', '7']);
  });

  it('calibrates reflected light', async () => {
    const ws = workspace([
      start(
        { type: 'ev3_light_calibrate', fields: { WHICH: 'min', PORT: '3' }, inputs: { VALUE: num(10) } },
        { type: 'ev3_light_calibrate', fields: { WHICH: 'max', PORT: '3' }, inputs: { VALUE: num(60) } },
        print({ block: { type: 'ev3_reflected', fields: { PORT: '3' } } }),
        line({ block: { type: 'ev3_reflected', fields: { PORT: '3' } } }),
      ),
    ]);
    expect(vm(ws, { sensor: (port, mode) => (port === 2 && mode === 0 ? 35 : 0) }).display).toEqual(['50']);
    const { program, printed } = await live(ws, (b) => (b.sensorValues['3'][0] = 35));
    await program.done;
    expect(printed).toEqual(['50']);
  });
});

describe('operators and lists', () => {
  const vars = [{ name: 'Wort', id: 'w' }, { name: 'Zahlen', id: 'L', type: LIST_TYPE }];
  const L = { LIST: { id: 'L' } };
  const blocks = () => [
    start(
      { type: 'variables_set', fields: { VAR: { id: 'w' } }, inputs: { VALUE: { block: { type: 'text_join', extraState: { itemCount: 2 }, inputs: { ADD0: text('Ro'), ADD1: text('boter') } } } } },
      line({ block: { type: 'ev3_letter_of', inputs: { INDEX: num(3), TEXT: get('w') } } }, 1),
      line({ block: { type: 'ev3_length_of', inputs: { TEXT: get('w') } } }, 2),
      line({ block: { type: 'ev3_contains', inputs: { TEXT: get('w'), PART: text('BOT') } } }, 3),
      { type: 'ev3_list_add', fields: L, inputs: { ITEM: num(5) } },
      { type: 'ev3_list_add', fields: L, inputs: { ITEM: num(7) } },
      { type: 'ev3_list_insert', fields: L, inputs: { ITEM: num(3), INDEX: num(1) } },
      { type: 'ev3_list_add', fields: L, inputs: { ITEM: num(9) } },
      { type: 'ev3_list_delete', fields: L, inputs: { INDEX: num(2) } },
      { type: 'ev3_list_replace', fields: L, inputs: { INDEX: num(3), ITEM: num(11) } },
      line({ block: { type: 'ev3_list_value', fields: L } }, 4),
      line({ block: { type: 'ev3_list_item', fields: L, inputs: { INDEX: num(2) } } }, 5),
      line({ block: { type: 'ev3_list_index', fields: L, inputs: { ITEM: num(11) } } }, 6),
      line({ block: { type: 'ev3_list_length', fields: L } }, 7),
      line({ block: { type: 'ev3_math', fields: { OP: 'sin' }, inputs: { NUM: get('w') } } }, 8),
    ),
  ];

  it('works on the brick', () => {
    const ws = workspace(blocks().map((b) => JSON.parse(JSON.stringify(b).replace('"NUM":{"block":{"type":"variables_get","fields":{"VAR":{"id":"w"}}}}', '"NUM":{"shadow":{"type":"math_number","fields":{"NUM":30}}}'))), vars);
    expect(vm(ws).display).toEqual(['b', '7', 'wahr', '3 7 11', '7', '3', '3', '0.5']);
  });

  it('works live', async () => {
    const ws = workspace(blocks().map((b) => JSON.parse(JSON.stringify(b).replace('"NUM":{"block":{"type":"variables_get","fields":{"VAR":{"id":"w"}}}}', '"NUM":{"shadow":{"type":"math_number","fields":{"NUM":30}}}'))), vars);
    const { program } = await live(ws);
    await program.done;
    expect(brick.texts).toEqual(['b', '7', 'wahr', '3 7 11', '7', '3', '3', '0.5']);
  });

  it('refuses texts in lists on the brick', () => {
    const ws = workspace([start({ type: 'ev3_list_add', fields: L, inputs: { ITEM: text('Ding') } })], vars);
    expect(() => compileRbf(ws)).toThrow(/nur Zahlen/);
  });
});
