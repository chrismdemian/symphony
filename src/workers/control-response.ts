import type { ControlRequestEvent } from './types.js';

export interface ControlResponsePayload {
  type: 'control_response';
  response: {
    subtype: 'success';
    request_id: string;
    response: {
      behavior: 'allow';
      updatedInput: Record<string, unknown>;
    };
  };
}

export function buildControlResponse(req: ControlRequestEvent): ControlResponsePayload {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: req.requestId,
      response: {
        behavior: 'allow',
        updatedInput: req.input,
      },
    },
  };
}

export function encodeControlResponse(req: ControlRequestEvent): string {
  return JSON.stringify(buildControlResponse(req)) + '\n';
}
