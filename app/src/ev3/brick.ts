import type { ButtonName, LedPattern } from './bytecodes';
import type { BrickFiles } from './files';

export type MotorPort = 'A' | 'B' | 'C' | 'D';
export type SensorPort = '1' | '2' | '3' | '4';
export type Port = MotorPort | SensorPort;

export const MOTOR_PORTS: MotorPort[] = ['A', 'B', 'C', 'D'];
export const SENSOR_PORTS: SensorPort[] = ['1', '2', '3', '4'];
export const ALL_PORTS: Port[] = [...SENSOR_PORTS, ...MOTOR_PORTS];

/** Port number as used by the opINPUT_* opcodes (motors are readable as 16-19). */
export function inputPortNumber(port: Port): number {
  const motor = MOTOR_PORTS.indexOf(port as MotorPort);
  return motor >= 0 ? 16 + motor : Number(port) - 1;
}

export interface PortState {
  port: Port;
  type: number;
  mode: number;
}

/**
 * Everything the app can do with a brick. Implemented by the real brick
 * (direct commands over a transport) and by the in-browser simulator.
 *
 * Speeds are in percent (-100..100), turn ratios in -200..200 as in the firmware.
 */
export interface Brick {
  readonly name: string;

  motorStart(ports: MotorPort[], speed: number): Promise<void>;
  motorStop(ports: MotorPort[], brake: boolean): Promise<void>;
  motorRunDegrees(ports: MotorPort[], speed: number, degrees: number, brake: boolean): Promise<void>;
  motorRunTime(ports: MotorPort[], speed: number, ms: number, brake: boolean): Promise<void>;
  /** Starts two motors synchronized; `degrees` 0 means run until stopped. */
  steerDegrees(ports: MotorPort[], speed: number, turn: number, degrees: number, brake: boolean): Promise<void>;
  steerTime(ports: MotorPort[], speed: number, turn: number, ms: number, brake: boolean): Promise<void>;
  motorBusy(ports: MotorPort[]): Promise<boolean>;
  motorResetCount(ports: MotorPort[]): Promise<void>;

  /** Reads a port in the given mode as SI value (degrees, cm, percent, ...). */
  readPort(port: Port, mode: number): Promise<number>;
  /** Reads several ports in one round trip (used by the device view). */
  readPorts(requests: { port: Port; mode: number }[]): Promise<number[]>;
  /** Type and mode of all eight ports. */
  readPortStates(): Promise<PortState[]>;

  playTone(volume: number, frequency: number, ms: number): Promise<void>;
  stopSound(): Promise<void>;
  setLed(pattern: LedPattern): Promise<void>;
  buttonPressed(button: ButtonName): Promise<boolean>;
  displayText(text: string, line: number): Promise<void>;
  displayClear(): Promise<void>;
  battery(): Promise<{ voltage: number; percent: number }>;

  /** Files and programs on the brick; missing for the simulator. */
  readonly files?: BrickFiles;

  close(): void;
}
