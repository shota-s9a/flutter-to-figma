/**
 * Flutter VM Service client — connects via WebSocket and calls
 * built-in Inspector extensions. No package dependency needed.
 */
export declare class VmServiceClient {
    private ws;
    private requestId;
    private pending;
    connect(uri: string): Promise<void>;
    call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    dispose(): Promise<void>;
    getVM(): Promise<Record<string, unknown>>;
    getIsolateId(): Promise<string>;
    callServiceExtension(method: string, isolateId: string, args?: Record<string, string>): Promise<Record<string, unknown>>;
    evaluate(isolateId: string, targetId: string, expression: string): Promise<Record<string, unknown>>;
}
