const PY_KW = new Set([
  "False","None","True","and","as","assert","async","await","break","class",
  "continue","def","del","elif","else","except","finally","for","from","global",
  "if","import","in","is","lambda","nonlocal","not","or","pass","raise","return",
  "try","while","with","yield",
]);

const JS_KW = new Set([
  "break","case","catch","class","const","continue","debugger","default","delete",
  "do","else","export","extends","finally","for","function","if","import","in",
  "instanceof","let","new","null","of","return","super","switch","this","throw",
  "true","false","try","typeof","var","void","while","with","yield","async","await",
]);

type Tok = { cls: string; text: string };

export function highlight(code: string, lang: string): Tok[] {
  const kw = lang === "py" || lang === "python" ? PY_KW : JS_KW;
  const tokens: Tok[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];

    if (ch === "#" && (lang === "py" || lang === "python")) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      tokens.push({ cls: "tok-com", text: code.slice(i, stop) });
      i = stop;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      tokens.push({ cls: "tok-com", text: code.slice(i, stop) });
      i = stop;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < code.length && code[j] !== quote) {
        if (code[j] === "\\") j++;
        j++;
      }
      tokens.push({ cls: "tok-str", text: code.slice(i, Math.min(j + 1, code.length)) });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < code.length && /[0-9.]/.test(code[j])) j++;
      tokens.push({ cls: "tok-num", text: code.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < code.length && /[A-Za-z0-9_]/.test(code[j])) j++;
      const word = code.slice(i, j);
      const isCall = code[j] === "(";
      const cls = kw.has(word) ? "tok-kw" : isCall ? "tok-fn" : "";
      tokens.push({ cls, text: word });
      i = j;
      continue;
    }
    tokens.push({ cls: "", text: ch });
    i += 1;
  }
  return tokens;
}
