import { iconMarkup } from '../../src/plugin';
import { tradeTicketMarkup } from './trade-ticket';

export const controlIcon = (name: 'play' | 'pause' | 'stop' | 'step' | 'fast' | 'calendar' | 'close'): string => {
    const native = iconMarkup(name === 'step' ? 'replay-step' : name === 'fast' ? 'fast-forward' : name);
    if (native) return `<span class="replay-control-icon" aria-hidden="true">${native}</span>`;
    const paths = { play: 'M6 3l12 9-12 9z', pause: 'M6 4h4v16H6zM14 4h4v16h-4z', stop: 'M5 5h14v14H5z',
        step: 'M4 4l11 8-11 8zM18 4h2v16h-2z', fast: 'M2 4l9 8-9 8zM13 4l9 8-9 8z', calendar: 'M4 5h16v16H4zM4 10h16M8 2v6M16 2v6', close: 'M6 6l12 12M18 6 6 18' };
    const stroke = name === 'calendar' || name === 'close';
    return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="${stroke ? 'none' : 'currentColor'}" stroke="${stroke ? 'currentColor' : 'none'}" stroke-width="1.5"><path d="${paths[name]}" /></svg>`;
};

export function replayTransportMarkup(): string {
    return `<div class="transport" role="toolbar" aria-label="Replay controls">
        <div class="transport-go"><button class="replay-button" data-action="go-to" title="Choose replay date" aria-label="Go to replay date">${controlIcon('calendar')}<span>Go to</span></button>
        <details id="replay-navigation" class="replay-navigation"><summary aria-label="Replay navigation options" title="Replay navigation options">⌄</summary><div class="replay-navigation-menu" role="group" aria-label="Replay navigation">
        <button data-action="go-to">Go to date…</button><button data-action="replay-jump-preset" data-preset="london">Next London open</button><button data-action="replay-jump-preset" data-preset="new-york">Next New York open</button><button data-action="replay-jump-preset" data-preset="next-day">Next day</button><hr><button data-action="skip">Advance 10 source bars</button></div></details></div>
        <span class="transport-divider"></span><div class="transport-main" role="group" aria-label="Playback">
        <button id="play" class="replay-button replay-primary" data-action="play" aria-label="Play replay" title="Play or pause (Space)">${controlIcon('play')}<span>Play</span></button>
        <button id="stop" class="replay-button" data-action="stop" aria-label="Stop replay" title="Stop playback or a jump at the current candle">${controlIcon('stop')}<span>Stop</span></button>
        <button class="replay-button" data-action="step" title="Next replay interval (Right arrow)" aria-label="Next replay interval">${controlIcon('step')}<span>Step</span></button>
        <button id="fast-forward" class="replay-button" data-action="fast-forward" aria-label="Fast forward replay" aria-pressed="false" title="Toggle fast playback at 10x">${controlIcon('fast')}<span>Fast</span></button></div>
        <label class="replay-speed-label"><span>Speed</span><select id="speed" aria-label="Playback speed"><option value="1">1x</option><option value="2">2x</option><option value="5">5x</option><option value="10">10x</option><option value="20">20x</option></select></label>
        <span class="transport-divider"></span><label class="replay-interval-label" title="Complete source bars processed per step"><span>Replay interval</span><select id="replay-interval" aria-label="Replay interval"><option value="1">1 bar</option><option value="5">5 bars</option><option value="10">10 bars</option></select></label>
        <span id="cursor-time" class="cursor-time">Replay paused</span><span id="jump-status" class="jump-status" role="status" hidden></span>
        <button class="replay-button replay-close" data-action="replay-close" aria-label="Close replay controls" title="Close replay controls and pause">${controlIcon('close')}<span>Close</span></button></div>`;
}

/** Keep the chart workspace separate from its management forms and shared dialogs. */
export function splitReplayShell(manager: string): { before: string; chart: string; after: string; overlays: string } {
    const start = manager.indexOf('<div class="chart-stage">');
    const end = manager.indexOf('<div class="transport"', start);
    const overlays = manager.indexOf('<dialog id="modal"');
    if (start < 0 || end <= start || overlays <= end) throw new Error('The replay workspace template is incomplete.');
    return { before: manager.slice(0, start), chart: manager.slice(start, end),
        after: manager.slice(end, overlays), overlays: manager.slice(overlays) };
}

export function buildReplayShell(): string {
        const parts = splitReplayShell(managementShell());
        const chart = parts.chart
            .replace(/<div class="empty-chart-glyph">.*?<\/div>/, '')
            .replace('Your next session starts here.', 'Vela Replay')
            .replace('Replay a futures contract at your pace.<br>Build consistency, one decision at a time.', 'Open a saved session or create a new one.')
            .replace('<button class="primary" data-action="new-session">', '<button class="quiet" data-action="sessions">Saved sessions</button><button class="primary" data-action="new-session">');
        return `<section id="standard-workspace" aria-label="Vela chart workspace">${chart}</section>
            <section id="session-manager" aria-label="Replay session manager" hidden>${parts.before}${parts.after}<div id="replay-home" hidden></div><div id="trade-home" hidden></div></section>${parts.overlays}`;
    }

export function managementShell(): string {
        return `<header class="app-header"><button class="brand quiet" data-action="chart" aria-label="Return to Vela chart">← Vela chart</button>
            <div class="header-center"><span class="eyebrow">SESSIONS & RESULTS</span><span class="simulation-badge">SIMULATED</span></div>
            <div class="header-actions"><span id="runtime-badge" class="runtime-badge" hidden></span><span id="connection" class="connection">Connecting locally…</span><button class="quiet" data-action="data">Data & settings</button></div></header>
        <div class="app-body"><aside class="sessions-sidebar"><div class="sidebar-heading"><span class="eyebrow">YOUR WORKSPACE</span><span class="local-label">LOCAL</span></div>
            <button class="primary new-session" data-action="new-session"><span>＋</span> New session</button><div class="section-label">SESSIONS <span id="session-count">0</span></div>
            <div id="sessions" class="session-list"></div><div class="sidebar-bottom"><button class="quiet" data-action="import-session">↥ Import session</button><p>Saved on this computer.<br>No broker connection.</p><div class="shortcut-line"><kbd>SPACE</kbd> Play / pause</div><div class="shortcut-line"><kbd>→</kbd> Next bar</div><div class="shortcut-line"><kbd>B</kbd><kbd>S</kbd><kbd>X</kbd> Buy · sell · close</div></div></aside>
        <main class="workspace"><div class="session-heading"><div><div class="eyebrow" id="session-kicker">BUILD YOUR EDGE</div><h1 id="session-name">A clear space to practice.</h1></div><div class="session-actions" id="session-actions" hidden><button class="quiet icon-button" data-action="rename" title="Rename session" aria-label="Rename session">✎</button><button class="quiet" data-action="save">Save</button><button class="quiet" data-action="clone">Clone</button><button class="quiet" data-action="restart">Fresh attempt</button><button class="quiet" data-action="export">Export</button></div></div>
        <section class="account-strip" aria-label="Simulated account"><div><span>BALANCE</span><strong id="balance">—</strong></div><div><span>EQUITY</span><strong id="equity">—</strong></div><div><span>UNREALIZED P&L</span><strong id="unrealized">—</strong></div><div><span>NET P&L</span><strong id="net-pnl">—</strong></div><div class="account-status"><span>ATTEMPT STATUS</span><strong id="attempt-status">Ready when you are</strong></div></section>
        <div class="terminal"><div class="chart-column"><section class="chart-panel"><div class="chart-heading"><div><strong id="chart-symbol">NQ</strong><span id="source-badge" class="source-badge">Choose a data source</span></div><div class="chart-options"><label class="sr-only" for="timeframe">Active chart timeframe</label><select id="timeframe" aria-label="Active chart timeframe"><option value="1S" disabled>1 sec</option><option value="5S" disabled>5 sec</option><option value="15S" disabled>15 sec</option><option value="1">1 min</option><option value="3">3 min</option><option value="5">5 min</option><option value="15">15 min</option><option value="30">30 min</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="D">1 day</option></select><select id="chart-layout" aria-label="Chart layout"><option value="1">▣ Single</option><option value="2h">◫ Side by side</option><option value="2v">⊟ Stacked</option><option value="4">⊞ Four charts</option></select><button class="quiet icon-button" data-action="bookmark" title="Bookmark current bar" aria-label="Bookmark current bar">⚑</button></div></div>
        <div class="chart-stage"><div id="chart"></div><div id="chart-empty" class="chart-empty"><div class="empty-chart-glyph">⌁</div><h2>Your next session starts here.</h2><p>Replay a futures contract at your pace.<br>Build consistency, one decision at a time.</p><button class="primary" data-action="new-session">Create a session <span>↗</span></button><button class="text-button" data-action="demo">Try with synthetic demo data</button></div></div>
        ${replayTransportMarkup()}<div class="replay-progress"><div id="replay-progress-fill"></div></div><div class="chart-footnote"><span id="bar-progress">Closed source bars · no future data shown</span><span>OHLC simulation · next-bar execution · stop-first ambiguity</span></div></section>
        <section class="results-panel"><div class="results-tabs" role="tablist" aria-label="Session results"><button role="tab" aria-selected="false" data-action="tab" data-tab="trading" aria-controls="trading-details">Positions & orders</button><button role="tab" aria-selected="false" data-action="tab" data-tab="trades">Trades <span id="trade-count">0</span></button><button role="tab" aria-selected="true" class="active" data-action="tab" data-tab="analytics">Overview</button><button role="tab" aria-selected="false" data-action="tab" data-tab="bookmarks">Bookmarks</button><button role="tab" aria-selected="false" data-action="tab" data-tab="rules">Rules & costs</button><span class="autosave" id="save-status"><i></i> Saved locally</span></div><div class="local-result-body"><div id="trading-details" class="local-trading-details" role="tabpanel" aria-label="Positions and working orders" hidden>
        <section class="position-panel"><div class="panel-heading"><h2>Position</h2><span id="position-badge" class="muted">FLAT</span></div><div id="position-content"><div class="empty-position">No open simulated position</div></div></section>
        <section class="orders-panel"><div class="panel-heading"><h2>Working orders</h2><span id="working-count" class="count-pill">0</span></div><div id="orders-content"><div class="empty-position">No working simulated orders</div></div></section>
        </div><div id="account-details" class="local-account-details" hidden><section class="rules-panel"><div class="panel-heading"><h2 id="rules-title">Practice account</h2><span id="rules-state" class="status-label">—</span></div><div id="rules-content"><p class="muted">Create a session to set your account rules.</p></div></section></div><div id="results" class="results-content" role="tabpanel"><div class="empty-small">Your completed simulated trades will appear here.</div></div></div></section></div>
        <aside class="trading-column">${tradeTicketMarkup()}</aside></div>
        <footer class="workspace-footer"><span><i class="status-dot"></i> Local simulation only</span><span id="cost-footnote">Your data. Your pace. Your process.</span><a href="https://github.com/luxalgo/vela" target="_blank" rel="noreferrer">Charts by Vela ↗</a></footer></main></div>
        <dialog id="modal" aria-labelledby="modal-title"><div id="modal-content"></div></dialog><div id="toast" role="status" aria-live="polite" hidden></div><input id="session-import" type="file" accept=".json,application/json" hidden />`;
    }
