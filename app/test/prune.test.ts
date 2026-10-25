// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as Blockly from 'blockly/core';
import 'blockly/blocks';
import { defineBlocks } from '../src/blocks/definitions';
import { dropUnknownBlocks } from '../src/blocks/prune';

defineBlocks();

describe('projects from older versions', () => {
  it('drop unknown blocks and keep the rest', () => {
    const data = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'ev3_start',
            x: 40,
            y: 40,
            next: {
              block: {
                type: 'ev3_old_motor',
                inputs: { SPEED: { shadow: { type: 'math_number', fields: { NUM: 50 } } } },
                next: { block: { type: 'ev3_wait', inputs: { SECONDS: { block: { type: 'ev3_old_sensor' } } } } },
              },
            },
          },
          { type: 'ev3_old_hat', x: 300, y: 40, next: { block: { type: 'ev3_wait' } } },
          { type: 'ev3_old_hat', x: 500, y: 40 },
        ],
      },
    };
    expect(dropUnknownBlocks(data)).toEqual(['ev3_old_motor', 'ev3_old_sensor', 'ev3_old_hat', 'ev3_old_hat']);
    expect(data.blocks.blocks).toEqual([
      { type: 'ev3_start', x: 40, y: 40, next: { block: { type: 'ev3_wait', inputs: {} } } },
      { type: 'ev3_wait', x: 300, y: 40 },
    ]);
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(data, ws);
    expect(ws.getAllBlocks(false).map((b) => b.type).sort()).toEqual(['ev3_start', 'ev3_wait', 'ev3_wait']);
  });
});
