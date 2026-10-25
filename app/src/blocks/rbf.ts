import * as Blockly from 'blockly/core';
import { CodeBuffer, buildImage, gv, lc, lcf, lcs, lv, type Label, type Operand } from '../ev3/assembler';
import { inputPortNumber, type MotorPort, type Port } from '../ev3/brick';
import {
  BUTTONS, CURRENT_SLOT, LED_PATTERNS, array, inputDevice, math, op, sound, strings, uiButton, uiDraw, uiWrite,
  type ButtonName, type LedPattern,
} from '../ev3/bytecodes';
import { portMask } from '../ev3/command';
import { INFRARED_CM_PER_PERCENT, TYPE_INFRARED } from '../ev3/devices';
import { LINES, LINE_HEIGHT, SCREEN_HEIGHT, SCREEN_WIDTH, emitDraw, imageOps } from '../ev3/display';
import { soundPath } from '../ev3/sounds';
import { ENDLESS_TONE_MS, formatValue } from '../runtime/runner';
import { HAT_TYPES, isEdgeHat } from './generator';

/**
 * Compiles a workspace into an EV3 program (.rbf) that runs on the brick by
 * itself. Object 1 sets everything up and starts one VMTHREAD per event block;
 * "Meine Blöcke" are inlined.
 *
 * Values are floats (DATAF), booleans DATA8 and texts fixed-size string buffers.
 * Lists are float arrays. Everything is 4-byte aligned, as the firmware validator
 * requires for 32 bit variables.
 */

type Ty = 'num' | 'bool' | 'str';

/** A value: where it is (or its encoded constant) and, for constants, the value itself. */
interface Val {
  ty: Ty;
  op: Operand;
  k?: number | boolean | string;
}

export class RbfError extends Error {
  constructor(message: string, readonly blockId?: string) {
    super(message);
  }
}

/** Bytes per text value; joined texts must stay below this. */
const STR = 256;
const LAYER = lc(0);
/** opREAD8/opWRITE8 take a DATA8 index, so only the first 127 characters of a text are reachable. */
const MAX_INDEX = 126;

/** 8 bit integer opcodes, used for text positions. */
const int8 = {
  ADD: 0x10,
  SUB: 0x14,
  CP_LT: 0x44,
  CP_GT: 0x48,
  MOVE16_8: 0x34,
} as const;

const align4 = (n: number) => (n + 3) & ~3;

class Memory {
  size = 0;
  alloc(bytes: number): number {
    const offset = align4(this.size);
    this.size = offset + bytes;
    return offset;
  }
}

type HatKind = 'start' | 'when' | 'message';

class Thread {
  code = new CodeBuffer();
  locals = new Memory();
  loops: { exit: Label; next: Label }[] = [];
  /** Parameters of the "Eigener Block" being inlined, by variable id. */
  scope: Map<string, Val> | null = null;
  returns: { label: Label; result?: Val }[] = [];
  calls: string[] = [];
  /** Where "stoppe diesen Ablauf" jumps to. */
  end: Label = this.code.label();

  constructor(
    readonly id: number,
    readonly kind: HatKind,
  ) {}
}

const num = (k: number): Val => ({ ty: 'num', op: lcf(k), k });
const bool = (k: boolean): Val => ({ ty: 'bool', op: lc(k ? 1 : 0), k });
const str = (k: string): Val => ({ ty: 'str', op: lcs(k), k });
const isNum = (v: Val): v is Val & { k: number } => typeof v.k === 'number';
const isStr = (v: Val): v is Val & { k: string } => typeof v.k === 'string';
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const NUMERIC = /^\s*-?\d+([.,]\d+)?\s*$/;

export interface RbfResult {
  image: Uint8Array;
  warnings: string[];
  /** Sounds the program plays; they have to be on the brick (see sounds.ts). */
  sounds: string[];
}

export function compileRbf(workspace: Blockly.Workspace): RbfResult {
  return new Compiler(workspace).compile();
}

class Compiler {
  private globals = new Memory();
  private variables = new Map<string, Val>();
  private varTypes = new Map<string, Ty>();
  private warnings = new Set<string>();
  private sounds = new Set<string>();
  /** Global state with its start value, set up by object 1. */
  private state = new Map<string, { op: Operand; ty: 'num' | 'bool'; init: number }>();
  private lists = new Map<string, { handle: Operand; length: Operand }>();
  private hats: { block: Blockly.Block; id: number; kind: HatKind }[] = [];
  private receivers = new Map<string, number[]>();
  private timerStart = this.globals.alloc(4);
  private t = new Thread(0, 'start');

  constructor(private workspace: Blockly.Workspace) {}

  compile(): RbfResult {
    const tops = this.workspace.getTopBlocks(true).filter((b) => HAT_TYPES.includes(b.type) && b.isEnabled());
    if (tops.length === 0) throw new RbfError('Kein Ereignisblock wie „Wenn Programm startet“ gefunden.');
    this.inferVariableTypes();
    this.checkLists();

    this.hats = tops.map((block, i) => ({
      block,
      id: i + 2,
      kind: block.type === 'ev3_start' ? 'start' : block.type === 'ev3_when_message' ? 'message' : 'when',
    }));
    for (const hat of this.hats) {
      if (hat.kind !== 'message') continue;
      const name = hat.block.getFieldValue('MESSAGE') as string;
      this.receivers.set(name, [...(this.receivers.get(name) ?? []), hat.id]);
    }

    const objects = this.hats.map((hat) => this.hatObject(hat));
    return {
      image: buildImage(align4(this.globals.size), [this.initObject(), ...objects]),
      warnings: [...this.warnings],
      sounds: [...this.sounds],
    };
  }

  /** Object 1: start values, then start all stacks. */
  private initObject(): { code: CodeBuffer; localBytes: number } {
    this.t = new Thread(1, 'start');
    const c = this.t.code;
    c.op(op.TIMER_READ, gv(this.timerStart));
    for (const s of this.state.values()) {
      if (s.ty === 'num') c.op(op.MOVEF_F, lcf(s.init), s.op);
      else c.op(op.MOVE8_8, lc(s.init), s.op);
    }
    for (const list of this.lists.values()) {
      c.op([op.ARRAY, array.CREATEF], lc(8), list.handle);
      c.op(op.MOVEF_F, lcf(0), list.length);
    }
    const drawing = /^ev3_(display|image|write|draw)/;
    if (this.workspace.getAllBlocks(false).some((b) => drawing.test(b.type) && b.isEnabled())) this.clearDisplay();
    for (const hat of this.hats) if (hat.kind !== 'message') c.op(op.OBJECT_START, lc(hat.id));
    c.op(op.OBJECT_END);
    return { code: c, localBytes: align4(this.t.locals.size) };
  }

  private hatObject(hat: { block: Blockly.Block; id: number; kind: HatKind }): { code: CodeBuffer; localBytes: number } {
    this.t = new Thread(hat.id, hat.kind);
    const c = this.t.code;
    const body = () => this.statements(hat.block.getNextBlock());
    if (hat.kind === 'start') {
      body();
      c.place(this.t.end);
    } else if (hat.kind === 'message') {
      body();
      c.place(this.t.end);
      c.op(op.MOVE8_8, lc(0), this.busy(hat.id));
    } else {
      // Runs each time the condition becomes true. The phase survives "stoppe andere
      // Abläufe", which restarts this object: it then waits for the condition to end.
      const phase = this.global(`phase${hat.id}`, 'bool', 0);
      const top = c.label();
      const rest = c.label();
      c.jump(op.JR_TRUE, rest, phase);
      c.place(top);
      this.waitUntil(() => this.hatCondition(hat.block));
      c.op(op.MOVE8_8, lc(1), phase);
      body();
      c.place(this.t.end);
      c.place(rest);
      // A change or release is true once per event; asking again would swallow the next one.
      if (!isEdgeHat(hat.block)) this.waitUntil(() => this.not(this.hatCondition(hat.block)));
      c.op(op.MOVE8_8, lc(0), phase);
      c.jump(op.JR, top);
    }
    c.op(op.OBJECT_END);
    return { code: c, localBytes: align4(this.t.locals.size) };
  }

  // --- Types ------------------------------------------------------------------

  private inferVariableTypes(): void {
    const sets = this.workspace.getAllBlocks(false).filter((b) => b.type === 'variables_set' || b.type === 'math_change');
    // Types can depend on other variables, so repeat until nothing changes.
    for (let round = 0; round < 5; round++) {
      for (const block of sets) {
        const id = block.getFieldValue('VAR');
        const ty = block.type === 'math_change' ? 'num' : this.staticType(block.getInputTargetBlock('VALUE'));
        const known = this.varTypes.get(id);
        if (known && known !== ty) {
          if (known === 'str' || ty === 'str') {
            const name = this.workspace.getVariableMap().getVariableById(id)?.getName() ?? id;
            throw new RbfError(
              `Die Variable „${name}“ enthält mal Text, mal eine Zahl. Auf dem EV3 braucht jede Variable eine feste Art.`,
              block.id,
            );
          }
          this.varTypes.set(id, 'num'); // numbers and yes/no mix: store as number
        } else {
          this.varTypes.set(id, ty);
        }
      }
    }
  }

  /** Lists on the brick hold numbers only. */
  private checkLists(): void {
    for (const block of this.workspace.getAllBlocks(false)) {
      if (!block.type.startsWith('ev3_list_') || !block.getInput('ITEM') || !block.isEnabled()) continue;
      const item = block.getInputTargetBlock('ITEM');
      if (this.staticType(item) !== 'str') continue;
      if (item?.type === 'text' && NUMERIC.test(item.getFieldValue('TEXT'))) continue;
      throw new RbfError('Listen können auf dem EV3 nur Zahlen enthalten.', block.id);
    }
  }

  private staticType(block: Blockly.Block | null, seen = new Set<string>()): Ty {
    if (!block) return 'num';
    if (block.type === 'variables_get') return this.varTypes.get(block.getFieldValue('VAR')) ?? 'num';
    if (block.type === 'procedures_callreturn') {
      const def = this.definition(block);
      if (!def || seen.has(def.id)) return 'num';
      seen.add(def.id);
      return this.staticType(def.getInputTargetBlock('RETURN'), seen);
    }
    const check = block.outputConnection?.getCheck() ?? [];
    if (check.includes('String')) return 'str';
    if (check.includes('Boolean')) return 'bool';
    return 'num';
  }

  // --- Memory and conversions ---------------------------------------------------

  private tmp(ty: Ty | 'int'): Operand {
    return lv(this.t.locals.alloc(ty === 'str' ? STR : 4));
  }

  /** A global with a start value, set by object 1. */
  private global(key: string, ty: 'num' | 'bool', init: number): Operand {
    let s = this.state.get(key);
    if (!s) {
      s = { op: gv(this.globals.alloc(4)), ty, init };
      this.state.set(key, s);
    }
    return s.op;
  }

  private motorSpeed = (p: MotorPort) => this.global(`speed${p}`, 'num', 75);
  private motorHold = (p: MotorPort) => this.global(`hold${p}`, 'bool', 1);
  private move = {
    mask: () => this.global('moveMask', 'bool', portMask(['B', 'C'])),
    /** -1 when the left motor has the higher port (the firmware's turn ratio refers to port order). */
    sign: () => this.global('moveSign', 'num', 1),
    speed: () => this.global('moveSpeed', 'num', 50),
    hold: () => this.global('moveHold', 'bool', 1),
    cm: () => this.global('moveCm', 'num', 17.6),
  };
  private volume = () => this.global('volume', 'num', 100);
  private busy = (id: number) => this.global(`busy${id}`, 'bool', 0);

  private variable(block: Blockly.Block): Val {
    const id = block.getFieldValue('VAR');
    const param = this.t.scope?.get(id);
    if (param) return param;
    let v = this.variables.get(id);
    if (!v) {
      const ty = this.varTypes.get(id) ?? 'num';
      v = { ty, op: gv(this.globals.alloc(ty === 'str' ? STR : 4)) };
      this.variables.set(id, v);
    }
    return v;
  }

  private list(block: Blockly.Block): { handle: Operand; length: Operand } {
    const id = block.getFieldValue('LIST');
    let l = this.lists.get(id);
    if (!l) {
      l = { handle: gv(this.globals.alloc(4)), length: gv(this.globals.alloc(4)) };
      this.lists.set(id, l);
    }
    return l;
  }

  private assign(dst: Val, src: Val): void {
    const c = this.t.code;
    if (dst.ty === 'num') c.op(op.MOVEF_F, src.op, dst.op);
    else if (dst.ty === 'bool') c.op(op.MOVE8_8, src.op, dst.op);
    else c.op([op.STRINGS, strings.DUPLICATE], src.op, dst.op);
  }

  private convert(v: Val, ty: Ty, block: Blockly.Block): Val {
    if (ty === 'num') return this.toNum(v, block);
    if (ty === 'bool') return this.toBool(v, block);
    return this.toStr(v);
  }

  private toNum(v: Val, block: Blockly.Block): Val {
    if (v.ty === 'num') return v;
    if (v.ty === 'str') {
      if (isStr(v) && NUMERIC.test(v.k)) return num(Number(v.k.replace(',', '.')));
      throw new RbfError('Hier wird eine Zahl gebraucht, nicht ein Text.', block.id);
    }
    if (typeof v.k === 'boolean') return num(v.k ? 1 : 0);
    const r = this.tmp('num');
    this.t.code.op(op.MOVE8_F, v.op, r);
    return { ty: 'num', op: r };
  }

  private toBool(v: Val, block: Blockly.Block): Val {
    if (v.ty === 'bool') return v;
    if (v.ty === 'str') throw new RbfError('Hier wird wahr/falsch gebraucht, nicht ein Text.', block.id);
    if (isNum(v)) return bool(v.k !== 0);
    const r = this.tmp('bool');
    this.t.code.op(op.CP_NEQF, v.op, lcf(0), r);
    return { ty: 'bool', op: r };
  }

  /** Numbers are shown with at most two decimals, like in the app. */
  private toStr(v: Val): Val {
    if (v.ty === 'str') return v;
    if (v.k !== undefined) return str(formatValue(v.k));
    const c = this.t.code;
    const r = this.tmp('str');
    if (v.ty === 'bool') {
      const no = c.label();
      const end = c.label();
      c.jump(op.JR_FALSE, no, v.op);
      c.op([op.STRINGS, strings.DUPLICATE], lcs('wahr'), r);
      c.jump(op.JR, end);
      c.place(no);
      c.op([op.STRINGS, strings.DUPLICATE], lcs('falsch'), r);
      c.place(end);
    } else {
      const rounded = this.tmp('num');
      c.op(op.MULF, v.op, lcf(100), rounded);
      c.op([op.MATH, math.ROUND], rounded, rounded);
      c.op(op.DIVF, rounded, lcf(100), rounded);
      c.op([op.STRINGS, strings.VALUE_FORMATTED], rounded, lcs('%g'), lc(64), r);
    }
    return { ty: 'str', op: r };
  }

  /** Limits a number to min..max (for speeds, volumes, ...). */
  private clampNum(v: Val, min: number, max: number): Val {
    if (isNum(v)) return num(clamp(v.k, min, max));
    const c = this.t.code;
    const r = this.tmp('num');
    const flag = this.tmp('bool');
    c.op(op.CP_LTF, v.op, lcf(min), flag);
    c.op(op.SELECTF, flag, lcf(min), v.op, r);
    c.op(op.CP_GTF, r, lcf(max), flag);
    c.op(op.SELECTF, flag, lcf(max), r, r);
    return { ty: 'num', op: r };
  }

  /** Integer parameter (DATA8/16/32) from a number; the VM truncates. */
  private int(v: Val, bits: 8 | 16 | 32): Operand {
    if (isNum(v)) return lc(Math.trunc(v.k));
    const r = this.tmp('int');
    this.t.code.op(bits === 8 ? op.MOVEF_8 : bits === 16 ? op.MOVEF_16 : op.MOVEF_32, v.op, r);
    return r;
  }

  /** A rounded integer parameter, e.g. for pixel coordinates. */
  private roundInt(v: Val, bits: 8 | 16 | 32): Operand {
    return this.int(this.mathOp(math.ROUND, v, Math.round), bits);
  }

  private arith(code: number | number[], a: Val, b: Val, fold: (x: number, y: number) => number): Val {
    if (isNum(a) && isNum(b)) return num(fold(a.k, b.k));
    const r = this.tmp('num');
    this.t.code.op(code, a.op, b.op, r);
    return { ty: 'num', op: r };
  }

  private add = (a: Val, b: Val) => this.arith(op.ADDF, a, b, (x, y) => x + y);
  private sub = (a: Val, b: Val) => this.arith(op.SUBF, a, b, (x, y) => x - y);
  private mul = (a: Val, b: Val) => this.arith(op.MULF, a, b, (x, y) => x * y);
  private div = (a: Val, b: Val) => this.arith(op.DIVF, a, b, (x, y) => x / y);

  private mathOp(sub: number, a: Val, fold: (x: number) => number): Val {
    if (isNum(a)) return num(fold(a.k));
    const r = this.tmp('num');
    this.t.code.op([op.MATH, sub], a.op, r);
    return { ty: 'num', op: r };
  }

  /** Copies a value into a fresh local, so it can be changed in place. */
  private copy(v: Val): Val {
    const r = { ty: v.ty, op: this.tmp(v.ty) };
    this.assign(r, v);
    return r;
  }

  private cmp(code: number, a: Val, b: Val): Val {
    const r = this.tmp('bool');
    this.t.code.op(code, a.op, b.op, r);
    return { ty: 'bool', op: r };
  }

  private not(v: Val): Val {
    if (typeof v.k === 'boolean') return bool(!v.k);
    const r = this.tmp('bool');
    this.t.code.op(op.CP_EQ8, v.op, lc(0), r);
    return { ty: 'bool', op: r };
  }

  private and(a: Val, b: Val): Val {
    const r = this.tmp('bool');
    this.t.code.op(op.AND8, a.op, b.op, r);
    return { ty: 'bool', op: r };
  }

  /** "<", "=" or ">" as in the "ist …?" blocks; "=" compares whole numbers. */
  private compareOp(value: Val, cmp: string, target: Val): Val {
    if (cmp === 'LT') return this.cmp(op.CP_LTF, value, target);
    if (cmp === 'GT') return this.cmp(op.CP_GTF, value, target);
    const round = (v: Val) => this.mathOp(math.ROUND, v, Math.round);
    return this.cmp(op.CP_EQF, round(value), round(target));
  }

  private numVal = (operand: Operand): Val => ({ ty: 'num', op: operand });

  // --- Expressions --------------------------------------------------------------

  private input(block: Blockly.Block, name: string, fallback: Val): Val {
    const target = block.getInputTargetBlock(name);
    return target && target.isEnabled() ? this.expr(target) : fallback;
  }

  private numIn(block: Blockly.Block, name: string, fallback = 0): Val {
    return this.toNum(this.input(block, name, num(fallback)), block);
  }

  private boolIn(block: Blockly.Block, name: string): Val {
    return this.toBool(this.input(block, name, bool(false)), block);
  }

  private strIn(block: Blockly.Block, name: string): Val {
    return this.toStr(this.input(block, name, str('')));
  }

  private expr(block: Blockly.Block): Val {
    const c = this.t.code;
    const f = (name: string) => block.getFieldValue(name);
    const port = () => f('PORT') as string;
    switch (block.type) {
      case 'math_number':
        return num(Number(f('NUM')) || 0);
      case 'text':
        return str(String(f('TEXT') ?? ''));
      case 'logic_boolean':
        return bool(f('BOOL') === 'TRUE');
      case 'variables_get':
        return this.variable(block);
      case 'procedures_callreturn':
        return this.inline(block, true)!;

      case 'math_arithmetic': {
        const a = this.numIn(block, 'A');
        const b = this.numIn(block, 'B');
        switch (f('OP')) {
          case 'ADD': return this.add(a, b);
          case 'MINUS': return this.sub(a, b);
          case 'MULTIPLY': return this.mul(a, b);
          case 'DIVIDE': return this.div(a, b);
          default: return this.arith([op.MATH, math.POW], a, b, Math.pow);
        }
      }
      case 'math_modulo':
        return this.arith([op.MATH, math.MOD], this.numIn(block, 'DIVIDEND'), this.numIn(block, 'DIVISOR'), (x, y) => x % y);
      case 'math_single': {
        const x = this.numIn(block, 'NUM');
        switch (f('OP')) {
          case 'ROOT': return this.mathOp(math.SQRT, x, Math.sqrt);
          case 'ABS': return this.mathOp(math.ABS, x, Math.abs);
          case 'NEG': return this.mathOp(math.NEGATE, x, (v) => -v);
          case 'LN': return this.mathOp(math.LN, x, Math.log);
          case 'LOG10': return this.mathOp(math.LOG, x, Math.log10);
          case 'EXP': return this.mathOp(math.EXP, x, Math.exp);
          default: return this.arith([op.MATH, math.POW], num(10), x, Math.pow);
        }
      }
      case 'ev3_math': {
        const x = this.numIn(block, 'NUM');
        const fromDeg = (fn: (r: number) => number) => (v: number) => fn((v * Math.PI) / 180);
        const toDeg = (fn: (v: number) => number) => (v: number) => (fn(v) * 180) / Math.PI;
        switch (f('OP')) {
          case 'abs': return this.mathOp(math.ABS, x, Math.abs);
          case 'floor': return this.mathOp(math.FLOOR, x, Math.floor);
          case 'ceiling': return this.mathOp(math.CEIL, x, Math.ceil);
          case 'sqrt': return this.mathOp(math.SQRT, x, Math.sqrt);
          case 'sin': return this.mathOp(math.SIN, x, fromDeg(Math.sin));
          case 'cos': return this.mathOp(math.COS, x, fromDeg(Math.cos));
          case 'tan': return this.mathOp(math.TAN, x, fromDeg(Math.tan));
          case 'asin': return this.mathOp(math.ASIN, x, toDeg(Math.asin));
          case 'acos': return this.mathOp(math.ACOS, x, toDeg(Math.acos));
          case 'atan': return this.mathOp(math.ATAN, x, toDeg(Math.atan));
          case 'ln': return this.mathOp(math.LN, x, Math.log);
          case 'log': return this.mathOp(math.LOG, x, Math.log10);
          case 'exp': return this.mathOp(math.EXP, x, Math.exp);
          default: return this.arith([op.MATH, math.POW], num(10), x, Math.pow);
        }
      }
      case 'math_round': {
        const x = this.numIn(block, 'NUM');
        if (f('OP') === 'ROUNDUP') return this.mathOp(math.CEIL, x, Math.ceil);
        if (f('OP') === 'ROUNDDOWN') return this.mathOp(math.FLOOR, x, Math.floor);
        return this.mathOp(math.ROUND, x, (v) => Math.sign(v) * Math.round(Math.abs(v)));
      }
      case 'math_random_int': {
        const r = this.tmp('int');
        const from = this.int(this.clampNum(this.numIn(block, 'FROM', 1), -32767, 32767), 16);
        const to = this.int(this.clampNum(this.numIn(block, 'TO', 10), -32767, 32767), 16);
        const v = this.tmp('num');
        c.op(op.RANDOM, from, to, r);
        c.op(op.MOVE16_F, r, v);
        return { ty: 'num', op: v };
      }

      case 'logic_compare': {
        const a = this.input(block, 'A', num(0));
        const b = this.input(block, 'B', num(0));
        const cmp = f('OP') as string;
        if ((a.ty === 'str' || b.ty === 'str') && (cmp === 'EQ' || cmp === 'NEQ')) {
          const r = this.tmp('bool');
          c.op([op.STRINGS, strings.COMPARE], this.toStr(a).op, this.toStr(b).op, r);
          return cmp === 'NEQ' ? this.not({ ty: 'bool', op: r }) : { ty: 'bool', op: r };
        }
        if (a.ty === 'str' && !isStr(a) || b.ty === 'str' && !isStr(b)) {
          throw new RbfError('Texte lassen sich auf dem EV3 nur auf „=“ oder „≠“ vergleichen.', block.id);
        }
        const codes: Record<string, number> = { EQ: op.CP_EQF, NEQ: op.CP_NEQF, LT: op.CP_LTF, LTE: op.CP_LTEQF, GT: op.CP_GTF, GTE: op.CP_GTEQF };
        return this.cmp(codes[cmp], this.toNum(a, block), this.toNum(b, block));
      }
      case 'logic_operation': {
        const a = this.boolIn(block, 'A');
        const b = this.boolIn(block, 'B');
        const and = f('OP') === 'AND';
        if (typeof a.k === 'boolean' && typeof b.k === 'boolean') return bool(and ? a.k && b.k : a.k || b.k);
        const r = this.tmp('bool');
        c.op(and ? op.AND8 : op.OR8, a.op, b.op, r);
        return { ty: 'bool', op: r };
      }
      case 'logic_negate':
        return this.not(this.boolIn(block, 'BOOL'));

      case 'text_join': {
        let result: Val = str('');
        for (let i = 0; block.getInput('ADD' + i); i++) {
          result = this.join(result, this.toStr(this.input(block, 'ADD' + i, str(''))));
        }
        return result;
      }
      case 'ev3_length_of':
        return this.length(this.strIn(block, 'TEXT'));
      case 'ev3_letter_of':
        return this.letter(this.numIn(block, 'INDEX', 1), this.strIn(block, 'TEXT'));
      case 'ev3_contains':
        return this.contains(this.strIn(block, 'TEXT'), this.strIn(block, 'PART'));

      // Sensoren
      case 'ev3_reflected':
        return this.reflected(port());
      case 'ev3_reflected_is':
        return this.compareOp(this.reflected(port()), f('OP'), this.numIn(block, 'VALUE'));
      case 'ev3_ambient':
        return this.readSensor(port(), 1);
      case 'ev3_ambient_is':
        return this.compareOp(this.readSensor(port(), 1), f('OP'), this.numIn(block, 'VALUE'));
      case 'ev3_color_value':
        return this.color(port());
      case 'ev3_color_is':
        return this.cmp(op.CP_EQF, this.color(port()), num(Number(f('COLOR'))));
      case 'ev3_touch_is':
        return f('STATE') === 'released' ? this.not(this.touch(port())) : this.touch(port());
      case 'ev3_distance':
        return this.distance(port(), f('UNIT'));
      case 'ev3_distance_is':
        return this.compareOp(this.distance(port(), f('UNIT')), f('OP'), this.numIn(block, 'VALUE'));
      case 'ev3_angle':
        return this.angle(port());
      case 'ev3_angle_is':
        return this.compareOp(this.angle(port()), f('OP'), this.numIn(block, 'VALUE'));
      case 'ev3_rate':
        return this.numVal(this.readValues(port(), 3, 2)[1]);
      case 'ev3_infrared':
        return this.readSensor(port(), 0);
      case 'ev3_ir_beacon': {
        const values = this.readValues(port(), 1, 8);
        return this.numVal(values[(Number(f('CHANNEL')) - 1) * 2 + (f('WHAT') === 'distance' ? 1 : 0)]);
      }
      case 'ev3_ir_remote':
        return this.numVal(this.readValues(port(), 2, 4)[Number(f('CHANNEL')) - 1]);
      case 'ev3_ir_remote_is':
        return this.cmp(op.CP_EQF, this.numVal(this.readValues(port(), 2, 4)[Number(f('CHANNEL')) - 1]), num(Number(f('BUTTON'))));
      case 'ev3_motor_degrees':
        return this.readSensor(port(), f('MODE') === 'speed' ? 2 : 0);
      case 'ev3_button_is':
        return f('STATE') === 'released' ? this.not(this.button(f('BUTTON'))) : this.button(f('BUTTON'));
      case 'ev3_button_value':
        return this.buttonNumber();
      case 'ev3_timer':
        return this.timer();

      // Listen
      case 'ev3_list_length':
        return this.numVal(this.list(block).length);
      case 'ev3_list_item':
        return this.listItem(block);
      case 'ev3_list_index':
        return this.listIndex(block);
      case 'ev3_list_contains':
        return this.cmp(op.CP_GTF, this.listIndex(block), num(0));
      case 'ev3_list_value':
        return this.listText(block);
    }
    throw new RbfError(`Der Block „${blockLabel(block)}“ kann noch nicht auf den EV3 übertragen werden.`, block.id);
  }

  // --- Sensors ----------------------------------------------------------------------

  private readSensor(port: string, mode: number): Val {
    const r = this.tmp('num');
    this.t.code.op(op.INPUT_READSI, LAYER, lc(inputPortNumber(port as Port)), lc(0), lc(mode), r);
    return { ty: 'num', op: r };
  }

  /** All values of a sensor mode (opINPUT_DEVICE READY_SI). */
  private readValues(port: string, mode: number, count: number): Operand[] {
    const values = Array.from({ length: count }, () => this.tmp('num'));
    this.t.code.op([op.INPUT_DEVICE, inputDevice.READY_SI], LAYER, lc(inputPortNumber(port as Port)), lc(0), lc(mode), lc(count), ...values);
    return values;
  }

  private touch(port: string): Val {
    return this.cmp(op.CP_GTF, this.readSensor(port, 0), num(0.5));
  }

  private color(port: string): Val {
    return this.mathOp(math.ROUND, this.readSensor(port, 2), Math.round);
  }

  private reflected(port: string): Val {
    const raw = this.readSensor(port, 0);
    if (!this.workspace.getAllBlocks(false).some((b) => b.type === 'ev3_light_calibrate' && b.isEnabled())) return raw;
    const min = this.numVal(this.global(`lightMin${port}`, 'num', 0));
    const max = this.numVal(this.global(`lightMax${port}`, 'num', 100));
    return this.clampNum(this.mul(this.div(this.sub(raw, min), this.sub(max, min)), num(100)), 0, 100);
  }

  /** Ultrasonic or infrared sensor, decided when the program runs (the infrared proximity is turned into cm). */
  private distance(port: string, unit: string): Val {
    const c = this.t.code;
    const type = this.tmp('int');
    const mode = this.tmp('int');
    const r = this.tmp('num');
    const ultrasonic = c.label();
    const end = c.label();
    c.op([op.INPUT_DEVICE, inputDevice.GET_TYPEMODE], LAYER, lc(inputPortNumber(port as Port)), type, mode);
    c.jump(op.JR_FALSE, ultrasonic, this.cmp(op.CP_EQ8, { ty: 'bool', op: type }, { ty: 'bool', op: lc(TYPE_INFRARED) }).op);
    c.op(op.INPUT_READSI, LAYER, lc(inputPortNumber(port as Port)), lc(0), lc(0), r);
    c.op(op.MULF, r, lcf(INFRARED_CM_PER_PERCENT / (unit === 'in' ? 2.54 : 1)), r);
    c.jump(op.JR, end);
    c.place(ultrasonic);
    c.op(op.INPUT_READSI, LAYER, lc(inputPortNumber(port as Port)), lc(0), lc(unit === 'in' ? 1 : 0), r);
    c.place(end);
    return { ty: 'num', op: r };
  }

  private gyroOffset(port: string): Operand {
    return this.global(`gyro${port}`, 'num', 0);
  }

  /** Mode 3 delivers angle and rate; switching modes would reset the angle. */
  private angle(port: string): Val {
    return this.sub(this.numVal(this.readValues(port, 3, 2)[0]), this.numVal(this.gyroOffset(port)));
  }

  private button(name: string): Val {
    const r = this.tmp('bool');
    this.t.code.op([op.UI_BUTTON, uiButton.PRESSED], lc(BUTTONS[name as ButtonName]), r);
    return { ty: 'bool', op: r };
  }

  /** 0 none, 1 left, 2 centre, 3 right, 4 up, 5 down – as in EV3 Classroom. */
  private buttonNumber(): Val {
    const c = this.t.code;
    const r = this.tmp('num');
    const end = c.label();
    c.op(op.MOVEF_F, lcf(0), r);
    (['left', 'enter', 'right', 'up', 'down'] as const).forEach((name, i) => {
      const next = c.label();
      c.jump(op.JR_FALSE, next, this.button(name).op);
      c.op(op.MOVEF_F, lcf(i + 1), r);
      c.jump(op.JR, end);
      c.place(next);
    });
    c.place(end);
    return { ty: 'num', op: r };
  }

  private timer(): Val {
    const c = this.t.code;
    const now = this.tmp('int');
    const r = this.tmp('num');
    c.op(op.TIMER_READ, now);
    c.op(op.SUB32, now, gv(this.timerStart), now);
    c.op(op.MOVE32_F, now, r);
    c.op(op.DIVF, r, lcf(1000), r);
    return { ty: 'num', op: r };
  }

  /** Event condition of a "Wenn …" block. */
  private hatCondition(block: Blockly.Block): Val {
    const f = (name: string) => block.getFieldValue(name);
    const port = () => f('PORT') as string;
    switch (block.type) {
      case 'ev3_when_color':
        return f('COLOR') === 'change'
          ? this.changed(block.id, this.color(port()), num(0))
          : this.cmp(op.CP_EQF, this.color(port()), num(Number(f('COLOR'))));
      case 'ev3_when_touch':
        return f('EVENT') === 'pressed' ? this.touch(port()) : this.released(block.id, this.touch(port()));
      case 'ev3_when_distance':
      case 'ev3_when_angle': {
        const value = block.type === 'ev3_when_angle' ? this.angle(port()) : this.distance(port(), f('UNIT'));
        const target = this.numIn(block, 'VALUE');
        return f('OP') === 'CHANGE' ? this.changed(block.id, value, target) : this.compareOp(value, f('OP'), target);
      }
      case 'ev3_when_button':
        return f('EVENT') === 'released' ? this.released(block.id, this.button(f('BUTTON'))) : this.button(f('BUTTON'));
      case 'ev3_when_timer':
        return this.cmp(op.CP_GTF, this.timer(), this.numIn(block, 'SECONDS'));
      default:
        return this.boolIn(block, 'COND');
    }
  }

  /** True once the value moved more than `delta` away from the last reference (the first reading sets it). */
  private changed(key: string, value: Val, delta: Val): Val {
    const c = this.t.code;
    const ref = this.numVal(this.global(`ref${key}`, 'num', 0));
    const known = this.global(`known${key}`, 'bool', 0);
    const r = this.tmp('bool');
    const end = c.label();
    const first = c.label();
    c.op(op.MOVE8_8, lc(0), r);
    c.jump(op.JR_FALSE, first, known);
    const diff = this.mathOp(math.ABS, this.sub(value, ref), Math.abs);
    c.op(op.CP_GTF, diff.op, delta.op, r);
    c.jump(op.JR_FALSE, end, r);
    c.place(first);
    c.op(op.MOVEF_F, value.op, ref.op);
    c.op(op.MOVE8_8, lc(1), known);
    c.place(end);
    return { ty: 'bool', op: r };
  }

  /** True once when a press ends ("losgelassen", "angestoßen"). */
  private released(key: string, pressed: Val): Val {
    const was = this.global(`was${key}`, 'bool', 0);
    const r = this.and({ ty: 'bool', op: was }, this.not(pressed));
    this.t.code.op(op.MOVE8_8, pressed.op, was);
    return r;
  }

  // --- Text -------------------------------------------------------------------------

  private join(a: Val, b: Val): Val {
    if (isStr(a) && isStr(b)) return str(a.k + b.k);
    const r = this.tmp('str');
    this.t.code.op([op.STRINGS, strings.ADD], a.op, b.op, r);
    return { ty: 'str', op: r };
  }

  private length(text: Val): Val {
    if (isStr(text)) return num(text.k.length);
    const n = this.tmp('int');
    const r = this.tmp('num');
    this.t.code.op([op.STRINGS, strings.GET_SIZE], text.op, n);
    this.t.code.op(op.MOVE16_F, n, r);
    return { ty: 'num', op: r };
  }

  /** A character as DATA8, optionally in lower case. */
  private charAt(text: Operand, index: Operand, lower: boolean): Operand {
    const c = this.t.code;
    const ch = this.tmp('int');
    c.op(op.READ8, text, index, ch);
    if (lower) {
      const skip = c.label();
      const flag = this.tmp('bool');
      c.op(int8.CP_LT, ch, lc(65), flag);
      c.jump(op.JR_TRUE, skip, flag);
      c.op(int8.CP_GT, ch, lc(90), flag);
      c.jump(op.JR_TRUE, skip, flag);
      c.op(int8.ADD, ch, lc(32), ch);
      c.place(skip);
    }
    return ch;
  }

  /** A text in a variable (opREAD8 cannot read constants). */
  private inMemory(v: Val): Val {
    return v.k !== undefined ? this.copy(v) : v;
  }

  private letter(index: Val, text: Val): Val {
    if (isNum(index) && isStr(text)) return str(text.k.charAt(index.k - 1));
    const c = this.t.code;
    const source = this.inMemory(text);
    const r = this.tmp('str');
    const end = c.label();
    const i = this.copy(this.sub(this.mathOp(math.ROUND, index, Math.round), num(1)));
    c.op(op.WRITE8, lc(0), lc(0), r); // empty text
    c.jump(op.JR_TRUE, end, this.cmp(op.CP_LTF, i, num(0)).op);
    c.jump(op.JR_TRUE, end, this.cmp(op.CP_GTF, i, num(MAX_INDEX)).op);
    c.jump(op.JR_TRUE, end, this.cmp(op.CP_GTEQF, i, this.length(source)).op);
    const ch = this.charAt(source.op, this.int(i, 8), false);
    c.op(op.WRITE8, ch, lc(0), r);
    c.op(op.WRITE8, lc(0), lc(1), r);
    c.place(end);
    return { ty: 'str', op: r };
  }

  /** Case-insensitive, like Scratch. */
  private contains(text: Val, part: Val): Val {
    if (isStr(text) && isStr(part)) return bool(text.k.toLowerCase().includes(part.k.toLowerCase()));
    const c = this.t.code;
    const hay = this.inMemory(text);
    const needle = this.inMemory(part);
    const r = this.tmp('bool');
    const n = this.int(this.clampNum(this.length(hay), 0, MAX_INDEX), 8);
    const m = this.int(this.clampNum(this.length(needle), 0, MAX_INDEX), 8);
    const last = this.tmp('int');
    const i = this.tmp('int');
    const j = this.tmp('int');
    const at = this.tmp('int');
    const flag = this.tmp('bool');
    const outer = c.label();
    const inner = c.label();
    const mismatch = c.label();
    const found = c.label();
    const end = c.label();

    c.op(op.MOVE8_8, lc(0), r);
    c.op(int8.SUB, n, m, last); // last start position
    c.op(op.MOVE8_8, lc(0), i);
    c.place(outer);
    c.op(int8.CP_GT, i, last, flag);
    c.jump(op.JR_TRUE, end, flag);
    c.op(op.MOVE8_8, lc(0), j);
    c.place(inner);
    c.op(int8.CP_LT, j, m, flag);
    c.jump(op.JR_FALSE, found, flag);
    c.op(int8.ADD, i, j, at);
    c.op(op.CP_EQ8, this.charAt(hay.op, at, true), this.charAt(needle.op, j, true), flag);
    c.jump(op.JR_FALSE, mismatch, flag);
    c.op(int8.ADD, j, lc(1), j);
    c.jump(op.JR, inner);
    c.place(mismatch);
    c.op(int8.ADD, i, lc(1), i);
    c.jump(op.JR, outer);
    c.place(found);
    c.op(op.MOVE8_8, lc(1), r);
    c.place(end);
    return { ty: 'bool', op: r };
  }

  // --- Lists ------------------------------------------------------------------------

  /** 1-based index → 0-based number, and whether it lies within the list (plus `extra` places). */
  private listPosition(index: Val, length: Operand, extra: number): { at: Val; ok: Val } {
    const at = this.copy(this.sub(this.mathOp(math.ROUND, index, Math.round), num(1)));
    const lo = this.cmp(op.CP_GTEQF, at, num(0));
    const hi = this.cmp(op.CP_LTF, this.sub(at, num(extra)), this.numVal(length));
    return { at, ok: this.and(lo, hi) };
  }

  private ensureCapacity(handle: Operand, needed: Val): void {
    const c = this.t.code;
    const size = this.tmp('int');
    const sizeF = this.tmp('num');
    const skip = c.label();
    c.op([op.ARRAY, array.SIZE], handle, size);
    c.op(op.MOVE32_F, size, sizeF);
    c.jump(op.JR_TRUE, skip, this.cmp(op.CP_GTEQF, this.numVal(sizeF), needed).op);
    c.op([op.ARRAY, array.RESIZE], handle, this.int(this.add(needed, num(8)), 32));
    c.place(skip);
  }

  private listItem(block: Blockly.Block): Val {
    const c = this.t.code;
    const l = this.list(block);
    const r = this.tmp('num');
    const end = c.label();
    const { at, ok } = this.listPosition(this.numIn(block, 'INDEX', 1), l.length, 0);
    c.op(op.MOVEF_F, lcf(0), r);
    c.jump(op.JR_FALSE, end, ok.op);
    c.op(op.ARRAY_READ, l.handle, this.int(at, 32), r);
    c.place(end);
    return { ty: 'num', op: r };
  }

  private listIndex(block: Blockly.Block): Val {
    const c = this.t.code;
    const l = this.list(block);
    const item = this.toNum(this.input(block, 'ITEM', num(0)), block);
    const r = this.tmp('num');
    const k = this.tmp('num');
    const v = this.tmp('num');
    const top = c.label();
    const end = c.label();
    c.op(op.MOVEF_F, lcf(0), r);
    c.op(op.MOVEF_F, lcf(0), k);
    c.place(top);
    c.jump(op.JR_FALSE, end, this.cmp(op.CP_LTF, this.numVal(k), this.numVal(l.length)).op);
    c.op(op.ARRAY_READ, l.handle, this.int(this.numVal(k), 32), v);
    c.op(op.ADDF, k, lcf(1), k);
    c.jump(op.JR_FALSE, top, this.cmp(op.CP_EQF, this.numVal(v), item).op);
    c.op(op.MOVEF_F, k, r);
    c.place(end);
    return { ty: 'num', op: r };
  }

  /** All items separated by spaces; stops before the text buffer could overflow. */
  private listText(block: Blockly.Block): Val {
    const c = this.t.code;
    const l = this.list(block);
    const r = this.tmp('str');
    const k = this.tmp('num');
    const v = this.tmp('num');
    const size = this.tmp('int');
    const sizeF = this.tmp('num');
    const top = c.label();
    const end = c.label();
    const noSpace = c.label();
    c.op(op.WRITE8, lc(0), lc(0), r);
    c.op(op.MOVEF_F, lcf(0), k);
    c.place(top);
    c.jump(op.JR_FALSE, end, this.cmp(op.CP_LTF, this.numVal(k), this.numVal(l.length)).op);
    c.op([op.STRINGS, strings.GET_SIZE], r, size);
    c.op(op.MOVE16_F, size, sizeF);
    c.jump(op.JR_TRUE, end, this.cmp(op.CP_GTF, this.numVal(sizeF), num(STR - 80)).op);
    c.jump(op.JR_TRUE, noSpace, this.cmp(op.CP_EQF, this.numVal(k), num(0)).op);
    c.op([op.STRINGS, strings.ADD], r, lcs(' '), r);
    c.place(noSpace);
    c.op(op.ARRAY_READ, l.handle, this.int(this.numVal(k), 32), v);
    c.op([op.STRINGS, strings.ADD], r, this.toStr(this.numVal(v)).op, r);
    c.op(op.ADDF, k, lcf(1), k);
    c.jump(op.JR, top);
    c.place(end);
    return { ty: 'str', op: r };
  }

  /** Statement blocks on lists. */
  private listStatement(block: Blockly.Block): void {
    const c = this.t.code;
    const l = this.list(block);
    const length = this.numVal(l.length);
    const item = () => this.toNum(this.input(block, 'ITEM', num(0)), block);
    const end = c.label();
    switch (block.type) {
      case 'ev3_list_add': {
        const v = item();
        this.ensureCapacity(l.handle, this.add(length, num(1)));
        c.op(op.ARRAY_WRITE, l.handle, this.int(length, 32), v.op);
        c.op(op.ADDF, l.length, lcf(1), l.length);
        break;
      }
      case 'ev3_list_clear':
        c.op(op.MOVEF_F, lcf(0), l.length);
        break;
      case 'ev3_list_replace': {
        const { at, ok } = this.listPosition(this.numIn(block, 'INDEX', 1), l.length, 0);
        const v = item();
        c.jump(op.JR_FALSE, end, ok.op);
        c.op(op.ARRAY_WRITE, l.handle, this.int(at, 32), v.op);
        break;
      }
      case 'ev3_list_delete': {
        const { at, ok } = this.listPosition(this.numIn(block, 'INDEX', 1), l.length, 0);
        c.jump(op.JR_FALSE, end, ok.op);
        // Move the following items one place forward.
        const top = c.label();
        const done = c.label();
        const v = this.tmp('num');
        const next = this.tmp('num');
        c.place(top);
        c.op(op.ADDF, at.op, lcf(1), next);
        c.jump(op.JR_FALSE, done, this.cmp(op.CP_LTF, this.numVal(next), length).op);
        c.op(op.ARRAY_READ, l.handle, this.int(this.numVal(next), 32), v);
        c.op(op.ARRAY_WRITE, l.handle, this.int(at, 32), v);
        c.op(op.MOVEF_F, next, at.op);
        c.jump(op.JR, top);
        c.place(done);
        c.op(op.SUBF, l.length, lcf(1), l.length);
        break;
      }
      case 'ev3_list_insert': {
        const v = this.copy(item());
        const { at, ok } = this.listPosition(this.numIn(block, 'INDEX', 1), l.length, 1);
        c.jump(op.JR_FALSE, end, ok.op);
        this.ensureCapacity(l.handle, this.add(length, num(1)));
        // Move the items from the end back by one place.
        const k = this.copy(length);
        const top = c.label();
        const done = c.label();
        const w = this.tmp('num');
        const prev = this.tmp('num');
        c.place(top);
        c.jump(op.JR_FALSE, done, this.cmp(op.CP_GTF, k, at).op);
        c.op(op.SUBF, k.op, lcf(1), prev);
        c.op(op.ARRAY_READ, l.handle, this.int(this.numVal(prev), 32), w);
        c.op(op.ARRAY_WRITE, l.handle, this.int(k, 32), w);
        c.op(op.MOVEF_F, prev, k.op);
        c.jump(op.JR, top);
        c.place(done);
        c.op(op.ARRAY_WRITE, l.handle, this.int(at, 32), v.op);
        c.op(op.ADDF, l.length, lcf(1), l.length);
        break;
      }
    }
    c.place(end);
  }

  // --- Statements ---------------------------------------------------------------

  private statements(block: Blockly.Block | null): void {
    for (; block; block = block.getNextBlock()) {
      if (block.isEnabled()) this.statement(block);
    }
  }

  private loop(body: (exit: Label, next: Label) => void): void {
    const c = this.t.code;
    const exit = c.label();
    const next = c.label();
    this.t.loops.push({ exit, next });
    body(exit, next);
    this.t.loops.pop();
    c.place(exit);
  }

  /** Polls a condition, giving other threads a turn in between. */
  private waitUntil(cond: () => Val): void {
    const c = this.t.code;
    const top = c.label();
    const done = c.label();
    c.place(top);
    c.jump(op.JR_TRUE, done, cond().op);
    c.op(op.SLEEP);
    c.jump(op.JR, top);
    c.place(done);
  }

  /** "warte bis … < > = / ändert sich um mehr als …" */
  private waitValue(read: () => Val, cmp: string, target: Val): void {
    if (cmp === 'CHANGE') {
      const start = this.copy(read());
      this.waitUntil(() => this.cmp(op.CP_GTF, this.mathOp(math.ABS, this.sub(read(), start), Math.abs), target));
    } else {
      this.waitUntil(() => this.compareOp(read(), cmp, target));
    }
  }

  private wait(seconds: Val): void {
    const c = this.t.code;
    const ms = this.int(this.mul(seconds, num(1000)), 32);
    const timer = this.tmp('int');
    c.op(op.TIMER_WAIT, ms, timer);
    c.op(op.TIMER_READY, timer);
  }

  private statement(block: Blockly.Block): void {
    const c = this.t.code;
    const f = (name: string) => block.getFieldValue(name);
    const portList = () => (f('PORT') as string).split('') as MotorPort[];
    const ports = () => lc(portMask(portList()));
    const port = () => f('PORT') as string;
    const draw = (sub: number, ...operands: Operand[]) => {
      c.op([op.UI_DRAW, sub], ...operands);
      c.op([op.UI_DRAW, uiDraw.UPDATE]);
    };

    if (block.type.startsWith('ev3_list_')) return this.listStatement(block);

    switch (block.type) {
      case 'ev3_wait':
        return this.wait(this.numIn(block, 'SECONDS', 1));
      case 'ev3_wait_until':
        return this.waitUntil(() => this.boolIn(block, 'COND'));
      case 'ev3_forever':
        return this.loop((_exit, next) => {
          c.place(next);
          this.statements(block.getInputTargetBlock('DO'));
          c.jump(op.JR, next);
        });
      case 'controls_repeat_ext':
      case 'controls_repeat': {
        const times = block.type === 'controls_repeat' ? num(Number(f('TIMES'))) : this.numIn(block, 'TIMES');
        const count = this.copy(times);
        const check = c.label();
        return this.loop((exit, next) => {
          c.place(check);
          c.jump(op.JR_TRUE, exit, this.cmp(op.CP_LTEQF, count, num(0)).op);
          this.statements(block.getInputTargetBlock('DO'));
          c.place(next);
          c.op(op.SUBF, count.op, lcf(1), count.op);
          c.jump(op.JR, check);
        });
      }
      case 'controls_whileUntil':
        return this.loop((exit, next) => {
          c.place(next);
          c.jump(f('MODE') === 'UNTIL' ? op.JR_TRUE : op.JR_FALSE, exit, this.boolIn(block, 'BOOL').op);
          this.statements(block.getInputTargetBlock('DO'));
          c.jump(op.JR, next);
        });
      case 'controls_if': {
        const end = c.label();
        for (let i = 0; block.getInput('IF' + i); i++) {
          const skip = c.label();
          c.jump(op.JR_FALSE, skip, this.boolIn(block, 'IF' + i).op);
          this.statements(block.getInputTargetBlock('DO' + i));
          c.jump(op.JR, end);
          c.place(skip);
        }
        if (block.getInput('ELSE')) this.statements(block.getInputTargetBlock('ELSE'));
        c.place(end);
        return;
      }
      case 'ev3_stop':
        if (f('WHAT') === 'this') c.jump(op.JR, this.t.end);
        else c.op(op.PROGRAM_STOP, lc(CURRENT_SLOT));
        return;
      case 'ev3_stop_other':
        for (const hat of this.hats) {
          if (hat.id === this.t.id) continue;
          c.op(op.OBJECT_STOP, lc(hat.id));
          if (hat.kind === 'when') c.op(op.OBJECT_START, lc(hat.id)); // keeps listening
          if (hat.kind === 'message') c.op(op.MOVE8_8, lc(0), this.busy(hat.id));
        }
        return;
      case 'ev3_broadcast':
      case 'ev3_broadcast_wait': {
        const ids = this.receivers.get(f('MESSAGE')) ?? [];
        for (const id of ids) {
          c.op(op.MOVE8_8, lc(1), this.busy(id));
          c.op(op.OBJECT_START, lc(id));
        }
        if (block.type === 'ev3_broadcast_wait' && ids.length) {
          this.waitUntil(() => ids.map((id) => this.not({ ty: 'bool', op: this.busy(id) })).reduce((a, b) => this.and(a, b)));
        }
        return;
      }

      case 'variables_set': {
        const dst = this.variable(block);
        this.assign(dst, this.convert(this.input(block, 'VALUE', num(0)), dst.ty, block));
        return;
      }
      case 'math_change': {
        const dst = this.variable(block);
        if (dst.ty !== 'num') throw new RbfError('„ändere um“ geht nur bei Zahlen.', block.id);
        c.op(op.ADDF, dst.op, this.numIn(block, 'DELTA', 1).op, dst.op);
        return;
      }
      case 'procedures_callnoreturn':
        this.inline(block, false);
        return;
      case 'procedures_ifreturn': {
        const ret = this.t.returns.at(-1);
        if (!ret) throw new RbfError('„Rückgabe“ steht nicht in einem eigenen Block.', block.id);
        const skip = c.label();
        c.jump(op.JR_FALSE, skip, this.boolIn(block, 'CONDITION').op);
        if (ret.result && block.getInput('VALUE')) {
          this.assign(ret.result, this.convert(this.input(block, 'VALUE', num(0)), ret.result.ty, block));
        }
        c.jump(op.JR, ret.label);
        c.place(skip);
        return;
      }

      // Motoren
      case 'ev3_motor_run_for':
      case 'ev3_motor_run_for_speed': {
        const amount = this.numIn(block, 'AMOUNT', 1);
        const fixed = amount.k !== undefined ? amount : this.copy(amount);
        const given = block.type === 'ev3_motor_run_for_speed' ? this.numIn(block, 'SPEED', 75) : null;
        const sign = f('DIR') === 'ccw' ? -1 : 1;
        for (const p of portList()) {
          const speed = given ?? this.mul(this.numVal(this.motorSpeed(p)), num(sign));
          this.runFor(lc(portMask([p])), speed, fixed, f('UNIT'), this.motorHold(p), null, false);
        }
        c.op(op.OUTPUT_READY, LAYER, ports());
        return;
      }
      case 'ev3_motor_start_dir': {
        const sign = f('DIR') === 'ccw' ? -1 : 1;
        for (const p of portList()) {
          const speed = this.int(this.clampNum(this.mul(this.numVal(this.motorSpeed(p)), num(sign)), -100, 100), 8);
          c.op(op.OUTPUT_SPEED, LAYER, lc(portMask([p])), speed);
        }
        c.op(op.OUTPUT_START, LAYER, ports());
        return;
      }
      case 'ev3_motor_start_power':
        c.op(op.OUTPUT_POWER, LAYER, ports(), this.speed(block, 'POWER', 75));
        c.op(op.OUTPUT_START, LAYER, ports());
        return;
      case 'ev3_motor_stop':
        for (const p of portList()) c.op(op.OUTPUT_STOP, LAYER, lc(portMask([p])), this.motorHold(p));
        return;
      case 'ev3_motor_set_speed': {
        const speed = this.clampNum(this.numIn(block, 'SPEED', 75), -100, 100);
        for (const p of portList()) c.op(op.MOVEF_F, speed.op, this.motorSpeed(p));
        return;
      }
      case 'ev3_motor_set_stop':
        for (const p of portList()) c.op(op.MOVE8_8, lc(f('ACTION') === 'hold' ? 1 : 0), this.motorHold(p));
        return;
      case 'ev3_motor_start_speed':
        c.op(op.OUTPUT_SPEED, LAYER, ports(), this.speed(block, 'SPEED', 75));
        c.op(op.OUTPUT_START, LAYER, ports());
        return;
      case 'ev3_motor_reset':
        c.op(op.OUTPUT_CLR_COUNT, LAYER, ports());
        return;

      // Fahren
      case 'ev3_move_for':
      case 'ev3_move_start': {
        const [speed, turn] = this.moveDirection(f('DIR'));
        if (block.type === 'ev3_move_start') return this.sync(speed, turn, true, null, '');
        return this.sync(speed, turn, true, this.numIn(block, 'AMOUNT', 10), f('UNIT'));
      }
      case 'ev3_move_steer_for':
      case 'ev3_move_steer_for_speed':
      case 'ev3_move_steer_start':
      case 'ev3_move_steer_start_speed': {
        const speed = block.getInput('SPEED') ? this.numIn(block, 'SPEED', 50) : this.numVal(this.move.speed());
        const turn = this.mul(this.numIn(block, 'STEERING'), num(2));
        if (block.type.includes('_start')) return this.sync(speed, turn, true, null, '');
        return this.sync(speed, turn, true, this.numIn(block, 'AMOUNT', 10), f('UNIT'));
      }
      case 'ev3_move_tank_for':
      case 'ev3_move_tank_start':
        return this.tank(block);
      case 'ev3_move_stop':
        c.op(op.OUTPUT_STOP, LAYER, this.move.mask(), this.move.hold());
        return;
      case 'ev3_move_set_speed':
        c.op(op.MOVEF_F, this.clampNum(this.numIn(block, 'SPEED', 50), -100, 100).op, this.move.speed());
        return;
      case 'ev3_move_set_motors': {
        const [left, right] = (f('PORTS') as string).split('') as MotorPort[];
        c.op(op.MOVE8_8, lc(portMask([left, right])), this.move.mask());
        c.op(op.MOVEF_F, lcf(left < right ? 1 : -1), this.move.sign());
        return;
      }
      case 'ev3_move_set_stop':
        c.op(op.MOVE8_8, lc(f('ACTION') === 'hold' ? 1 : 0), this.move.hold());
        return;
      case 'ev3_move_set_rotation': {
        const cm = this.mul(this.numIn(block, 'DISTANCE', 17.6), num(f('UNIT') === 'in' ? 2.54 : 1));
        const skip = c.label();
        c.jump(op.JR_FALSE, skip, this.cmp(op.CP_GTF, cm, num(0)).op);
        c.op(op.MOVEF_F, cm.op, this.move.cm());
        c.place(skip);
        return;
      }

      // Anzeige
      case 'ev3_image':
        return this.drawImage(f('IMAGE'));
      case 'ev3_image_for':
        this.drawImage(f('IMAGE'));
        this.wait(this.numIn(block, 'SECONDS', 2));
        this.clearDisplay();
        return;
      case 'ev3_write_line': {
        const text = this.strIn(block, 'TEXT');
        const line = this.clampNum(this.mathOp(math.ROUND, this.numIn(block, 'LINE', 1), Math.round), 1, LINES);
        const y = this.int(this.mul(this.sub(line, num(1)), num(LINE_HEIGHT)), 16);
        c.op([op.UI_DRAW, uiDraw.FILLRECT], lc(0), lc(0), y, lc(SCREEN_WIDTH), lc(LINE_HEIGHT));
        c.op([op.UI_DRAW, uiDraw.SELECT_FONT], lc(0));
        return draw(uiDraw.TEXT, lc(1), lc(0), y, text.op);
      }
      case 'ev3_write_xy': {
        const [font, ink] = (f('FONT') as string).split(',').map(Number);
        const text = this.strIn(block, 'TEXT');
        const [x, y] = this.coords(block, 'X', 'Y');
        c.op([op.UI_DRAW, uiDraw.SELECT_FONT], lc(font));
        return draw(uiDraw.TEXT, lc(ink), x, y, text.op);
      }
      case 'ev3_draw_pixel':
        return draw(uiDraw.PIXEL, lc(Number(f('INK'))), ...this.coords(block, 'X', 'Y'));
      case 'ev3_draw_line':
        return draw(uiDraw.LINE, lc(Number(f('INK'))), ...this.coords(block, 'X1', 'Y1', 'X2', 'Y2'));
      case 'ev3_draw_circle': {
        const [x, y] = this.coords(block, 'X', 'Y');
        const r = this.roundInt(this.mathOp(math.ABS, this.numIn(block, 'R', 10), Math.abs), 16);
        return draw(f('FILL') === 'TRUE' ? uiDraw.FILLCIRCLE : uiDraw.CIRCLE, lc(Number(f('INK'))), x, y, r);
      }
      case 'ev3_draw_rect':
        return draw(f('FILL') === 'TRUE' ? uiDraw.FILLRECT : uiDraw.RECT, lc(Number(f('INK'))), ...this.coords(block, 'X', 'Y', 'W', 'H'));
      case 'ev3_display_invert':
        return draw(uiDraw.INVERSERECT, lc(0), lc(0), lc(SCREEN_WIDTH), lc(SCREEN_HEIGHT));
      case 'ev3_display_clear':
        this.clearDisplay();
        return;
      case 'ev3_led':
        c.op([op.UI_WRITE, uiWrite.LED], lc(LED_PATTERNS[f('PATTERN') as LedPattern]));
        return;

      // Klang
      case 'ev3_sound_play':
      case 'ev3_sound_start':
        this.sounds.add(f('SOUND'));
        c.op([op.SOUND, sound.PLAY], this.int(this.numVal(this.volume()), 8), lcs(soundPath(f('SOUND'))));
        if (block.type === 'ev3_sound_play') c.op(op.SOUND_READY);
        return;
      case 'ev3_beep_for':
      case 'ev3_beep_start': {
        const note = this.numIn(block, 'NOTE', 60);
        const power = this.arith([op.MATH, math.POW], num(2), this.div(this.sub(note, num(69)), num(12)), Math.pow);
        const freq = this.int(this.clampNum(this.mul(power, num(440)), 250, 10000), 16);
        const ms =
          block.type === 'ev3_beep_start'
            ? lc(ENDLESS_TONE_MS)
            : this.int(this.clampNum(this.mul(this.numIn(block, 'SECONDS', 0.2), num(1000)), 1, ENDLESS_TONE_MS), 16);
        c.op([op.SOUND, sound.TONE], this.int(this.numVal(this.volume()), 8), freq, ms);
        if (block.type === 'ev3_beep_for') c.op(op.SOUND_READY);
        return;
      }
      case 'ev3_sound_stop':
        c.op([op.SOUND, sound.BREAK]);
        return;
      case 'ev3_volume_set':
        c.op(op.MOVEF_F, this.clampNum(this.numIn(block, 'VOLUME', 100), 0, 100).op, this.volume());
        return;

      // Sensoren
      case 'ev3_light_calibrate': {
        const min = f('WHICH') === 'min';
        c.op(op.MOVEF_F, this.numIn(block, 'VALUE').op, this.global(`light${min ? 'Min' : 'Max'}${port()}`, 'num', min ? 0 : 100));
        return;
      }
      case 'ev3_wait_color':
        return this.waitUntil(() => this.cmp(op.CP_EQF, this.color(port()), num(Number(f('COLOR')))));
      case 'ev3_wait_touch': {
        const event = f('EVENT');
        if (event !== 'released') this.waitUntil(() => this.touch(port()));
        if (event !== 'pressed') this.waitUntil(() => this.not(this.touch(port())));
        return;
      }
      case 'ev3_wait_distance':
        return this.waitValue(() => this.distance(port(), f('UNIT')), f('OP'), this.copy(this.numIn(block, 'VALUE')));
      case 'ev3_wait_angle':
        return this.waitValue(() => this.angle(port()), f('OP'), this.copy(this.numIn(block, 'VALUE')));
      case 'ev3_angle_reset':
        c.op(op.MOVEF_F, this.readValues(port(), 3, 2)[0], this.gyroOffset(port()));
        return;
      case 'ev3_wait_button':
        return this.waitUntil(() => (f('STATE') === 'released' ? this.not(this.button(f('BUTTON'))) : this.button(f('BUTTON'))));
      case 'ev3_timer_reset':
        c.op(op.TIMER_READ, gv(this.timerStart));
        return;
      case 'ev3_log':
      case 'ev3_log_clear':
        this.warnings.add('Messwerte werden auf dem EV3 nicht aufgezeichnet, nur wenn das Programm mit ▶ Start in der App läuft.');
        return;
    }
    throw new RbfError(`Der Block „${blockLabel(block)}“ kann noch nicht auf den EV3 übertragen werden.`, block.id);
  }

  private coords(block: Blockly.Block, ...names: string[]): Operand[] {
    return names.map((name) => this.roundInt(this.numIn(block, name), 16));
  }

  private speed(block: Blockly.Block, name: string, fallback: number): Operand {
    return this.int(this.clampNum(this.numIn(block, name, fallback), -100, 100), 8);
  }

  /**
   * Starts motors for an amount of rotations/degrees/seconds; with `wait` it also
   * waits until they are done. Negative amounts run backwards.
   */
  private runFor(ports: Operand, speedVal: Val, amount: Val, unit: string, brake: Operand, turn: Operand | null, wait: boolean): void {
    const c = this.t.code;
    const end = c.label();
    const factor = unit === 'rotations' ? 360 : unit === 'seconds' ? 1000 : 1;
    let value = this.mathOp(math.ROUND, this.mul(amount, num(factor)), Math.round);
    let speed = this.clampNum(speedVal, -100, 100);

    if (unit === 'seconds') {
      if (isNum(value) && value.k <= 0) return;
      if (!isNum(value)) c.jump(op.JR_TRUE, end, this.cmp(op.CP_LTEQF, value, num(0)).op);
    } else if (isNum(value) && isNum(speed)) {
      // Negative degrees mean backwards: the firmware wants the sign on the speed.
      if (value.k === 0) return;
      if (value.k < 0) [value, speed] = [num(-value.k), num(-speed.k)];
    } else if (isNum(value) && value.k === 0) {
      return;
    } else {
      value = this.copy(value);
      speed = this.copy(speed);
      const forward = c.label();
      c.jump(op.JR_FALSE, forward, this.cmp(op.CP_LTF, value, num(0)).op);
      c.op([op.MATH, math.NEGATE], value.op, value.op);
      c.op([op.MATH, math.NEGATE], speed.op, speed.op);
      c.place(forward);
      c.jump(op.JR_TRUE, end, this.cmp(op.CP_EQF, value, num(0)).op);
    }

    const s = this.int(speed, 8);
    const amount32 = this.int(value, 32);
    if (turn) {
      c.op(unit === 'seconds' ? op.OUTPUT_TIME_SYNC : op.OUTPUT_STEP_SYNC, LAYER, ports, s, turn, amount32, brake);
    } else {
      c.op(unit === 'seconds' ? op.OUTPUT_TIME_SPEED : op.OUTPUT_STEP_SPEED, LAYER, ports, s, lc(0), amount32, lc(0), brake);
    }
    if (wait) c.op(op.OUTPUT_READY, LAYER, ports);
    c.place(end);
  }

  // --- Movement -------------------------------------------------------------------

  private moveDirection(dir: string): [Val, Val] {
    const speed = this.numVal(this.move.speed());
    if (dir === 'back') return [this.mul(speed, num(-1)), num(0)];
    if (dir === 'right') return [speed, num(200)];
    if (dir === 'left') return [speed, num(-200)];
    return [speed, num(0)];
  }

  /**
   * Synchronized movement of the movement motors. `turn` is the firmware ratio
   * (-200..200, positive = towards the second motor); `mirror` flips it when the
   * left motor has the higher port. `amount` null runs until stopped.
   */
  private sync(speed: Val, turn: Val, mirror: boolean, amount: Val | null, unit: string): void {
    const c = this.t.code;
    const mask = this.move.mask();
    const hold = this.move.hold();
    const t = this.int(this.clampNum(mirror ? this.mul(turn, this.numVal(this.move.sign())) : turn, -200, 200), 16);
    if (amount === null) {
      c.op(op.OUTPUT_STEP_SYNC, LAYER, mask, this.int(this.clampNum(speed, -100, 100), 8), t, lc(0), hold);
      return;
    }
    let value = amount;
    let u = unit;
    if (unit === 'cm' || unit === 'in') {
      const cm = unit === 'in' ? this.mul(amount, num(2.54)) : amount;
      value = this.mul(this.div(cm, this.numVal(this.move.cm())), num(360));
      u = 'degrees';
    }
    this.runFor(mask, speed, value, u, hold, t, true);
  }

  /** Separate speeds for the left and right motor, as speed and turn ratio of the faster one. */
  private tank(block: Blockly.Block): void {
    const c = this.t.code;
    const left = this.clampNum(this.numIn(block, 'LEFT', 50), -100, 100);
    const right = this.clampNum(this.numIn(block, 'RIGHT', 50), -100, 100);
    // a: motor with the lower port, b: the other one.
    const swapped = this.cmp(op.CP_LTF, this.numVal(this.move.sign()), num(0));
    const a = this.tmp('num');
    const b = this.tmp('num');
    c.op(op.SELECTF, swapped.op, right.op, left.op, a);
    c.op(op.SELECTF, swapped.op, left.op, right.op, b);
    const speed = this.tmp('num');
    const turn = this.tmp('num');
    const end = c.label();
    const stop = c.label();
    const bFaster = c.label();
    const go = c.label();
    const absA = this.mathOp(math.ABS, this.numVal(a), Math.abs);
    const absB = this.mathOp(math.ABS, this.numVal(b), Math.abs);
    const bIsFaster = this.cmp(op.CP_LTF, absA, absB);
    c.jump(op.JR_TRUE, stop, this.cmp(op.CP_EQF, this.add(absA, absB), num(0)).op);
    c.jump(op.JR_TRUE, bFaster, bIsFaster.op);
    c.op(op.MOVEF_F, a, speed); // turn = 100 · (1 − b/a)
    c.op(op.DIVF, b, a, turn);
    c.jump(op.JR, go);
    c.place(bFaster);
    c.op(op.MOVEF_F, b, speed); // turn = −100 · (1 − a/b)
    c.op(op.DIVF, a, b, turn);
    c.place(go);
    c.op(op.SUBF, lcf(1), turn, turn);
    c.op(op.MULF, turn, lcf(100), turn);
    const keep = c.label();
    c.jump(op.JR_FALSE, keep, bIsFaster.op);
    c.op([op.MATH, math.NEGATE], turn, turn);
    c.place(keep);
    const forever = block.type === 'ev3_move_tank_start';
    this.sync(this.numVal(speed), this.numVal(turn), false, forever ? null : this.numIn(block, 'AMOUNT', 10), forever ? '' : block.getFieldValue('UNIT'));
    c.jump(op.JR, end);
    c.place(stop);
    if (forever) c.op(op.OUTPUT_STOP, LAYER, this.move.mask(), this.move.hold());
    c.place(end);
  }

  // --- Display ----------------------------------------------------------------------

  private drawImage(id: string): void {
    const c = this.t.code;
    emitDraw(imageOps(id), (sub, args) => c.op([op.UI_DRAW, sub], ...args.map((a) => (typeof a === 'string' ? lcs(a) : lc(a)))));
    c.op([op.UI_DRAW, uiDraw.UPDATE]);
  }

  private clearDisplay(): void {
    this.t.code.op([op.UI_DRAW, uiDraw.FILLWINDOW], lc(0), lc(0), lc(0));
    this.t.code.op([op.UI_DRAW, uiDraw.UPDATE]);
  }

  // --- Meine Blöcke ------------------------------------------------------------------

  private definition(call: Blockly.Block): Blockly.Block | null {
    return Blockly.Procedures.getDefinition(call.getFieldValue('NAME'), this.workspace);
  }

  /** Copies the body of an "Eigener Block" to the place of the call. */
  private inline(call: Blockly.Block, wantResult: boolean): Val | null {
    const name = call.getFieldValue('NAME') as string;
    const def = this.definition(call);
    if (!def || !def.isEnabled()) throw new RbfError(`Der eigene Block „${name}“ fehlt.`, call.id);
    if (this.t.calls.includes(name)) {
      throw new RbfError(`„${name}“ ruft sich selbst auf. Das geht auf dem EV3 leider nicht.`, call.id);
    }

    const scope = new Map<string, Val>();
    def.getVarModels().forEach((model, i) => {
      const arg = this.input(call, 'ARG' + i, num(0));
      scope.set(model.getId(), arg.k !== undefined ? arg : this.copy(arg));
    });

    const t = this.t;
    const saved = { scope: t.scope, loops: t.loops };
    const label = t.code.label();
    const result = wantResult ? { ty: this.staticType(def.getInputTargetBlock('RETURN')), op: [] as Operand } : undefined;
    if (result) result.op = this.tmp(result.ty);
    t.scope = scope;
    t.loops = [];
    t.calls.push(name);
    t.returns.push({ label, result });

    this.statements(def.getInputTargetBlock('STACK'));
    if (result && def.getInput('RETURN')) {
      this.assign(result, this.convert(this.input(def, 'RETURN', num(0)), result.ty, def));
    }
    t.code.place(label);

    t.returns.pop();
    t.calls.pop();
    t.scope = saved.scope;
    t.loops = saved.loops;
    return result ?? null;
  }
}

function blockLabel(block: Blockly.Block): string {
  return block.toString(30).trim() || block.type;
}
