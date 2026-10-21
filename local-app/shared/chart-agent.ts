export const CHART_AGENT_OPERATIONS = [
    'read_chart', 'read_candles', 'set_timeframe', 'list_drawing_tools',
    'add_drawing', 'update_drawing', 'remove_drawing', 'list_indicators',
    'add_indicator', 'update_indicator', 'remove_indicator', 'set_viewport', 'screenshot',
    'run_script', 'update_script', 'read_script_job', 'cancel_script_job', 'read_script_context', 'read_operation', 'read_indicator_context',
    'capture_analysis_scope', 'read_analysis_scope', 'evaluate_analysis', 'read_analysis_job', 'cancel_analysis_job',
    'read_session', 'list_scripts', 'read_script', 'list_backtests', 'read_backtest', 'read_workspace', 'list_templates', 'read_current_result',
    'read_analysis_request',
    'backtest_indicator', 'read_backtest_job', 'cancel_backtest_job',
] as const;

export type ChartAgentOperation = typeof CHART_AGENT_OPERATIONS[number];

export interface ChartAgentClient {
    clientId: string;
    sessionId: string;
    generation: number;
    symbol: string;
    timeframe: string;
    cells: { id: string; timeframe: string }[];
    cursorTime: number | null;
}

export interface ChartAgentTarget {
    clientId: string;
    sessionId: string;
    generation: number;
    cellId?: string;
}

export interface ChartAgentCall {
    requestId?: string;
    operation: ChartAgentOperation;
    target: ChartAgentTarget;
    args: Record<string, unknown>;
}

export interface ChartAgentTask extends ChartAgentCall {
    requestId: string;
    deadline: number;
}

export type ChartAgentCompletion =
    | { requestId: string; success: true; value: unknown }
    | { requestId: string; success: false; error: string };

/** A failed tool may have edited its chart before reporting an error; unknown never proves it was not applied. */
export interface ChartAgentOutcome {
    requestId: string;
    target: ChartAgentTarget;
    operation?: ChartAgentOperation;
    state: 'pending' | 'completed' | 'failed' | 'unknown' | 'not_dispatched';
    createdAt?: number;
    dispatchedAt?: number;
    updatedAt?: number;
    completedAt?: number;
    deadline?: number;
    expiresAt?: number;
    value?: unknown;
    error?: string;
}

export type ChartAgentExchangeInput =
    | {
        action: 'poll';
        clientId: string;
        clientToken: string;
        chart: Omit<ChartAgentClient, 'clientId'>;
        completion?: ChartAgentCompletion;
    }
    | {
        action: 'heartbeat';
        clientId: string;
        clientToken: string;
        chart: Omit<ChartAgentClient, 'clientId'>;
    }
    | { action: 'release'; clientId: string; clientToken: string };

export interface ChartAgentExchangeResult {
    request: ChartAgentTask | null;
}
