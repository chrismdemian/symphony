import { EventEmitter } from 'node:events';
import type { ToolMode } from './types.js';

export interface ModeChangeEvent {
  previous: ToolMode;
  next: ToolMode;
  reason: string;
}

export interface ModeControllerOptions {
  initial?: ToolMode;
}

type Listener = (event: ModeChangeEvent) => void;

export class ModeController {
  private readonly emitter = new EventEmitter();
  private current: ToolMode;

  constructor(options: ModeControllerOptions = {}) {
    this.current = options.initial ?? 'plan';
    this.emitter.setMaxListeners(0);
  }

  get mode(): ToolMode {
    return this.current;
  }

  setMode(next: ToolMode, reason = ''): boolean {
    if (next === this.current) return false;
    const event: ModeChangeEvent = { previous: this.current, next, reason };
    this.current = next;
    this.emitter.emit('change', event);
    return true;
  }

  onChange(listener: Listener): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }
}
