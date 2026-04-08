# flutter-to-figma

Claude Code 用プラグイン。Flutter デバッグアプリの画面を Figma JSON にエクスポートし、Dart ソースコードの静的解析と組み合わせて高精度な設計情報を抽出する。

## 特長

- **パッケージ追加不要** — VM Service 経由で外部から Widget Tree を取得するため、対象 Flutter アプリに依存パッケージを追加する必要がない
- **実行時情報 + ソース解析の統合** — Inspector API で取得した実測座標・サイズに加え、Dart ソースから `LinearGradient` / `BoxShadow` / `Border` / テーマトークンを自動補完
- **汎用ヒューリスティクス** — 任意のディレクトリ構造・任意の `*Widget` 基底クラス・任意のトークン名前空間に対応
- **ノード単位スクリーンショット** — Widget 名を指定するだけで、該当ノードの PNG を個別に保存（座標計算不要）

## 提供ツール

### `list_flutter_apps`

起動中の Flutter デバッグアプリを検出し、VM Service URI を返す。

### `export_screen`

現在表示中の画面を Figma JSON としてエクスポートする。`project_root` を指定すると、Dart ソースから decoration 情報を静的解析して JSON に補完する。

**パラメータ**

| 名前 | 必須 | 説明 |
|---|---|---|
| `vm_service_uri` | ✅ | VM Service WebSocket URI (例: `ws://127.0.0.1:55624/TOKEN=/ws`) |
| `project_root` | — | Flutter プロジェクトのルート。指定すると `lib/` を静的解析して装飾情報を補完 |
| `output_path` | — | 出力先 JSON ファイル (省略時はカレント) |
| `page_name` | — | Figma 上のフレーム名 |

**ソース解析で補完される情報**

- `LinearGradient(colors:...)` → Figma `GRADIENT_LINEAR` fill
- `BoxShadow(...)` → Figma `DROP_SHADOW` effect
- `Border.all(...)` → Figma `strokes`
- `BorderRadius.circular(...)` → `cornerRadius` (トークン参照も解決)
- `IconData(U+...)` → Material Icons 名 (`help_outline` 等)
- `AssetImage("...")` / `NetworkImage("...")` → `imageAssetPath` / `imageNetworkUrl`

### `extract_theme`

Flutter プロジェクトから design tokens (spacing, radius, colors, textStyles) を抽出して JSON で返す。

`lib/` 配下の Dart ソース全体を走査し、以下のパターンを自動検出:

- `name: Color(0xAARRGGBB)` (constructor arg)
- `static const Color name = Color(...)`
- `Color get name => Color(...)`
- ScreenUtil 数値: `name: N.w/h/r/sp,`
- `static const double name = N`
- `double get name => N`

クラス名に基づいて spacing / radius に自動分類される。

**パラメータ**

| 名前 | 必須 | 説明 |
|---|---|---|
| `project_root` | ✅ | Flutter プロジェクトのルート |
| `output_path` | — | 出力先 JSON (省略時は `theme_tokens.json`) |

### `screenshot_node`

指定した Widget 名のノードを Inspector ツリーから検索し、各ノードを個別の PNG として保存する。座標計算なしで任意 Widget の正確なスクショを取得できる。

**パラメータ**

| 名前 | 必須 | 説明 |
|---|---|---|
| `vm_service_uri` | ✅ | VM Service WebSocket URI |
| `node_name` | ✅ | 検索対象の Widget 名 (例: `ClipOval`, `_CustomImage`) |
| `output_dir` | — | PNG 出力先ディレクトリ |
| `width` / `height` | — | スクショサイズ (省略時はノード実測サイズの 3x) |

### `capture_screenshot`

現在の画面全体のスクリーンショットを取得する。

## セットアップ

### 前提

- Claude Code がインストール済み
- Flutter プロジェクトがデバッグビルドで起動できる (`flutter run --flavor develop` 等)

### インストール

```bash
claude plugin install https://github.com/shota-s9a/flutter-to-figma
```

### Figma 連携 (オプション)

Figma に画面を送りたい場合は、Figma リモート MCP を追加:

```bash
claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp
```

`/mcp` で `figma` を選択 → 認証。その後 `generate_figma_design` ツールで HTML ページを Figma フレームに変換できる。

## 使い方

1. Flutter アプリをデバッグモードで起動
   ```bash
   flutter run --flavor develop
   ```

2. Claude Code で以下のように指示:
   ```
   list_flutter_apps で URI を取得して、現在の画面を
   export_screen でエクスポートしてください。project_root は
   /path/to/flutter/app です。
   ```

3. 出力された JSON を使って HTML/CSS を生成し、`generate_figma_design` で Figma に送る

## 設計思想

### 情報源の統合

プラグインは以下 3 つの情報源を組み合わせて精度を担保する:

| 情報 | 取得元 | 得意 | 苦手 |
|---|---|---|---|
| 実測座標・サイズ | Inspector API | 動的計算値 | 装飾の詳細 |
| 装飾情報 (gradient/shadow) | Dart ソース静的解析 | 設計意図 | 実行時の値 |
| 実レンダリング結果 | screenshot_node | ネットワーク画像 | 構造 |

`export_screen` に `project_root` を渡すことで、Inspector API で取得できない情報 (Container の decoration 等) をソースコードから補完する。

### 汎用化ヒューリスティクス

プロジェクト固有の命名規約に依存せず動作するよう、以下のヒューリスティクスで自動検出する:

- **Widget 基底クラス**: `extends \w*Widget\b` でマッチ
- **ディレクトリ**: `lib/` 全体を走査 (テーマディレクトリ固定なし)
- **トークン参照**: 任意の識別子チェーン `xxx.yyy.zzz` の最後のセグメントを色トークンとして解決
- **spacing/radius 分類**: クラス名に `Radius`/`Corner` が含まれれば radius、それ以外は spacing

## ライセンス

MIT

## Author

[shota-s9a](https://github.com/shota-s9a)
