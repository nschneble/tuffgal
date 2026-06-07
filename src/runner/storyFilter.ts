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
