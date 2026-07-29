// ics.js — pure RFC 5545 ICS parsing primitives. No DOM.

// unfoldLines: RFC 5545 §3.1 line unfolding. Content lines are split by CRLF
// (or bare LF); a line that begins with a single space or tab is a
// continuation of the previous line — join it after stripping that one
// leading whitespace char. Trailing blank lines (from a final line ending)
// are dropped.
export function unfoldLines(text) {
  const rawLines = text.split(/\r\n|\r|\n/);
  // A trailing line ending produces one trailing empty string; drop it.
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const lines = [];
  for (const raw of rawLines) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += raw.slice(1);
    } else {
      lines.push(raw);
    }
  }
  return lines;
}

// parseProperty: parse a single unfolded content line of the form
//   NAME;PARAM=VALUE;PARAM2="quoted,value":value
// into { name, params: { PARAM: value, ... }, value }.
// Params precede the first unquoted `:`. A param value may be double-quoted,
// in which case it can contain `:`, `;`, `,` literally. Multi-value params
// (comma-separated) are returned as a single string; later tasks split them.
export function parseProperty(line) {
  let i = 0;
  const len = line.length;

  // NAME: up to the first ';' or ':'.
  let nameEnd = i;
  while (nameEnd < len && line[nameEnd] !== ';' && line[nameEnd] !== ':') nameEnd++;
  const name = line.slice(0, nameEnd);
  i = nameEnd;

  const params = {};
  while (i < len && line[i] === ';') {
    i++; // skip ';'
    let keyEnd = i;
    while (keyEnd < len && line[keyEnd] !== '=') keyEnd++;
    const key = line.slice(i, keyEnd);
    i = keyEnd + 1; // skip '='

    let value;
    if (line[i] === '"') {
      i++; // skip opening quote
      let valEnd = i;
      while (valEnd < len && line[valEnd] !== '"') valEnd++;
      value = line.slice(i, valEnd);
      i = valEnd + 1; // skip closing quote
    } else {
      let valEnd = i;
      while (valEnd < len && line[valEnd] !== ';' && line[valEnd] !== ':') valEnd++;
      value = line.slice(i, valEnd);
      i = valEnd;
    }
    params[key] = value;
  }

  // i now points at the unquoted ':' separating params from value (or at end).
  const value = i < len && line[i] === ':' ? line.slice(i + 1) : '';

  return { name, params, value };
}

// unescapeText: reverse RFC 5545 §3.3.11 TEXT escaping.
//   \\  -> \
//   \;  -> ;
//   \,  -> ,
//   \n / \N -> newline
export function unescapeText(v) {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\' && i + 1 < v.length) {
      const next = v[i + 1];
      if (next === '\\') { out += '\\'; i++; continue; }
      if (next === ';') { out += ';'; i++; continue; }
      if (next === ',') { out += ','; i++; continue; }
      if (next === 'n' || next === 'N') { out += '\n'; i++; continue; }
    }
    out += v[i];
  }
  return out;
}
