# Flutter 画面を編集可能な Figma フレームに送る

起動中の Flutter 画面を、**編集可能な Figma レイヤー**として書き出すためのエンドツーエンドのフロー。

Figma 公式の Code to Canvas は「ローカルで配信されている HTML ページをキャプチャして DOM を Figma レイヤーに変換する」仕組みのため、一度 HTML/CSS を経由する必要がある。このスキルはその経路を最小コストで通すためのオーケストレーション手順。

## 🚨 作業開始前に必ず読むこと 🚨

**このスキルを呼び出した瞬間、まず下記「フロー」セクションを Step 1 から Step 9 まで**最後まで**読み切ってから着手すること**。
途中のステップ（特に Step 2 のコード精読、Step 5 のユーザー確認）をスキップすると必ず手戻りが発生する。

**絶対に守る原則:**
- **Step を飛ばさない**。特に HTML 変換を飛ばして JSON を直接 Figma に投げるのは禁止（Code to Canvas の仕組み上動かない）。
- **勝手に Figma に送らない**。`generate_figma_design` を呼ぶ前に必ずユーザー確認を挟む。
- **「画面全体」を対象にする**。スクロール可能な画面では見えている部分だけで済ませず、**末尾まで必ず確認する**（下記「全画面を対象にする」を参照）。

## 全画面を対象にする（重要）

対象画面が `ListView` / `CustomScrollView` / `SingleChildScrollView` 等でスクロール可能な場合、最初に取ったシミュレータのスクショには**一部しか写っていない**。これを「画面の全容」と誤解して HTML を書くと、ユーザーから「残りが出ていない」と必ず指摘される。

**必ず守る手順:**

1. **実装コードを読んだ時点で、スクロール可能 Widget (`ListView`, `SliverList`, `CustomScrollView` 等) が含まれるか判定する**。含まれる場合、「最初のスクショに写っていない要素が存在する可能性が高い」とみなす。
2. 対象画面の**末尾までスクロールしたスクショを揃える**。
3. スクロール後、ユーザーに「末尾まで全部再現する必要がありますか？それとも先頭から N 件だけでよいですか？」と**範囲を確認してから** HTML に起こす。

### スクロール画像の取得方法

**(A) 自動スクロール（推奨）**

macOS のアクセシビリティ権限が Claude Code に付与されていれば、Python + Quartz でシミュレータのマウスドラッグをエミュレートできる。

```python
# pyobjc-framework-Quartz が必要: pip3 install pyobjc-framework-Quartz
import Quartz, time, subprocess

# Simulator を前面に
subprocess.run(['osascript','-e','tell application "Simulator" to activate'])
time.sleep(0.4)

# Simulator ウィンドウの位置とサイズを取得
r = subprocess.run(
    ['osascript','-e',
     'tell application "System Events" to tell process "Simulator" to '
     'return (position of window 1) & (size of window 1)'],
    capture_output=True, text=True).stdout.strip()
# 例: "-530, -1265, 391, 838"
wx, wy, ww, wh = [int(v.strip()) for v in r.split(',')]

def post(e): Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)

# 画面中央付近で上向きドラッグ = 下にスクロール
x = wx + ww // 2
ys, ye = wy + int(wh*0.80), wy + int(wh*0.25)

post(Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, (x,ys), Quartz.kCGMouseButtonLeft))
for i in range(1, 25):
    yy = ys + (ye-ys)*i/25
    post(Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDragged, (x,yy), Quartz.kCGMouseButtonLeft))
    time.sleep(0.012)
post(Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, (x,ye), Quartz.kCGMouseButtonLeft))
```

これを `xcrun simctl io booted screenshot /tmp/sim_pN.png` と交互に繰り返し、**末尾到達を確認**するまでスクショを取り続ける（連続したスクショが同一になったら末尾）。

**(B) 自動スクロールが使えない場合 → ユーザーにスクショ依頼**

アクセシビリティ権限がない、`pyobjc-framework-Quartz` が入っていない、Android 実機で `simctl` が使えない、等のケース:

> 「Python + Quartz でのスクロール自動化が使えません。お手数ですが、対象画面をスクロールしながらスクショを撮って、**デスクトップ**に `screen_01.png`, `screen_02.png` のように連番で置いてもらえますか？全部置き終わったら『置きました』と教えてください。」

ユーザーが置き終わったら `~/Desktop/screen_*.png` を `Glob` で列挙し、`Read` で順に読み込んで画面情報を抽出する。

## 前提

- Flutter アプリがデバッグビルドで起動していること（`flutter run`）
- Playwright MCP が使えること（レンダリング検証用）
- Figma MCP が使えること（`generate_figma_design` が呼べる状態）

## フロー

### 1. 情報を集める

1. `list_flutter_apps` で VM Service URI を取得
2. `export_screen` に `vm_service_uri` と `project_root` を渡して画面の JSON を出力
   - 出力パスは `/tmp/flutter_figma_<timestamp>/export.json` のような作業用一時ディレクトリを推奨
3. シミュレータのスクリーンショットを取る
   - iOS: `xcrun simctl io booted screenshot <path>`
   - Android: `adb exec-out screencap -p > <path>`
   - これは「正解画像」として後の差分チェックに使う
4. **スクロール可能画面なら末尾までスクショを揃える**（上記「全画面を対象にする」を参照）。この時点で「見えている部分だけでよいか、末尾まで全部再現するか」をユーザーに確認する。

### 2. 実装コードを読む（最重要ステップ）

**ここで手を抜くと後工程が全部崩れる**。HTML を書き始める前に、対象画面の実装をコード上で完全に把握する。

#### 2-1. 画面の Widget ツリーを特定

JSON のルートから辿って、Page/Screen レベルの Widget クラス名を特定する。そのクラスのソースファイルを `lib/` から探し、上から下まで読む。`Scaffold`、`AppBar`、`body` に渡されている Widget、その中の子 Widget、さらにその子 Widget、と再帰的に読み込む。

子 Widget が別ファイルに切り出されている場合（カード、リスト項目、ヘッダー、ボタン等）は**必ずそのファイルも読む**。「どうせ似たようなカードだろう」で済ませると、余白・角丸・影・背景色のどれかが確実にズレる。

#### 2-2. 画像・アイコンを全部リストアップ

画面に出てくる視覚要素のうち、テキスト以外の**すべて**を明示的に把握する。これをサボると Figma 側で「プレースホルダーの灰色の四角だらけ」になる。

チェックすべき種類:

- **ローカルアセット画像** — `Image.asset('assets/images/xxx.png')`, `AssetImage('...')`, `SvgPicture.asset('...')`
  - `pubspec.yaml` の `assets:` セクションと突き合わせて実在を確認
  - ファイルのフルパスを控えておき、HTML 側に `<img src="...">` で埋める（`serve_html` は画像も配信できる）
- **ネットワーク画像** — `Image.network(url)`, `CachedNetworkImage(imageUrl: ...)`
  - URL がコードに直書きならそれを使う
  - 実行時に API から取得される場合は、シミュレータのスクショから `screenshot_node` で該当ノードだけ切り出して使う
- **Material Icons** — `Icon(Icons.xxx)`
  - アイコン名を控えておく。HTML では Material Symbols の Web フォントか、対応する SVG で置き換える
- **Cupertino Icons** — `Icon(CupertinoIcons.xxx)` も同様
- **カスタム SVG アイコン** — `SvgPicture.asset('assets/icons/xxx.svg')`
  - ファイルパスを控える
- **装飾的な Container** — アイコンではなく `BoxDecoration` で描かれている丸・線・グラデーション等も視覚要素。HTML/CSS で再現する

作業時は、以下のような対応表を**必ず**頭に（もしくはメモに）作ってから HTML を書き始める。

```
要素        | 種類              | ソース
----------|-----------------|---------------------------
ヘッダーロゴ  | AssetImage       | assets/images/logo.png
プロフィール | NetworkImage     | ユーザーAPIレスポンス（プレースホルダー）
戻るボタン   | Icons.arrow_back | Material Symbols
通知ベル    | SvgPicture.asset | assets/icons/bell.svg
カード背景   | BoxDecoration    | LinearGradient (from source)
```

#### 2-3. テーマトークンと定数を解決

`Theme.of(context).xxx`, `AppColors.xxx`, 独自の `ThemeExtension` 等で参照されている色・スペーシング・角丸は、`extract_theme` を併用するか、テーマ定義ファイルを直接読んで**実値に解決**してからHTMLに埋める。

**禁止事項**: 推測で値を書かない。テキスト・パディング・角丸・色・フォントサイズ・フォントウェイトは、実装コード・JSON・スクショの**いずれか**から実際の値を取る。一箇所でも「だいたいこのくらい」で書くと、Figma 側で必ず気付かれる。

### 3. HTML/CSS を書く

作業用の一時ディレクトリに `index.html` を作成する。

- 編集可能なレイヤーにするため、**画像ではなく DOM 構造**で組む
  - `Container` → `<div>` + inline style
  - `Text` → `<span>` or `<div>`
  - `Row` / `Column` → flexbox
  - `Icon` → SVG か Unicode（フォント依存を避けるなら SVG）
- 画像アセットは Step 2-2 で洗い出したリスト通りに配置する
  - ローカルアセットは作業ディレクトリにコピーし、`<img src="assets/xxx.png">` で参照（`serve_html` がそのまま配信してくれる）
  - ネットワーク画像は `screenshot_node` で切り出したものを同じく作業ディレクトリにコピー
  - どうしても実体が取れない画像だけプレースホルダーにし、ユーザーに「ここは実画像が取れなかった」と明示する
- フォントは **Noto Sans JP** を Google Fonts から `<link>` で読み込む（システム依存を避ける）
- 画面サイズは export の `metadata.screenSize` に合わせる
- 1発で完璧を狙うこと。後で直すより最初から読み込んで書いたほうが早い

### 4. ローカルで配信する

`serve_html` に上記ディレクトリを渡して URL を得る。

### 5. Playwright でレンダリング結果を撮る

Playwright MCP の `browser_navigate` で `http://localhost:<port>` を開き、`browser_take_screenshot` で PNG を保存する。ビューポートは Flutter 画面サイズに合わせる（例: 393x852）。

### 6. シミュレータ画像と差分チェック

2枚のスクリーンショット（シミュレータ / Playwright）を両方 Read して、**視覚的に比較**する。ピクセル完全一致は目指さない。以下の観点で差分を見る:

- レイアウト崩れ（要素の並び順、折り返し、はみ出し）
- テキストの欠落・内容違い
- 色の明らかな違い（グラデーション方向、背景色など）
- 角丸・影・境界線の有無
- 余白・サイズ感

差分があったら HTML を編集し、ブラウザをリロードして再撮影。**最大 3 回までリトライ**する。それ以上は無理に修正せず、残っている差分を明示してユーザーに判断を仰ぐ。

### 7. ユーザーに品質確認

URL と Playwright スクショをユーザーに提示して、「この状態で Figma に送っていいか」を必ず確認する。**勝手に Figma に送らない**。

### 8. Figma に送る

ユーザー OK が出たら、Figma MCP の `generate_figma_design` を呼ぶ。

- 初回は `outputMode: "newFile"` で新規ファイル作成
- `captureId` が返ってきたら、最大 10 回まで polling して完了を待つ
- 完了後、Figma のファイル URL をユーザーに返す

### 9. 後片付け

`stop_html_server` で HTTP サーバーを停止する。一時ディレクトリは、ユーザーが再利用したいかもしれないので自動削除しない。

## 注意事項

- HTML 生成の精度 = Figma 側の精度。ここをケチると全部崩れる
- Playwright のスクショはビューポートサイズを明示的に合わせること。デフォルトサイズだとレイアウトが変わる
- `generate_figma_design` は localhost でも動く。外部公開不要
- 実装コード由来の固有名詞（Widget クラス名、プロジェクト名など）は、生成する HTML の **コメントや class 名に入れない**。汎用的な名前 (`card-1`, `header`, `nav-item` 等) を使う
