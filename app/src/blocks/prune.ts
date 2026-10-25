import * as Blockly from 'blockly/core';

interface BlockState {
  type: string;
  x?: number;
  y?: number;
  next?: { block?: BlockState; shadow?: BlockState };
  inputs?: Record<string, { block?: BlockState; shadow?: BlockState }>;
}

/**
 * Removes blocks this version no longer has (projects from older versions), keeping
 * the blocks below them. Returns the removed types.
 */
export function dropUnknownBlocks(data: object): string[] {
  const dropped: string[] = [];
  const prune = (block: BlockState | undefined): BlockState | undefined => {
    const at = block && { x: block.x, y: block.y };
    while (block && !Blockly.Blocks[block.type]) {
      dropped.push(block.type);
      block = block.next?.block;
    }
    if (!block) return undefined;
    if (at?.x !== undefined) Object.assign(block, at);
    for (const [name, input] of Object.entries(block.inputs ?? {})) {
      input.block = prune(input.block);
      input.shadow = prune(input.shadow);
      if (!input.block) delete input.block;
      if (!input.shadow) delete input.shadow;
      if (!input.block && !input.shadow) delete block.inputs![name];
    }
    if (block.next) {
      block.next.block = prune(block.next.block);
      if (!block.next.block) delete block.next;
    }
    return block;
  };
  const top = (data as { blocks?: { blocks?: BlockState[] } }).blocks;
  if (top?.blocks) top.blocks = top.blocks.map(prune).filter((b): b is BlockState => !!b);
  return dropped;
}
