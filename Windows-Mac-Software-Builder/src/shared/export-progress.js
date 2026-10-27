'use strict';

// Stage-based progress, never a timer: 100 is reserved for the committed output.
function createExportProgress(sender) {
  let percent = 0;
  let terminal = false;
  let previous = '';
  function publish(value, stage, status = 'building') {
    if (terminal || !Number.isFinite(value)) return;
    percent = Math.max(percent, Math.min(status === 'success' ? 100 : 99, Math.max(0, Math.floor(value))));
    const key = percent + ':' + stage + ':' + status;
    if (key === previous) return;
    previous = key;
    terminal = status !== 'building';
    try { sender.send('export:progress', { percent, stage, status }); } catch (_) { /* UI closed. */ }
  }
  return {
    update: (value, stage) => publish(value, stage),
    range: (start, end, completed, total, stage) => {
      if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) {
        publish(start + (end - start) * Math.min(1, Math.max(0, completed / total)), stage);
      }
    },
    complete: () => publish(100, 'complete', 'success'),
    cancel: () => publish(percent, 'cancelled', 'cancelled'),
    fail: () => publish(percent, 'failed', 'error')
  };
}

// 7-Zip emits carriage returns/backspaces and may split "42%" across chunks.
function sevenZipProgress(onPercent) {
  let tail = '';
  let previous = -1;
  return chunk => {
    const text = tail + chunk.toString();
    for (const match of text.matchAll(/(?:^|[\s\b])(\d{1,3})%/g)) {
      const value = Number(match[1]);
      if (value <= 100 && value > previous) { previous = value; onPercent(value); }
    }
    tail = text.slice(-32);
  };
}

module.exports = { createExportProgress, sevenZipProgress };
