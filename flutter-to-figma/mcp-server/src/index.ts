#!/usr/bin/env node

/**
 * flutter-to-figma MCP Server
 *
 * Tools:
 *   list_flutter_apps   — Find running Flutter debug apps and VM Service URIs
 *   export_screen        — Export current screen to Figma JSON
 *   capture_screenshot   — Take a screenshot of the current screen
 *   screenshot_node      — Screenshot a specific widget by class name
 *   extract_theme        — Extract design tokens from Flutter source
 *   serve_html           — Serve a local directory over HTTP (for Code to Canvas)
 *   stop_html_server     — Stop a previously started HTTP server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "node:child_process";
import http from "node:http";
import { writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { VmServiceClient } from "./vm-service.js";
import { FlutterInspector } from "./inspector.js";
import { FigmaConverter, extractThemeTokens } from "./figma-converter.js";

const server = new McpServer({
  name: "flutter-to-figma",
  version: "0.1.0",
});

// ── Tool: list_flutter_apps ──

server.tool(
  "list_flutter_apps",
  "起動中の Flutter デバッグアプリを検出し、VM Service URI を返す",
  {},
  async () => {
    try {
      // Find Flutter debug processes with VM Service URIs
      const output = execSync(
        'ps aux | grep -E "dart|flutter" | grep -i "development-service\\|vm-service" | grep -v grep',
        { encoding: "utf-8", timeout: 5000 }
      ).trim();

      if (!output) {
        return {
          content: [
            {
              type: "text" as const,
              text: "起動中の Flutter デバッグアプリが見つかりません。\n\n`flutter run --flavor develop` でデバッグビルドを起動してください。",
            },
          ],
        };
      }

      // Extract VM Service URIs
      const uriPattern =
        /--vm-service-uri=([^\s]+)|vm-service-url=([^\s]+)|ws:\/\/[^\s]+/g;
      const uris: string[] = [];
      let match;
      while ((match = uriPattern.exec(output)) !== null) {
        uris.push(match[1] || match[2] || match[0]);
      }

      // Also try to find via DDS (Dart Development Service)
      try {
        const ddsOutput = execSync(
          'ps aux | grep "dart.*development-service" | grep -v grep',
          { encoding: "utf-8", timeout: 5000 }
        ).trim();

        const ddsMatch = ddsOutput.match(
          /--vm-service-uri=(ws:\/\/[^\s]+)/
        );
        if (ddsMatch && !uris.includes(ddsMatch[1])) {
          uris.push(ddsMatch[1]);
        }
      } catch {
        // DDS process not found, that's fine
      }

      if (uris.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Flutter プロセスは見つかりましたが VM Service URI を抽出できませんでした。\n\nコンソールに表示される `ws://127.0.0.1:XXXXX/TOKEN=/ws` をコピーして `export_screen` に直接渡してください。",
            },
          ],
        };
      }

      // Resolve DDS URIs (raw VM Service returns 302 when DDS is running)
      const resolvedUris = await Promise.all(
        uris.map((uri) => resolveDdsWsUri(uri))
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `検出された Flutter アプリ:\n\n${resolvedUris.map((uri, i) => `${i + 1}. ${uri}`).join("\n")}\n\n\`export_screen\` ツールに URI を渡して画面をエクスポートできます。`,
          },
        ],
      };
    } catch {
      return {
        content: [
          {
            type: "text" as const,
            text: "起動中の Flutter デバッグアプリが見つかりません。\n\n`flutter run --flavor develop` でデバッグビルドを起動してください。",
          },
        ],
      };
    }
  }
);

// ── Tool: export_screen ──

server.tool(
  "export_screen",
  "Flutter デバッグアプリの現在の画面を Figma JSON にエクスポートする。project_root を指定すると Dart ソースから BoxDecoration/LinearGradient/BoxShadow を自動抽出して補完する。",
  {
    vm_service_uri: z
      .string()
      .describe(
        "VM Service WebSocket URI (例: ws://127.0.0.1:55624/TOKEN=/ws)"
      ),
    output_path: z
      .string()
      .optional()
      .describe("出力先ファイルパス (省略時はカレントディレクトリに出力)"),
    page_name: z
      .string()
      .optional()
      .describe("ページ名 (Figma上のフレーム名に使用)"),
    project_root: z
      .string()
      .optional()
      .describe(
        "Flutter プロジェクトのルートディレクトリ。指定すると lib/ 以下の Dart ソースを静的解析して、Inspector API で取得できない decoration 情報 (gradient/shadow/border/radius) を補完する。"
      ),
  },
  async ({ vm_service_uri, output_path, page_name, project_root }) => {
    const client = new VmServiceClient();

    try {
      // Connect
      await client.connect(vm_service_uri);
      const isolateId = await client.getIsolateId();

      // Create inspector and converter
      const inspector = new FlutterInspector(client, isolateId);
      const converter = new FigmaConverter(inspector, { projectRoot: project_root });

      // Export
      const figmaJson = await converter.convert();

      // Set page name if provided
      if (page_name) {
        figmaJson.root.name = page_name;
      }

      // Write output
      const jsonStr = JSON.stringify(figmaJson, null, 2);
      const outPath =
        output_path ?? `${page_name ?? "screen"}_figma.json`;
      writeFileSync(outPath, jsonStr, "utf-8");

      const nodeCount = countNodes(figmaJson.root);

      return {
        content: [
          {
            type: "text" as const,
            text: `エクスポート完了!\n\n- ノード数: ${nodeCount}\n- 出力: ${outPath}\n- サイズ: ${(jsonStr.length / 1024).toFixed(1)} KB\n\nFigma Plugin に JSON を貼り付けてください。`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `エクスポートに失敗しました: ${err instanceof Error ? err.message : String(err)}\n\nアプリがデバッグビルドで起動しているか、URI が正しいか確認してください。`,
          },
        ],
      };
    } finally {
      await client.dispose();
    }
  }
);

// ── Tool: capture_screenshot ──

server.tool(
  "capture_screenshot",
  "Flutter デバッグアプリの現在の画面のスクリーンショットを取得する",
  {
    vm_service_uri: z
      .string()
      .describe("VM Service WebSocket URI"),
    output_path: z
      .string()
      .optional()
      .describe("出力先ファイルパス (PNG)"),
  },
  async ({ vm_service_uri, output_path }) => {
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
              type: "text" as const,
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
              type: "text" as const,
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
            type: "text" as const,
            text: `スクリーンショットを保存しました: ${outPath}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `スクリーンショット取得に失敗: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    } finally {
      await client.dispose();
    }
  }
);

// ── Tool: screenshot_node ──

server.tool(
  "screenshot_node",
  "指定したWidget名のノードを Inspector ツリーから検索し、各ノードを個別の PNG として保存する。座標計算なしで任意Widgetの正確なスクショを取得できる。",
  {
    vm_service_uri: z
      .string()
      .describe("VM Service WebSocket URI (例: ws://127.0.0.1:55624/TOKEN=/ws)"),
    node_name: z
      .string()
      .describe(
        "検索対象の Widget 名 (例: 'ClipOval', 'CustomCandidateCard', '_CustomImage')。同じ名前のノードが複数ある場合は全てキャプチャする。"
      ),
    output_dir: z
      .string()
      .optional()
      .describe("PNG 出力先ディレクトリ (省略時はカレントディレクトリ)"),
    width: z
      .number()
      .optional()
      .describe("スクショ幅 (px)。省略時はノードの実測幅を 3x で出力。"),
    height: z
      .number()
      .optional()
      .describe("スクショ高さ (px)。省略時はノードの実測高さを 3x で出力。"),
  },
  async ({ vm_service_uri, node_name, output_dir, width, height }) => {
    const client = new VmServiceClient();

    try {
      await client.connect(vm_service_uri);
      const isolateId = await client.getIsolateId();
      const inspector = new FlutterInspector(client, isolateId);

      // Find matching nodes
      const matches = await inspector.findNodesByName(node_name);
      if (matches.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `'${node_name}' に一致するノードが見つかりませんでした。\n\nWidget 名や private クラス名 (例: '_CustomImage') を確認してください。`,
            },
          ],
        };
      }

      const dir = output_dir ?? ".";
      const saved: string[] = [];
      const failed: string[] = [];

      for (let i = 0; i < matches.length; i++) {
        const node = matches[i];
        const renderId = node.valueId ?? node.objectId;
        if (!renderId) {
          failed.push(`${i}: no objectId`);
          continue;
        }

        // Get layout to determine actual size
        let w = width;
        let h = height;
        if (w == null || h == null) {
          try {
            const layout = await inspector.getLayoutExplorerNode(renderId);
            const size = layout?.size ?? { width: 0, height: 0 };
            // Use 3x retina by default
            w = w ?? Math.round(size.width * 3);
            h = h ?? Math.round(size.height * 3);
          } catch {
            // Fall back to default size
            w = w ?? 300;
            h = h ?? 300;
          }
        }

        if (!w || !h) {
          failed.push(`${i}: invalid size ${w}x${h}`);
          continue;
        }

        try {
          const base64 = await inspector.screenshot(renderId, w, h);
          if (!base64) {
            failed.push(`${i}: screenshot returned null`);
            continue;
          }
          const safeName = node_name.replace(/[^a-zA-Z0-9_-]/g, "_");
          const outPath = `${dir}/${safeName}_${i}.png`;
          writeFileSync(outPath, Buffer.from(base64, "base64"));
          saved.push(outPath);
        } catch (e) {
          failed.push(`${i}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const lines = [
        `'${node_name}' で ${matches.length} 件のノードを検出しました。`,
        ``,
        `保存成功: ${saved.length} 件`,
        ...saved.map((p) => `  - ${p}`),
      ];
      if (failed.length > 0) {
        lines.push(``, `失敗: ${failed.length} 件`);
        lines.push(...failed.map((m) => `  - ${m}`));
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `screenshot_node に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    } finally {
      await client.dispose();
    }
  }
);

// ── Tool: extract_theme ──

server.tool(
  "extract_theme",
  "Flutter プロジェクトから design tokens (spacing, radius, colors, textStyles) を抽出して JSON で返す。lib/ 配下の Dart source 全体を静的解析するため VM Service 不要。テーマディレクトリの場所は自動検出する。",
  {
    project_root: z
      .string()
      .describe("Flutter プロジェクトのルートパス (lib/ を含むディレクトリ)"),
    output_path: z
      .string()
      .optional()
      .describe("JSON 出力先 (省略時は theme_tokens.json をカレントに出力)"),
  },
  async ({ project_root, output_path }) => {
    try {
      const libDir = join(project_root, "lib");
      if (!existsSync(libDir)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `lib ディレクトリが見つかりません: ${libDir}\n\nFlutter プロジェクトのルートを指定してください。`,
            },
          ],
        };
      }

      // Use the shared extractor which handles arbitrary theme directory
      // layouts and any token naming convention via heuristics.
      const baseTokens = extractThemeTokens(project_root);

      // Also extract TextStyle definitions (best-effort across the whole lib/)
      const textStyles: Record<
        string,
        { fontSize?: number; fontWeight?: number; color?: string }
      > = {};
      const dartFiles: string[] = [];
      const walk = (d: string) => {
        try {
          for (const entry of readdirSync(d)) {
            if (entry.startsWith(".")) continue;
            const full = join(d, entry);
            const st = statSync(full);
            if (st.isDirectory()) {
              if (entry === "build" || entry === ".dart_tool") continue;
              walk(full);
            } else if (entry.endsWith(".dart") && !entry.endsWith(".g.dart")) {
              dartFiles.push(full);
            }
          }
        } catch {
          // skip
        }
      };
      walk(libDir);

      for (const file of dartFiles) {
        let content: string;
        try {
          content = readFileSync(file, "utf-8");
        } catch {
          continue;
        }
        // Match: `static TextStyle get name => TextStyle(...);`
        // and:   `static TextStyle name(...) => TextStyle(...);`
        const matches = content.matchAll(
          /(?:static\s+)?TextStyle\s+(?:get\s+)?(\w+)(?:\([^)]*\))?\s*=>\s*(?:const\s+)?TextStyle\(([\s\S]*?)\)\s*;/g
        );
        for (const m of matches) {
          const name = m[1];
          const body = m[2];
          const fsMatch = body.match(/fontSize:\s*([0-9.]+)/);
          const fwMatch = body.match(/FontWeight\.w(\d+)|FontWeight\.bold/);
          const colorMatch = body.match(/Color\(0x([0-9A-Fa-f]{8})\)/);
          textStyles[name] = {
            fontSize: fsMatch ? parseFloat(fsMatch[1]) : undefined,
            fontWeight: fwMatch
              ? fwMatch[1]
                ? parseInt(fwMatch[1])
                : 700
              : undefined,
            color: colorMatch ? `#${colorMatch[1].substring(2)}` : undefined,
          };
        }
      }

      // Convert color objects to hex strings for output
      const colorHex: Record<string, string> = {};
      for (const [name, c] of Object.entries(baseTokens.colors)) {
        const r = Math.round(c.r * 255).toString(16).padStart(2, "0");
        const g = Math.round(c.g * 255).toString(16).padStart(2, "0");
        const b = Math.round(c.b * 255).toString(16).padStart(2, "0");
        const a = Math.round(c.a * 255).toString(16).padStart(2, "0");
        colorHex[name] = a === "ff" ? `#${r}${g}${b}` : `#${r}${g}${b} (alpha:${a})`;
      }

      const out = {
        spacing: baseTokens.spacing,
        radius: baseTokens.radius,
        colors: colorHex,
        textStyles,
      };

      const json = JSON.stringify(out, null, 2);
      const outPath = output_path ?? "theme_tokens.json";
      writeFileSync(outPath, json, "utf-8");

      const summary = [
        `テーマ抽出完了!`,
        ``,
        `- spacing: ${Object.keys(out.spacing).length} トークン`,
        `- radius: ${Object.keys(out.radius).length} トークン`,
        `- colors: ${Object.keys(out.colors).length} トークン`,
        `- textStyles: ${Object.keys(out.textStyles).length} スタイル`,
        ``,
        `出力: ${outPath}`,
      ];

      return {
        content: [{ type: "text" as const, text: summary.join("\n") }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `extract_theme に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  }
);

// ── Tool: serve_html ──

const runningServers = new Map<number, http.Server>();

server.tool(
  "serve_html",
  "指定ディレクトリを静的 HTTP サーバーとして配信する。Figma の Code to Canvas (generate_figma_design) に食わせる HTML プレビュー用。返り値の URL をそのまま Playwright / generate_figma_design に渡せる。サーバーは stop_html_server で停止するまで動き続ける。",
  {
    directory: z
      .string()
      .describe("配信するディレクトリの絶対パス (index.html を含む)"),
    port: z
      .number()
      .optional()
      .describe("ポート番号 (省略時は 8770-8799 の空きを自動選択)"),
  },
  async ({ directory, port }) => {
    if (!existsSync(directory)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `ディレクトリが見つかりません: ${directory}`,
          },
        ],
      };
    }
    const indexPath = join(directory, "index.html");
    if (!existsSync(indexPath)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `index.html が見つかりません: ${indexPath}`,
          },
        ],
      };
    }

    const portsToTry = port
      ? [port]
      : Array.from({ length: 30 }, (_, i) => 8770 + i);

    for (const p of portsToTry) {
      if (runningServers.has(p)) continue;
      try {
        const srv = await startStaticServer(directory, p);
        runningServers.set(p, srv);
        return {
          content: [
            {
              type: "text" as const,
              text: `ローカルサーバーを起動しました。\n\n- URL: http://localhost:${p}\n- 配信元: ${directory}\n\n停止するには stop_html_server に port=${p} を渡してください。`,
            },
          ],
        };
      } catch {
        // port in use, try next
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `利用可能なポートが見つかりませんでした (試行範囲: 8770-8799)`,
        },
      ],
    };
  }
);

// ── Tool: stop_html_server ──

server.tool(
  "stop_html_server",
  "serve_html で起動したローカル HTTP サーバーを停止する",
  {
    port: z.number().describe("停止するサーバーのポート番号"),
  },
  async ({ port }) => {
    const srv = runningServers.get(port);
    if (!srv) {
      return {
        content: [
          {
            type: "text" as const,
            text: `ポート ${port} にサーバーが登録されていません。`,
          },
        ],
      };
    }
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    runningServers.delete(port);
    return {
      content: [
        {
          type: "text" as const,
          text: `ポート ${port} のサーバーを停止しました。`,
        },
      ],
    };
  }
);

// ── Helpers ──

function startStaticServer(
  directory: string,
  port: number
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      try {
        const reqUrl = decodeURIComponent((req.url ?? "/").split("?")[0]);
        // Prevent directory traversal: reject any ".." in the decoded path.
        if (reqUrl.includes("..")) {
          res.writeHead(400).end("bad request");
          return;
        }
        const rel = reqUrl === "/" ? "/index.html" : reqUrl;
        const filePath = join(directory, rel);
        if (!filePath.startsWith(directory)) {
          res.writeHead(403).end("forbidden");
          return;
        }
        if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
          res.writeHead(404).end("not found");
          return;
        }
        const ext = filePath.substring(filePath.lastIndexOf(".") + 1).toLowerCase();
        const mime: Record<string, string> = {
          html: "text/html; charset=utf-8",
          css: "text/css; charset=utf-8",
          js: "application/javascript; charset=utf-8",
          json: "application/json; charset=utf-8",
          svg: "image/svg+xml",
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          webp: "image/webp",
          gif: "image/gif",
          woff: "font/woff",
          woff2: "font/woff2",
        };
        res.writeHead(200, {
          "content-type": mime[ext] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        res.end(readFileSync(filePath));
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
    srv.on("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}



/**
 * Resolve raw VM Service HTTP URI to DDS WebSocket URI.
 * When DDS (Dart Development Service) is running, the raw VM Service
 * returns 302 redirect pointing to the DDS endpoint.
 */
function resolveDdsWsUri(rawUri: string): Promise<string> {
  // Normalize to HTTP
  const httpUri = rawUri
    .replace(/^ws/, "http")
    .replace(/\/ws\/?$/, "/");

  return new Promise((resolve) => {
    http
      .get(httpUri, (res) => {
        if (res.statusCode === 302 && res.headers.location) {
          try {
            const location = new URL(res.headers.location);
            const wsParam = location.searchParams.get("uri");
            if (wsParam) {
              resolve(wsParam);
              return;
            }
          } catch {
            // fall through
          }
          // Derive from redirect path
          const loc = new URL(res.headers.location);
          resolve(
            `ws://${loc.host}${loc.pathname.replace(/\/devtools\/.*$/, "/ws")}`
          );
        } else {
          // No redirect — direct access
          resolve(
            rawUri.replace(/^http/, "ws").replace(/\/$/, "") + "/ws"
          );
        }
      })
      .on("error", () => {
        resolve(
          rawUri.replace(/^http/, "ws").replace(/\/$/, "") + "/ws"
        );
      });
  });
}

function countNodes(node: { children?: unknown[] }): number {
  let count = 1;
  if (node.children) {
    for (const child of node.children) {
      count += countNodes(child as { children?: unknown[] });
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
