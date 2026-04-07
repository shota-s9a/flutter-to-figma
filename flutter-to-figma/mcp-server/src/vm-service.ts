/**
 * Flutter VM Service client — connects via WebSocket and calls
 * built-in Inspector extensions. No package dependency needed.
 */

import WebSocket from "ws";

interface JsonRpcResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export class VmServiceClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (reason: Error) => void;
    }
  >();

  async connect(uri: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(uri);
      this.ws.on("open", () => resolve());
      this.ws.on("error", (err) => reject(err));
      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as JsonRpcResponse;
        const handler = this.pending.get(msg.id);
        if (handler) {
          this.pending.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(msg.error.message));
          } else {
            handler.resolve(msg.result ?? {});
          }
        }
      });
    });
  }

  async call(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    if (!this.ws) throw new Error("Not connected");
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    });
  }

  async dispose(): Promise<void> {
    this.ws?.close();
    this.ws = null;
  }

  // ── VM Service helpers ──

  async getVM(): Promise<Record<string, unknown>> {
    return this.call("getVM");
  }

  async getIsolateId(): Promise<string> {
    const vm = await this.getVM();
    const isolates = vm.isolates as Array<{ id: string; name: string }>;
    const main =
      isolates.find((i) => i.name === "main") ?? isolates[0];
    return main.id;
  }

  async callServiceExtension(
    method: string,
    isolateId: string,
    args: Record<string, string> = {}
  ): Promise<Record<string, unknown>> {
    return this.call(method, { isolateId, ...args });
  }

  async evaluate(
    isolateId: string,
    targetId: string,
    expression: string
  ): Promise<Record<string, unknown>> {
    return this.call("evaluate", {
      isolateId,
      targetId,
      expression,
    });
  }
}
