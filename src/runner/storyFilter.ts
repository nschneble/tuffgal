/**
 * Shared `--story` filter semantics. Matches by exact filename, by
 * filename minus the `.json` suffix, or by the story's prose title
 * (`story.story`). Keeps `tuffgal run --story` and `tuffgal approve
 * --story` in lock-step.
 */
export function storyMatchesFilter(
  candidate: { file: string; storyName: string },
  filter: string,
): boolean {
  return (
    candidate.file === filter ||
    candidate.file === `${filter}.json` ||
    candidate.storyName === filter
  );
}

/**
 * Normalises a positional story argument (`tuffgal approve user-logs-in`) into
 * the form `storyMatchesFilter` expects. A path-shaped argument
 * (`tuffgal/stories/user-logs-in.json`) reduces to its basename so it matches
 * `story.file`; a bare name passes through untouched (the `.json` suffix stays
 * optional, since `storyMatchesFilter` accepts the name with or without it).
 */
export function normaliseStoryArg(arg: string): string {
  const slash = Math.max(arg.lastIndexOf('/'), arg.lastIndexOf('\\'));
  return slash === -1 ? arg : arg.slice(slash + 1);
}
