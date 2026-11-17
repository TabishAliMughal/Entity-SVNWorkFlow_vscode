// Regenerates media/pane/*.svg (direction arrow + change mark, light and dark). Run: node scripts/gen-pane-icons.js
const fs = require('node:fs');
const path = require('node:path');

const COLORS = {
  light: { out: '#b5760a', in: '#0e70c0', add: '#2e8b3d', del: '#c4402f', replace: '#b5760a', conflict: '#c4402f', unversioned: '#6e7681', missing: '#b5760a' },
  dark: { out: '#e2b45a', in: '#5db3ff', add: '#6fc47d', del: '#f0705f', replace: '#e2b45a', conflict: '#f0705f', unversioned: '#9aa4b0', missing: '#e2b45a' },
};
const stroke = (c, d, w = 1.6) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const up = (x, c, h = 3) => stroke(c, `M${x} 13V3M${x - h} ${3 + h * 1.07}L${x} 3L${x + h} ${3 + h * 1.07}`);
const down = (x, c, h = 3) => stroke(c, `M${x} 3V13M${x - h} ${13 - h * 1.07}L${x} 13L${x + h} ${13 - h * 1.07}`);
const marks = {
  add: (c) => stroke(c, 'M4 5.5V10.5M1.5 8H6.5'),
  del: (c) => stroke(c, 'M1.5 8H6.5'),
  replace: (c) => stroke(c, 'M4 3.5V7.5M2 5.5H6M2 10.5H6'),
  conflict: (c) => stroke(c, 'M4 3.5V9') + `<circle cx="4" cy="12" r="1" fill="${c}"/>`,
  unversioned: (c) => stroke(c, 'M2.4 5.6Q2.4 3.4 4.2 3.4Q6 3.4 6 5.2Q6 6.6 4.2 7.5V8.8') + `<circle cx="4.2" cy="11.8" r="1" fill="${c}"/>`,
  missing: (c) => stroke(c, 'M4 3.5V9') + `<circle cx="4" cy="12" r="1" fill="${c}"/>`,
};
const out = path.resolve(__dirname, '..', 'media', 'pane');
fs.mkdirSync(out, { recursive: true });
for (const theme of ['light', 'dark']) {
  const c = COLORS[theme];
  for (const dir of ['in', 'out', 'both']) {
    for (const mark of ['none', ...Object.keys(marks)]) {
      let body = '';
      if (mark !== 'none') body += marks[mark](c[mark]);
      const cx = mark === 'none' ? [8, 5, 11] : [11.5, 9, 13.5];
      if (dir === 'out') body += up(cx[0], c.out);
      else if (dir === 'in') body += down(cx[0], c.in);
      else body += up(cx[1], c.out, 2.2) + down(cx[2], c.in, 2.2);
      fs.writeFileSync(path.join(out, `${dir}-${mark}-${theme}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${body}</svg>\n`);
    }
  }
}
