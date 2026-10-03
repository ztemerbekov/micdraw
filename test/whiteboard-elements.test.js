import assert from "node:assert/strict";
import { test } from "node:test";

import { detectMalformedLayoutWarnings, fitShapesToLabels } from "../src/whiteboard-elements.js";

test("fitShapesToLabels returns an empty array for non-array input", () => {
  assert.deepEqual(fitShapesToLabels(undefined), []);
});

test("detectMalformedLayoutWarnings flags a standalone text overlapping a shape", () => {
  const warnings = detectMalformedLayoutWarnings([
    { type: "rectangle", id: "card", x: 100, y: 100, width: 300, height: 100 },
    { type: "text", id: "loose-text", x: 110, y: 110, text: "OpenAI", fontSize: 24 },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /standalone text "OpenAI"/);
  assert.match(warnings[0], /id "loose-text"/);
  assert.match(warnings[0], /shape "card"/);
  assert.match(warnings[0], /label/);
});

test("detectMalformedLayoutWarnings does NOT flag standalone text placed clearly outside any shape", () => {
  const warnings = detectMalformedLayoutWarnings([
    { type: "rectangle", id: "card", x: 100, y: 100, width: 300, height: 100 },
    { type: "text", id: "title", x: 0, y: 0, text: "Section title", fontSize: 24 },
  ]);
  assert.equal(warnings.length, 0);
});

test("detectMalformedLayoutWarnings flags a labeled shape that is too narrow for its label", () => {
  const warnings = detectMalformedLayoutWarnings([
    {
      type: "rectangle",
      id: "narrow",
      x: 0,
      y: 0,
      width: 80,
      height: 100,
      label: { text: "Realtime-2 voice generation", fontSize: 18 },
    },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /shape "narrow" is 80px wide/);
  assert.match(warnings[0], /shorten the label/);
});

test("detectMalformedLayoutWarnings is silent on a properly-sized labeled shape", () => {
  const warnings = detectMalformedLayoutWarnings([
    {
      type: "rectangle",
      id: "ok",
      x: 0,
      y: 0,
      width: 400,
      height: 90,
      label: { text: "OpenAI", fontSize: 18 },
    },
  ]);
  assert.equal(warnings.length, 0);
});

test("detectMalformedLayoutWarnings measures labels with Excalidraw's 5 px padding, not 24 px", () => {
  // From a real session: "смысловые задачи" at 18 px is about 173 px wide, so a
  // 220 px card fits it with Excalidraw's padding. The old 24 px rule wanted
  // 221 px and cost a whole extra agent pass.
  const warnings = detectMalformedLayoutWarnings([
    {
      type: "rectangle",
      id: "perf-3",
      x: 680,
      y: 130,
      width: 220,
      height: 110,
      label: { text: "Выделить\nсмысловые задачи", fontSize: 18 },
    },
  ]);
  assert.deepEqual(warnings, []);
});

// "Replay real turns on each model" is 31 characters: about 335 px at 18 px.
const longLabel = { text: "Replay real turns on each model", fontSize: 18 };
const card = { type: "rectangle", id: "card", x: 100, y: 100, width: 249, height: 110, label: longLabel };

test("fitShapesToLabels widens a shape around its centre to fit its label with 24 px of padding", () => {
  const fitted = fitShapesToLabels([card]);
  assert.deepEqual(fitted, [{ ...card, x: 33, width: 383 }]);
  assert.deepEqual(detectMalformedLayoutWarnings(fitted), []);
});

test("fitShapesToLabels settles for Excalidraw's own padding when the roomier size would hit a neighbour", () => {
  const neighbour = { type: "rectangle", id: "next", x: 410, y: 100, width: 200, height: 110 };
  const fitted = fitShapesToLabels([card, neighbour]);
  assert.deepEqual(fitted, [{ ...card, x: 52, width: 345 }, neighbour]);
});

test("fitShapesToLabels leaves a shape it cannot grow without overlap, and the warning stays", () => {
  const neighbour = { type: "rectangle", id: "next", x: 380, y: 100, width: 200, height: 110 };
  const fitted = fitShapesToLabels([card, neighbour]);
  assert.deepEqual(fitted, [card, neighbour]);
  assert.equal(detectMalformedLayoutWarnings(fitted).length, 1);
});

test("fitShapesToLabels still grows a shape that sits inside a larger container shape", () => {
  const lane = { type: "rectangle", id: "lane", x: 0, y: 50, width: 800, height: 300 };
  const fitted = fitShapesToLabels([lane, card]);
  assert.deepEqual(fitted, [lane, { ...card, x: 33, width: 383 }]);
});

test("detectMalformedLayoutWarnings flags elements that share an id, by line number", () => {
  const card = (id, x) => ({ type: "rectangle", id, x, y: 100, width: 200, height: 80 });
  const warnings = detectMalformedLayoutWarnings([
    { type: "text", id: "title", x: 0, y: 0, text: "Pipeline", fontSize: 24 },
    card("publish", 0),
    { type: "arrow", id: "publish-to-review", x: 200, y: 140, width: 100, height: 0 },
    card("publish", 300),
    card("review", 600),
    card("review", 900),
    card("review", 1200),
  ]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /lines 2 and 4 share id "publish"/);
  assert.match(warnings[1], /lines 5, 6 and 7 share id "review"/);
  assert.match(warnings[0], /new id/);
});

test("detectMalformedLayoutWarnings does not count elements without an id as duplicates", () => {
  const warnings = detectMalformedLayoutWarnings([
    { type: "text", x: 0, y: 0, text: "One", fontSize: 24 },
    { type: "text", x: 0, y: 200, text: "Two", fontSize: 24 },
  ]);
  assert.deepEqual(warnings, []);
});
