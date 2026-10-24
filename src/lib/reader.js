// ES module wrapper. The implementation lives in reader.core.js so the injected
// page reader (a classic content script) can load the same code.
import "./reader.core.js";

export const Reader = globalThis.__PDFREADER__.Reader;
