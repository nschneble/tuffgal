import { readFile, readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { join } from 'node:path';
import { actionSchema, type Action } from './action.ts';
import { storySchema, type Story } from './story.ts';

/**
 * Loads every action JSON file under the configured actions directory and
 * returns a name -> Action map. Throws a typed `LoadError` on the first
 * parse failure so the CLI can print the file path next to the validation
 * error.
 */
export async function loadActions(
  actionsDir: string,
): Promise<Map<string, Action>> {
  const files = await readJsonFiles(actionsDir);
  const actions = new Map<string, Action>();
  for (const { path, contents } of files) {
    const parsed = actionSchema.safeParse(contents);
    if (!parsed.success) {
      throw new LoadError(path, parsed.error.message);
    }
    if (actions.has(parsed.data.action)) {
      throw new LoadError(
        path,
        `duplicate action name "${parsed.data.action}"`,
      );
    }
    actions.set(parsed.data.action, parsed.data);
  }
  return actions;
}

export interface StoryFile {
  file: string;
  story: Story;
}

export async function loadStories(storiesDir: string): Promise<StoryFile[]> {
  const files = await readJsonFiles(storiesDir);
  const stories: StoryFile[] = [];
  for (const { path, contents } of files) {
    const parsed = storySchema.safeParse(contents);
    if (!parsed.success) {
      throw new LoadError(path, parsed.error.message);
    }
    stories.push({ file: basename(path), story: parsed.data });
  }
  return stories;
}

interface JsonFile {
  path: string;
  contents: unknown;
}

async function readJsonFiles(directory: string): Promise<JsonFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const subdirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const jsonNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  const files: JsonFile[] = [];
  for (const name of jsonNames) {
    const path = join(directory, name);
    const raw = await readFile(path, 'utf8');
    try {
      files.push({ path, contents: JSON.parse(raw) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid JSON';
      throw new LoadError(path, message);
    }
  }
  for (const subdirectory of subdirectories) {
    const nested = await readJsonFiles(join(directory, subdirectory));
    files.push(...nested);
  }
  return files;
}

export class LoadError extends Error {
  readonly path: string;
  readonly reason: string;
  constructor(path: string, reason: string) {
    super(`Failed to load ${path}: ${reason}`);
    this.name = 'LoadError';
    this.path = path;
    this.reason = reason;
  }
}
