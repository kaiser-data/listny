// Joining Rests pieces into one text, either all at once or one piece at a time while they are
// typed into the focused field. Providers often leave a piece without its final period, and pieces
// end at pauses, which are usually sentence ends: add one unless the next piece carries on in lower case.

const isOpen = (text) => !/[.!?…:;,)"'”»]$/.test(text);
const continues = (next) => /^\p{Ll}/u.test(next);

// What goes between an already inserted piece and the next one.
function separator(prev, next) {
  if (!prev) return '';
  return isOpen(prev) && !continues(next) ? '. ' : ' ';
}

// What closes the text after the last piece.
const ending = (last) => (last && isOpen(last) ? '.' : '');

function joinPieces(texts) {
  const parts = texts.map((t) => (t || '').trim()).filter(Boolean);
  let out = '';
  parts.forEach((t, i) => (out += separator(parts[i - 1], t) + t));
  return out + ending(parts.at(-1));
}

module.exports = { separator, ending, joinPieces };
