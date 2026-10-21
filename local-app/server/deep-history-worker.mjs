/** Trusted cache reader only. User scripts never enter this Node worker. */
export const DEEP_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
let db;
function fail(status, message, code = 'DEEP_HISTORY_UNAVAILABLE') {
    throw Object.assign(new Error(message), { status, code });
}
function bucket(time, period) {
    if (period.unit === 'month') {
        const date = new Date(time);
        const months = (date.getUTCFullYear() - 1970) * 12 + date.getUTCMonth();
        const output = new Date(0);
        output.setUTCFullYear(1970, Math.floor(months / period.count) * period.count, 1);
        return output.getTime();
    }
    const anchor = period.unit === 'week' ? -259200000 : 0;
    return Math.floor((time - anchor) / period.intervalMs) * period.intervalMs + anchor;
}
try {
    const input = workerData;
    db = new DatabaseSync(input.databasePath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
    const check = db.prepare('SELECT checksum,meta FROM datasets WHERE id=?');
    for (const dataset of input.datasets) {
        const row = check.get(dataset.id);
        if (!row || row.checksum !== dataset.checksum) fail(409, 'Cached history changed. Start a new deep backtest.', 'HISTORY_CHANGED');
        const meta = JSON.parse(row.meta);
        if (meta.symbol !== dataset.symbol || meta.schema !== dataset.schema || meta.intervalMs !== dataset.intervalMs || meta.start !== dataset.start || meta.end !== dataset.end) fail(409, 'Cached history metadata changed. Start a new deep backtest.', 'HISTORY_CHANGED');
    }
    const heap = [];
    const less = (a, b) => a.row.time < b.row.time || a.row.time === b.row.time && a.dataset.id < b.dataset.id;
    function push(node) {
        let index = heap.length; heap.push(node);
        while (index > 0) { const parent = (index - 1) >> 1; if (!less(node, heap[parent])) break; heap[index] = heap[parent]; index = parent; }
        heap[index] = node;
    }
    function pop() {
        const first = heap[0]; const last = heap.pop();
        if (heap.length) {
            let index = 0;
            while (index * 2 + 1 < heap.length) {
                let child = index * 2 + 1;
                if (child + 1 < heap.length && less(heap[child + 1], heap[child])) child++;
                if (!less(heap[child], last)) break;
                heap[index] = heap[child]; index = child;
            }
            heap[index] = last;
        }
        return first;
    }
    const query = 'SELECT time,open,high,low,close,volume FROM bars WHERE dataset_id=? AND time>=? AND time<=? ORDER BY time';
    for (const dataset of input.datasets) {
        const iterator = db.prepare(query).iterate(dataset.id, input.scopeFrom, input.availableUntil - dataset.intervalMs)[Symbol.iterator]();
        const next = iterator.next();
        if (!next.done) push({ dataset, iterator, row: next.value });
    }
    const contributors = new Map();
    const output = new Array(input.primary ? 0 : input.limit);
    let outputCount = 0; let totalCount = 0; let current; let previous; let previousHA; let cursorTime = null;
    function emit(raw) {
        let bar = raw;
        if (input.modifier === 'heikinashi') {
            const close = (raw.open + raw.high + raw.low + raw.close) / 4;
            const open = previousHA ? (previousHA.open + previousHA.close) / 2 : (raw.open + raw.close) / 2;
            bar = { ...raw, open, close, high: Math.max(raw.high, open, close), low: Math.min(raw.low, open, close) };
            previousHA = bar;
        }
        // Source selection bounds the prices; a partial first bucket keeps its standard opening label.
        if (bar.time >= input.scopeTo || input.from !== undefined && bar.time < input.from || input.to !== undefined && bar.time > input.to) return;
        totalCount++;
        if (input.primary) {
            if (totalCount > input.maxBars) fail(413, 'Deep history exceeds the 250,000 calculation-bar limit. Choose a higher timeframe or a shorter date range.', 'CAPACITY_REACHED');
            output.push(bar);
        } else { output[outputCount % input.limit] = bar; outputCount++; }
    }
    while (heap.length) {
        const node = pop(); const row = node.row;
        contributors.set(node.dataset.id, { id: node.dataset.id, checksum: node.dataset.checksum });
        const next = node.iterator.next(); if (!next.done) push({ ...node, row: next.value });
        if (previous && row.time === previous.time) {
            if (['open', 'high', 'low', 'close', 'volume'].some((key) => row[key] !== previous[key])) fail(409, 'Overlapping cached partitions contain conflicting OHLCV candles. Resolve the conflicting imports before backtesting.', 'HISTORY_CONFLICT');
            continue;
        }
        previous = row; cursorTime = row.time;
        const time = bucket(row.time, input.period);
        if (!current || current.time !== time) {
            if (current) emit(current);
            current = { time, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume };
        } else {
            current.high = Math.max(current.high, row.high); current.low = Math.min(current.low, row.low);
            current.close = row.close; current.volume += row.volume;
            if (!Number.isSafeInteger(current.volume)) fail(413, 'Aggregated volume exceeds the safe numeric limit.', 'CAPACITY_REACHED');
        }
    }
    if (current) emit(current);
    const sourceDatasets = [...contributors.values()].sort((a, b) => a.id.localeCompare(b.id));
    let bars;
    if (input.primary) {
        bars = output;
        if (!bars.length) fail(404, 'No complete source candles are cached in the selected date range.', 'HISTORY_EMPTY');
    } else {
        const count = Math.min(outputCount, input.limit);
        const start = outputCount > input.limit ? outputCount % input.limit : 0;
        bars = Array.from({ length: count }, (_, index) => output[(start + index) % input.limit]);
    }
    let calendarInterval = 0;
    if (input.period.unit === 'month') {
        const date = new Date(bars[0]?.time ?? input.scopeFrom);
        for (let offset = 0; offset < input.period.count; offset++) {
            const index = date.getUTCMonth() + offset;
            const year = date.getUTCFullYear() + Math.floor(index / 12); const month = index % 12;
            const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
            calendarInterval += [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month] * 86400000;
        }
    }
    const response = { bars, symbolInfo: input.symbolInfo, timeframe: input.period.native,
        intervalMs: input.period.intervalMs ?? calendarInterval,
        baseIntervalMs: input.baseIntervalMs, cursorTime, hasMore: !input.primary && totalCount > input.limit };
    if (input.primary) {
        const checksum = createHash('sha256').update(JSON.stringify(bars)).digest('hex');
        Object.assign(response, { scopeId: input.scopeId, from: input.scopeFrom, to: input.scopeTo,
            history: { mode: 'deep', requestedFrom: input.scopeFrom, requestedTo: input.scopeTo, barCount: bars.length, sourceDatasets, checksum } });
    } else response.sourceDatasets = sourceDatasets;
    db.exec('ROLLBACK'); db.close(); db = undefined;
    parentPort.postMessage({ ok: true, body: JSON.stringify(response), cursorTime });
} catch (error) {
    try { db?.close(); } catch {}
    parentPort.postMessage({ ok: false, status: error.status ?? 500, code: error.code ?? 'DEEP_HISTORY_UNAVAILABLE',
        message: error.status ? error.message : 'Unable to read the cached history. No provider request was made.' });
}
`;
