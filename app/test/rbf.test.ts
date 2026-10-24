// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as Blockly from 'blockly/core';
import 'blockly/blocks';
import * as De from 'blockly/msg/de';
import { defineBlocks } from '../src/blocks/definitions';
import { RbfError, compileRbf } from '../src/blocks/rbf';
import { CodeBuffer, lc, lcf, lcs } from '../src/ev3/assembler';
import { Ev3Vm, type FakeBrick } from './ev3vm';

Blockly.setLocale(De as unknown as Record<string, string>);
defineBlocks();

const num = (v: number) => ({ shadow: { type: 'math_number', fields: { NUM: v } } });
const text = (t: string) => ({ shadow: { type: 'text', fields: { TEXT: t } } });
const get = (id: string) => ({ block: { type: 'variables_get', fields: { VAR: { id } } } });
const chain = (...blocks: object[]): object =>
  blocks.reduceRight<object | undefined>((next, b) => ({ ...b, ...(next ? { next: { block: next } } : {}) }), undefined)!;
const start = (...blocks: object[]) => chain({ type: 'ev3_start' }, ...blocks);
const show = (value: object, line = 1) => ({ type: 'ev3_display_text', inputs: { TEXT: value, LINE: num(line) } });

function workspace(blocks: object[], variables: { name: string; id: string }[] = []): Blockly.Workspace {
  const ws = new Blockly.Workspace();
  Blockly.serialization.workspaces.load({ variables, blocks: { languageVersion: 0, blocks } }, ws);
  return ws;
}

function run(ws: Blockly.Workspace, brick: FakeBrick = {}): Ev3Vm {
  const vm = new Ev3Vm(compileRbf(ws).image, brick);
  vm.run();
  return vm;
}

describe('assembler', () => {
  it('encodes constants like the EV3 assembler', () => {
    expect(lc(5)).toEqual([0x05]);
    expect(lc(-1)).toEqual([0x3f]);
    expect(lc(100)).toEqual([0x81, 100]);
    expect(lc(1000)).toEqual([0x82, 0xe8, 0x03]);
    expect(lcf(0)).toEqual([0]);
    expect(lcf(1)).toEqual([0x83, 0x00, 0x00, 0x80, 0x3f]);
    expect(lcs('Hä')).toEqual([0x84, 0x48, 0x61, 0x65, 0]);
  });

  it('resolves jumps relative to the end of the instruction', () => {
    const c = new CodeBuffer();
    const end = c.label();
    c.jump(0x40, end); // JR: 1 + 3 bytes
    c.op(0x01); // NOP
    c.place(end);
    expect(c.finish()).toEqual([0x40, 0x82, 0x01, 0x00, 0x01]);
  });
});

describe('EV3 programs (.rbf)', () => {
  it('drives a motor and shows its position', () => {
    const vm = run(
      workspace([
        start(
          { type: 'ev3_motor_for', fields: { PORT: 'B', UNIT: 'rotations', BRAKE: 'TRUE' }, inputs: { SPEED: num(75), AMOUNT: num(2) } },
          show({ block: { type: 'ev3_motor_degrees', fields: { PORT: 'B', MODE: 'degrees' } } }, 2),
        ),
      ]),
      { sensor: (port, mode) => (port === 17 && mode === 0 ? 720 : 0) },
    );
    expect(vm.log).toEqual(['clear', 'run B 75 720deg brake', 'text 2 720']);
  });

  it('turns a negative amount into driving backwards', () => {
    const vm = run(
      workspace([
        start(
          { type: 'ev3_motor_for', fields: { PORT: 'BC', UNIT: 'degrees', BRAKE: 'FALSE' }, inputs: { SPEED: num(50), AMOUNT: num(-90) } },
          { type: 'ev3_steer_for', fields: { PORT: 'BC', UNIT: 'seconds', BRAKE: 'TRUE' }, inputs: { STEERING: num(-30), SPEED: num(150), AMOUNT: num(0.5) } },
          { type: 'ev3_steer_on', fields: { PORT: 'BC' }, inputs: { STEERING: num(0), SPEED: num(40) } },
          { type: 'ev3_motor_off', fields: { PORT: 'BC', BRAKE: 'TRUE' } },
        ),
      ]),
    );
    expect(vm.log).toEqual(['run BC -50 90deg', 'sync BC 100 turn -60 500ms brake', 'sync BC 40 turn 0 0deg brake', 'stop BC brake']);
  });

  it('computes amounts at run time, including the sign', () => {
    const vm = run(
      workspace(
        [
          start(
            { type: 'variables_set', fields: { VAR: { id: 'n' } }, inputs: { VALUE: num(-0.5) } },
            { type: 'ev3_motor_for', fields: { PORT: 'A', UNIT: 'rotations', BRAKE: 'TRUE' }, inputs: { SPEED: num(30), AMOUNT: get('n') } },
          ),
        ],
        [{ name: 'n', id: 'n' }],
      ),
    );
    expect(vm.log).toEqual(['run A -30 180deg brake']);
  });

  it('counts with a loop, a variable and joined text', () => {
    const vm = run(
      workspace(
        [
          start(
            {
              type: 'controls_repeat_ext',
              inputs: {
                TIMES: num(3),
                DO: {
                  block: chain(
                    { type: 'math_change', fields: { VAR: { id: 'i' } }, inputs: { DELTA: num(1) } },
                    show({ block: { type: 'text_join', extraState: { itemCount: 2 }, inputs: { ADD0: text('Runde '), ADD1: get('i') } } }),
                  ),
                },
              },
            },
            show({ block: { type: 'math_arithmetic', fields: { OP: 'DIVIDE' }, inputs: { A: get('i'), B: num(4) } } }, 2),
          ),
        ],
        [{ name: 'i', id: 'i' }],
      ),
    );
    expect(vm.log.filter((l) => l.startsWith('text'))).toEqual(['text 1 Runde 1', 'text 1 Runde 2', 'text 1 Runde 3', 'text 2 0.75']);
  });

  it('waits for the touch sensor and decides with if/else', () => {
    const ws = workspace([
        start(
          { type: 'ev3_wait_until', inputs: { COND: { block: { type: 'ev3_touch', fields: { PORT: '1' } } } } },
          {
            type: 'controls_if',
            extraState: { hasElse: true },
            inputs: {
              IF0: { block: { type: 'ev3_color_is', fields: { PORT: '3', COLOR: '5' } } },
              DO0: { block: { type: 'ev3_led', fields: { PATTERN: 'red' } } },
              ELSE: { block: { type: 'ev3_led', fields: { PATTERN: 'green' } } },
            },
          },
          { type: 'ev3_wait', inputs: { SECONDS: num(0.2) } },
        ),
      ]);
    const vm: Ev3Vm = new Ev3Vm(compileRbf(ws).image, {
      sensor: (port, mode) => {
        if (port === 0) return vm.now >= 300 ? 1 : 0; // pressed after 0.3 s
        if (port === 2 && mode === 2) return 4.6; // rounds to 5 = red
        return 0;
      },
    });
    vm.run();
    expect(vm.log).toEqual(['led 2']);
    expect(vm.now).toBeGreaterThanOrEqual(500);
  });

  it('runs start blocks in parallel', () => {
    const vm = run(
      workspace([
        start({ type: 'ev3_tone', fields: { WAIT: 'TRUE' }, inputs: { FREQ: num(440), SECONDS: num(1), VOLUME: num(80) } }, { type: 'ev3_led', fields: { PATTERN: 'orange' } }),
        start({ type: 'ev3_wait', inputs: { SECONDS: num(0.1) } }, { type: 'ev3_led', fields: { PATTERN: 'green' } }),
      ]),
    );
    // The second thread finishes its wait while the first one still plays the tone.
    expect(vm.log).toEqual(['tone 440 1000 80', 'led 1', 'led 3']);
  });

  it('inlines own blocks with parameters and return values', () => {
    const vm = run(
      workspace(
        [
          {
            type: 'procedures_defreturn',
            extraState: { params: [{ name: 'x', id: 'x' }] },
            fields: { NAME: 'doppelt' },
            inputs: {
              STACK: {
                block: {
                  type: 'procedures_ifreturn',
                  extraState: '<mutation value="1"></mutation>',
                  inputs: {
                    CONDITION: { block: { type: 'logic_compare', fields: { OP: 'LT' }, inputs: { A: get('x'), B: num(0) } } },
                    VALUE: num(0),
                  },
                },
              },
              RETURN: { block: { type: 'math_arithmetic', fields: { OP: 'MULTIPLY' }, inputs: { A: get('x'), B: num(2) } } },
            },
          },
          start(
            show({ block: { type: 'procedures_callreturn', extraState: { name: 'doppelt', params: ['x'] }, inputs: { ARG0: num(4) } } }),
            show({ block: { type: 'procedures_callreturn', extraState: { name: 'doppelt', params: ['x'] }, inputs: { ARG0: num(-3) } } }, 2),
          ),
        ],
        [{ name: 'x', id: 'x' }],
      ),
    );
    expect(vm.display.slice(0, 2)).toEqual(['8', '0']);
  });

  it('shows yes/no and numbers as text', () => {
    const vm = run(
      workspace([
        start(
          show({ block: { type: 'ev3_button', fields: { BUTTON: 'enter' } } }),
          show({ block: { type: 'math_arithmetic', fields: { OP: 'DIVIDE' }, inputs: { A: { block: { type: 'ev3_timer' } }, B: num(3) } } }, 2),
        ),
      ]),
      { button: () => true },
    );
    expect(vm.display.slice(0, 2)).toEqual(['wahr', '0']);
  });

  it('explains what cannot be compiled', () => {
    expect(() => compileRbf(workspace([]))).toThrow(RbfError);
    const ws = workspace(
      [
        start(
          { type: 'variables_set', fields: { VAR: { id: 'v' } }, inputs: { VALUE: num(1) } },
          { type: 'variables_set', fields: { VAR: { id: 'v' } }, inputs: { VALUE: text('eins') } },
        ),
      ],
      [{ name: 'v', id: 'v' }],
    );
    expect(() => compileRbf(ws)).toThrow(/feste Art/);
    const warnings = compileRbf(workspace([start({ type: 'ev3_print', inputs: { VALUE: text('x') } })])).warnings;
    expect(warnings[0]).toMatch(/keine Wirkung/);
  });
});
