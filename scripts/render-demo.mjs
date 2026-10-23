// Renders `npm run try` against the demo contact center as an animated SVG for the README: npm run demo:svg
// The clock is pinned so the output is the same on every run.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const C = { bg: "#05050B", line: "#1E1B2E", star: "#F4F2EC", dust: "#8B86A0", aurora: "#6FF2C6", gold: "#F2C46D", violet: "#A98BFF", red: "#FF7B8A" };
const FONT = 14, LH = 21, PAD = 28, TOP = 64, CHAR = 8.43;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Wraps text to `width` columns at spaces. */
function wrap(text, width) {
  const out = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/** Renders rows of [text, colour, extra?] spans as an animated terminal. */
function terminal({ title, typed, rows, aria, cycle = 18, step = 0.11 }) {
  const len = (row) => row.reduce((n, [t]) => n + t.length, 0);
  const width = Math.ceil(Math.max(typed.length + 2, ...rows.map(len)) * CHAR + PAD * 2 + 10);
  const height = TOP + (rows.length + 1) * LH + PAD;
  const show = (t) => {
    const a = (t / cycle) * 100;
    return `0%,${a.toFixed(2)}%{opacity:0}${(a + 0.8).toFixed(2)}%,94%{opacity:1}100%{opacity:0}`;
  };
  const startOut = 0.4 + typed.length * 0.035 + 0.5;
  let css = "";
  let body = "";
  rows.forEach((row, i) => {
    if (!len(row)) return;
    css += `@keyframes l${i}{${show(startOut + i * step)}}.l${i}{opacity:0;animation:l${i} ${cycle}s linear infinite}\n`;
    const tspans = row.map(([text, fill, extra = ""]) => `<tspan fill="${fill}" ${extra}>${esc(text)}</tspan>`).join("");
    body += `<text class="l${i}" x="${PAD}" y="${TOP + (i + 1) * LH}" xml:space="preserve">${tspans}</text>\n`;
  });
  const typeEnd = (((0.4 + typed.length * 0.035) / cycle) * 100).toFixed(2);
  const tw = (typed.length + 1) * CHAR;
  css += `@keyframes type{0%{width:0}2%{width:0}${typeEnd}%{width:${tw}px}94%{width:${tw}px}100%{width:0}}`;
  css += `.type{animation:type ${cycle}s steps(${typed.length + 1}) infinite}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(aria)}">
<style>
text{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:${FONT}px}
${css}
</style>
<rect width="${width}" height="${height}" rx="14" fill="${C.bg}"/>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="none" stroke="${C.line}"/>
<circle cx="24" cy="22" r="5.5" fill="#2A2638"/><circle cx="42" cy="22" r="5.5" fill="#2A2638"/><circle cx="60" cy="22" r="5.5" fill="#2A2638"/>
<text x="${width / 2}" y="26" text-anchor="middle" fill="${C.dust}" style="font-size:12px">${esc(title)}</text>
<line x1="0" y1="42" x2="${width}" y2="42" stroke="${C.line}"/>
<clipPath id="typed"><rect class="type" x="${PAD + 2 * CHAR}" y="${TOP - LH + 4}" height="${LH}" width="0"/></clipPath>
<text x="${PAD}" y="${TOP}" xml:space="preserve"><tspan fill="${C.aurora}">$</tspan></text>
<text x="${PAD + 2 * CHAR}" y="${TOP}" fill="${C.star}" clip-path="url(#typed)" xml:space="preserve">${esc(typed)}</text>
${body}</svg>
`;
}

const { stdout } = spawnSync("node", ["scripts/try.mjs"], { encoding: "utf8", env: { ...process.env, DEMO_NOW: "2026-10-20T16:40:00Z" } });

const rows = [];
let header = null;
for (const line of stdout.replace(/^\n+/, "").replace(/\n+$/, "").split("\n")) {
  const callLine = line.match(/^(→ )(\S+)( .*)$/);
  if (callLine) {
    rows.push([[callLine[1], C.violet], [callLine[2], C.aurora], [callLine[3], C.dust]]);
    header = null;
    continue;
  }
  if (/^\s+(queue|started)\s/.test(line)) {
    header = line;
    rows.push([[line, C.dust]]);
    continue;
  }
  // In the performance table, abandon rates of 20% or more in gold.
  const col = header?.indexOf("abandoned") ?? -1;
  if (col > 0 && header.includes("offered")) {
    const end = col + "abandoned".length;
    const value = parseFloat(line.slice(col, end));
    rows.push([[line.slice(0, col), C.star], [line.slice(col, end), value >= 20 ? C.gold : C.star], [line.slice(end), C.star]]);
    continue;
  }
  if (/^\s+\d+ of \d+\./.test(line)) {
    rows.push([[line, C.dust]]);
    continue;
  }
  rows.push(line ? [[line, C.star]] : []);
}

const svg = terminal({
  title: "genesys-cloud-mcp · demo contact center",
  typed: "npm run try",
  rows,
  aria: "Terminal demo: three read-only tool calls against the demo contact center show live queue status, today's queue performance and the abandoned calls in Billing, with customer data masked",
  step: 0.09,
});
writeFileSync("docs/demo.svg", svg);
console.log(`docs/demo.svg, ${rows.length} rows, ${Math.round(svg.length / 1024)} KB`);
