export function normalizeWhiteboardElements(elements) {
  if (!Array.isArray(elements)) return [];

  return elements;
}

const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
const CHAR_WIDTH_RATIO = 0.6;
// Excalidraw 0.18 keeps 5 px between a label and its container
// (BOUND_TEXT_PADDING). A label overflows only below that; warning earlier
// sends the agent on a whole extra edit pass for nothing.
const LABEL_PADDING = 5;

function rectanglesOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function estimateTextBox(text, fontSize) {
  const fs = fontSize ?? 18;
  const lines = String(text ?? "").split("\n");
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  return {
    width: Math.ceil(longest * fs * CHAR_WIDTH_RATIO),
    height: Math.ceil(lines.length * fs * 1.25),
  };
}

// The padding the system prompt asks for. A shape the app grows gets this much.
const COMFORT_PADDING = 24;

function labelledShapeSize(shape, padding) {
  const estimated = estimateTextBox(shape.label.text, shape.label.fontSize ?? 18);
  return { width: estimated.width + padding * 2, height: estimated.height + padding * 2 };
}

function grownAroundCentre(shape, size) {
  const width = Math.max(shape.width, size.width);
  const height = Math.max(shape.height, size.height);
  return {
    ...shape,
    x: Math.round(shape.x - (width - shape.width) / 2),
    y: Math.round(shape.y - (height - shape.height) / 2),
    width,
    height,
  };
}

// Shapes and standalone text an element can collide with. Arrows and lines are
// left out: they end at shape edges by design.
function collisionBox(element) {
  if (typeof element?.x !== "number" || typeof element?.y !== "number") return null;
  if (SHAPE_TYPES.has(element.type)) {
    if (typeof element.width !== "number" || typeof element.height !== "number") return null;
    return element;
  }
  if (element.type === "text") {
    const estimated = estimateTextBox(element.text, element.fontSize);
    return {
      x: element.x,
      y: element.y,
      width: typeof element.width === "number" ? element.width : estimated.width,
      height: typeof element.height === "number" ? element.height : estimated.height,
    };
  }
  return null;
}

// Grow labelled shapes whose label would overflow, keeping each centre in
// place, so the agent does not spend another edit pass resizing them. Growth
// that would run into something the shape did not already touch is skipped,
// and the layout warning goes to the agent instead.
export function fitShapesToLabels(elements) {
  if (!Array.isArray(elements)) return [];
  const fitted = [...elements];
  fitted.forEach((shape, index) => {
    if (!SHAPE_TYPES.has(shape?.type) || typeof shape.label?.text !== "string" || !shape.label.text) return;
    if (typeof shape.width !== "number" || typeof shape.height !== "number") return;
    const needed = labelledShapeSize(shape, LABEL_PADDING);
    if (shape.width >= needed.width && shape.height >= needed.height) return;
    const others = fitted.filter((_, i) => i !== index).map(collisionBox).filter(Boolean);
    const runsIntoSomething = (box) => others.some((other) => rectanglesOverlap(box, other) && !rectanglesOverlap(shape, other));
    for (const padding of [COMFORT_PADDING, LABEL_PADDING]) {
      const grown = grownAroundCentre(shape, labelledShapeSize(shape, padding));
      if (!runsIntoSomething(grown)) {
        fitted[index] = grown;
        return;
      }
    }
  });
  return fitted;
}

export function detectMalformedLayoutWarnings(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return [];
  const warnings = [];
  const shapes = elements.filter((el) => SHAPE_TYPES.has(el?.type));
  const texts = elements.filter((el) => el?.type === "text");

  // 1. Standalone text overlapping a shape -> should have been a label.
  for (const text of texts) {
    if (typeof text.x !== "number" || typeof text.y !== "number") continue;
    const estimated = estimateTextBox(text.text, text.fontSize);
    const textBox = {
      x: text.x,
      y: text.y,
      width: typeof text.width === "number" ? text.width : estimated.width,
      height: typeof text.height === "number" ? text.height : estimated.height,
    };
    for (const shape of shapes) {
      if (typeof shape.width !== "number" || typeof shape.height !== "number") continue;
      if (rectanglesOverlap(textBox, shape)) {
        const preview = (text.text ?? "").slice(0, 40);
        warnings.push(
          `LAYOUT WARNING: standalone text "${preview}" (id "${text.id}") overlaps shape "${shape.id}". Excalidraw renders standalone text by your literal coordinates, so it bleeds outside the shape. Replace the text element with a label on the shape: { "type": "${shape.type}", "id": "${shape.id}", ..., "label": { "text": "${preview}", "fontSize": ${text.fontSize ?? 18} } }. Then Excalidraw will center it inside the shape and wrap correctly.`,
        );
        break;
      }
    }
  }

  // 2. Labeled shape too narrow / short for its label.
  for (const shape of shapes) {
    const labelText = shape?.label?.text;
    if (typeof labelText !== "string" || labelText.length === 0) continue;
    const fontSize = shape.label.fontSize ?? 18;
    const estimated = estimateTextBox(labelText, fontSize);
    const minWidth = estimated.width + LABEL_PADDING * 2;
    const minHeight = estimated.height + LABEL_PADDING * 2;
    if (typeof shape.width === "number" && shape.width < minWidth) {
      warnings.push(
        `LAYOUT WARNING: shape "${shape.id}" is ${shape.width}px wide but its label "${labelText.slice(0, 40)}" needs about ${minWidth}px (text + padding). Either widen the shape or shorten the label - otherwise the label text will overflow the shape's edges.`,
      );
    }
    if (typeof shape.height === "number" && shape.height < minHeight) {
      warnings.push(
        `LAYOUT WARNING: shape "${shape.id}" is ${shape.height}px tall but its label "${labelText.slice(0, 40)}" needs about ${minHeight}px. Either grow the shape or shorten the label.`,
      );
    }
  }

  // 3. Two elements with one id. Arrows bind to an element by id, so a second
  // element with that id is ambiguous. A miscounted line-number edit leaves
  // such a copy behind (#52).
  const linesById = new Map();
  elements.forEach((element, index) => {
    if (typeof element?.id !== "string" || element.id === "") return;
    linesById.set(element.id, [...(linesById.get(element.id) ?? []), index + 1]);
  });
  for (const [id, lines] of linesById) {
    if (lines.length < 2) continue;
    const listed = `${lines.slice(0, -1).join(", ")} and ${lines.at(-1)}`;
    warnings.push(
      `DUPLICATE ID WARNING: lines ${listed} share id "${id}". Every element needs its own id: give the extra element a new id, or delete it if it is a stray copy.`,
    );
  }

  return warnings;
}
