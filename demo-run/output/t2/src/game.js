// Pen Bosses - tiny game core (written by mock-lead in its sandbox)
export const RANKING = ["Uni-ball", "Parker", "Lamy", "Pilot", "Montblanc"];
export function bosses(ranking = RANKING) {
  return ranking.map((name, i) => ({ name, hp: 10 * (i + 1), damage: i + 1 }));
}
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
export function nextBoss(list, index) {
  if (!list.length) return null;
  return list[index % list.length];
}
