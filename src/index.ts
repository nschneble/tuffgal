// Public API surface. Consumer projects import only what is re-exported here.
// Anything not re-exported is internal and may break between minor releases.

export {
  defineConfig,
  loadConfig,
  type TuffgalConfig,
  type ResolvedConfig,
  type DatabaseBridge,
  type DevServerBridge,
  type PathsConfig,
  type CiConfig,
} from './config.ts';

export { runAll, type RunCliOptions } from './runner/run.ts';
export { approveAll, type ApproveOptions } from './runner/approve.ts';
export { supervise, type SuperviseOptions } from './commands/supervise.ts';
export { init, type InitOptions } from './commands/init.ts';

export type { Action, Step, Hint } from './schema/action.ts';
export type { Story } from './schema/story.ts';
export type {
  RunResult,
  StoryResult,
  ActionResult,
  ActionStatus,
  StoryStatus,
} from './schema/result.ts';
