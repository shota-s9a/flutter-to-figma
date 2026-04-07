/**
 * Flutter VM Service client — connects via WebSocket and calls
 * built-in Inspector extensions. No package dependency needed.
 */
import WebSocket from "ws";
export class VmServiceClient {
    ws = null;
    requestId = 0;
    pending = new Map();
    async connect(uri) {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(uri);
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
