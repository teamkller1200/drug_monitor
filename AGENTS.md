# AGENTS.md

端末内完結型の薬物動態・相互作用ハームリダクションアプリ（静的 PWA + Capacitor iOS）。
素の ES Modules（フレームワーク・バンドラ・バックエンドなし）で動作し、外部通信を行わない。

詳細な要件・設計は `REQUIREMENTS.md` と `DESIGN.md` を参照すること。

## コマンド

Node.js 22 以上を前提とする。

```bash
npm test          # ユニットテスト・データ整合性テスト（node --test "test/*.test.js"）
npm run build     # scripts/build-www.mjs で静的アセットを www/ へコピー
npm run ios:sync  # ビルド後に Capacitor iOS プロジェクトへ同期
npx serve .       # ローカルで静的配信して動作確認
```

## 構成と依存ルール

```text
index.html / manifest.json / sw.js
src/
  app.js            # UI・画面遷移・グラフ描画・1秒更新
  pk.js             # 薬物動態シミュレータ（純粋関数・RK4）
  interactions.js   # 相互作用・累積量判定（純粋関数）
  oplock.js         # 操作ロックの状態遷移（純粋関数）
  store.js          # localStorage（dm.vault）永続化・JSON 入出力
  motion.js         # シートのスプリング・ドラッグ操作
  style.css         # スタイルシート
data/
  drugs.json        # 物質パラメータ
  products.json     # 市販製品 → 含有成分マッピング
  interactions.json # 相互作用ルール（pd / pk）
  limits.json       # 累積量上限基準
test/               # Node 標準テストランナーによる単体・データテスト
scripts/
  build-www.mjs     # www/ 生成スクリプト
ios/                # Capacitor iOS プロジェクト
```

- 依存の向きは `app.js → (pk, interactions, store, oplock, motion)`。
- `pk.js` / `interactions.js` / `oplock.js` は DOM やブラウザ固有 API に依存させない（Node 上でそのままテストできる状態を保つ）。
- 外部パッケージの追加は避ける（ランタイム依存はゼロ）。

## 変更時の必須ルール

### 1. 安全・ハームリダクション要件
- 免責表示と救急（119）・中毒110番への導線
- 操作ロック中も、閲覧・1秒更新・警告確認・緊急導線は有効のままにする。
- 警告はポップアップやプッシュ通知で割り込ませず、ベルのバッジと一覧シートで示す。

### 2. データファイル（`data/*.json`）
- 全エントリに `source`（URL または文献）と `status`（`draft` / `estimated` / `verified`）が必須。
- `draft` は通常 UI に表示しない。
- `estimated` は `note` を `概算` で始める。
- `verified` の `note` に `未取得` / `仮値` を残さない。
- `products.json` と `limits.json` の物質 ID は `drugs.json` に存在するものを参照する。
- 編集後は `npm test`（特に `test/data.test.js`）で検証する。

### 3. アセット追加時の同期
- 新規ファイルを追加した場合は以下を確認する:
  - `sw.js` の `FILES`（キャッシュ対象。必要に応じて `CACHE` バージョンも更新）
  - `scripts/build-www.mjs` の `ENTRIES`（ルート直下に新規ファイル/ディレクトリを追加した場合）

### 4. プライバシー・永続化
- 外部へのデータ送信・解析・トラッキングを追加しない。
- 保存は `localStorage`（`dm.vault`）の平文 JSON（`{ v: 2, data }`）でパスワードロックなし。旧暗号化ボルトからの移行パスは壊さない。

## 検証

コードや `data/*.json` を変更したら `npm test` を実行して全テストが通ることを確認する。
