# Figma Export 補完コマンド (v5)

DevToolsから取得した **階層構造** raw JSON をソースコード読みで補完し、enriched Figma JSON を出力する。

## 入力

`$ARGUMENTS` に raw JSON のパスを指定（省略時: `../example-app/test/figma_output/top_page_devtools_raw.json`）

## 処理手順

### 1. raw JSON を読む

指定パスの JSON を読み込み、`root` の階層構造を把握する。
v5 では `root` がネストされた FRAME/RECTANGLE/TEXT ツリーになっている。

### 2. ソースコードからテーマ情報を収集

以下のファイルを読む:

- `../example-app/lib/presentation/theme/app_theme_colors.dart` — カラートークン定義（light の static const を参照）
- `../example-app/lib/presentation/theme/app_theme.dart` — レイアウト定数・TextStyle定義・primaryColor・gradationEnd
- `../example-app/lib/presentation/theme/spacing_extension.dart` — スペーシングトークン
- `../example-app/lib/presentation/theme/radius_extension.dart` — 角丸トークン

各ファイルからカラー値（RGB）→トークン名のマッピングテーブルを構築する。

### 3. 対象ページのウィジェットソースを読む

- `../example-app/lib/presentation/pages/top/top_page.dart`
- top_page.dart が参照する子ウィジェットファイルも辿って読む（import を追跡）
- ウィジェットの構造と命名を把握する

### 4. 補完処理（再帰的にツリーを走査）

ツリーの各ノードに対して以下を適用する。**Y座標ベースのヒューリスティクスは使わない** — DevToolsの階層構造 + ソースコードの対応関係で判定する。

#### a. カラートークンマッピング

fills の color 値を `app_theme_colors.dart` の light 定義と照合:
- RGB各成分の差が **0.02以内** なら同一とみなす
- 一致したらノードに `_colorToken` フィールドを追加
- グラデーション: `GRADIENT_LINEAR` の stops の色が `primaryColor → gradationEnd` パターンかチェックし、トークンを記録

```json
{
  "fills": [{"type": "SOLID", "color": {"r": 0.84, "g": 0.05, "b": 0.09}}],
  "_colorToken": "primaryColor"
}
```

#### b. セマンティック命名

raw JSON の name（`Material`, `DecoratedBox`, `Column` 等のruntimeType）を、ソースコードの構造に基づいて意味のある名前に変換する。

判定方法:
- ウィジェットソースの **クラス名・メソッド名** と階層位置を対応させる
- 階層構造（親子関係）を使って文脈を判定する
- 位置情報は補助的に使う（プライマリ判定基準にしない）

例:
- `Material` (ツリー上部, primaryColor系) → `AppBar`
- `Material` (ツリー最下部, 全幅, BottomNav系) → `BottomNavigationBar`
- `Column` (セクション単位) → `Section:おすすめ求人`
- `Image:network` → `ProfileImage` / `ThumbnailImage`（親ノードのコンテキストで判定）

#### c. プロジェクトアセット読み込み

`assetPath` を持つノードに対して:
- `../example-app/{assetPath}` からファイルを読み取り
- base64エンコードして `imageData` フィールドに設定
- ファイルが見つからない場合は警告を出力

```
assetPath: "assets/images/logo.png"
→ imageData: "iVBORw0KGgo..." (base64)
```

#### d. Material Icon 処理

`iconCodePoint` を持つノードに対して:
- `iconCodePoint` (Unicode codepoint) と `iconFontFamily` を記録
- 可能であれば Material Icons フォントから SVG/PNG を生成して `imageData` に設定
- 最低限: codePoint と fontFamily をそのまま保持（Figma plugin 側で処理）

#### e. フォントスタイル確認

TEXTノードのフォント情報を確認:
- fontFamily: DevToolsで取得済みの値をそのまま使用（iOS は `Hiragino Kaku Gothic ProN` 等）
- fontSize: DevToolsの値が正しい（screenutil 適用後の実サイズ）
- fontWeight: そのまま使用
- lineHeight / letterSpacing: DevToolsで追加した値をそのまま保持

### 5. 出力

補完済み JSON を `{元のファイルから _raw を除いた名前}_enriched.json` として保存する。
例: `top_page_devtools_raw.json` → `top_page_devtools_enriched.json`

変更サマリーを出力:
- カラートークンマッチ数
- セマンティック命名変更数
- アセット画像読み込み数
- アイコン処理数
- 総ノード数

### 注意事項

- **ツリー構造を壊さない** — ノードの追加・削除・移動はしない。フィールドの追加・変更のみ行う。
- **_networkImage ノードは触らない** — スクリーンショットクロップ済みの imageData はそのまま保持する。
- **座標は変更しない** — DevTools が出力した絶対座標はそのまま維持する。
