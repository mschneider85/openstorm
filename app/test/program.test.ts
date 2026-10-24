// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly/core';
import 'blockly/blocks';
import * as De from 'blockly/msg/de';
import { defineBlocks } from '../src/blocks/definitions';
import { compile } from '../src/blocks/generator';
import { ProgramRun } from '../src/runtime/runner';
import { SimBrick } from '../src/ev3/simbrick';

Blockly.setLocale(De as unknown as Record<string, string>);
defineBlocks();

const num = (v: number) => ({ shadow: { type: 'math_number', fields: { NUM: v } } });
const chain = (...blocks: object[]): object =>
  blocks.reduceRight<object | undefined>(
    (next, b) => ({ ...b, ...(next ? { next: { block: next } } : {}) }),
    undefined,
  )!;

function workspace(...topBlocks: object[]): Blockly.Workspace {
  const ws = new Blockly.Workspace();
  Blockly.serialization.workspaces.load({ blocks: { languageVersion: 0, blocks: topBlocks } }, ws);
  return ws;
}

let brick: SimBrick;
afterEach(() => brick?.close());

async function run(ws: Blockly.Workspace, steps: string[] = [], printed: string[] = []) {
  brick = new SimBrick();
  const { code } = compile(ws);
  const program = new ProgramRun(brick, code, {
    onStep: (id) => steps.push(id),
    onPrint: (t) => printed.push(t),
  });
  return { program, code };
}

describe('block programs', () => {
  it('drives a motor for one rotation and reports its position', async () => {
    const ws = workspace(
      chain(
        { type: 'ev3_start' },
        { type: 'ev3_motor_reset', fields: { PORT: 'B' } },
        { type: 'ev3_motor_for', fields: { PORT: 'B', UNIT: 'rotations', BRAKE: 'TRUE' }, inputs: { SPEED: num(100), AMOUNT: num(1) } },
        { type: 'ev3_print', inputs: { VALUE: { block: { type: 'ev3_motor_degrees', fields: { PORT: 'B', MODE: 'degrees' } } } } },
      ),
    );
    const printed: string[] = [];
    const { program } = await run(ws, [], printed);
    await program.done;
    expect(printed).toEqual(['360']);
  });

  it('runs several start blocks in parallel and shares variables', async () => {
    const ws = new Blockly.Workspace();
    const v = { getId: () => 'var-zahl' };
    Blockly.serialization.workspaces.load(
      {
        variables: [{ name: 'zahl', id: v.getId() }],
        blocks: {
          languageVersion: 0,
          blocks: [
            chain(
              { type: 'ev3_start' },
              { type: 'variables_set', fields: { VAR: { id: v.getId() } }, inputs: { VALUE: num(7) } },
            ),
            chain(
              { type: 'ev3_start' },
              { type: 'ev3_wait', inputs: { SECONDS: num(0.05) } },
              { type: 'ev3_print', inputs: { VALUE: { block: { type: 'variables_get', fields: { VAR: { id: v.getId() } } } } } },
            ),
          ],
        },
      },
      ws,
    );
    const printed: string[] = [];
    const { program } = await run(ws, [], printed);
    await program.done;
    expect(printed).toEqual(['7']);
  });

  it('stops an endless loop and coasts the motors', async () => {
    const ws = workspace(
      chain(
        { type: 'ev3_start' },
        { type: 'ev3_motor_on', fields: { PORT: 'C' }, inputs: { SPEED: num(30) } },
        { type: 'ev3_forever', inputs: { DO: { block: { type: 'ev3_wait', inputs: { SECONDS: num(0.01) } } } } },
      ),
    );
    const { program } = await run(ws);
    await new Promise((r) => setTimeout(r, 100));
    expect(brick.motorSpeed('C')).toBe(30);
    await program.stop();
    expect(brick.motorSpeed('C')).toBe(0);
  });

  it('waits for a sensor condition', async () => {
    const ws = workspace(
      chain(
        { type: 'ev3_start' },
        { type: 'ev3_wait_until', inputs: { COND: { block: { type: 'ev3_touch', fields: { PORT: '1' } } } } },
        { type: 'ev3_print', inputs: { VALUE: { shadow: { type: 'text', fields: { TEXT: 'gedrückt' } } } } },
      ),
    );
    const printed: string[] = [];
    const { program } = await run(ws, [], printed);
    await new Promise((r) => setTimeout(r, 60));
    expect(printed).toEqual([]);
    brick.setSensorValue('1', 1);
    await program.done;
    expect(printed).toEqual(['gedrückt']);
  });

  it('supports user-defined blocks with awaits inside', async () => {
    const ws = workspace(
      {
        type: 'procedures_defnoreturn',
        fields: { NAME: 'piepen' },
        inputs: { STACK: { block: { type: 'ev3_print', inputs: { VALUE: { shadow: { type: 'text', fields: { TEXT: 'piep' } } } } } } },
      },
      chain(
        { type: 'ev3_start' },
        { type: 'procedures_callnoreturn', extraState: { name: 'piepen' } },
        { type: 'procedures_callnoreturn', extraState: { name: 'piepen' } },
      ),
    );
    const steps: string[] = [];
    const printed: string[] = [];
    const { program, code } = await run(ws, steps, printed);
    await program.done;
    expect(code).toContain('async function piepen');
    expect(printed).toEqual(['piep', 'piep']);
    expect(steps.length).toBeGreaterThan(3);
  });

  it('ignores loose blocks without a start block', async () => {
    const ws = workspace({ type: 'ev3_print', inputs: { VALUE: { shadow: { type: 'text', fields: { TEXT: 'x' } } } } });
    expect(compile(ws).threads).toBe(0);
  });
});
