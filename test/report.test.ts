import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { reportPaths } from '../src/commands/report.js';

test('reportPaths: 既存の report.html / report.pdf を残して番号を振る', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-scan-report-'));
  try {
    assert.deepEqual(reportPaths(dir), { htmlFile: path.join(dir, 'report.html'), pdfFile: path.join(dir, 'report.pdf'), index: 1 });
    // PDF だけ残っていても（HTML を消していても）report を空けたままにする
    fs.writeFileSync(path.join(dir, 'report.pdf'), 'pdf');
    assert.equal(reportPaths(dir).index, 2);
    assert.equal(path.basename(reportPaths(dir).htmlFile), 'report-2.html');
    fs.writeFileSync(path.join(dir, 'report-2.html'), 'html');
    assert.equal(path.basename(reportPaths(dir).pdfFile), 'report-3.pdf');
    // --overwrite は常に report.html / report.pdf
    assert.equal(reportPaths(dir, true).index, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
