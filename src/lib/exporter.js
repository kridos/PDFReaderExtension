// Applies the editor state (page order, rotations, annotations) to the original
// PDF and returns new PDF bytes. Pure pdf-lib so it also runs in Node tests.
import { PDFDocument, StandardFonts, degrees, rgb } from "../vendor/pdf-lib.esm.min.js";

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

/** Crop box used by pdf.js for the page view, falling back to the media box. */
function pageBox(page) {
  try {
    return page.getCropBox() ?? page.getMediaBox();
  } catch {
    return page.getMediaBox();
  }
}

/**
 * Normalised (0..1) page coordinates -> PDF points, using the same bottom-left
 * origin the viewer stores annotations in.
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @param {{x: number, y: number, width: number, height: number}} box
 */
export function toPdfRect(rect, box) {
  return {
    x: Number(box.x ?? 0) + clamp01(rect.x) * box.width,
    y: Number(box.y ?? 0) + clamp01(rect.y) * box.height,
    width: clamp01(rect.w) * box.width,
    height: clamp01(rect.h) * box.height,
  };
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return rgb(0.98, 0.8, 0.08);
  const v = parseInt(m[1], 16);
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

/** pdf-lib's StandardFonts only cover WinAnsi; swap anything else for '?'. */
export function toWinAnsi(text) {
  return String(text ?? "").replace(/[^\x20-\x7e\u00a0-\u00ff\n\r\t]/g, "?");
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes original PDF
 * @param {{annotations: any[], pageOrder: number[], rotations: Record<number, number>}} state
 * @returns {Promise<Uint8Array>}
 */
export async function buildEditedPdf(bytes, state) {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);

  const pageCount = source.getPageCount();
  const order = (state.pageOrder ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= pageCount);
  const finalOrder = order.length ? order : Array.from({ length: pageCount }, (_, i) => i + 1);

  const byPage = new Map();
  for (const a of state.annotations ?? []) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page).push(a);
  }

  for (const original of finalOrder) {
    const [copied] = await out.copyPages(source, [original - 1]);
    const extra = Number(state.rotations?.[original] ?? 0) || 0;
    if (extra) {
      copied.setRotation(degrees((copied.getRotation().angle + extra + 360) % 360));
    }
    out.addPage(copied);

    const box = pageBox(copied);
    const ox = Number(box.x ?? 0);
    const oy = Number(box.y ?? 0);
    const width = Number(box.width);
    const height = Number(box.height);

    for (const a of byPage.get(original) ?? []) {
      const color = hexToRgb(a.color);

      if (a.type === "highlight") {
        for (const r of a.rects ?? []) {
          const rect = toPdfRect(r, { x: ox, y: oy, width, height });
          if (rect.width <= 0 || rect.height <= 0) continue;
          copied.drawRectangle({
            ...rect,
            color,
            opacity: 0.38,
            borderWidth: 0,
          });
        }
        continue;
      }

      if (a.type === "ink") {
        const points = a.points ?? [];
        const thickness = Math.max(0.4, clamp01(a.strokeWidth) * height);
        for (let i = 1; i < points.length; i++) {
          copied.drawLine({
            start: { x: ox + points[i - 1][0] * width, y: oy + points[i - 1][1] * height },
            end: { x: ox + points[i][0] * width, y: oy + points[i][1] * height },
            thickness,
            color,
            opacity: 1,
            lineCap: 1,
          });
        }
        continue;
      }

      if (a.type === "text" && a.text) {
        const size = Math.max(4, clamp01(a.fontSize) * height);
        copied.drawText(toWinAnsi(a.text), {
          x: ox + clamp01(a.x) * width,
          y: oy + clamp01(a.y) * height,
          size,
          font,
          color,
          lineHeight: size * 1.2,
        });
      }
    }
  }

  if (out.getPageCount() === 0) {
    throw new Error("Every page was deleted, so there is nothing to save.");
  }
  return out.save();
}
