// Reads c8's json-summary output and writes a shields-style SVG badge, so CI
// can publish coverage without any third-party service.
import fs from 'fs';

import { makeBadge } from 'badge-maker';

const outPath = process.argv[2] ?? 'coverage/coverage.svg';

const summary = JSON.parse(
    fs.readFileSync('coverage/coverage-summary.json', 'utf8'),
);
const pct = summary.total.lines.pct;

const color =
    pct >= 90
        ? 'brightgreen'
        : pct >= 80
          ? 'green'
          : pct >= 70
            ? 'yellowgreen'
            : pct >= 60
              ? 'yellow'
              : pct >= 50
                ? 'orange'
                : 'red';

fs.writeFileSync(
    outPath,
    makeBadge({ label: 'coverage', message: pct + '%', color }),
);

console.log('coverage ' + pct + '% → ' + outPath);
