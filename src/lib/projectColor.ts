/**
 * The project swatch palette, and how a project gets one.
 *
 * A colour is assigned and stored when a project is created. Projects that
 * predate that — anything imported from Excel, or created before the field
 * existed — have `color: null`, and every one of them used to fall back to a
 * single accent, so the whole list wore the same dot and the swatch told you
 * nothing.
 *
 * The fallback is now derived from the project's id instead. It is stable
 * (same project, same colour, on every device and across reloads) and needs no
 * write, so nothing has to be migrated.
 */
export const PROJECT_COLORS = [
  "#1f6f68",
  "#a64b2a",
  "#5b6c5d",
  "#3f5f8f",
  "#7a5c99",
  "#8a6a23",
  "#8a3f5a",
  "#2f6f8f",
  "#6b7a3a",
  "#5a4a8a"
];

interface Swatchable {
  id: string;
  color?: string | null;
}

/**
 * Colour every project in a list, assigning the ones without a stored colour.
 *
 * Done over the whole list rather than per project so the result can be
 * DISTINCT: hashing each id independently collides well before the palette is
 * full (12 projects landed on 8 colours in practice), which is exactly the
 * thing the swatch exists to avoid. Stored colours are honoured first and the
 * rest fill from the unused remainder, so no two projects share a dot until
 * there are more projects than colours.
 */
export function buildSwatchMap(...lists: Swatchable[][]): Map<string, string> {
  const projects = lists.flat();
  const swatches = new Map<string, string>();
  const taken = new Set<string>();

  for (const project of projects) {
    const stored = project.color?.trim();
    if (!stored) continue;
    swatches.set(project.id, stored);
    taken.add(stored.toLowerCase());
  }

  let cursor = 0;
  for (const project of projects) {
    if (swatches.has(project.id)) continue;
    let picked = PROJECT_COLORS[cursor % PROJECT_COLORS.length];
    for (let step = 0; step < PROJECT_COLORS.length; step += 1) {
      const candidate = PROJECT_COLORS[(cursor + step) % PROJECT_COLORS.length];
      if (!taken.has(candidate.toLowerCase())) {
        picked = candidate;
        cursor += step + 1;
        break;
      }
      // Every colour is spoken for — wrap and let them repeat from here.
      if (step === PROJECT_COLORS.length - 1) cursor += 1;
    }
    swatches.set(project.id, picked);
    taken.add(picked.toLowerCase());
  }

  return swatches;
}
