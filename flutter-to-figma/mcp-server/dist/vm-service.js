/**
 * Flutter VM Service client — connects via WebSocket and calls
 * built-in Inspector extensions. No package dependency needed.
 */
import WebSocket from "ws";
import http from "node:http";
export class VmServiceClient {
    ws = null;
    requestId = 0;
    pending = new Map();
    async connect(uri) {
        // Resolve DDS URI if raw VM Service URI redirects (302)
        const wsUri = await this.resolveDdsUri(uri);
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(wsUri);
            this.ws.on("open", () => resolve());
            this.ws.on("error", (err) => reject(err));
            this.ws.on("message", (data) => {
                const msg = JSON.parse(data.toString());
                const handler = this.pending.get(msg.id);
                if (handler) {
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        handler.reject(new Error(msg.error.message));
                    }
                    else {
                        handler.resolve(msg.result ?? {});
                    }
                }
            });
        });
    }
    /**
     * When DDS is running, the raw VM Service URI returns 302 with the DDS URI.
     * Extract the ws:// URI from the redirect's query parameter.
     */
    async resolveDdsUri(uri) {
        // If already a ws:// URI, use as-is
        if (uri.startsWith("ws://") || uri.startsWith("wss://")) {
            return uri;
        }
        // Convert to HTTP and check for redirect
        const httpUrl = uri.replace(/^ws/, "http");
        return new Promise((resolve) => {
            http
                .get(httpUrl, (res) => {
                if (res.statusCode === 302 && res.headers.location) {
                    // Extract ws URI from redirect location's query param
                    try {
                        const location = new URL(res.headers.location);
                        const wsParam = location.searchParams.get("uri");
                        if (wsParam) {
                            console.error(`[DDS] Resolved DDS URI: ${wsParam}`);
                            resolve(wsParam);
                            return;
                        }
                    }
                    catch {
                        // Failed to parse, fall through
                    }
                    // Fallback: derive ws URI from the redirect host/path
                    const loc = new URL(res.headers.location);
                    const ddsWs = `ws://${loc.host}${loc.pathname.replace(/\/devtools\/.*$/, "/ws")}`;
                    console.error(`[DDS] Derived DDS URI: ${ddsWs}`);
                    resolve(ddsWs);
                }
                else {
                    // No redirect — raw VM Service is directly accessible
                    const wsUri = uri.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
                    resolve(wsUri);
                }
            })
                .on("error", () => {
                // Network error — try the URI as ws directly
                const wsUri = uri.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
                resolve(wsUri);
            });
        });
    }
    async call(method, params = {}) {
        if (!this.ws)
            throw new Error("Not connected");
        const id = ++this.requestId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
        });
    }
    async dispose() {
        this.ws?.close();
        this.ws = null;
    }
    // ── VM Service helpers ──
    async getVM() {
        return this.call("getVM");
    }
    async getIsolateId() {
        const vm = await this.getVM();
        const isolates = vm.isolates;
        const main = isolates.find((i) => i.name === "main") ?? isolates[0];
        return main.id;
    }
    async callServiceExtension(method, isolateId, args = {}) {
        return this.call(method, { isolateId, ...args });
    }
    async evaluate(isolateId, targetId, expression) {
        return this.call("evaluate", {
            isolateId,
            targetId,
            expression,
        });
    }
}
