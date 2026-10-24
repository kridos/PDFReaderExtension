// Copies the pdf.js runtime and pdf-lib ESM build into src/vendor so the
// extension can run without a bundler. Run after `npm install`.
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const from = (p) => path.join(root, "node_modules", p);
const to = (p) => path.join(root, "src", "vendor", p);

fs.mkdirSync(to("pdfjs"), { recursive: true });

fs.copyFileSync(from("pdfjs-dist/build/pdf.min.mjs"), to("pdfjs/pdf.mjs"));
fs.copyFileSync(from("pdfjs-dist/build/pdf.worker.min.mjs"), to("pdfjs/pdf.worker.mjs"));
fs.copyFileSync(from("pdfjs-dist/LICENSE"), to("pdfjs/LICENSE"));
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  fs.cpSync(from(`pdfjs-dist/${dir}`), to(`pdfjs/${dir}`), { recursive: true });
}

fs.copyFileSync(from("pdf-lib/dist/pdf-lib.esm.min.js"), to("pdf-lib.esm.min.js"));
fs.copyFileSync(from("pdf-lib/LICENSE.md"), to("pdf-lib.LICENSE.md"));

console.log("vendored pdf.js and pdf-lib into src/vendor");
