import { describe, expect, it } from 'vitest';
import { nativeChartConfig } from '../client/charts';

describe('saved chart appearance on the native workspace', () => {
    it('rebases the original local palette without losing chart preferences or mutating the saved document', () => {
        const saved = { layout: { background: '#101419', textColor: '#8795a8', fontSize: 15 },
            grid: { vertLines: { visible: false, color: '#1a222b' } },
            candles: { upColor: '#50d5ac', downColor: '#f17b82', bodyVisible: false },
            custom: { color: '#123456' } };
        expect(nativeChartConfig(saved)).toEqual({ layout: { background: '#0f0f0f', textColor: '#dbdbdb', fontSize: 15 },
            grid: { vertLines: { visible: false, color: '#242424' } },
            candles: { upColor: '#089981', downColor: '#f23645', bodyVisible: false },
            custom: { color: '#123456' } });
        expect(saved.layout.background).toBe('#101419');
    });
    it('preserves user themes and handles absent or malformed older renderer documents', () => {
        const custom = { layout: { background: '#ffffff', textColor: '#8795a8' }, candles: { upColor: '#50d5ac' } };
        expect(nativeChartConfig(custom)).toBe(custom);
        expect(nativeChartConfig(undefined)).toBeUndefined();
        expect(nativeChartConfig(null)).toBeNull();
        expect(nativeChartConfig('invalid')).toBe('invalid');
        expect(nativeChartConfig({ grid: {} })).toEqual({ grid: {} });
    });
});
