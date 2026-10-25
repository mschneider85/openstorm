// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as Blockly from 'blockly/core';
import 'blockly/blocks';
import * as De from 'blockly/msg/de';
import { defineBlocks } from '../src/blocks/definitions';
import { compile } from '../src/blocks/generator';
import { compileRbf } from '../src/blocks/rbf';
import { SimBrick } from '../src/ev3/simbrick';
import { ProgramRun } from '../src/runtime/runner';
import { addValue, clearValues, valuesAsCsv } from '../src/ui/datalog';

Blockly.setLocale(De as unknown as Record<string, string>);
defineBlocks();

const num = (v: number) => ({ shadow: { type: 'math_number', fields: { NUM: v } } });

function program(): Blockly.Workspace {
  const ws = new Blockly.Workspace();
  const logged = { type: 'ev3_log', fields: { NAME: 'Licht' }, inputs: { VALUE: { block: { type: 'ev3_reflected', fields: { PORT: '3' } } } } };
  const loop = {
    type: 'controls_repeat_ext',
    inputs: { TIMES: num(3), DO: { block: { ...logged, next: { block: { type: 'ev3_wait', inputs: { SECONDS: num(0.02) } } } } } },
  };
  Blockly.serialization.workspaces.load({ blocks: { languageVersion: 0, blocks: [{ type: 'ev3_start', next: { block: loop } }] } }, ws);
  return ws;
}

describe('recording values', () => {
  it('reports each value with the time since the program started', async () => {
    const brick = new SimBrick();
    brick.sensorValues['3'][0] = 42;
    const values: [string, number, number][] = [];
    const run = new ProgramRun(brick, compile(program()).code, {
      onStep: () => {},
      onLog: (name, t, v) => values.push([name, t, v]),
    });
    await run.done;
    brick.close();
    expect(values.map(([name, , v]) => [name, v])).toEqual([['Licht', 42], ['Licht', 42], ['Licht', 42]]);
    expect(values[2][1]).toBeGreaterThan(values[0][1]);
  });

  it('is only a warning when the program goes onto the brick', () => {
    expect(compileRbf(program()).warnings.join()).toMatch(/nicht aufgezeichnet/);
  });

  it('saves a table with one column per series', () => {
    clearValues();
    addValue('Licht', 0, 12.5);
    addValue('Abstand', 0, 30);
    addValue('Licht', 0.5, 14);
    expect(valuesAsCsv()).toBe('"Zeit (s)";"Licht";"Abstand"\r\n0;12,5;30\r\n0,5;14;\r\n');
    for (let i = 0; i < 6; i++) expect(addValue(`Reihe ${i}`, 1, i)).toBe(true);
    expect(addValue('zu viel', 1, 1)).toBe(false);
  });
});
