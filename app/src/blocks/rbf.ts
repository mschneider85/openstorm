import * as Blockly from 'blockly/core';
import { CodeBuffer, buildImage, gv, lc, lcf, lcs, lv, type Label, type Operand } from '../ev3/assembler';
import { inputPortNumber, type Port } from '../ev3/brick';
import { BUTTONS, LED_PATTERNS, math, op, sound, strings, uiButton, uiDraw, uiWrite, type ButtonName, type LedPattern } from '../ev3/bytecodes';
import { portMask } from '../ev3/command';
import { formatValue } from '../runtime/runner';

/**
 * Compiles a workspace into an EV3 program (.rbf) that runs on the brick by
 * itself. Each start block becomes a VMTHREAD; "Eigene Blöcke" are inlined.
 *
 * Values are floats (DATAF), booleans DATA8 and texts fixed-size string buffers.
 * Everything is 4-byte aligned, as the firmware validator requires for 32 bit
 * variables.
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
const LINE_HEIGHT = 16;
const SCREEN_WIDTH = 178;

const align4 = (n: number) => (n + 3) & ~3;

class Memory {
  size = 0;
  alloc(bytes: number): number {
    const offset = align4(this.size);
    this.size = offset + bytes;
    return offset;
  }
}

class Thread {
  code = new CodeBuffer();
  locals = new Memory();
  loops: { exit: Label; next: Label }[] = [];
  /** Parameters of the "Eigener Block" being inlined, by variable id. */
  scope: Map<string, Val> | null = null;
  returns: { label: Label; result?: Val }[] = [];
  calls: string[] = [];
}

const num = (k: number): Val => ({ ty: 'num', op: lcf(k), k });
const bool = (k: boolean): Val => ({ ty: 'bool', op: lc(k ? 1 : 0), k });
const str = (k: string): Val => ({ ty: 'str', op: lcs(k), k });
const isNum = (v: Val): v is Val & { k: number } => typeof v.k === 'number';
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export interface RbfResult {
  image: Uint8Array;
  warnings: string[];
}

export function compileRbf(workspace: Blockly.Workspace): RbfResult {
  return new Compiler(workspace).compile();
}

class Compiler {
  private globals = new Memory();
  private variables = new Map<string, Val>();
  private varTypes = new Map<string, Ty>();
  private warnings = new Set<string>();
  private timerStart = this.globals.alloc(4);
  private t = new Thread();

  constructor(private workspace: Blockly.Workspace) {}

  compile(): RbfResult {
    const starts = this.workspace.getTopBlocks(true).filter((b) => b.type === 'ev3_start' && b.isEnabled());
    if (starts.length === 0) throw new RbfError('Kein „Programmstart“-Block gefunden.');
    this.inferVariableTypes();
    const usesDisplay = this.workspace.getAllBlocks(false).some((b) => b.type.startsWith('ev3_display') && b.isEnabled());

    const threads = starts.map((start, i) => {
      this.t = new Thread();
      const c = this.t.code;
      if (i === 0) {
        c.op(op.TIMER_READ, gv(this.timerStart));
        if (usesDisplay) this.clearDisplay();
        for (let id = 2; id <= starts.length; id++) c.op(op.OBJECT_START, lc(id));
      }
      this.statements(start.getNextBlock());
      c.op(op.OBJECT_END);
      return { code: c, localBytes: align4(this.t.locals.size) };
    });
    return { image: buildImage(align4(this.globals.size), threads), warnings: [...this.warnings] };
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
    if (v.ty === 'str') throw new RbfError('Hier wird eine Zahl gebraucht, nicht ein Text.', block.id);
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

  private arith(code: number | number[], a: Val, b: Val, fold: (x: number, y: number) => number): Val {
    if (isNum(a) && isNum(b)) return num(fold(a.k, b.k));
    const r = this.tmp('num');
    this.t.code.op(code, a.op, b.op, r);
    return { ty: 'num', op: r };
  }

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

  private expr(block: Blockly.Block): Val {
    const c = this.t.code;
    const f = (name: string) => block.getFieldValue(name);
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
          case 'ADD': return this.arith(op.ADDF, a, b, (x, y) => x + y);
          case 'MINUS': return this.arith(op.SUBF, a, b, (x, y) => x - y);
          case 'MULTIPLY': return this.arith(op.MULF, a, b, (x, y) => x * y);
          case 'DIVIDE': return this.arith(op.DIVF, a, b, (x, y) => x / y);
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
        const r = this.tmp('bool');
        const cmp = f('OP') as string;
        if (a.ty === 'str' || b.ty === 'str') {
          if (cmp !== 'EQ' && cmp !== 'NEQ') throw new RbfError('Texte lassen sich auf dem EV3 nur auf „=“ oder „≠“ vergleichen.', block.id);
          c.op([op.STRINGS, strings.COMPARE], this.toStr(a).op, this.toStr(b).op, r);
          if (cmp === 'NEQ') c.op(op.CP_EQ8, r, lc(0), r);
          return { ty: 'bool', op: r };
        }
        const codes: Record<string, number> = { EQ: op.CP_EQF, NEQ: op.CP_NEQF, LT: op.CP_LTF, LTE: op.CP_LTEQF, GT: op.CP_GTF, GTE: op.CP_GTEQF };
        c.op(codes[cmp], this.toNum(a, block).op, this.toNum(b, block).op, r);
        return { ty: 'bool', op: r };
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
      case 'logic_negate': {
        const a = this.boolIn(block, 'BOOL');
        if (typeof a.k === 'boolean') return bool(!a.k);
        const r = this.tmp('bool');
        c.op(op.CP_EQ8, a.op, lc(0), r);
        return { ty: 'bool', op: r };
      }

      case 'text_join': {
        let result: Val = str('');
        for (let i = 0; block.getInput('ADD' + i); i++) {
          const item = this.toStr(this.input(block, 'ADD' + i, str('')));
          if (typeof result.k === 'string' && typeof item.k === 'string') {
            result = str(result.k + item.k);
            continue;
          }
          const r = this.tmp('str');
          c.op([op.STRINGS, strings.ADD], result.op, item.op, r);
          result = { ty: 'str', op: r };
        }
        return result;
      }

      case 'ev3_touch':
        return this.compare(op.CP_GTF, this.readSensor(f('PORT'), 0), 0.5);
      case 'ev3_color':
      case 'ev3_gyro':
        return this.readSensor(f('PORT'), Number(f('MODE')));
      case 'ev3_ultrasonic':
      case 'ev3_infrared':
        return this.readSensor(f('PORT'), 0);
      case 'ev3_color_is': {
        const color = this.mathOp(math.ROUND, this.readSensor(f('PORT'), 2), Math.round);
        return this.compare(op.CP_EQF, color, Number(f('COLOR')));
      }
      case 'ev3_motor_degrees':
        return this.readSensor(f('PORT'), f('MODE') === 'speed' ? 2 : 0);
      case 'ev3_button': {
        const r = this.tmp('bool');
        c.op([op.UI_BUTTON, uiButton.PRESSED], lc(BUTTONS[f('BUTTON') as ButtonName]), r);
        return { ty: 'bool', op: r };
      }
      case 'ev3_timer': {
        const now = this.tmp('int');
        const r = this.tmp('num');
        c.op(op.TIMER_READ, now);
        c.op(op.SUB32, now, gv(this.timerStart), now);
        c.op(op.MOVE32_F, now, r);
        c.op(op.DIVF, r, lcf(1000), r);
        return { ty: 'num', op: r };
      }
    }
    throw new RbfError(`Der Block „${blockLabel(block)}“ kann noch nicht auf den EV3 übertragen werden.`, block.id);
  }

  private compare(code: number, v: Val, k: number): Val {
    const r = this.tmp('bool');
    this.t.code.op(code, v.op, lcf(k), r);
    return { ty: 'bool', op: r };
  }

  private readSensor(port: string, mode: number): Val {
    const r = this.tmp('num');
    this.t.code.op(op.INPUT_READSI, LAYER, lc(inputPortNumber(port as Port)), lc(0), lc(mode), r);
    return { ty: 'num', op: r };
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

  private statement(block: Blockly.Block): void {
    const c = this.t.code;
    const f = (name: string) => block.getFieldValue(name);
    const ports = () => lc(portMask((f('PORT') as string).split('')));
    const brake = () => lc(f('BRAKE') === 'TRUE' ? 1 : 0);

    switch (block.type) {
      case 'ev3_wait': {
        const ms = this.int(this.arith(op.MULF, this.numIn(block, 'SECONDS', 1), num(1000), (x, y) => x * y), 32);
        const timer = this.tmp('int');
        c.op(op.TIMER_WAIT, ms, timer);
        c.op(op.TIMER_READY, timer);
        return;
      }
      case 'ev3_wait_until':
        return this.loop((exit, next) => {
          c.place(next);
          c.jump(op.JR_TRUE, exit, this.boolIn(block, 'COND').op);
          c.op(op.SLEEP); // give other threads a turn while waiting
          c.jump(op.JR, next);
        });
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
          const done = this.tmp('bool');
          c.op(op.CP_LTEQF, count.op, lcf(0), done);
          c.jump(op.JR_TRUE, exit, done);
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
      case 'controls_flow_statements': {
        const loop = this.t.loops.at(-1);
        if (!loop) throw new RbfError('„Schleife abbrechen“ steht nicht in einer Schleife.', block.id);
        c.jump(op.JR, f('FLOW') === 'BREAK' ? loop.exit : loop.next);
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

      case 'ev3_motor_on':
        c.op(op.OUTPUT_SPEED, LAYER, ports(), this.speed(block));
        c.op(op.OUTPUT_START, LAYER, ports());
        return;
      case 'ev3_motor_off':
        c.op(op.OUTPUT_STOP, LAYER, ports(), brake());
        return;
      case 'ev3_motor_reset':
        c.op(op.OUTPUT_CLR_COUNT, LAYER, ports());
        return;
      case 'ev3_motor_for':
        return this.runFor(block, null);
      case 'ev3_steer_on':
        c.op(op.OUTPUT_STEP_SYNC, LAYER, ports(), this.speed(block), this.turn(block), lc(0), lc(1));
        return;
      case 'ev3_steer_for':
        return this.runFor(block, this.turn(block));

      case 'ev3_display_text': {
        const text = this.toStr(this.input(block, 'TEXT', str('')));
        const line = this.clampNum(this.numIn(block, 'LINE', 1), 1, 8);
        const y = this.int(this.arith(op.MULF, this.arith(op.SUBF, line, num(1), (a, b) => a - b), num(LINE_HEIGHT), (a, b) => a * b), 16);
        c.op([op.UI_DRAW, uiDraw.FILLRECT], lc(0), lc(0), y, lc(SCREEN_WIDTH), lc(LINE_HEIGHT));
        c.op([op.UI_DRAW, uiDraw.SELECT_FONT], lc(0));
        c.op([op.UI_DRAW, uiDraw.TEXT], lc(1), lc(0), y, text.op);
        c.op([op.UI_DRAW, uiDraw.UPDATE]);
        return;
      }
      case 'ev3_display_clear':
        this.clearDisplay();
        return;
      case 'ev3_tone': {
        const volume = this.int(this.clampNum(this.numIn(block, 'VOLUME', 50), 0, 100), 8);
        const freq = this.int(this.clampNum(this.numIn(block, 'FREQ', 440), 250, 10000), 16);
        const ms = this.clampNum(this.arith(op.MULF, this.numIn(block, 'SECONDS', 0.5), num(1000), (a, b) => a * b), 1, 32767);
        c.op([op.SOUND, sound.TONE], volume, freq, this.int(ms, 16));
        if (f('WAIT') === 'TRUE') c.op(op.SOUND_READY);
        return;
      }
      case 'ev3_led':
        c.op([op.UI_WRITE, uiWrite.LED], lc(LED_PATTERNS[f('PATTERN') as LedPattern]));
        return;
      case 'ev3_timer_reset':
        c.op(op.TIMER_READ, gv(this.timerStart));
        return;
      case 'ev3_print':
        this.warnings.add('„in der App ausgeben“ hat auf dem EV3 keine Wirkung (es gibt dort keine App-Ausgabe).');
        return;
    }
    throw new RbfError(`Der Block „${blockLabel(block)}“ kann noch nicht auf den EV3 übertragen werden.`, block.id);
  }

  private speed(block: Blockly.Block): Operand {
    return this.int(this.clampNum(this.numIn(block, 'SPEED', 50), -100, 100), 8);
  }

  /** Steering -100..100 as in the EV3 software; the firmware wants -200..200. */
  private turn(block: Blockly.Block): Operand {
    const steering = this.numIn(block, 'STEERING');
    return this.int(this.clampNum(this.arith(op.MULF, steering, num(2), (a, b) => a * b), -200, 200), 16);
  }

  /** "Motor/Lenken ... für x Umdrehungen/Grad/Sekunden": start and wait until done. */
  private runFor(block: Blockly.Block, turn: Operand | null): void {
    const c = this.t.code;
    const ports = lc(portMask((block.getFieldValue('PORT') as string).split('')));
    const brake = lc(block.getFieldValue('BRAKE') === 'TRUE' ? 1 : 0);
    const unit = block.getFieldValue('UNIT') as string;
    const amount = this.numIn(block, 'AMOUNT', 1);
    const end = c.label();
    const factor = unit === 'rotations' ? 360 : unit === 'seconds' ? 1000 : 1;
    let value = this.mathOp(math.ROUND, this.arith(op.MULF, amount, num(factor), (a, b) => a * b), Math.round);
    let speed = this.clampNum(this.numIn(block, 'SPEED', 50), -100, 100);

    if (unit === 'seconds') {
      if (isNum(value) && value.k <= 0) return;
      if (!isNum(value)) {
        const none = this.tmp('bool');
        c.op(op.CP_LTEQF, value.op, lcf(0), none);
        c.jump(op.JR_TRUE, end, none);
      }
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
      const flag = this.tmp('bool');
      c.op(op.CP_LTF, value.op, lcf(0), flag);
      c.jump(op.JR_FALSE, forward, flag);
      c.op([op.MATH, math.NEGATE], value.op, value.op);
      c.op([op.MATH, math.NEGATE], speed.op, speed.op);
      c.place(forward);
      c.op(op.CP_EQF, value.op, lcf(0), flag);
      c.jump(op.JR_TRUE, end, flag);
    }

    const s = this.int(speed, 8);
    const amount32 = this.int(value, 32);
    if (turn) {
      c.op(unit === 'seconds' ? op.OUTPUT_TIME_SYNC : op.OUTPUT_STEP_SYNC, LAYER, ports, s, turn, amount32, brake);
    } else {
      c.op(unit === 'seconds' ? op.OUTPUT_TIME_SPEED : op.OUTPUT_STEP_SPEED, LAYER, ports, s, lc(0), amount32, lc(0), brake);
    }
    c.op(op.OUTPUT_READY, LAYER, ports);
    c.place(end);
  }

  private clearDisplay(): void {
    this.t.code.op([op.UI_DRAW, uiDraw.FILLWINDOW], lc(0), lc(0), lc(0));
    this.t.code.op([op.UI_DRAW, uiDraw.UPDATE]);
  }

  // --- Eigene Blöcke --------------------------------------------------------------

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
