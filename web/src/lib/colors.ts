// A small fixed palette (Monday.com-style accent colors) used to give every
// person a stable, distinct color across the app — task board groups,
// avatars in the sidebar/employee list, etc. — derived deterministically
// from their id so the same person always gets the same color.
export const PERSON_PALETTE = [
  "#579bfc", "#a25ddc", "#ff642e", "#00c875", "#fdab3d",
  "#e2445c", "#66ccff", "#037f4c", "#784bd1", "#ff158a", "#bb3354",
];

export function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PERSON_PALETTE[hash % PERSON_PALETTE.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
