import type { TimelineMark } from '../../src/index';
import type { Session } from '../shared/types';
import { money, number, signedMoney, utc } from './util';

/** Marks use revealed execution records; current orders never imply a future fill. */
export function sessionMarks(session: Session, from: number, cursorTime: number): TimelineMark[] {
    const visible = (time: number): boolean => time >= from && time <= cursorTime;
    const marks: TimelineMark[] = session.fills.filter((fill) => visible(fill.time)).slice(-150).map((fill) => ({
        id: `fill-${fill.id}`, time: fill.time, group: 'simulation',
        title: `Simulated ${fill.side.toUpperCase()} fill`,
        glyph: { shape: 'circle', color: fill.side === 'buy' ? '#50d5ac' : '#f17b82', letter: fill.side === 'buy' ? 'B' : 'S' },
        tooltip: `Simulated ${fill.side} ${fill.qty} @ ${number(fill.price)}`,
        content: { text: `${fill.qty} contracts @ ${number(fill.price)}\n${utc(fill.time)}\nFees ${money(fill.fees)} · ${fill.reason}` },
    }));
    for (const trade of session.trades.filter((item) => visible(item.exitTime)).slice(-75)) marks.push({
        id: `trade-${trade.id}`, time: trade.exitTime, group: 'simulation', title: 'Completed simulated trade',
        glyph: { shape: 'diamond', color: trade.netPnl >= 0 ? '#9bc7ad' : '#d899a4', letter: 'T' },
        tooltip: `Completed simulated trade ${signedMoney(trade.netPnl)}`,
        content: { text: `${trade.side === 'buy' ? 'Long' : 'Short'} ${trade.qty} · ${number(trade.entryPrice)} → ${number(trade.exitPrice)}\nNet P&L ${signedMoney(trade.netPnl)} · fees ${money(trade.fees)}\n${trade.reason}` },
    });
    for (const order of session.orders.filter((item) => item.status === 'working' && item.createdTime <= cursorTime).slice(-32)) marks.push({
        id: `order-${order.id}`, time: cursorTime, group: 'simulation', title: 'Working simulated order',
        glyph: { shape: 'square', color: '#b6ad82', letter: 'O' },
        tooltip: `Working simulated ${order.side} ${order.qty} · ${order.type}`,
        content: { text: `${order.side.toUpperCase()} ${order.qty} · ${order.type}\n${order.price === undefined ? 'Eligible on the next source bar' : `Order price ${number(order.price)}`}\nNo fill is implied. SL ${order.stopLoss ?? '—'} · TP ${order.takeProfit ?? '—'}` },
    });
    const position = session.position;
    if (position && position.entryTime <= cursorTime) marks.push({
        id: 'current-position', time: cursorTime, group: 'simulation', title: 'Open simulated position',
        glyph: { shape: 'pin', color: '#99c0d9', letter: 'P' },
        tooltip: `${position.side === 'buy' ? 'Long' : 'Short'} ${position.qty} @ ${number(position.avgPrice)}`,
        content: { text: `${position.side === 'buy' ? 'Long' : 'Short'} ${position.qty} @ ${number(position.avgPrice)}\nUnrealized ${signedMoney(session.account.unrealizedPnl)}\nSL ${position.stopLoss ?? '—'} · TP ${position.takeProfit ?? '—'}` },
    });
    return marks;
}
