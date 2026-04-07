#!/usr/bin/env node
/**
 * flutter-to-figma MCP Server
 *
 * Tools:
 *   list_flutter_apps  — Find running Flutter debug apps and VM Service URIs
 *   export_screen       — Export current screen to Figma JSON
 *   capture_screenshot  — Take a screenshot of the current screen
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { VmServiceClient } from "./vm-service.js";
import { FlutterInspector } from "./inspector.js";
import { FigmaConverter } from "./figma-converter.js";
const server = new McpServer({
    name: "flutter-to-figma",
    version: "0.1.0",
});
// ── Tool: list_flutter_apps ──
server.tool("list_flutter_apps", "起動中の Flutter デバッグアプリを検出し、VM Service URI を返す", {}, async () => {
    try {
        // Find Flutter debug processes with VM Service URIs
        const output = execSync('ps aux | grep -E "dart|flutter" | grep -i "development-service\\|vm-service" | grep -v grep', { encoding: "utf-8", timeout: 5000 }).trim();
        if (!output) {
            return {
                content: [
                    {
                        type: "text",
                        text: "起動中の Flutter デバッグアプリが見つかりません。\n\n`flutter run --flavor develop` でデバッグビルドを起動してください。",
                    },
                ],
            };
        }
        // Extract VM Service URIs
        const uriPattern = /--vm-service-uri=([^\s]+)|vm-service-url=([^\s]+)|ws:\/\/[^\s]+/g;
        const uris = [];
        let match;
        while ((match = uriPattern.exec(output)) !== null) {
            uris.push(match[1] || match[2] || match[0]);
        }
        // Also try to find via DDS (Dart Development Service)
        try {
            const ddsOutput = execSync('ps aux | grep "dart.*development-service" | grep -v grep', { encoding: "utf-8", timeout: 5000 }).trim();
            const ddsMatch = ddsOutput.match(/--vm-service-uri=(ws:\/\/[^\s]+)/);
            if (ddsMatch && !uris.includes(ddsMatch[1])) {
                uris.push(ddsMatch[1]);
            }
        }
        catch {
            // DDS process not found, that's fine
        }
        if (uris.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Flutter プロセスは見つかりましたが VM Service URI を抽出できませんでした。\n\nコンソールに表示される `ws://127.0.0.1:XXXXX/TOKEN=/ws` をコピーして `export_screen` に直接渡してください。",
                    },
                ],
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: `検出された Flutter アプリ:\n\n${uris.map((uri, i) => `${i + 1}. ${uri}`).join("\n")}\n\n\`export_screen\` ツールに URI を渡して画面をエクスポートできます。`,
                },
            ],
        };
    }
    catch {
        return {
            content: [
                {
                    type: "text",
                    text: "起動中の Flutter デバッグアプリが見つかりません。\n\n`flutter run --flavor develop` でデバッグビルドを起動してください。",
                },
            ],
        };
    }
});
// ── Tool: export_screen ──
server.tool("export_screen", "Flutter デバッグアプリの現在の画面を Figma JSON にエクスポートする", {
    vm_service_uri: z
        .string()
        .describe("VM Service WebSocket URI (例: ws://127.0.0.1:55624/TOKEN=/ws)"),
    output_path: z
        .string()
        .optional()
        .describe("出力先ファイルパス (省略時はカレントディレクトリに出力)"),
    page_name: z
        .string()
        .optional()
        .describe("ページ名 (Figma上のフレーム名に使用)"),
}, async ({ vm_service_uri, output_path, page_name }) => {
    const client = new VmServiceClient();
    try {
        // Connect
        await client.connect(vm_service_uri);
        const isolateId = await client.getIsolateId();
        // Create inspector and converter
        const inspector = new FlutterInspector(client, isolateId);
        const converter = new FigmaConverter(inspector);
        // Export
        const figmaJson = await converter.convert();
        // Set page name if provided
        if (page_name) {
            figmaJson.root.name = page_name;
        }
        // Write output
        const jsonStr = JSON.stringify(figmaJson, null, 2);
        const outPath = output_path ?? `${page_name ?? "screen"}_figma.json`;
        writeFileSync(outPath, jsonStr, "utf-8");
        const nodeCount = countNodes(figmaJson.root);
        return {
            content: [
                {
                    type: "text",
                    text: `エクスポート完了!\n\n- ノード数: ${nodeCount}\n- 出力: ${outPath}\n- サイズ: ${(jsonStr.length / 1024).toFixed(1)} KB\n\nFigma Plugin に JSON を貼り付けてください。`,
                },
            ],
        };
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `エクスポートに失敗しました: ${err instanceof Error ? err.message : String(err)}\n\nアプリがデバッグビルドで起動しているか、URI が正しいか確認してください。`,
                },
            ],
        };
    }
    finally {
        await client.dispose();
    }
});
// ── Tool: capture_screenshot ──
server.tool("capture_screenshot", "Flutter デバッグアプリの現在の画面のスクリーンショットを取得する", {
    vm_service_uri: z
        .string()
        .describe("VM Service WebSocket URI"),
    output_path: z
        .string()
        .optional()
        .describe("出力先ファイルパス (PNG)"),
}, async ({ vm_service_uri, output_path }) => {
    const client = new VmServiceClient();
    try {
        await client.connect(vm_service_uri);
        const isolateId = await client.getIsolateId();
        const inspector = new FlutterInspector(client, isolateId);
        // Get root RenderObject for screenshot
        const rootTree = await inspector.getRootTree();
        const rootId = rootTree.valueId ?? rootTree.objectId;
        if (!rootId) {
            return {
                content: [
                    {
                        type: "text",
                        text: "ルートノードの ID が取得できませんでした。",
                    },
                ],
            };
        }
        const base64Png = await inspector.screenshot(rootId, 390, 844);
        if (!base64Png) {
            return {
                content: [
                    {
                        type: "text",
                        text: "スクリーンショットの取得に失敗しました。",
                    },
                ],
            };
        }
        const outPath = output_path ?? "screenshot.png";
        writeFileSync(outPath, Buffer.from(base64Png, "base64"));
        return {
            content: [
                {
                    type: "text",
                    text: `スクリーンショットを保存しました: ${outPath}`,
                },
            ],
        };
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `スクリーンショット取得に失敗: ${err instanceof Error ? err.message : String(err)}`,
                },
            ],
        };
    }
    finally {
        await client.dispose();
    }
});
// ── Helpers ──
function countNodes(node) {
    let count = 1;
    if (node.children) {
        for (const child of node.children) {
            count += countNodes(child);
        }
    }
    return count;
}
// ── Start ──
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch(console.error);
