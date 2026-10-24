// Opcodes and constants of the EV3 firmware (LMS2012), see
// "LEGO MINDSTORMS EV3 Firmware Developer Kit" and "Communication Developer Kit".

export const DIRECT_COMMAND_REPLY = 0x00;
export const DIRECT_COMMAND_NO_REPLY = 0x80;
export const DIRECT_REPLY = 0x02;
export const DIRECT_REPLY_ERROR = 0x04;

export const op = {
  PROGRAM_STOP: 0x02,
  PROGRAM_START: 0x03,
  OBJECT_START: 0x05,
  OBJECT_END: 0x0a,
  SLEEP: 0x0b,
  ADDF: 0x13,
  SUB32: 0x16,
  SUBF: 0x17,
  MULF: 0x1b,
  DIVF: 0x1f,
  OR8: 0x20,
  AND8: 0x24,
  MOVE8_8: 0x30,
  MOVE8_F: 0x33,
  MOVE16_F: 0x37,
  MOVE32_F: 0x3b,
  MOVEF_8: 0x3c,
  MOVEF_16: 0x3d,
  MOVEF_32: 0x3e,
  MOVEF_F: 0x3f,
  JR: 0x40,
  JR_FALSE: 0x41,
  JR_TRUE: 0x42,
  CP_LTF: 0x47,
  CP_GTF: 0x4b,
  CP_EQ8: 0x4c,
  CP_EQF: 0x4f,
  CP_NEQF: 0x53,
  CP_LTEQF: 0x57,
  CP_GTEQF: 0x5b,
  SELECTF: 0x5f,
  STRINGS: 0x7d,
  TIMER_WAIT: 0x85,
  TIMER_READY: 0x86,
  TIMER_READ: 0x87,
  MATH: 0x8d,
  RANDOM: 0x8e,
  SOUND_READY: 0x96,
  OUTPUT_READY: 0xaa,
  FILE: 0xc0,
  UI_READ: 0x81,
  UI_WRITE: 0x82,
  UI_BUTTON: 0x83,
  UI_DRAW: 0x84,
  SOUND: 0x94,
  INPUT_DEVICE: 0x99,
  INPUT_READSI: 0x9d,
  OUTPUT_RESET: 0xa2,
  OUTPUT_STOP: 0xa3,
  OUTPUT_POWER: 0xa4,
  OUTPUT_SPEED: 0xa5,
  OUTPUT_START: 0xa6,
  OUTPUT_TEST: 0xa9,
  OUTPUT_STEP_SPEED: 0xae,
  OUTPUT_TIME_SPEED: 0xaf,
  OUTPUT_STEP_SYNC: 0xb0,
  OUTPUT_TIME_SYNC: 0xb1,
  OUTPUT_CLR_COUNT: 0xb2,
  OUTPUT_GET_COUNT: 0xb3,
  COM_GET: 0xd3,
} as const;

export const uiRead = { GET_VBATT: 1, GET_LBATT: 18 } as const;
export const uiWrite = { LED: 27 } as const;
export const uiButton = { PRESSED: 9 } as const;
export const uiDraw = { UPDATE: 0, TEXT: 5, FILLRECT: 9, SELECT_FONT: 17, FILLWINDOW: 19 } as const;
export const sound = { BREAK: 0, TONE: 1 } as const;
export const inputDevice = { GET_TYPEMODE: 5, GET_NAME: 21 } as const;
export const comGet = { GET_BRICKNAME: 13 } as const;
export const math = { EXP: 1, MOD: 2, FLOOR: 3, CEIL: 4, ROUND: 5, ABS: 6, NEGATE: 7, SQRT: 8, LOG: 9, LN: 10, POW: 20 } as const;
export const strings = { ADD: 2, COMPARE: 3, DUPLICATE: 5, VALUE_FORMATTED: 11 } as const;
export const file = { LOAD_IMAGE: 8 } as const;
/** Program slot for user programs (opFILE LOAD_IMAGE, opPROGRAM_START/STOP). */
export const USER_SLOT = 1;

// System commands (file transfer), see c_com.h.
export const SYSTEM_COMMAND_REPLY = 0x01;
export const SYSTEM_REPLY = 0x03;
export const SYSTEM_REPLY_ERROR = 0x05;
export const sys = {
  BEGIN_DOWNLOAD: 0x92,
  CONTINUE_DOWNLOAD: 0x93,
  BEGIN_UPLOAD: 0x94,
  CONTINUE_UPLOAD: 0x95,
  LIST_FILES: 0x99,
  DELETE_FILE: 0x9c,
} as const;
export const SYSTEM_OK = 0;
export const SYSTEM_END_OF_FILE = 8;

/** Button numbers for opUI_BUTTON. */
export const BUTTONS = { up: 1, enter: 2, down: 3, right: 4, left: 5, back: 6, any: 7 } as const;
export type ButtonName = keyof typeof BUTTONS;

/** LED patterns for opUI_WRITE LED. */
export const LED_PATTERNS = {
  off: 0,
  green: 1,
  red: 2,
  orange: 3,
  green_flash: 4,
  red_flash: 5,
  orange_flash: 6,
  green_pulse: 7,
  red_pulse: 8,
  orange_pulse: 9,
} as const;
export type LedPattern = keyof typeof LED_PATTERNS;
