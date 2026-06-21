// Public API. Consumer projects only import what's exported here. Anything
// else comes with a giant "DON'T DO IT" sticker and may change, break, or
// straight up disappear between releases.

export {
  BREAKPOINTS,
  defineConfig,
  loadConfig,
  type BreakpointName,
  type BreakpointSelector,
  type DatabaseBridge,
  type DevServerBridge,
  type PathsConfig,
  type ResolvedConfig,
  type TuffgalConfig,
} from './config.ts';

export { init, type InitOptions } from './commands/init.ts';
export { supervise, type SuperviseOptions } from './commands/supervise.ts';

export { approveAll, type ApproveOptions } from './runner/approve.ts';
export { runAll, type RunCliOptions } from './runner/run.ts';

export type { Action, Hint, Step } from './schema/action.ts';
export type { Story } from './schema/story.ts';
export type {
  ActionResult,
  ActionStatus,
  RunResult,
  StoryResult,
  StoryStatus,
} from './schema/result.ts';
