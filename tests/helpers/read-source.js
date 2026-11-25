// A source file as text with Unix line endings (2026-11-25): a Windows checkout
// (core.autocrlf=true) has CRLF on disk, while the tests' patterns match "\n".
import { readFileSync } from "node:fs";

export const readSource = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
