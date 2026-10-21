import { registerRendererLayer, type RendererLayerArgs, type RendererLayerInstance } from '../../src/plugin';
import type { Command, SessionView, Side, TakeProfitLeg } from '../shared/types';
import type { TicketPriceSelection } from './trade-ticket';
import { sameTakeProfitLegs } from './partial-exit-controls';
import './chart-order-lines.css';

export interface ChartOrderLine {
    key: string; price: number; side: Side; text: string; qty: number;
    kind: 'order' | 'position' | 'takeProfit' | 'stopLoss' | 'draft';
    orderId?: string; orderType?: 'limit' | 'stop'; draft?: boolean; entryPrice?: number; signedQty?: boolean;
    takeProfitLegId?: string; takeProfits?: TakeProfitLeg[]; positionIdentity?: string;
}
export interface ChartOrderLineBinding {
    view(): SessionView | null;
    blocked(): boolean;
    current(): boolean;
    preview(): TicketPriceSelection | null;
    plotSurface?(): string;
    command(command: Command, sessionId: string, revision: number): void | Promise<unknown>;
    selectPrice(price: number, type: 'limit' | 'stop'): void;
    selectBracket?(kind: 'takeProfit' | 'stopLoss', price: number | null): void;
    selectTakeProfits?(legs: TakeProfitLeg[]): void;
    clearPreview?(): void;
}

const bindings = new WeakMap<HTMLElement, ChartOrderLineBinding>();
const layers = new Set<ChartOrderLinesLayer>();

export function chartOrderLines(view: SessionView, preview: TicketPriceSelection | null = null): ChartOrderLine[] {
    const { session } = view;
    const lines: ChartOrderLine[] = [];
    const brackets = (parent: { side: Side; qty: number; takeProfit?: number | null; stopLoss?: number | null; takeProfits?: TakeProfitLeg[] }, entryPrice: number,
        prefix: string, extra: Pick<ChartOrderLine, 'draft' | 'orderId' | 'signedQty' | 'positionIdentity'> = {}): void => {
        for (const kind of ['takeProfit', 'stopLoss'] as const) {
            if (kind === 'takeProfit' && parent.takeProfits?.length) continue;
            const price = parent[kind];
            if (price !== undefined && price !== null && Number.isFinite(price) && price > 0) lines.push({
                key: `${prefix}${kind}`, kind, price, entryPrice, side: parent.side, qty: parent.qty, text: kind === 'takeProfit' ? 'TP' : 'SL', ...extra,
            });
        }
        const targets = parent.takeProfits?.map(leg => ({ ...leg }));
        for (const [i, leg] of (targets ?? []).entries()) lines.push({ key: `${prefix}takeProfit:${leg.id}`, kind: 'takeProfit',
            price: leg.price, entryPrice, side: parent.side, qty: leg.qty, text: `TP${i + 1}`,
            takeProfitLegId: leg.id, takeProfits: targets, ...extra });
    };
    for (const order of session.orders) {
        if (order.status !== 'working' || order.type === 'market' || order.price === undefined) continue;
        lines.push({ key: `order:${order.id}`, orderId: order.id, orderType: order.type, kind: 'order',
            price: order.price, side: order.side, text: order.type === 'limit' ? 'Limit' : 'Stop', qty: order.qty });
        brackets(order, order.price, `order:${order.id}:`, { orderId: order.id });
    }
    const p = session.position;
    if (p) {
        const positionIdentity = JSON.stringify([p.side, p.entryTime, p.avgPrice]);
        lines.push({ key: 'position', kind: 'position', price: p.avgPrice, side: p.side, text: 'Position', qty: p.qty, signedQty: true, positionIdentity });
        brackets(p, p.avgPrice, '', { signedQty: true, positionIdentity });
    }
    if (preview?.price !== null && preview?.price !== undefined && preview.type !== 'market') {
        const qty = Number.isInteger(preview.qty) && preview.qty! > 0 ? preview.qty! : 0;
        lines.push({ key: 'draft', kind: 'draft', draft: true, price: preview.price, side: preview.side,
            text: preview.type === 'limit' ? 'Limit' : 'Stop', qty, orderType: preview.type });
        brackets({ ...preview, qty }, preview.price, 'draft:', { draft: true });
    }
    return lines;
}

export function orderLineAmendment(line: ChartOrderLine, price: number | null): Command | null {
    if (line.draft) return null;
    if (line.kind === 'order' && price !== null) return { type: 'amend', orderId: line.orderId, price };
    const order = line.orderId ? { orderId: line.orderId } : {};
    if (line.kind === 'takeProfit' && line.takeProfitLegId) {
        if (!line.takeProfits?.some(leg => leg.id === line.takeProfitLegId)) return null;
        return { type: 'amend', ...order, takeProfits: line.takeProfits.flatMap(leg => leg.id !== line.takeProfitLegId ? [{ ...leg }]
            : price === null ? [] : [{ ...leg, price }]) };
    }
    if (line.kind === 'takeProfit') return { type: 'amend', ...order, takeProfit: price };
    if (line.kind === 'stopLoss') return { type: 'amend', ...order, stopLoss: price };
    return null;
}

export function bindChartOrderLines(host: HTMLElement, binding: ChartOrderLineBinding): () => void {
    bindings.set(host, binding);
    refreshChartOrderLines(host);
    return () => {
        if (bindings.get(host) === binding) bindings.delete(host);
        refreshChartOrderLines(host);
    };
}

export function refreshChartOrderLines(host: HTMLElement): void {
    for (const layer of layers) if (layer.belongsTo(host)) layer.repaint();
}

interface PricePreview {
    line: ChartOrderLine; price: number; sessionId: string; revision: number; cursor: number; binding: ChartOrderLineBinding;
    addBracket?: 'takeProfit' | 'stopLoss';
}
interface Drag extends PricePreview { pointerId: number; target: HTMLElement }
interface ActionPreview extends PricePreview { target: HTMLButtonElement; action: string; pointerId: number; released: boolean }
interface OrderLineRow {
    root: HTMLDivElement; label: HTMLButtonElement; badge: HTMLSpanElement; qty: HTMLSpanElement;
    text: HTMLSpanElement; cancel: HTMLButtonElement; reverse: HTMLButtonElement; partial: HTMLButtonElement; takeProfit: HTMLButtonElement; stopLoss: HTMLButtonElement;
    exits: HTMLSpanElement; price: HTMLSpanElement; minTextWidth: number;
}

function lineColor(line: ChartOrderLine): string {
    return line.kind === 'takeProfit' ? '#089981' : line.kind === 'stopLoss' ? '#ff9800' : line.side === 'sell' ? '#f23645' : '#2962ff';
}
function money(value: number): string {
    return `${value > 0 ? '+' : value < 0 ? '\u2212' : ''}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
}
function linePnl(line: ChartOrderLine, price: number, view: SessionView): number | null {
    if (line.kind === 'position') return view.session.account.unrealizedPnl;
    return line.entryPrice === undefined || !line.qty ? null
        : (price - line.entryPrice) * line.qty * (line.side === 'buy' ? 1 : -1) * view.dataset.instrument.pointValue;
}
const replayGlyph = '<svg class="local-order-replay" viewBox="0 0 8 8" aria-hidden="true"><path d="M4 4V0L0 4L4 8V4ZM4 4L8 0V8L4 4Z" /></svg>';
const closeGlyph = '<svg viewBox="0 0 7 7" aria-hidden="true"><path d="M0 0L7 7M7 0L0 7" /></svg>';

/** Order state belongs to the application; this layer owns only a transient price preview. */
export class ChartOrderLinesLayer implements RendererLayerInstance {
    private canvas: HTMLCanvasElement | null = null;
    private overlay: HTMLDivElement | null = null;
    private args: RendererLayerArgs | null = null;
    private drag: Drag | null = null;
    private pending: PricePreview | null = null;
    private actionPreview: ActionPreview | null = null;
    private surface: string | null = null;
    private selectedKey: string | null = null;
    private hoveredKey: string | null = null;
    private rows = new Map<string, OrderLineRow>();
    private disposers: (() => void)[] = [];

    mount(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        const parent = canvas.parentElement;
        if (!parent) return;
        const overlay = canvas.ownerDocument.createElement('div');
        overlay.className = 'local-chart-orders';
        parent.append(overlay); this.overlay = overlay; layers.add(this);
        const down = (event: PointerEvent): void => {
            this.actionPreview = null;
            const action = (event.target as Element).closest<HTMLButtonElement>('[data-order-partial],[data-order-edit-targets],[data-order-close],[data-order-reverse]');
            if (action) {
                const binding = this.binding(); const view = binding?.view();
                const key = action.dataset.orderPartial ?? action.dataset.orderEditTargets ?? action.dataset.orderClose ?? action.dataset.orderReverse;
                const line = view && binding ? chartOrderLines(view, binding.preview()).find(line => line.key === key) : undefined;
                if (!action.disabled && binding && view && line && this.editable(binding, view)) this.actionPreview = {
                    line, price: line.price, sessionId: view.session.id, revision: view.session.revision, cursor: view.session.cursor, binding,
                    target: action, action: this.actionName(action), pointerId: event.pointerId, released: false,
                };
            }
            if ((event.target as Element).closest('[data-order-close],[data-order-reverse],[data-order-partial],[data-order-edit-targets]')) { event.stopPropagation(); this.rollback(); return; }
            this.start(event);
        };
        const move = (event: PointerEvent): void => this.move(event);
        const up = (event: PointerEvent): void => {
            if (this.actionPreview?.pointerId === event.pointerId) this.actionPreview.released = true;
            if ((event.target as Element).closest('[data-order-close],[data-order-reverse],[data-order-partial],[data-order-edit-targets]')) { event.stopPropagation(); return; }
            this.finish(event);
        };
        const cancel = (event: PointerEvent): void => {
            // Normal capture release follows pointerup but precedes its guarded click.
            if (this.actionPreview?.pointerId === event.pointerId && (event.type === 'pointercancel' || !this.actionPreview.released)) this.actionPreview = null;
            if (this.drag?.pointerId === event.pointerId) this.rollback();
        };
        const click = (event: MouseEvent): void => {
            const target = (event.target as Element).closest<HTMLButtonElement>('[data-order-close],[data-order-reverse],[data-order-partial],[data-order-edit-targets]');
            if (!target) return;
            event.stopPropagation(); event.preventDefault();
            const binding = this.binding(); const view = binding?.view();
            if (target.disabled || this.pending || !binding || !view || !this.editable(binding, view)) return;
            const line = chartOrderLines(view, binding.preview()).find(item => item.key === (target.dataset.orderClose ?? target.dataset.orderReverse ?? target.dataset.orderPartial ?? target.dataset.orderEditTargets));
            if (!line) return;
            const activation = this.actionPreview; this.actionPreview = null;
            if (activation && (activation.target !== target || activation.action !== this.actionName(target)
                || activation.line.key !== line.key || !this.samePreviewState(activation, binding, view))) return;
            if (target.dataset.orderEditTargets) {
                const p = view.session.position;
                const order = line.orderId ? view.session.orders.find(item => item.id === line.orderId && item.status === 'working') : undefined;
                const owner = order ? { orderId: order.id, qty: order.qty, side: order.side, createdTime: order.createdTime }
                    : line.kind === 'position' && p ? { entryTime: p.entryTime, side: p.side, qty: p.qty, avgPrice: p.avgPrice } : null;
                if (owner) overlay.dispatchEvent(new CustomEvent('local-replay:chart-edit-exits', { bubbles: true,
                    detail: { sessionId: view.session.id, revision: view.session.revision, cursor: view.session.cursor, ...owner } }));
                return;
            }
            if (target.dataset.orderPartial) {
                const p = view.session.position;
                if (line.kind !== 'position' || !p) return;
                overlay.dispatchEvent(new CustomEvent('local-replay:chart-partial-close', { bubbles: true,
                    detail: { sessionId: view.session.id, revision: view.session.revision, cursor: view.session.cursor,
                        entryTime: p.entryTime, side: p.side, qty: p.qty, avgPrice: p.avgPrice } }));
            }
            else if (line.kind === 'position') binding.command({ type: target.dataset.orderReverse ? 'reverse' : 'close' }, view.session.id, view.session.revision);
            else if (line.kind === 'order') binding.command({ type: 'cancel', orderId: line.orderId! }, view.session.id, view.session.revision);
            else if (line.kind === 'draft') binding.clearPreview?.();
            else if (line.kind === 'takeProfit' || line.kind === 'stopLoss') {
                if (line.draft && line.takeProfitLegId) binding.selectTakeProfits?.(line.takeProfits!.filter(leg => leg.id !== line.takeProfitLegId).map(leg => ({ ...leg })));
                else if (line.draft) binding.selectBracket?.(line.kind, null);
                else {
                    const command = orderLineAmendment(line, null);
                    if (command) binding.command(command, view.session.id, view.session.revision);
                }
            }
        };
        const key = (event: KeyboardEvent): void => {
            if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) {
                const action = (event.target as Element).closest<HTMLButtonElement>('[data-order-close],[data-order-reverse],[data-order-partial],[data-order-edit-targets]');
                if (action && !action.disabled) this.actionPreview = null;
            }
            if (event.key === 'Escape' && this.drag) { event.preventDefault(); event.stopPropagation(); this.rollback(); }
        };
        const lineKey = (target: EventTarget | null): string | null => target instanceof overlay.ownerDocument.defaultView!.Element
            ? target.closest<HTMLElement>('[data-order-line]')?.dataset.orderLine ?? null : null;
        const over = (event: PointerEvent): void => {
            const next = lineKey(event.target);
            if (next !== this.hoveredKey) { this.hoveredKey = next; this.repaint(); }
        };
        const out = (event: PointerEvent): void => {
            const next = lineKey(event.relatedTarget);
            if (next !== this.hoveredKey) { this.hoveredKey = next; this.repaint(); }
        };
        const focus = (event: FocusEvent): void => {
            const next = lineKey(event.type === 'focusin' ? event.target : event.relatedTarget);
            if (next !== this.selectedKey) { this.selectedKey = next; this.repaint(); }
        };
        for (const [type, fn] of [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', cancel], ['lostpointercapture', cancel], ['click', click], ['keydown', key],
            ['pointerover', over], ['pointerout', out], ['focusin', focus], ['focusout', focus]] as const) {
            overlay.addEventListener(type, fn as EventListener);
            this.disposers.push(() => overlay.removeEventListener(type, fn as EventListener));
        }
    }

    render(args: RendererLayerArgs): void { this.args = args; this.repaint(); }
    belongsTo(host: HTMLElement): boolean { return this.canvas !== null && host.contains(this.canvas); }
    repaint(): void {
        const args = this.args; const canvas = this.canvas; const overlay = this.overlay;
        if (!args || !canvas || !overlay) return;
        const binding = this.binding(); const view = binding?.view();
        const surface = binding?.plotSurface?.() || args.theme.background;
        if (surface !== this.surface) { overlay.style.setProperty('--local-order-surface', surface); this.surface = surface; }
        if (this.drag && (!binding || !view || !this.sameDragState(this.drag, binding, view))) this.releaseDrag();
        if (this.pending && (!binding || !view || !this.samePreviewState(this.pending, binding, view))) this.pending = null;
        const context = canvas.getContext('2d');
        context?.setTransform(1, 0, 0, 1, 0, 0); context?.clearRect(0, 0, canvas.width, canvas.height);
        const items = binding && view && binding.current() && view.session.cursor >= 0 ? chartOrderLines(view, binding.preview()) : [];
        const projection = this.drag?.addBracket ? this.drag : this.pending?.addBracket ? this.pending : null;
        if (projection) items.push({ ...projection.line, key: `projection:${projection.addBracket}`, kind: projection.addBracket!,
            entryPrice: projection.line.price, price: projection.price, text: projection.addBracket === 'takeProfit' ? 'TP' : 'SL', signedQty: true });
        const live = new Set(items.map(line => line.key));
        if (this.selectedKey && !live.has(this.selectedKey)) this.selectedKey = null;
        if (this.hoveredKey && !live.has(this.hoveredKey)) this.hoveredKey = null;
        for (const [key, row] of this.rows) if (!live.has(key)) { row.root.remove(); row.price.remove(); this.rows.delete(key); }
        if (!binding || !view) return;
        const enabled = this.editable(binding, view) && !this.pending;
        const tick = view.dataset.instrument.tickSize;
        const decimals = Math.max(0, Math.min(8, (String(tick).split('.')[1] ?? '').length));
        const dpr = args.coords.dpr;
        context?.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (context && typeof context.measureText === 'function') {
            const style = overlay.ownerDocument.defaultView?.getComputedStyle(overlay);
            context.font = style ? `${style.fontWeight} ${style.fontSize} ${style.fontFamily}` : '13px Arial';
        }
        for (const line of items.sort((a, b) => this.priority(a) - this.priority(b))) {
            const moving = this.previewKey(this.drag) === line.key ? this.drag : this.previewKey(this.pending) === line.key ? this.pending : null;
            const price = moving?.price ?? line.price;
            const y = args.coords.priceToY(price, args.scale, args.bounds);
            let row = this.rows.get(line.key);
            if (!row) {
                const root = overlay.ownerDocument.createElement('div'); root.className = 'local-order-line'; root.dataset.orderLine = line.key;
                const badge = overlay.ownerDocument.createElement('span'); badge.className = 'local-order-side';
                const body = overlay.ownerDocument.createElement('div'); body.className = 'local-order-body';
                const label = overlay.ownerDocument.createElement('button'); label.type = 'button'; label.dataset.orderDrag = line.key;
                label.className = 'local-order-drag'; label.innerHTML = replayGlyph;
                const qty = overlay.ownerDocument.createElement('span'); qty.className = 'local-order-quantity';
                const text = overlay.ownerDocument.createElement('span'); text.className = 'local-order-text';
                label.append(qty, text);
                const cancel = overlay.ownerDocument.createElement('button'); cancel.type = 'button'; cancel.className = 'local-order-cancel';
                cancel.dataset.orderClose = line.key; cancel.innerHTML = closeGlyph;
                const reverse = overlay.ownerDocument.createElement('button'); reverse.type = 'button'; reverse.className = 'local-order-reverse';
                reverse.dataset.orderReverse = line.key; reverse.textContent = '\u21c4';
                reverse.setAttribute('aria-label', 'Reverse simulated position on the next source bar');
                const partial = overlay.ownerDocument.createElement('button'); partial.type = 'button'; partial.className = 'local-order-partial';
                partial.dataset.orderPartial = line.key; partial.textContent = '%';
                partial.setAttribute('aria-label', 'Partially close simulated position'); partial.title = 'Close part of the remaining position';
                const addExit = (kind: 'takeProfit' | 'stopLoss'): HTMLButtonElement => {
                    const button = overlay.ownerDocument.createElement('button'); button.type = 'button'; button.className = 'local-order-add-exit';
                    button.dataset.orderAddExit = kind; button.textContent = kind === 'takeProfit' ? 'TP' : 'SL';
                    button.setAttribute('aria-label', `Drag to add ${kind === 'takeProfit' ? 'take profit' : 'stop loss'} to ${line.kind === 'position' ? 'simulated position' : line.kind === 'draft' ? 'draft order' : 'working order'}`);
                    button.title = button.getAttribute('aria-label')!; return button;
                };
                const takeProfit = addExit('takeProfit'), stopLoss = addExit('stopLoss');
                const exits = overlay.ownerDocument.createElement('span'); exits.className = 'local-order-add-exits'; exits.append(takeProfit, stopLoss);
                body.append(label, partial, reverse, cancel); root.append(badge, exits, body);
                const axisPrice = overlay.ownerDocument.createElement('span'); axisPrice.className = 'local-order-axis-price'; axisPrice.dataset.orderPrice = line.key;
                overlay.append(root, axisPrice); row = { root, label, badge, qty, text, cancel, reverse, partial, takeProfit, stopLoss, exits, price: axisPrice, minTextWidth: 0 }; this.rows.set(line.key, row);
            }
            row.root.hidden = !Number.isFinite(y) || y < args.bounds.top || y > args.bounds.top + args.bounds.height;
            row.root.dataset.kind = line.kind; row.root.dataset.side = line.side; row.root.dataset.moving = String(moving !== null);
            row.root.dataset.selected = String(this.selectedKey === line.key); row.root.dataset.hovered = String(this.hoveredKey === line.key);
            row.root.style.zIndex = String(this.priority(line)); row.price.style.zIndex = row.root.style.zIndex;
            row.root.dataset.draft = String(!!line.draft);
            row.root.dataset.positionBracket = String(line.signedQty === true && line.kind !== 'position');
            row.root.dataset.projection = String(line.key.startsWith('projection:'));
            row.root.style.setProperty('--order-color', lineColor(line));
            row.root.style.left = `${args.coords.width * 0.6}px`; row.root.style.top = `${y}px`;
            row.badge.hidden = line.kind !== 'draft' && line.kind !== 'order'; row.badge.textContent = line.side === 'buy' ? 'Buy' : 'Sell';
            row.qty.textContent = line.key.startsWith('projection:') ? line.text : line.qty ? `${line.signedQty && line.side === 'sell' ? '\u2212' : ''}${line.qty}` : '—';
            const pnl = linePnl(line, price, view);
            row.text.textContent = pnl === null ? line.text : `${line.takeProfitLegId ? `${line.text} · ` : ''}${money(pnl)}`;
            if (context && typeof context.measureText === 'function') {
                row.qty.style.width = `${Math.max(19, Math.ceil(context.measureText(row.qty.textContent).width) + 14)}px`;
                row.minTextWidth = Math.max(row.minTextWidth, Math.ceil(context.measureText(row.text.textContent).width) + Math.ceil(context.measureText('0').width));
                row.text.style.minWidth = `${row.minTextWidth}px`;
            }
            row.text.dataset.profit = pnl === null ? '' : pnl < 0 ? 'negative' : 'positive';
            row.label.setAttribute('aria-label', `${line.kind === 'position' ? '' : 'Drag '}${line.text.toLowerCase()} at ${price.toFixed(decimals)}`);
            const editableDraft = !line.draft || line.kind === 'draft' || (line.takeProfitLegId ? !!binding.selectTakeProfits : !!binding.selectBracket);
            row.label.disabled = !enabled || line.kind === 'position' || !editableDraft;
            row.reverse.hidden = line.kind !== 'position'; row.reverse.disabled = !enabled;
            row.partial.hidden = line.kind !== 'position'; row.partial.disabled = !enabled;
            const exitParent = this.exitParent(line, binding, view);
            for (const kind of ['takeProfit', 'stopLoss'] as const) {
                const editTargets = kind === 'takeProfit' && !!exitParent?.takeProfits?.length && !line.draft;
                row[kind].hidden = !editTargets && (!exitParent || exitParent[kind] != null || kind === 'takeProfit' && !!exitParent.takeProfits?.length || line.draft && !binding.selectBracket
                    || projection?.line.key === line.key && projection?.addBracket === kind && this.drag?.addBracket !== kind);
                if (editTargets) {
                    row[kind].dataset.orderEditTargets = line.key;
                    row[kind].setAttribute('aria-label', 'Edit partial take-profit targets'); row[kind].title = 'Edit partial take-profit targets';
                } else {
                    delete row[kind].dataset.orderEditTargets;
                    row[kind].setAttribute('aria-label', `Drag to add ${kind === 'takeProfit' ? 'take profit' : 'stop loss'} to ${line.kind === 'position' ? 'simulated position' : line.kind === 'draft' ? 'draft order' : 'working order'}`);
                    row[kind].title = row[kind].getAttribute('aria-label')!;
                }
                row[kind].disabled = !enabled;
            }
            row.exits.hidden = row.takeProfit.hidden && row.stopLoss.hidden;
            row.cancel.hidden = line.key.startsWith('projection:') || line.kind === 'draft' && !binding.clearPreview || !!line.draft && line.kind !== 'draft' && !editableDraft;
            row.cancel.disabled = !enabled;
            row.cancel.setAttribute('aria-label', line.kind === 'position' ? 'Close simulated position on the next source bar' : line.kind === 'order' ? `Cancel ${line.text.toLowerCase()} order`
                : line.kind === 'draft' ? 'Clear draft entry price' : `Remove ${line.takeProfitLegId ? `${line.text} target` : line.kind === 'takeProfit' ? 'take profit' : 'stop loss'}${line.draft ? ' from draft' : ''}`);
            if (line.kind === 'order') row.cancel.dataset.orderCancel = line.orderId; else delete row.cancel.dataset.orderCancel;
            row.price.hidden = row.root.hidden; row.price.textContent = price.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
            row.price.style.left = `${args.coords.width}px`; row.price.style.top = `${y}px`;
            row.price.style.setProperty('--order-color', lineColor(line));
            row.price.dataset.kind = line.kind; row.price.dataset.draft = String(!!line.draft);
            if (context && !row.root.hidden) {
                context.strokeStyle = lineColor(line);
                context.lineWidth = 1; context.setLineDash(line.kind === 'position' ? [] : line.draft || line.kind === 'takeProfit' || line.kind === 'stopLoss' ? [1, 2] : [4, 4]);
                context.beginPath(); context.moveTo(0, y + 0.5 / dpr); context.lineTo(args.coords.width, y + 0.5 / dpr); context.stroke();
            }
        }
    }

    destroy(): void {
        this.releaseDrag(); for (const dispose of this.disposers.splice(0)) dispose();
        this.overlay?.remove(); this.overlay = null; this.canvas = null; this.args = null; this.surface = null;
        this.pending = null; this.actionPreview = null; this.selectedKey = null; this.hoveredKey = null; this.rows.clear(); layers.delete(this);
    }

    private binding(): ChartOrderLineBinding | null {
        for (let host = this.canvas?.parentElement; host; host = host.parentElement) { const binding = bindings.get(host); if (binding) return binding; }
        return null;
    }
    private editable(binding: ChartOrderLineBinding, view: SessionView): boolean {
        return binding.current() && !binding.blocked() && view.session.status === 'paused' && view.session.cursor >= 0;
    }
    private exitParent(line: ChartOrderLine, binding: ChartOrderLineBinding, view: SessionView): { takeProfit?: number | null; stopLoss?: number | null; takeProfits?: TakeProfitLeg[] } | null {
        if (line.kind === 'position') return view.session.position;
        if (line.kind === 'draft') return binding.preview();
        if (line.kind === 'order') return view.session.orders.find(order => order.id === line.orderId && order.status === 'working') ?? null;
        return null;
    }
    private priority(line: ChartOrderLine): number {
        return this.previewKey(this.drag) === line.key || this.previewKey(this.pending) === line.key ? 4 : this.hoveredKey === line.key ? 3 : this.selectedKey === line.key ? 2
            : line.kind === 'takeProfit' || line.kind === 'stopLoss' ? 0 : 1;
    }
    private actionName(target: HTMLElement): string {
        return target.hasAttribute('data-order-partial') ? 'partial' : target.hasAttribute('data-order-edit-targets') ? 'edit-targets'
            : target.hasAttribute('data-order-reverse') ? 'reverse' : 'close';
    }
    private previewKey(preview: PricePreview | null): string | undefined { return preview?.addBracket ? `projection:${preview.addBracket}` : preview?.line.key; }
    private sameDragState(drag: Drag, binding: ChartOrderLineBinding, view: SessionView): boolean {
        return this.editable(binding, view) && this.samePreviewState(drag, binding, view);
    }
    private samePreviewState(drag: PricePreview, binding: ChartOrderLineBinding, view: SessionView): boolean {
        return drag.binding === binding && binding.current() && view.session.status === 'paused' && drag.sessionId === view.session.id
            && drag.revision === view.session.revision && drag.cursor === view.session.cursor
            && chartOrderLines(view, binding.preview()).some(line => line.key === drag.line.key && line.price === drag.line.price
                && line.side === drag.line.side && line.qty === drag.line.qty && line.entryPrice === drag.line.entryPrice && line.orderType === drag.line.orderType
                && line.positionIdentity === drag.line.positionIdentity && sameTakeProfitLegs(line.takeProfits, drag.line.takeProfits)
                && (!drag.addBracket || this.exitParent(line, binding, view)?.[drag.addBracket] == null
                    && (drag.addBracket !== 'takeProfit' || !this.exitParent(line, binding, view)?.takeProfits?.length)));
    }
    private start(event: PointerEvent): void {
        if (event.button !== 0 || this.drag || this.pending) return;
        const target = (event.target as Element).closest<HTMLElement>('[data-order-drag],[data-order-add-exit]');
        if (!target || (target as HTMLButtonElement).disabled) return;
        const binding = this.binding(); const view = binding?.view();
        if (!binding || !view || !this.editable(binding, view)) return;
        const requestedBracket = target.dataset.orderAddExit;
        const addBracket = requestedBracket === 'takeProfit' || requestedBracket === 'stopLoss' ? requestedBracket : undefined;
        if (requestedBracket && !addBracket) return;
        const parentKey = target.closest<HTMLElement>('[data-order-line]')?.dataset.orderLine;
        const line = chartOrderLines(view, binding.preview()).find(item => item.key === (addBracket ? parentKey : target.dataset.orderDrag));
        if (!line || line.key.startsWith('projection:') || line.kind === 'position' && !addBracket) return;
        const exitParent = this.exitParent(line, binding, view);
        if (addBracket && (!exitParent || exitParent[addBracket] != null || addBracket === 'takeProfit' && exitParent.takeProfits?.length || line.draft && !binding.selectBracket)) return;
        event.preventDefault(); event.stopPropagation();
        this.drag = { pointerId: event.pointerId, line, price: line.price, sessionId: view.session.id, revision: view.session.revision,
            cursor: view.session.cursor, binding, target, ...(addBracket ? { addBracket } : {}) };
        target.focus({ preventScroll: true });
        try { target.setPointerCapture(event.pointerId); } catch { /* a synthetic pointer may have no capture */ }
        this.repaint();
    }
    private move(event: PointerEvent): void {
        const drag = this.drag;
        if (!drag || drag.pointerId !== event.pointerId || !this.args || !this.canvas) return;
        event.preventDefault(); event.stopPropagation();
        const binding = this.binding(); const view = binding?.view();
        if (!binding || !view || !this.sameDragState(drag, binding, view)) { this.rollback(); return; }
        const y = event.clientY - this.canvas.getBoundingClientRect().top;
        const raw = this.args.coords.yToPrice(y, this.args.scale, this.args.bounds);
        const tick = view.dataset.instrument.tickSize;
        const price = Number((Math.round(raw / tick) * tick).toFixed(8));
        if (Number.isFinite(price) && price > 0 && price <= 1e9 && price !== drag.price) { drag.price = price; this.repaint(); }
    }
    private finish(event: PointerEvent): void {
        const drag = this.drag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        const binding = this.binding(); const view = binding?.view();
        const valid = binding && view && this.sameDragState(drag, binding, view);
        if (!valid || drag.price === drag.line.price) { this.releaseDrag(); this.repaint(); return; }
        if (drag.addBracket && drag.line.draft) { this.releaseDrag(); binding.selectBracket?.(drag.addBracket, drag.price); this.repaint(); }
        else if (drag.line.kind === 'draft') { this.releaseDrag(); binding.selectPrice(drag.price, drag.line.orderType ?? 'limit'); this.repaint(); }
        else if (drag.line.draft && (drag.line.kind === 'takeProfit' || drag.line.kind === 'stopLoss')) {
            this.releaseDrag();
            if (drag.line.takeProfitLegId) binding.selectTakeProfits?.(drag.line.takeProfits!.map(leg => ({ ...leg, ...(leg.id === drag.line.takeProfitLegId ? { price: drag.price } : {}) })));
            else binding.selectBracket?.(drag.line.kind, drag.price);
            this.repaint();
        }
        else {
            const command: Command | null = drag.addBracket ? { type: 'amend', ...(drag.line.orderId ? { orderId: drag.line.orderId } : {}), [drag.addBracket]: drag.price } : orderLineAmendment(drag.line, drag.price);
            if (!command) { this.releaseDrag(); this.repaint(); return; }
            const pending: PricePreview = { line: drag.line, price: drag.price, sessionId: drag.sessionId, revision: drag.revision, cursor: drag.cursor, binding,
                ...(drag.addBracket ? { addBracket: drag.addBracket } : {}) };
            this.pending = pending; this.releaseDrag(); this.repaint();
            const settle = (): void => { if (this.pending === pending) { this.pending = null; this.repaint(); } };
            try {
                const result = binding.command(command, drag.sessionId, drag.revision);
                if (result && typeof result.then === 'function') void result.then(settle, settle);
                else settle();
            }
            catch { settle(); }
        }
    }
    private releaseDrag(): void {
        const drag = this.drag; this.drag = null;
        if (drag) try { drag.target.releasePointerCapture(drag.pointerId); } catch { /* capture already ended */ }
    }
    private rollback(): void { this.releaseDrag(); this.repaint(); }
}

registerRendererLayer({ id: 'local-simulated-order-lines', placement: 'above-data', create: () => new ChartOrderLinesLayer() });
