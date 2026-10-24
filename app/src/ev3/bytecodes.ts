// Opcodes and constants of the EV3 firmware (LMS2012), see
// "LEGO MINDSTORMS EV3 Firmware Developer Kit" and "Communication Developer Kit".

export const DIRECT_COMMAND_REPLY = 0x00;
export const DIRECT_COMMAND_NO_REPLY = 0x80;
export const DIRECT_REPLY = 0x02;
export const DIRECT_REPLY_ERROR = 0x04;

export const op = {
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
