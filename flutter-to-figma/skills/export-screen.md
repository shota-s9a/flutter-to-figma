# Flutter 画面を Figma にエクスポート

Flutter デバッグアプリの画面をキャプチャし、Figma で編集可能な JSON を生成します。

## 手順

1. **起動中の Flutter アプリを検出**
   - `list_flutter_apps` ツールで VM Service URI を取得
   - 複数アプリが見つかった場合はユーザーに選択してもらう

2. **画面をエクスポート**
   - `export_screen` ツールで Widget ツリーを取得し Figma JSON に変換
   - ツリー構造・色・角丸・padding・テキスト・画像を含む

3. **結果をユーザーに返す**
   - JSON ファイルのパスを伝える
   - Figma Plugin への貼り付け手順を案内する

## 注意事項

- Flutter アプリは **デバッグビルド** で起動している必要がある（リリースビルドでは Inspector API が無効）
- アプリ側にパッケージ追加は **不要**
- VM Service の接続にはデバッグビルド起動時に表示される URI を使用する
