import test from "node:test";
import assert from "node:assert/strict";
import { bosses, nextBoss, escapeHtml, RANKING } from "../src/game.js";

test("bosses get harder in ranking order", () => {
  const b = bosses();
  for (let i = 1; i < b.length; i++) assert.ok(b[i].hp > b[i - 1].hp);
});
test("last boss is the best pen", () => {
  assert.equal(bosses().at(-1).name, RANKING.at(-1));
});
test("empty ranking yields no boss", () => {
  assert.equal(nextBoss([], 0), null);
});
test("brand names are escaped", () => {
  assert.equal(escapeHtml("<b>"), "&lt;b&gt;");
});
