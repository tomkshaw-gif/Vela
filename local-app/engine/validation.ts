import type { Bar, Instrument, OrderDraft, PropRules, Session, SessionConfig, TakeProfitLeg } from '../shared/types';

export const LIMITS = { orders: 20000, fills: 40000, trades: 20000, curve: 10000, days: 10000, bookmarks: 1000, contracts: 1000, takeProfits: 10 };
export const money = (n: number): number => Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;
export const object = (v: unknown, label: string): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} must be an object`);
    return v as Record<string, unknown>;
};
export function number(v: unknown, label: string, min = -1e12, max = 1e12): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${label} must be a finite number between ${min} and ${max}`);
    return v;
}
export function integer(v: unknown, label: string, min: number, max: number): number {
    const n = number(v, label, min, max);
    if (!Number.isSafeInteger(n)) throw new Error(`${label} must be an integer`);
    return n;
}
export function text(v: unknown, label: string, max = 100): string {
    if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`${label} must contain 1 to ${max} characters`);
    return v.trim();
}
export function id(v: unknown, label = 'ID'): string {
    if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(v)) throw new Error(`${label} is invalid`);
    return v;
}
export function choice<T extends string>(v: unknown, values: readonly T[], label: string): T {
    if (!values.includes(v as T)) throw new Error(`${label} must be ${values.join(', ')}`);
    return v as T;
}
function boolean(v: unknown, label: string): boolean {
    if (typeof v !== 'boolean') throw new Error(`${label} must be a boolean`);
    return v;
}
export function tickPrice(v: unknown, instrument: Instrument, label: string): number {
    const n = number(v, label, 0.00000001, 1e9);
    const ticks = n / instrument.tickSize;
    if (Math.abs(ticks - Math.round(ticks)) > 1e-6) throw new Error(`${label} must align to tick size ${instrument.tickSize}`);
    return n;
}
export function validateInstrument(v: unknown): Instrument {
    const x = object(v, 'Instrument');
    const root = text(x.root, 'Instrument root', 12);
    if (!/^[A-Z0-9]+$/.test(root)) throw new Error('Instrument root is invalid');
    return { root, tickSize: number(x.tickSize, 'Tick size', 0.00000001, 1000), pointValue: number(x.pointValue, 'Point value', 0.00000001, 100000) };
}
export function validateSessionConfig(v: unknown, barCount?: number): SessionConfig {
    const x = object(v, 'Session config');
    const mode = choice(x.mode, ['practice', 'prop'], 'Session mode');
    const r = object(x.rules, 'Prop rules');
    const timezone = text(r.dayResetTimezone, 'Reset timezone', 80);
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0); } catch { throw new Error('Reset timezone is invalid'); }
    const rules: PropRules = {
        profitTargetUsd: number(r.profitTargetUsd, 'Profit target', 0.01, 1e8),
        maxDailyLossUsd: number(r.maxDailyLossUsd, 'Daily loss', 0.01, 1e8),
        maxDrawdownUsd: number(r.maxDrawdownUsd, 'Maximum drawdown', 0.01, 1e8),
        drawdownType: choice(r.drawdownType, ['static', 'trailing-intraday', 'trailing-eod'], 'Drawdown type'),
        drawdownLocksAtInitialBalance: boolean(r.drawdownLocksAtInitialBalance, 'Drawdown lock'),
        minTradingDays: integer(r.minTradingDays, 'Minimum trading days', 0, 3650),
        maxContracts: integer(r.maxContracts, 'Maximum contracts', 1, LIMITS.contracts),
        consistencyPct: r.consistencyPct === null ? null : number(r.consistencyPct, 'Consistency percentage', 0.01, 100),
        dayResetTimezone: timezone, dayResetHour: integer(r.dayResetHour, 'Reset hour', 0, 23),
        requireFlatToPass: boolean(r.requireFlatToPass, 'Require flat to pass'),
    };
    const commission = number(x.commissionPerContractSide, 'Commission', 0, 10000);
    if (Math.abs(commission * 100 - Math.round(commission * 100)) > 1e-6) throw new Error('Commission supports whole cents');
    const initialBalance = number(x.initialBalance, 'Initial balance', 1, 1e9);
    if (Math.abs(initialBalance * 100 - Math.round(initialBalance * 100)) > 1e-6) throw new Error('Initial balance supports whole cents');
    if (mode === 'prop' && (rules.maxDrawdownUsd >= initialBalance || rules.maxDailyLossUsd >= initialBalance)) throw new Error('Loss and drawdown limits must be less than initial balance');
    const startIndex = integer(x.startIndex, 'Start index', 0, barCount === undefined ? 5000000 : Math.max(0, barCount - 1));
    return {
        name: text(x.name, 'Session name'), datasetId: id(x.datasetId, 'Dataset ID'),
        mode, initialBalance,
        commissionPerContractSide: commission,
        slippageTicks: integer(x.slippageTicks, 'Slippage ticks', 0, 100),
        spreadTicks: integer(x.spreadTicks, 'Spread ticks', 0, 100),
        startIndex, ...(x.endIndex === undefined ? {} : { endIndex: integer(x.endIndex, 'End index', startIndex + 1, barCount ?? 5000000) }), rules,
    };
}
export function validateBar(bar: Bar, instrument: Instrument): void {
    const x = object(bar, 'Bar');
    integer(x.time, 'Bar time', 0, 8640000000000000);
    for (const key of ['open', 'high', 'low', 'close'] as const) tickPrice(x[key], instrument, `Bar ${key}`);
    number(x.volume, 'Bar volume', 0, 1e15);
    if (bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close)) throw new Error('Bar OHLC range is invalid');
}
export function validateDraft(v: unknown, instrument: Instrument, reference?: number): OrderDraft {
    const x = object(v, 'Order');
    const side = choice(x.side, ['buy', 'sell'], 'Order side');
    const type = choice(x.type, ['market', 'limit', 'stop'], 'Order type');
    const draft: OrderDraft = { side, type, qty: integer(x.qty, 'Order quantity', 1, LIMITS.contracts * 2) };
    if (type !== 'market') draft.price = tickPrice(x.price, instrument, 'Order price');
    else if (x.price !== undefined) throw new Error('Market orders do not have a price');
    if (x.stopLoss !== undefined) draft.stopLoss = tickPrice(x.stopLoss, instrument, 'Stop loss');
    if (x.takeProfit !== undefined) draft.takeProfit = tickPrice(x.takeProfit, instrument, 'Take profit');
    if (x.takeProfits !== undefined) {
        if (x.takeProfit !== undefined) throw new Error('Scalar take profit and target legs cannot be combined');
        draft.takeProfits = validateTakeProfits(x.takeProfits, instrument, draft.qty);
    }
    const targets = [draft.takeProfit, ...(draft.takeProfits ?? []).map(leg => leg.price)].filter((price): price is number => price !== undefined);
    const entry = draft.price ?? reference;
    if (entry !== undefined) {
        if (draft.stopLoss !== undefined && (side === 'buy' ? draft.stopLoss >= entry : draft.stopLoss <= entry)) throw new Error('Stop loss must be beyond the entry on the loss side');
        if (targets.some(price => side === 'buy' ? price <= entry : price >= entry)) throw new Error('Take profit must be beyond the entry on the profit side');
    } else if (draft.stopLoss !== undefined && targets.some(price => side === 'buy' ? draft.stopLoss! >= price : draft.stopLoss! <= price)) throw new Error('Bracket prices are reversed');
    return draft;
}
export function validateTakeProfits(value: unknown, instrument: Instrument, ownerQty: number): TakeProfitLeg[] {
    const legs = list(value, 'Take profit targets', LIMITS.takeProfits).map(value => {
        const leg = object(value, 'Take profit target');
        return { id: id(leg.id, 'Take profit target ID'), price: tickPrice(leg.price, instrument, 'Take profit target price'), qty: integer(leg.qty, 'Take profit target quantity', 1, ownerQty) };
    });
    unique(legs, 'take profit target');
    if (legs.reduce((sum, leg) => sum + leg.qty, 0) > ownerQty) throw new Error('Take profit target quantities exceed remaining contracts');
    return legs;
}
/** A missing marker is legacy only when no version-two execution fields are present. */
export function validateExecutionVersion(input: unknown): 1 | 2 {
    const x = object(input, 'Session');
    if (x.executionVersion !== undefined && x.executionVersion !== 2) throw new Error('Unsupported execution version');
    const has = (value: unknown, key: string): boolean => !!value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key);
    const entriesHave = (value: unknown, key: string): boolean => Array.isArray(value) && value.some(entry => has(entry, key));
    if (x.executionVersion === undefined && (has(x.position, 'takeProfits') || entriesHave(x.orders, 'takeProfits') || entriesHave(x.fills, 'takeProfitLegId') || entriesHave(x.trades, 'takeProfitLegId'))) throw new Error('Target legs and provenance require execution version 2');
    return x.executionVersion === 2 ? 2 : 1;
}
export function safeLayout(v: unknown): unknown {
    let nodes = 0;
    const visit = (value: unknown, depth: number): void => {
        if (++nodes > 20000 || depth > 32) throw new Error('Layout is too large or deeply nested');
        if (value === null || typeof value === 'boolean') return;
        if (typeof value === 'number') { number(value, 'Layout number', -1e16, 1e16); return; }
        if (typeof value === 'string') { if (value.length > 250000) throw new Error('Layout string is too large'); return; }
        if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
        const obj = object(value, 'Layout');
        if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) throw new Error('Layout must contain plain JSON');
        for (const [key, item] of Object.entries(obj)) {
            if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new Error('Layout key is invalid');
            visit(item, depth + 1);
        }
    };
    visit(v, 0);
    const encoded = JSON.stringify(v);
    if (encoded.length > 500000) throw new Error('Layout must be at most 500 KB');
    return JSON.parse(encoded) as unknown;
}
function list(v: unknown, label: string, max: number): unknown[] {
    if (!Array.isArray(v) || v.length > max) throw new Error(`${label} must contain at most ${max} entries`);
    return v as unknown[];
}
function date(v: unknown, label: string): string {
    const value = text(v, label, 40);
    if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
    return value;
}
function optionalNumber(x: Record<string, unknown>, key: string, min = -1e12): number | undefined {
    return x[key] === undefined ? undefined : number(x[key], key, min);
}
function unique(items: { id: string }[], label: string): void {
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error(`Duplicate ${label} IDs`);
}
/** Validate persisted/imported state before it can resume an account. Unknown fields are discarded. */
export function validateStoredSession(input: unknown, bars: Bar[], expectedInstrument: Instrument): Session {
    const x = object(input, 'Session');
    const executionVersion = validateExecutionVersion(input);
    if (!Array.isArray(bars) || bars.length < 1 || bars.length > 5000000) throw new Error('A session needs 1 to 5000000 source bars');
    const config = validateSessionConfig(x.config, bars.length);
    const instrument = validateInstrument(x.instrument);
    if (JSON.stringify(instrument) !== JSON.stringify(validateInstrument(expectedInstrument))) throw new Error('Session instrument does not match dataset');
    const cursor = integer(x.cursor, 'Cursor', config.startIndex - 1, (config.endIndex ?? bars.length) - 1);
    if (cursor >= 0) validateBar(bars[cursor]!, instrument);
    const a = object(x.account, 'Account');
    const p = object(x.prop, 'Prop state');
    const session: Session = {
        ...(executionVersion === 2 ? { executionVersion: 2 } : {}),
        id: id(x.id, 'Session ID'), config, instrument, cursor,
        status: choice(x.status, ['paused', 'completed', 'passed', 'failed'], 'Session status'),
        revision: integer(x.revision, 'Revision', 0, Number.MAX_SAFE_INTEGER - 1),
        createdAt: date(x.createdAt, 'Created time'), updatedAt: date(x.updatedAt, 'Updated time'),
        account: { balance: number(a.balance, 'Balance'), equity: number(a.equity, 'Equity'), unrealizedPnl: number(a.unrealizedPnl, 'Unrealized PnL'), netPnl: number(a.netPnl, 'Net PnL'), fees: number(a.fees, 'Fees', 0), peakEquity: number(a.peakEquity, 'Peak equity'), maxDrawdown: number(a.maxDrawdown, 'Drawdown', 0) },
        position: null, orders: [], fills: [], trades: [], equityCurve: [], days: [], bookmarks: [], layout: safeLayout(x.layout),
        prop: { status: choice(p.status, ['active', 'passed', 'failed'], 'Prop status'), reason: p.reason === null ? null : text(p.reason, 'Prop reason', 500), dailyLoss: number(p.dailyLoss, 'Daily loss', 0), drawdownFloor: number(p.drawdownFloor, 'Drawdown floor'), trailingPeak: number(p.trailingPeak, 'Trailing peak'), tradingDays: integer(p.tradingDays, 'Trading days', 0, LIMITS.days), bestDayProfit: number(p.bestDayProfit, 'Best day profit', 0), consistencyPct: number(p.consistencyPct, 'Consistency', 0, 1e12) },
    };
    if (x.position !== null) {
        const q = object(x.position, 'Position');
        const side = choice(q.side, ['buy', 'sell'], 'Position side');
        session.position = { side, qty: integer(q.qty, 'Position quantity', 1, config.rules.maxContracts), avgPrice: number(q.avgPrice, 'Average price', 0.00000001, 1e9), entryTime: integer(q.entryTime, 'Entry time', 0, 8640000000000000), entryFees: number(q.entryFees, 'Entry fees', 0), mae: number(q.mae, 'MAE', 0), mfe: number(q.mfe, 'MFE', 0) };
        for (const key of ['stopLoss', 'takeProfit'] as const) if (q[key] !== undefined) session.position[key] = tickPrice(q[key], instrument, key);
        if (q.takeProfits !== undefined) {
            if (q.takeProfit !== undefined) throw new Error('Scalar take profit and target legs cannot be combined');
            session.position.takeProfits = validateTakeProfits(q.takeProfits, instrument, session.position.qty);
        }
        if (q.initialRisk !== undefined) session.position.initialRisk = number(q.initialRisk, 'Initial risk', 0.00000001);
    }
    session.orders = list(x.orders, 'Orders', LIMITS.orders).map(value => {
        const o = object(value, 'Order');
        const draft = validateDraft(o, instrument);
        return { ...draft, id: id(o.id, 'Order ID'), intent: o.intent === undefined ? undefined : choice(o.intent, ['close', 'reverse'] as const, 'Order intent'), status: choice(o.status, ['working', 'filled', 'cancelled', 'rejected'], 'Order status'), createdTime: integer(o.createdTime, 'Order time', -1, 8640000000000000), filledTime: o.filledTime === undefined ? undefined : integer(o.filledTime, 'Fill time', 0, 8640000000000000), fillPrice: optionalNumber(o, 'fillPrice', 0.00000001), rejectReason: o.rejectReason === undefined ? undefined : text(o.rejectReason, 'Rejection reason', 500) };
    });
    session.fills = list(x.fills, 'Fills', LIMITS.fills).map(value => {
        const f = object(value, 'Fill');
        return { id: id(f.id, 'Fill ID'), orderId: id(f.orderId, 'Order ID'), time: integer(f.time, 'Fill time', 0, 8640000000000000), side: choice(f.side, ['buy', 'sell'], 'Fill side'), qty: integer(f.qty, 'Fill quantity', 1, LIMITS.contracts * 2), price: tickPrice(f.price, instrument, 'Fill price'), fees: number(f.fees, 'Fill fees', 0), reason: text(f.reason, 'Fill reason', 100), ...(f.takeProfitLegId === undefined ? {} : { takeProfitLegId: id(f.takeProfitLegId, 'Take profit target ID') }) };
    });
    session.trades = list(x.trades, 'Trades', LIMITS.trades).map(value => {
        const t = object(value, 'Trade');
        return { id: id(t.id, 'Trade ID'), side: choice(t.side, ['buy', 'sell'], 'Trade side'), qty: integer(t.qty, 'Trade quantity', 1, LIMITS.contracts), entryTime: integer(t.entryTime, 'Entry time', 0, 8640000000000000), exitTime: integer(t.exitTime, 'Exit time', 0, 8640000000000000), entryPrice: number(t.entryPrice, 'Entry price', 0.00000001, 1e9), exitPrice: number(t.exitPrice, 'Exit price', 0.00000001, 1e9), grossPnl: number(t.grossPnl, 'Gross PnL'), fees: number(t.fees, 'Trade fees', 0), netPnl: number(t.netPnl, 'Trade net PnL'), reason: text(t.reason, 'Trade reason', 100), initialRisk: optionalNumber(t, 'initialRisk', 0.00000001), mae: number(t.mae, 'MAE', 0), mfe: number(t.mfe, 'MFE', 0), ...(t.takeProfitLegId === undefined ? {} : { takeProfitLegId: id(t.takeProfitLegId, 'Take profit target ID') }) };
    });
    session.equityCurve = list(x.equityCurve, 'Equity curve', LIMITS.curve).map(value => {
        const e = object(value, 'Equity point');
        return { time: integer(e.time, 'Equity time', 0, 8640000000000000), balance: number(e.balance, 'Equity balance'), equity: number(e.equity, 'Equity value') };
    });
    session.days = list(x.days, 'Days', LIMITS.days).map(value => {
        const d = object(value, 'Day');
        const day = text(d.day, 'Trading day', 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Trading day is invalid');
        return { day, startBalance: number(d.startBalance, 'Day starting balance'), realizedPnl: number(d.realizedPnl, 'Day PnL'), minEquity: number(d.minEquity, 'Day minimum equity'), endBalance: number(d.endBalance, 'Day ending balance'), trades: integer(d.trades, 'Day trades', 0, LIMITS.trades), traded: boolean(d.traded, 'Day traded') };
    });
    session.bookmarks = list(x.bookmarks, 'Bookmarks', LIMITS.bookmarks).map(value => {
        const b = object(value, 'Bookmark');
        return { id: id(b.id, 'Bookmark ID'), time: integer(b.time, 'Bookmark time', 0, 8640000000000000), label: text(b.label, 'Bookmark label', 200) };
    });
    unique(session.orders, 'order'); unique(session.fills, 'fill'); unique(session.trades, 'trade'); unique(session.bookmarks, 'bookmark');
    const now = cursor >= 0 ? bars[cursor]!.time : -1;
    const close = cursor >= 0 ? bars[cursor]!.close : 0;
    const unrealized = session.position ? money((close - session.position.avgPrice) * (session.position.side === 'buy' ? 1 : -1) * session.position.qty * instrument.pointValue) : 0;
    const fees = money(session.fills.reduce((sum, fill) => sum + fill.fees, 0));
    const gross = money(session.trades.reduce((sum, trade) => sum + trade.grossPnl, 0));
    const signedQty = session.fills.reduce((sum, fill) => sum + (fill.side === 'buy' ? fill.qty : -fill.qty), 0);
    const qty = session.position ? session.position.qty * (session.position.side === 'buy' ? 1 : -1) : 0;
    const near = (left: number, right: number): boolean => Math.abs(left - right) < 0.011;
    if (!near(a.fees as number, fees) || !near(session.account.balance, money(config.initialBalance + gross - fees)) || !near(session.account.unrealizedPnl, unrealized) || !near(session.account.equity, money(session.account.balance + unrealized)) || !near(session.account.netPnl, money(session.account.equity - config.initialBalance)) || signedQty !== qty) throw new Error('Session account and execution ledger do not reconcile');
    if (session.account.peakEquity < session.account.equity - 0.01 || session.account.maxDrawdown + 0.01 < session.account.peakEquity - session.account.equity) throw new Error('Session drawdown state is invalid');
    for (const fill of session.fills) if (fill.time > now || !near(fill.fees, money(fill.qty * config.commissionPerContractSide))) throw new Error('Fill time or fees are invalid');
    for (const trade of session.trades) if (trade.exitTime > now || trade.entryTime > trade.exitTime || !near(trade.netPnl, money(trade.grossPnl - trade.fees)) || !near(trade.grossPnl, money((trade.exitPrice - trade.entryPrice) * trade.qty * instrument.pointValue * (trade.side === 'buy' ? 1 : -1)))) throw new Error('Trade ledger is invalid');
    if (session.position && session.position.entryTime > now) throw new Error('Position entry is in the future');
    if (session.orders.some(o => o.createdTime > Math.max(now, bars[0]!.time - 1) || (o.filledTime !== undefined && (o.filledTime > now || o.filledTime <= o.createdTime)))) throw new Error('Order timestamps are invalid');
    if (session.equityCurve.some((point, index, points) => point.time > now || (index > 0 && point.time <= points[index - 1]!.time))) throw new Error('Equity history is not ordered or contains future data');
    if (session.bookmarks.some(b => b.time > now)) throw new Error('Bookmark contains future data');
    if (new Set(session.days.map(day => day.day)).size !== session.days.length) throw new Error('Duplicate trading days');
    if (session.status === 'failed' || session.status === 'passed' || session.status === 'completed') {
        if (session.position || session.orders.some(order => order.status === 'working')) throw new Error('Terminal session must be flat with no working orders');
    }
    if ((session.status === 'failed') !== (session.prop.status === 'failed') || (session.status === 'passed') !== (session.prop.status === 'passed')) throw new Error('Session and prop status disagree');
    if ((session.status === 'passed' || session.status === 'failed') && !session.prop.reason) throw new Error('Terminal evaluation requires a reason');
    // Rebuild cost basis from executions, so changing an imported average price or fee allocation cannot silently alter later PnL.
    let ledger: { side: 'buy' | 'sell'; qty: number; price: number; fees: number; time: number } | null = null;
    let closedTrades = 0;
    const equalPrice = (left: number, right: number): boolean => Math.abs(left - right) <= 1e-7 * Math.max(1, Math.abs(left) / 1000000);
    const sourceTime = (time: number): boolean => {
        let low = config.startIndex; let high = cursor;
        while (low <= high) { const mid = Math.floor((low + high) / 2); const candidate = bars[mid]!.time; if (candidate === time) return true; if (candidate < time) low = mid + 1; else high = mid - 1; }
        return false;
    };
    for (let index = 0; index < session.fills.length; index++) {
        const f = session.fills[index]!;
        if (!sourceTime(f.time) || (index > 0 && f.time < session.fills[index - 1]!.time)) throw new Error('Fills must follow revealed source-bar times');
        if (ledger && ledger.side !== f.side) {
            const qty = Math.min(ledger.qty, f.qty);
            const entryFees = qty === ledger.qty ? ledger.fees : money(ledger.fees * qty / ledger.qty);
            const exitFees = qty === f.qty ? f.fees : money(f.fees * qty / f.qty);
            const trade = session.trades[closedTrades++];
            if ((f.takeProfitLegId !== undefined && (f.qty > ledger.qty || f.reason !== 'Take profit')) || trade?.takeProfitLegId !== f.takeProfitLegId) throw new Error('Take profit target provenance does not match a reducing fill');
            if (!trade || trade.side !== ledger.side || trade.qty !== qty || trade.entryTime !== ledger.time || trade.exitTime !== f.time || !equalPrice(trade.entryPrice, ledger.price) || !equalPrice(trade.exitPrice, f.price) || !near(trade.fees, money(entryFees + exitFees))) throw new Error('Trades do not match execution cost basis');
            if (qty < ledger.qty) { ledger.qty -= qty; ledger.fees = money(ledger.fees - entryFees); }
            else ledger = f.qty > qty ? { side: f.side, qty: f.qty - qty, price: f.price, fees: money(f.fees - exitFees), time: f.time } : null;
        } else if (f.takeProfitLegId !== undefined) throw new Error('Take profit target provenance cannot describe an entry');
        else if (ledger) {
            ledger.price = (ledger.price * ledger.qty + f.price * f.qty) / (ledger.qty + f.qty);
            ledger.qty += f.qty; ledger.fees = money(ledger.fees + f.fees);
        } else ledger = { side: f.side, qty: f.qty, price: f.price, fees: f.fees, time: f.time };
        if (ledger && ledger.qty > config.rules.maxContracts) throw new Error('Execution history exceeds contract limit');
    }
    const position = session.position;
    if (closedTrades !== session.trades.length || (!!ledger !== !!position) || (ledger && position && (ledger.side !== position.side || ledger.qty !== position.qty || ledger.time !== position.entryTime || !equalPrice(ledger.price, position.avgPrice) || !near(ledger.fees, position.entryFees)))) throw new Error('Position does not match execution cost basis');
    const fillOrders = new Map<string, typeof session.fills>();
    for (const f of session.fills) { const group = fillOrders.get(f.orderId) ?? []; group.push(f); fillOrders.set(f.orderId, group); }
    for (const o of session.orders) {
        const matches = fillOrders.get(o.id) ?? [];
        if (o.intent && o.type !== 'market') throw new Error('Position-intent orders must be market orders');
        if (o.status === 'filled' ? matches.length !== 1 || o.fillPrice !== matches[0]?.price || o.filledTime !== matches[0]?.time || o.side !== matches[0]?.side || o.qty !== matches[0]?.qty : matches.length !== 0 || o.fillPrice !== undefined || o.filledTime !== undefined) throw new Error('Order and fill states disagree');
    }
    const expectedFloor = config.rules.drawdownType === 'static' ? config.initialBalance - config.rules.maxDrawdownUsd : session.prop.trailingPeak - config.rules.maxDrawdownUsd;
    if (!near(session.prop.drawdownFloor, money(config.rules.drawdownLocksAtInitialBalance ? Math.min(config.initialBalance, expectedFloor) : expectedFloor)) || session.prop.trailingPeak < config.initialBalance || session.prop.trailingPeak > session.account.peakEquity + 0.01) throw new Error('Trailing drawdown state is invalid');
    const day = session.days.at(-1);
    const total = money(session.account.balance - config.initialBalance);
    const bestDay = money(Math.max(0, ...session.days.map(d => d.realizedPnl)));
    const consistency = total > 0 ? bestDay / total * 100 : 0;
    if (session.prop.tradingDays !== session.days.filter(d => d.traded).length || !near(session.prop.bestDayProfit, bestDay) || Math.abs(session.prop.consistencyPct - consistency) > 0.000001 || !near(session.prop.dailyLoss, money(Math.max(0, (day?.startBalance ?? config.initialBalance) - session.account.equity)))) throw new Error('Daily evaluation state does not reconcile');
    if (session.days.reduce((sum, d) => sum + d.trades, 0) !== session.trades.length || !near(session.days.reduce((sum, d) => sum + d.realizedPnl, 0), total)) throw new Error('Daily ledger does not reconcile');
    for (let index = 0; index < session.days.length; index++) {
        const d = session.days[index]!;
        if (!near(d.endBalance, money(d.startBalance + d.realizedPnl)) || !near(d.startBalance, index === 0 ? config.initialBalance : session.days[index - 1]!.endBalance) || (index > 0 && d.day <= session.days[index - 1]!.day)) throw new Error('Daily ledger is not ordered or balanced');
    }
    return session;
}
