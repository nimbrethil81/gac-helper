"use strict";

// Minimal, dependency-free, read-only .xlsx reader for catalogue snapshots.
//
// It understands exactly what a Google Sheets "Download → Microsoft Excel"
// export contains: a ZIP (stored or deflated entries), a workbook sheet list,
// shared strings, and per-sheet cell XML with optional formulas. It never
// writes to the workbook and only parses the worksheets a caller names, so
// tabs outside the catalogue allow-list (for example personal roster history)
// are never decoded.

const zlib = require("node:zlib");

// ─── ZIP ─────────────────────────────────────────────────────────────────────

function readZipEntries(buffer) {
  const EOCD_SIGNATURE = 0x06054b50;
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP/xlsx file: end-of-central-directory record not found");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error("Corrupt ZIP central directory");
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }

  return {
    has: (name) => entries.has(name),
    read(name) {
      const entry = entries.get(name);
      if (!entry) throw new Error(`Missing xlsx part: ${name}`);
      const local = entry.localOffset;
      if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`Corrupt ZIP local header: ${name}`);
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + entry.compressedSize);
      if (entry.method === 0) return data.toString("utf8");
      if (entry.method === 8) return zlib.inflateRawSync(data).toString("utf8");
      throw new Error(`Unsupported ZIP compression method ${entry.method} for ${name}`);
    }
  };
}

// ─── XML helpers ─────────────────────────────────────────────────────────────

function decodeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (match, code) => {
    if (code === "amp") return "&";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "quot") return "\"";
    if (code === "apos") return "'";
    if (code[1] === "x") return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
  });
}

function attributes(tagText) {
  const result = {};
  for (const match of tagText.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) result[match[1]] = decodeXml(match[2]);
  return result;
}

// Concatenate every <t> run of a string item, ignoring phonetic (<rPh>) runs.
function textRuns(xml) {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let text = "";
  for (const match of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) {
    text += decodeXml(match[1] ?? "");
  }
  return text;
}

function columnIndex(letters) {
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function columnLetters(index) {
  let letters = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function splitCellRef(ref) {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) throw new Error(`Invalid cell reference: ${ref}`);
  return { column: columnIndex(match[1]), row: Number(match[2]) - 1 };
}

// ─── workbook ────────────────────────────────────────────────────────────────

function resolvePartPath(target) {
  if (target.startsWith("/")) return target.slice(1);
  return `xl/${target}`.replace(/\/\.\//g, "/");
}

function openWorkbook(buffer) {
  const zip = readZipEntries(buffer);
  const workbookXml = zip.read("xl/workbook.xml");
  const relsXml = zip.read("xl/_rels/workbook.xml.rels");

  const targets = new Map();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = attributes(match[1]);
    targets.set(attrs.Id, resolvePartPath(attrs.Target));
  }

  const sheets = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = attributes(match[1]);
    sheets.push({ name: attrs.name, part: targets.get(attrs["r:id"]) });
  }

  let sharedStrings = null;
  const loadSharedStrings = () => {
    if (sharedStrings) return sharedStrings;
    sharedStrings = [];
    if (zip.has("xl/sharedStrings.xml")) {
      const xml = zip.read("xl/sharedStrings.xml");
      for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) sharedStrings.push(textRuns(match[1] ?? ""));
    }
    return sharedStrings;
  };

  return {
    sheetNames: sheets.map((sheet) => sheet.name),
    // Read one worksheet into a dense grid of typed values, mirroring what
    // Apps Script's getDataRange().getValues() returns: numbers as numbers,
    // booleans as booleans, empty cells as "". Formulas and error cells are
    // returned separately so they can be audited without changing values.
    readSheet(name) {
      const sheet = sheets.find((entry) => entry.name === name);
      if (!sheet) return null;
      const xml = zip.read(sheet.part);
      const strings = loadSharedStrings();
      const cells = [];
      const formulas = [];
      const errors = [];
      let maxRow = -1;
      let maxColumn = -1;

      for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = attributes(match[1]);
        const body = match[2] ?? "";
        const { row, column } = splitCellRef(attrs.r);
        const formulaMatch = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
        const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
        const raw = valueMatch ? decodeXml(valueMatch[1]) : null;

        let value = "";
        if (attrs.t === "s") value = raw === null ? "" : strings[Number(raw)] ?? "";
        else if (attrs.t === "str") value = raw ?? "";
        else if (attrs.t === "inlineStr") value = textRuns(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
        else if (attrs.t === "b") value = raw === "1";
        else if (attrs.t === "e") value = raw ?? "#ERROR!";
        else if (raw !== null && raw !== "") value = Number(raw);

        if (formulaMatch) {
          const fAttrs = attributes(formulaMatch[1]);
          formulas.push({
            cell: attrs.r,
            formula: formulaMatch[2] === undefined ? null : `=${decodeXml(formulaMatch[2])}`,
            ...(fAttrs.t ? { type: fAttrs.t } : {}),
            ...(fAttrs.ref ? { ref: fAttrs.ref } : {})
          });
        }
        if (attrs.t === "e") errors.push({ cell: attrs.r, value });

        const occupied = value !== "" || Boolean(formulaMatch);
        if (!occupied) continue;
        if (!cells[row]) cells[row] = [];
        cells[row][column] = value;
        maxRow = Math.max(maxRow, row);
        maxColumn = Math.max(maxColumn, column);
      }

      // Array formulas occupy their whole declared range for getDataRange(),
      // whether or not a spilled cell carries a value.
      for (const formula of formulas) {
        if (!formula.ref) continue;
        const [from, to] = formula.ref.split(":");
        const end = splitCellRef(to ?? from);
        maxRow = Math.max(maxRow, end.row);
        maxColumn = Math.max(maxColumn, end.column, splitCellRef(from).column);
      }

      const grid = [];
      for (let row = 0; row <= maxRow; row += 1) {
        const source = cells[row] ?? [];
        const values = [];
        for (let column = 0; column <= maxColumn; column += 1) values.push(source[column] ?? "");
        grid.push(values);
      }
      return { name, grid, formulas, errors };
    }
  };
}

module.exports = { columnIndex, columnLetters, openWorkbook, readZipEntries, splitCellRef };
