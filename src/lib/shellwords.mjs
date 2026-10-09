// Split a command-line string into argv WITHOUT a shell: no expansion, no globbing,
// no substitution, no evaluation. `wrangler-command` and `wrangler-args` are
// workflow-author strings ("pnpm exec wrangler", "--env staging --var A:\"b c\""),
// and passing the result to spawn() with no shell means nothing in them can run as
// code — `$(...)`, backticks, `;` and `|` stay literal characters in an argument.
//
// Supports the quoting people actually write: '…' (literal), "…" (with \" \\ \$ \`
// escapes), and a backslash outside quotes escaping the next character.

export function splitWords(input) {
  const words = [];
  let word = "";
  let inWord = false;
  let quote = null;
  const s = String(input ?? "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) word += s[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < s.length) {
      word += s[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) throw new Error(`unterminated ${quote} quote in ${JSON.stringify(s)}`);
  if (inWord) words.push(word);
  return words;
}
