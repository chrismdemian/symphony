export { startOrchestratorServer } from './server.js';
export type { OrchestratorServerHandle, OrchestratorServerOptions } from './server.js';
export { ModeController } from './mode.js';
export type { ModeChangeEvent, ModeControllerOptions } from './mode.js';
export { AgentSafetyGuard } from './safety.js';
export type { SafetyGuardOptions } from './safety.js';
export { CapabilityEvaluator, DEFAULT_DISPATCH_CONTEXT } from './capabilities.js';
export { ToolRegistry, DuplicateToolRegistrationError } from './registry.js';
export type { ToolRegistration, ToolRegistryOptions } from './registry.js';
export {
  SafetyGuardError,
  CapabilityDeniedError,
} from './types.js';
export type {
  AutonomyTier,
  CapabilityDecision,
  CapabilityFlag,
  DispatchContext,
  SafetyGuardStats,
  SafetyRejectionReason,
  ToolMode,
  ToolScope,
  WorkerRole,
} from './types.js';
export { WORKER_ROLES } from './types.js';
export {
  WorkerRegistry,
  CircularBuffer,
  DEFAULT_OUTPUT_BUFFER_CAP,
  toSnapshot,
} from './worker-registry.js';
export type { WorkerRecord, WorkerRecordSnapshot, WorkerLookupMatch } from './worker-registry.js';
export { createWorkerLifecycle } from './worker-lifecycle.js';
export type {
  WorkerLifecycleHandle,
  WorkerLifecycleOptions,
  SpawnWorkerInput,
  ResumeWorkerInput,
} from './worker-lifecycle.js';
export { deriveFeatureIntent, matchesFeatureIntent } from './feature-intent.js';
export {
  ProjectRegistry,
  DuplicateProjectError,
  projectRegistryFromMap,
  toProjectSnapshot,
} from '../projects/registry.js';
export type {
  ProjectRecord,
  ProjectSnapshot,
  ProjectStore,
  ProjectRegistryListFilter,
} from '../projects/types.js';
export {
  TaskRegistry,
  toTaskSnapshot,
} from '../state/task-registry.js';
export {
  TASK_STATUSES,
  TASK_TRANSITIONS,
  canTransition,
  isTerminalStatus,
  InvalidTaskTransitionError,
  UnknownTaskError,
} from '../state/types.js';
export type {
  TaskRecord,
  TaskSnapshot,
  TaskStore,
  TaskStatus,
  TaskNote,
  TaskListFilter,
  CreateTaskInput,
  TaskPatch,
} from '../state/types.js';
export {
  QuestionRegistry,
  AlreadyAnsweredError,
  UnknownQuestionError,
  toQuestionSnapshot,
} from '../state/question-registry.js';
export type {
  QuestionRecord,
  QuestionSnapshot,
  QuestionStore,
  QuestionUrgency,
  QuestionListFilter,
  EnqueueQuestionInput,
} from '../state/question-registry.js';
export {
  WaveRegistry,
  UnknownWaveError,
  toWaveSnapshot,
} from './research-wave-registry.js';
export type {
  WaveRecord,
  WaveSnapshot,
  WaveStore,
  WaveListFilter,
  EnqueueWaveInput,
} from './research-wave-registry.js';
