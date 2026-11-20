// The boot screen's rotating "Borg cube": a z-buffered, shaded cube rendered in text, with a
// circuit grid and random greebles on every face. Pure (no DOM): returns an HTML string whose
// spans carry intensity classes c1..c6, coloured by the theme.

const RAMP = [' ', '·', ':', '░', '▒', '▓', '█'];
const FACES = [[0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0]];
const LIGHT = (() => {
  const l = [-0.55, 0.65, -0.6], n = Math.hypot(...l);
  return l.map((v) => v / n);
})();

function hash(a, b) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// Returns rows of intensity levels (0 = empty .. 6 = brightest) for rotation angles A (x), B (y).
export function cubeLevels(A, B, W = 46, H = 22, grid = 6) {
  const lv = Array.from({ length: H }, () => new Uint8Array(W));
  const zb = Array.from({ length: H }, () => new Float32Array(W));
  const cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B);
  const rot = (x, y, z) => {
    const y1 = y * cA - z * sA, z1 = y * sA + z * cA;
    return [x * cB + z1 * sB, y1, -x * sB + z1 * cB];
  };
  const scale = Math.min(W * 0.78, H * 1.56), step = 1.6 / Math.max(W, H);
  FACES.forEach((n, fi) => {
    const nr = rot(...n);
    if (nr[2] > 0.05) return; // faces pointing away from the viewer
    const lum = Math.max(0, nr[0] * LIGHT[0] + nr[1] * LIGHT[1] + nr[2] * LIGHT[2]);
    for (let u = -1; u <= 1.0001; u += step) {
      for (let v = -1; v <= 1.0001; v += step) {
        const p = n[2] ? [u, v, n[2]] : n[1] ? [u, n[1], v] : [n[0], u, v];
        const [x, y, z] = rot(...p);
        const ooz = 1 / (z + 4);
        const xp = Math.round(W / 2 + scale * x * ooz);
        const yp = Math.round(H / 2 - scale * 0.5 * y * ooz);
        if (xp < 0 || xp >= W || yp < 0 || yp >= H || ooz <= zb[yp][xp]) continue;
        zb[yp][xp] = ooz;
        const gu = ((u + 1) / 2) * grid, gv = ((v + 1) / 2) * grid;
        const cu = Math.floor(gu), cv = Math.floor(gv);
        const line = gu - cu < 0.12 || gv - cv < 0.12;
        const g = hash(cu * 7 + fi * 131, cv * 13 + fi);
        let b = 0.28 + 0.55 * lum;
        if (line) b += 0.3;             // circuit grid
        else if (g > 0.8) b += 0.15;    // lit greeble
        else if (g < 0.22) b -= 0.12;   // recessed panel
        if (Math.abs(u) > 0.985 || Math.abs(v) > 0.985) b = 1; // edges
        lv[yp][xp] = Math.max(1, Math.min(6, Math.floor(Math.min(0.999, Math.max(0, b)) * 7)));
      }
    }
  });
  return lv;
}

// One frame as HTML: runs of equal intensity share a span.
export function cubeHTML(A, B, W, H) {
  return cubeLevels(A, B, W, H).map((row) => {
    let html = '', run = '', cur = -1;
    const flush = () => {
      if (run) html += cur > 0 ? `<span class="c${cur}">${run}</span>` : run;
      run = '';
    };
    for (const l of row) {
      if (l !== cur) {
        flush();
        cur = l;
      }
      run += RAMP[l];
    }
    flush();
    return html;
  }).join('\n');
}

// "MINI-BORG" in the figlet "ANSI Shadow" style.
export const WORDMARK = [
  '███╗   ███╗██╗███╗   ██╗██╗      ██████╗  ██████╗ ██████╗  ██████╗ ',
  '████╗ ████║██║████╗  ██║██║      ██╔══██╗██╔═══██╗██╔══██╗██╔════╝ ',
  '██╔████╔██║██║██╔██╗ ██║██║█████╗██████╔╝██║   ██║██████╔╝██║  ███╗',
  '██║╚██╔╝██║██║██║╚██╗██║██║╚════╝██╔══██╗██║   ██║██╔══██╗██║   ██║',
  '██║ ╚═╝ ██║██║██║ ╚████║██║      ██████╔╝╚██████╔╝██║  ██║╚██████╔╝',
  '╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝      ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ',
];
