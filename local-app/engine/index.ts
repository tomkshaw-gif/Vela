import type { Bar, Command, DayStat, Instrument, Order, OrderDraft, Position, Session, SessionConfig, Side } from '../shared/types';
import { choice, id, integer, LIMITS, money, object, safeLayout, text, tickPrice, validateBar, validateDraft, validateInstrument, validateSessionConfig, validateStoredSession, validateTakeProfits } from './validation';
export { validateSessionConfig, validateStoredSession } from './validation';
export { analytics, monteCarlo } from './statistics';

const sign = (side: Side): number => side === 'buy' ? 1 : -1;
const opposite = (side: Side): Side => side === 'buy' ? 'sell' : 'buy';
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function localId(s: Session, kind: string, count: number): string {
    let hash = 2166136261;
    for (const c of s.id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
    return `${kind}_${(hash >>> 0).toString(16)}_${s.revision + 1}_${count + 1}`;
}

export function createSession(raw: SessionConfig, rawInstrument: Instrument, sessionId?: string): Session {
    const config = validateSessionConfig(raw);
    const instrument = validateInstrument(rawInstrument);
    const createdAt = new Date().toISOString();
    return {
        id: id(sessionId ?? globalThis.crypto.randomUUID(), 'Session ID'), config, instrument,
        cursor: config.startIndex - 1, status: 'paused', revision: 0, createdAt, updatedAt: createdAt,
        account: { balance: config.initialBalance, equity: config.initialBalance, unrealizedPnl: 0, netPnl: 0, fees: 0, peakEquity: config.initialBalance, maxDrawdown: 0 },
        position: null, orders: [], fills: [], trades: [], equityCurve: [], days: [], bookmarks: [], layout: null,
        prop: { status: 'active', reason: null, dailyLoss: 0, drawdownFloor: money(config.initialBalance - config.rules.maxDrawdownUsd), trailingPeak: config.initialBalance, tradingDays: 0, bestDayProfit: 0, consistencyPct: 0 },
    };
}

/** Session day is a calendar date in the configured zone, shifted before its local reset hour. */
function sessionDay(time: number, s: Session): string {
    const zone = s.config.rules.dayResetTimezone;
    let formatter = dayFormatters.get(zone);
    if (!formatter) {
        if (dayFormatters.size >= 32) dayFormatters.delete(dayFormatters.keys().next().value!);
        formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
        dayFormatters.set(zone, formatter);
    }
    const parts = formatter.formatToParts(time);
    const get = (key: Intl.DateTimeFormatPartTypes): number => Number(parts.find(p => p.type === key)!.value);
    const date = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
    if (get('hour') < s.config.rules.dayResetHour) date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
}
function currentDay(s: Session): DayStat | undefined { return s.days[s.days.length - 1]; }
function updateFloor(s: Session): void {
    const { rules, initialBalance } = s.config;
    const peak = rules.drawdownType === 'static' ? initialBalance : s.prop.trailingPeak;
    s.prop.drawdownFloor = money(rules.drawdownLocksAtInitialBalance ? Math.min(initialBalance, peak - rules.maxDrawdownUsd) : peak - rules.maxDrawdownUsd);
}
function dayAt(s: Session, time: number): DayStat {
    const key = sessionDay(time, s);
    let day = currentDay(s);
    if (day?.day === key) return day;
    if (day && s.config.rules.drawdownType === 'trailing-eod') {
        s.prop.trailingPeak = Math.max(s.prop.trailingPeak, day.endBalance);
        updateFloor(s);
    }
    if (s.days.length >= LIMITS.days) throw new Error('Trading-day history limit reached; start a separate attempt');
    day = { day: key, startBalance: s.account.balance, realizedPnl: 0, minEquity: s.account.equity, endBalance: s.account.balance, trades: 0, traded: false };
    s.days.push(day);
    return day;
}
function propStats(s: Session): void {
    const day = currentDay(s);
    s.prop.dailyLoss = money(Math.max(0, (day?.startBalance ?? s.config.initialBalance) - s.account.equity));
    s.prop.tradingDays = s.days.filter(d => d.traded).length;
    s.prop.bestDayProfit = money(Math.max(0, ...s.days.map(d => d.realizedPnl)));
    const total = money(s.account.balance - s.config.initialBalance);
    s.prop.consistencyPct = total > 0 ? s.prop.bestDayProfit / total * 100 : 0;
}
function mark(s: Session, price: number): void {
    const p = s.position;
    s.account.unrealizedPnl = p ? money((price - p.avgPrice) * sign(p.side) * p.qty * s.instrument.pointValue) : 0;
    s.account.equity = money(s.account.balance + s.account.unrealizedPnl);
    s.account.netPnl = money(s.account.equity - s.config.initialBalance);
    if (![s.account.balance, s.account.equity, s.account.netPnl, s.account.fees].every(value => Number.isFinite(value) && Math.abs(value) <= 1e12)) throw new Error('Account magnitude exceeds the simulation limit');
    s.account.peakEquity = Math.max(s.account.peakEquity, s.account.equity);
    s.account.maxDrawdown = money(Math.max(s.account.maxDrawdown, s.account.peakEquity - s.account.equity));
    const day = currentDay(s);
    if (day) { day.minEquity = Math.min(day.minEquity, s.account.equity); day.endBalance = s.account.balance; }
    if (s.config.rules.drawdownType === 'trailing-intraday') {
        s.prop.trailingPeak = Math.max(s.prop.trailingPeak, s.account.equity);
        updateFloor(s);
    }
    propStats(s);
}
/** Keep fills on ticks while charging exactly one configured spread per round trip. */
function executionPrice(s: Session, base: number, side: Side, limit?: number): number {
    const spread = side === 'buy' ? Math.ceil(s.config.spreadTicks / 2) : Math.floor(s.config.spreadTicks / 2);
    const adverseTicks = s.config.slippageTicks + spread;
    const raw = base + sign(side) * adverseTicks * s.instrument.tickSize;
    const ticks = raw / s.instrument.tickSize;
    let result = (side === 'buy' ? Math.ceil(ticks - 1e-8) : Math.floor(ticks + 1e-8)) * s.instrument.tickSize;
    if (limit !== undefined) result = side === 'buy' ? Math.min(result, limit) : Math.max(result, limit);
    if (!Number.isFinite(result) || result <= 0 || result > 1e9) throw new Error('Configured execution costs produce an invalid fill price');
    return Number(result.toFixed(8));
}
function cancelWorking(s: Session): void {
    for (const order of s.orders) if (order.status === 'working') order.status = 'cancelled';
}
function contractsFit(s: Session, draft?: OrderDraft, excludedId?: string): void {
    const current = s.position ? sign(s.position.side) * s.position.qty : 0;
    let buys = 0; let sells = 0;
    for (const o of [...s.orders.filter(o => o.status === 'working' && o.id !== excludedId), ...(draft ? [draft] : [])]) {
        if (o.side === 'buy') buys += o.qty; else sells += o.qty;
    }
    if (Math.max(Math.abs(current + buys), Math.abs(current - sells)) > s.config.rules.maxContracts) throw new Error(`Orders could exceed the ${s.config.rules.maxContracts}-contract limit`);
}
function bracketCompatibility(s: Session, draft: OrderDraft): void {
    const p = s.position;
    if (!p) return;
    if (p.side !== draft.side) {
        const opened = draft.qty - p.qty;
        if (opened <= 0 && draft.takeProfits !== undefined) throw new Error('A purely reducing order cannot carry take profit target legs');
        if (draft.takeProfits !== undefined && opened > 0) validateTakeProfits(draft.takeProfits, s.instrument, opened);
        return;
    }
    if ((p.takeProfit !== undefined && draft.takeProfits !== undefined) || (p.takeProfits !== undefined && draft.takeProfit !== undefined)) throw new Error('Scalar take profit and target legs cannot be combined on a scale-in');
    if (draft.takeProfits !== undefined) validateTakeProfits([...(p.takeProfits ?? []), ...draft.takeProfits], s.instrument, p.qty + draft.qty);
}
function queue(s: Session, draft: OrderDraft, time: number): Order {
    if (s.orders.length >= LIMITS.orders) throw new Error('Order history limit reached; start a separate attempt');
    contractsFit(s, draft);
    const order: Order = { ...draft, id: localId(s, 'o', s.orders.length), status: 'working', createdTime: time };
    s.orders.push(order);
    return order;
}
/** Preserve earlier legs at equal prices when a reduction releases farthest allocations. */
function reconcileTakeProfits(p: Position): void {
    if (p.takeProfits === undefined) return;
    let excess = p.takeProfits.reduce((sum, leg) => sum + leg.qty, 0) - p.qty;
    const farthest = p.takeProfits.map((leg, index) => ({ leg, index })).sort((a, b) => sign(p.side) * (b.leg.price - a.leg.price) || b.index - a.index);
    for (const { leg } of farthest) {
        if (excess <= 0) break;
        const released = Math.min(leg.qty, excess);
        leg.qty -= released; excess -= released;
    }
    p.takeProfits = p.takeProfits.filter(leg => leg.qty > 0);
}
function fill(s: Session, orderId: string, side: Side, qty: number, price: number, reference: number, time: number, reason: string, bracket?: OrderDraft, takeProfitLegId?: string): void {
    if (s.fills.length >= LIMITS.fills) throw new Error('Fill history limit reached; start a separate attempt');
    const fees = money(qty * s.config.commissionPerContractSide);
    const p = s.position;
    s.account.balance = money(s.account.balance - fees);
    s.account.fees = money(s.account.fees + fees);
    const day = dayAt(s, time);
    day.traded = true;
    day.realizedPnl = money(day.realizedPnl - fees);
    const provenance = takeProfitLegId === undefined ? {} : { takeProfitLegId };
    s.fills.push({ id: localId(s, 'f', s.fills.length), orderId, time, side, qty, price, fees, reason, ...provenance });
    if (p && p.side !== side) {
        if (s.trades.length >= LIMITS.trades) throw new Error('Trade history limit reached; start a separate attempt');
        const closed = Math.min(p.qty, qty);
        const entryFees = closed === p.qty ? p.entryFees : money(p.entryFees * closed / p.qty);
        const exitFees = closed === qty ? fees : money(fees * closed / qty);
        const grossPnl = money((price - p.avgPrice) * sign(p.side) * closed * s.instrument.pointValue);
        const tradeFees = money(entryFees + exitFees);
        s.trades.push({ id: localId(s, 't', s.trades.length), side: p.side, qty: closed, entryTime: p.entryTime, exitTime: time, entryPrice: p.avgPrice, exitPrice: price, grossPnl, fees: tradeFees, netPnl: money(grossPnl - tradeFees), reason, initialRisk: p.initialRisk === undefined ? undefined : p.initialRisk * closed / p.qty, mae: p.mae * closed / p.qty, mfe: p.mfe * closed / p.qty, ...provenance });
        day.trades++;
        day.realizedPnl = money(day.realizedPnl + grossPnl);
        s.account.balance = money(s.account.balance + grossPnl);
        if (takeProfitLegId !== undefined) {
            const leg = p.takeProfits?.find(leg => leg.id === takeProfitLegId);
            if (leg) leg.qty -= closed;
        }
        if (closed < p.qty) {
            const fraction = (p.qty - closed) / p.qty;
            p.qty -= closed; p.entryFees = money(p.entryFees - entryFees);
            p.mae *= fraction; p.mfe *= fraction;
            if (p.initialRisk !== undefined) p.initialRisk *= fraction;
            reconcileTakeProfits(p);
        } else {
            s.position = null;
            if (qty > closed) s.position = newPosition(s, side, qty - closed, price, time, money(fees - exitFees), bracket);
        }
    } else if (p) {
        const oldRisk = p.initialRisk;
        p.avgPrice = (p.avgPrice * p.qty + price * qty) / (p.qty + qty);
        p.qty += qty; p.entryFees = money(p.entryFees + fees);
        if (bracket?.stopLoss !== undefined) p.stopLoss = bracket.stopLoss;
        if (bracket?.takeProfit !== undefined) p.takeProfit = bracket.takeProfit;
        if (bracket?.takeProfits !== undefined) p.takeProfits = [...(p.takeProfits ?? []), ...bracket.takeProfits.map(leg => ({ ...leg }))];
        if (p.stopLoss !== undefined) p.initialRisk = Math.max(0, (p.avgPrice - p.stopLoss) * sign(p.side) * p.qty * s.instrument.pointValue) || oldRisk;
    } else s.position = newPosition(s, side, qty, price, time, fees, bracket);
    day.endBalance = s.account.balance;
    mark(s, reference);
}
function newPosition(s: Session, side: Side, qty: number, price: number, time: number, fees: number, bracket?: OrderDraft): Position {
    const risk = bracket?.stopLoss === undefined ? undefined : Math.max(0, (price - bracket.stopLoss) * sign(side) * qty * s.instrument.pointValue);
    return { side, qty, avgPrice: price, entryTime: time, entryFees: fees, stopLoss: bracket?.stopLoss, takeProfit: bracket?.takeProfit,
        ...(bracket?.takeProfits === undefined ? {} : { takeProfits: bracket.takeProfits.map(leg => ({ ...leg })) }), initialRisk: risk && risk > 0 ? risk : undefined, mae: 0, mfe: 0 };
}
function flatten(s: Session, base: number, time: number, reason: string, limit?: number): void {
    const p = s.position;
    if (!p) return;
    const side = opposite(p.side);
    fill(s, localId(s, 'exit', s.fills.length), side, p.qty, executionPrice(s, base, side, limit), base, time, reason);
}
function riskReason(s: Session): string | null {
    if (s.config.mode !== 'prop') return null;
    if (s.account.equity <= s.prop.drawdownFloor + 1e-8) return 'Maximum drawdown breached';
    if (s.prop.dailyLoss >= s.config.rules.maxDailyLossUsd - 1e-8) return 'Maximum daily loss breached';
    return null;
}
function fail(s: Session, price: number, time: number, reason: string): void {
    cancelWorking(s);
    flatten(s, price, time, 'Prop violation');
    s.status = 'failed'; s.prop.status = 'failed'; s.prop.reason = reason;
    mark(s, price);
}
/** Walk to a risk boundary rather than filling at a distant candle extreme; gaps use the open. */
function move(s: Session, price: number, time: number, from: number): boolean {
    const position = s.position;
    const before = s.account.equity;
    const threshold = Math.max(s.prop.drawdownFloor, (currentDay(s)?.startBalance ?? s.config.initialBalance) - s.config.rules.maxDailyLossUsd);
    const endEquity = position ? money(s.account.balance + (price - position.avgPrice) * sign(position.side) * position.qty * s.instrument.pointValue) : s.account.balance;
    if (s.config.mode === 'prop' && position && before > threshold && endEquity <= threshold) {
        const raw = position.avgPrice + (threshold - s.account.balance) / (sign(position.side) * position.qty * s.instrument.pointValue);
        const ticks = raw / s.instrument.tickSize;
        const crossing = (position.side === 'buy' ? Math.floor(ticks + 1e-8) : Math.ceil(ticks - 1e-8)) * s.instrument.tickSize;
        const reached = position.side === 'buy' ? Math.max(price, Math.min(from, crossing)) : Math.min(price, Math.max(from, crossing));
        excursions(s, reached);
        mark(s, reached);
        fail(s, reached, time, riskReason(s) ?? 'Maximum loss breached');
        return false;
    }
    excursions(s, price);
    mark(s, price);
    const reason = riskReason(s);
    if (reason) { fail(s, price, time, reason); return false; }
    return true;
}
function excursions(s: Session, price: number): void {
    const p = s.position;
    if (!p) return;
    const pnl = (price - p.avgPrice) * sign(p.side) * p.qty * s.instrument.pointValue;
    p.mae = Math.max(p.mae, -pnl, 0); p.mfe = Math.max(p.mfe, pnl, 0);
}
function positionTargets(s: Session, bar: Bar, entryReference: number, from: number, openingGap = false): number | null {
    const p = s.position;
    if (!p?.takeProfits) return from;
    const favorable = openingGap ? bar.open : p.side === 'buy' ? bar.high : bar.low;
    const touched = p.takeProfits.filter(leg => p.side === 'buy' ? favorable >= leg.price : favorable <= leg.price)
        .sort((a, b) => sign(p.side) * (a.price - b.price));
    for (const target of touched) {
        const position = s.position;
        const leg = position?.takeProfits?.find(leg => leg.id === target.id);
        if (!position || !leg) continue;
        const base = position.side === 'buy' ? Math.max(entryReference, leg.price) : Math.min(entryReference, leg.price);
        if (!move(s, base, bar.time, from)) return null;
        const side = opposite(position.side);
        const qty = Math.min(leg.qty, position.qty);
        fill(s, localId(s, 'exit', s.fills.length), side, qty, executionPrice(s, base, side, leg.price), base, bar.time, 'Take profit', undefined, leg.id);
        mark(s, base);
        const reason = riskReason(s);
        if (reason) { fail(s, base, bar.time, reason); return null; }
        from = base;
    }
    return from;
}
/** OHLC ambiguity is deliberately resolved against the position: protective stops precede targets. */
function positionBar(s: Session, bar: Bar, entryReference = bar.open): void {
    const p = s.position;
    if (!p) return;
    const isLong = p.side === 'buy';
    const adverse = isLong ? bar.low : bar.high;
    const favorable = isLong ? bar.high : bar.low;
    const stopHit = p.stopLoss !== undefined && (isLong ? adverse <= p.stopLoss : adverse >= p.stopLoss);
    const targetHit = p.takeProfit !== undefined && (isLong ? favorable >= p.takeProfit : favorable <= p.takeProfit);
    const stopBase = stopHit ? (isLong ? Math.min(entryReference, p.stopLoss!) : Math.max(entryReference, p.stopLoss!)) : adverse;
    if (!move(s, stopBase, bar.time, entryReference)) return;
    if (stopHit) {
        flatten(s, stopBase, bar.time, 'Stop loss'); mark(s, stopBase);
        const reason = riskReason(s);
        if (reason) fail(s, stopBase, bar.time, reason);
        return;
    }
    if (targetHit) {
        // Limits never fill worse than their price; favorable gaps may improve the execution.
        const targetBase = isLong ? Math.max(entryReference, p.takeProfit!) : Math.min(entryReference, p.takeProfit!);
        if (!move(s, targetBase, bar.time, adverse)) return;
        flatten(s, targetBase, bar.time, 'Take profit', p.takeProfit); mark(s, targetBase);
        const reason = riskReason(s);
        if (reason) fail(s, targetBase, bar.time, reason);
        return;
    }
    const afterTargets = positionTargets(s, bar, entryReference, adverse);
    if (afterTargets === null || !s.position) return;
    if (!move(s, favorable, bar.time, afterTargets)) return;
    // A trailing intraday floor must also survive a high-to-low path permitted by this OHLC.
    if (s.config.rules.drawdownType === 'trailing-intraday' && !move(s, adverse, bar.time, favorable)) return;
    move(s, bar.close, bar.time, adverse);
}
function pass(s: Session, price: number, time: number): void {
    if (s.config.mode !== 'prop' || s.status !== 'paused') return;
    propStats(s);
    const rules = s.config.rules;
    const profit = s.account.equity - s.config.initialBalance;
    const consistencyOkay = rules.consistencyPct === null || s.prop.consistencyPct <= rules.consistencyPct + 1e-8;
    if (profit + 1e-8 < rules.profitTargetUsd || s.prop.tradingDays < rules.minTradingDays || !consistencyOkay || (rules.requireFlatToPass && s.position)) return;
    if (s.position) {
        const liquidationPrice = executionPrice(s, price, opposite(s.position.side));
        const liquidation = money(s.account.balance + (liquidationPrice - s.position.avgPrice) * sign(s.position.side) * s.position.qty * s.instrument.pointValue - s.position.qty * s.config.commissionPerContractSide);
        if (liquidation - s.config.initialBalance < rules.profitTargetUsd) return;
        flatten(s, price, time, 'Profit target');
        const reason = riskReason(s);
        if (reason) { fail(s, price, time, reason); return; }
        propStats(s);
        if (rules.consistencyPct !== null && s.prop.consistencyPct > rules.consistencyPct + 1e-8) return;
    }
    cancelWorking(s); s.status = 'passed'; s.prop.status = 'passed'; s.prop.reason = 'Profit target and evaluation rules satisfied';
}
function intrabarOrders(s: Session, bar: Bar): Order[] {
    const triggered = s.orders.filter(o => {
        if (o.status !== 'working' || o.createdTime >= bar.time || o.type === 'market') return false;
        return o.type === 'limit' ? (o.side === 'buy' ? bar.low <= o.price! : bar.high >= o.price!) : (o.side === 'buy' ? bar.high >= o.price! : bar.low <= o.price!);
    });
    const limits = {
        buy: triggered.filter(o => o.type === 'limit' && o.side === 'buy').sort((a, b) => b.price! - a.price!),
        sell: triggered.filter(o => o.type === 'limit' && o.side === 'sell').sort((a, b) => a.price! - b.price!),
    };
    const next = { buy: 0, sell: 0 };
    // Exchange only same-side touched limit slots; OHLC does not establish a global trigger path.
    return triggered.map(o => o.type === 'limit' ? limits[o.side][next[o.side]++]! : o);
}
function processBar(s: Session, bar: Bar): void {
    dayAt(s, bar.time);
    // Overnight gaps are observed before any queued discretionary order can execute.
    excursions(s, bar.open);
    mark(s, bar.open);
    const gapReason = riskReason(s);
    if (gapReason) { fail(s, bar.open, bar.time, gapReason); return; }
    // An existing bracket protects a position at a gap before later submitted orders.
    const p = s.position;
    if (p?.stopLoss !== undefined && (p.side === 'buy' ? bar.open <= p.stopLoss : bar.open >= p.stopLoss)) flatten(s, bar.open, bar.time, 'Stop loss');
    else if (p?.takeProfit !== undefined && (p.side === 'buy' ? bar.open >= p.takeProfit : bar.open <= p.takeProfit)) flatten(s, bar.open, bar.time, 'Take profit', p.takeProfit);
    else if (positionTargets(s, bar, bar.open, bar.open, true) === null) return;
    mark(s, bar.open);
    const afterBracket = riskReason(s);
    if (afterBracket) { fail(s, bar.open, bar.time, afterBracket); return; }
    const execute = (o: Order, base: number): boolean => {
        let qty = o.qty;
        if (o.intent) {
            const position = s.position;
            if (!position || position.side === o.side) { o.status = 'cancelled'; return true; }
            qty = o.intent === 'reverse' ? position.qty * 2 : Math.min(o.qty, position.qty);
        }
        try { bracketCompatibility(s, { ...o, qty }); }
        catch (error) { o.status = 'rejected'; o.rejectReason = error instanceof Error ? error.message : 'Entry bracket no longer fits the position'; return true; }
        const net = (s.position ? sign(s.position.side) * s.position.qty : 0) + sign(o.side) * qty;
        if (Math.abs(net) > s.config.rules.maxContracts) { o.status = 'rejected'; o.rejectReason = 'Contract limit after earlier executions'; return true; }
        const price = executionPrice(s, base, o.side, o.type === 'limit' ? o.price : undefined);
        o.qty = qty;
        o.status = 'filled'; o.filledTime = bar.time; o.fillPrice = price;
        fill(s, o.id, o.side, o.qty, price, base, bar.time, o.intent === 'close' ? 'Close position' : o.intent === 'reverse' ? 'Reverse position' : o.type === 'market' ? 'Market order' : `${o.type === 'limit' ? 'Limit' : 'Stop'} order`, o);
        return move(s, base, bar.time, base);
    };
    // All orders executable at the open precede the unknown intrabar path.
    for (const o of s.orders) {
        if (o.status !== 'working' || o.createdTime >= bar.time) continue;
        const atOpen = o.type === 'market' || (o.type === 'limit' ? (o.side === 'buy' ? bar.open <= o.price! : bar.open >= o.price!) : (o.side === 'buy' ? bar.open >= o.price! : bar.open <= o.price!));
        if (atOpen && !execute(o, bar.open)) return;
    }
    positionBar(s, bar);
    if (s.status !== 'paused') return;
    for (const o of intrabarOrders(s, bar)) {
        if (!execute(o, o.price!)) return;
        // Triggered entries face the full adverse range, but their earlier candle open cannot be an exit gap.
        positionBar(s, bar, o.price!);
        if (s.status !== 'paused') return;
    }
    if (s.status !== 'paused') return;
    mark(s, bar.close);
    const reason = riskReason(s);
    if (reason) { fail(s, bar.close, bar.time, reason); return; }
    pass(s, bar.close, bar.time);
}
function appendEquity(s: Session, time: number): void {
    s.equityCurve.push({ time, balance: s.account.balance, equity: s.account.equity });
    // Preserve early coverage while bounding history; risk statistics are retained independently.
    if (s.equityCurve.length > LIMITS.curve) s.equityCurve = s.equityCurve.filter((_, i) => i % 2 === 0 || i === s.equityCurve.length - 1);
}
function advance(s: Session, bars: Bar[], end: number): void {
    const endIndex = s.config.endIndex ?? bars.length;
    for (let index = s.cursor + 1; index <= end && s.status === 'paused'; index++) {
        const bar = bars[index]!;
        const previous = index > 0 ? bars[index - 1]! : undefined;
        const hasIdentity = (value: Bar | undefined) => value?.instrumentId !== undefined || value?.contract !== undefined;
        for (const value of [previous, bar]) {
            if (hasIdentity(value) && (!/^[1-9]\d{0,9}$/.test(value!.instrumentId ?? '') || !new RegExp(`^${s.instrument.root}[FGHJKMNQUVXZ]\\d{1,4}$`).test(value!.contract ?? ''))) throw new Error('Continuous source identity is invalid');
        }
        if (previous && hasIdentity(previous) !== hasIdentity(bar)) throw new Error('Continuous source identity is incomplete');
        if (previous?.instrumentId && previous.contract !== bar.contract) {
            // Read only the identity of the next source record before closing at the
            // already revealed old contract. Its OHLC cannot price the old position.
            cancelWorking(s); flatten(s, previous.close, previous.time, 'Continuous contract roll'); mark(s, previous.close);
            const reason = riskReason(s);
            if (reason) fail(s, previous.close, previous.time, reason); else pass(s, previous.close, previous.time);
            const point = s.equityCurve.at(-1);
            if (point?.time === previous.time) { point.balance = s.account.balance; point.equity = s.account.equity; }
            if (s.status !== 'paused') break;
        }
        validateBar(bar, s.instrument);
        if (index > 0 && bars[index - 1]!.time >= bar.time) throw new Error('Source bars must have strictly increasing times');
        s.cursor = index;
        processBar(s, bar);
        if (index === endIndex - 1 && s.status === 'paused') {
            cancelWorking(s); flatten(s, bar.close, bar.time, 'End of data'); mark(s, bar.close);
            const reason = riskReason(s);
            if (reason) fail(s, bar.close, bar.time, reason);
            else { pass(s, bar.close, bar.time); if (s.status === 'paused') s.status = 'completed'; }
            if (s.config.rules.drawdownType === 'trailing-eod') { s.prop.trailingPeak = Math.max(s.prop.trailingPeak, s.account.balance); updateFloor(s); }
        }
        appendEquity(s, bar.time);
    }
}
function amend(s: Session, command: Extract<Command, { type: 'amend' }>, reference: number | undefined): void {
    if (command.price === undefined && command.stopLoss === undefined && command.takeProfit === undefined && command.takeProfits === undefined) throw new Error('Amend needs a price or bracket change');
    if (command.orderId !== undefined) {
        const order = s.orders.find(o => o.id === id(command.orderId, 'Order ID'));
        if (!order || order.status !== 'working') throw new Error('Only a working order can be amended');
        if (command.price !== undefined && order.type === 'market') throw new Error('A market order cannot have a price');
        const next = { ...order };
        if (command.price !== undefined) next.price = tickPrice(command.price, s.instrument, 'Order price');
        if (command.stopLoss === null) delete next.stopLoss; else if (command.stopLoss !== undefined) next.stopLoss = tickPrice(command.stopLoss, s.instrument, 'Stop loss');
        if (command.takeProfit === null) delete next.takeProfit; else if (command.takeProfit !== undefined) next.takeProfit = tickPrice(command.takeProfit, s.instrument, 'Take profit');
        if (command.takeProfits === null) delete next.takeProfits;
        else if (command.takeProfits !== undefined) next.takeProfits = command.takeProfits;
        const validated = validateDraft(next, s.instrument, reference);
        bracketCompatibility(s, validated);
        if (next.stopLoss === undefined) delete order.stopLoss;
        if (next.takeProfit === undefined) delete order.takeProfit;
        if (next.takeProfits === undefined) delete order.takeProfits;
        else next.takeProfits = validated.takeProfits;
        Object.assign(order, next);
    } else {
        const p = s.position;
        if (!p) throw new Error('There is no open position to amend');
        if (command.price !== undefined) throw new Error('A position entry price cannot be amended');
        const draft: OrderDraft = { side: p.side, type: 'market', qty: p.qty, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
            ...(p.takeProfits === undefined ? {} : { takeProfits: p.takeProfits }) };
        if (command.stopLoss === null) delete draft.stopLoss; else if (command.stopLoss !== undefined) draft.stopLoss = tickPrice(command.stopLoss, s.instrument, 'Stop loss');
        if (command.takeProfit === null) delete draft.takeProfit; else if (command.takeProfit !== undefined) draft.takeProfit = tickPrice(command.takeProfit, s.instrument, 'Take profit');
        if (command.takeProfits === null) delete draft.takeProfits;
        else if (command.takeProfits !== undefined) draft.takeProfits = command.takeProfits;
        const validated = validateDraft(draft, s.instrument, reference);
        p.stopLoss = draft.stopLoss; p.takeProfit = draft.takeProfit;
        if (draft.takeProfits === undefined) delete p.takeProfits;
        else p.takeProfits = validated.takeProfits;
        if (p.initialRisk === undefined && p.stopLoss !== undefined) p.initialRisk = Math.max(0, (p.avgPrice - p.stopLoss) * sign(p.side) * p.qty * s.instrument.pointValue) || undefined;
    }
    if (command.takeProfits !== undefined && s.executionVersion !== 3) s.executionVersion = 2;
}

/** Commands return a new state. A failed validation never partially mutates the supplied session. */
export function applyCommand(input: Session, bars: Bar[], rawCommand: Command): Session {
    const continuous = bars[0]?.instrumentId !== undefined || bars[0]?.contract !== undefined;
    const s = validateStoredSession(continuous ? { ...input, executionVersion: 3 } : input, bars, input.instrument);
    const raw = object(rawCommand, 'Command');
    const type = choice(raw.type, ['advance', 'advanceTo', 'place', 'cancel', 'close', 'reverse', 'amend', 'bookmark', 'layout', 'rename'], 'Command type');
    if (s.status !== 'paused' && !['bookmark', 'layout', 'rename'].includes(type)) throw new Error('This attempt is finished; create a new attempt to trade again');
    const time = s.cursor >= 0 ? bars[s.cursor]!.time : bars[0]!.time - 1;
    const reference = s.cursor >= 0 ? bars[s.cursor]!.close : undefined;
    const endIndex = s.config.endIndex ?? bars.length;
    const command = rawCommand;
    switch (command.type) {
        case 'advance': {
            const count = integer(command.count, 'Advance count', 1, 5000);
            advance(s, bars, Math.min(endIndex - 1, s.cursor + count)); break;
        }
        case 'advanceTo': {
            const target = integer(command.time, 'Target time', 0, 8640000000000000);
            if (target <= time) throw new Error('Go-to must move forward; create a separate attempt to start over');
            let end = s.cursor;
            while (end + 1 < endIndex && end - s.cursor < 5000 && bars[end + 1]!.time <= target) end++;
            if (end === s.cursor) throw new Error('Target does not include a new source bar');
            advance(s, bars, end); break;
        }
        case 'place': {
            const draft = validateDraft(command.order, s.instrument, reference);
            bracketCompatibility(s, draft);
            if (draft.takeProfits !== undefined && s.executionVersion !== 3) s.executionVersion = 2;
            queue(s, draft, time); break;
        }
        case 'cancel': {
            const order = s.orders.find(o => o.id === id(command.orderId, 'Order ID'));
            if (!order || order.status !== 'working') throw new Error('Only a working order can be cancelled');
            order.status = 'cancelled'; break;
        }
        case 'close': {
            const p = s.position;
            if (!p) throw new Error('There is no open position to close');
            const qty = command.qty === undefined ? p.qty : integer(command.qty, 'Close quantity', 1, p.qty);
            cancelWorking(s); queue(s, { side: opposite(p.side), type: 'market', qty }, time).intent = 'close'; break;
        }
        case 'reverse': {
            const p = s.position;
            if (!p) throw new Error('There is no open position to reverse');
            cancelWorking(s); queue(s, { side: opposite(p.side), type: 'market', qty: p.qty * 2 }, time).intent = 'reverse'; break;
        }
        case 'amend': amend(s, command, reference); break;
        case 'rename': s.config.name = text(command.name, 'Session name'); break;
        case 'layout': s.layout = safeLayout(command.layout); break;
        case 'bookmark': {
            if (s.cursor < 0) throw new Error('Reveal a bar before adding a bookmark');
            if (s.bookmarks.length >= LIMITS.bookmarks) throw new Error('Bookmark limit reached');
            s.bookmarks.push({ id: localId(s, 'b', s.bookmarks.length), time, label: text(command.label, 'Bookmark label', 200) }); break;
        }
    }
    s.revision++;
    s.updatedAt = new Date().toISOString();
    return s;
}
