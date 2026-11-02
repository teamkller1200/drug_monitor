# 基本設計: 摂取薬物モニター

## 1. 構成
静的PWA(素のJS、フレームワークなし、バックエンドなし)。

```
drug_monitor/
  index.html  manifest.json  sw.js
  src/
    app.js            # UI(画面遷移、描画、1秒タイマー)
    pk.js             # シミュレータ(純粋関数)
    interactions.js   # 相互作用・累積量の判定(純粋関数)
    store.js          # 保存・暗号化・エクスポート
    oplock.js         # 操作ロックの状態遷移(純粋関数)
    motion.js         # スプリングと縦ドラッグ
  data/
    drugs.json        # 物質パラメータ
    products.json     # 製品→成分
    interactions.json # 相互作用ルール
    limits.json       # 累積量上限
  test/
    pk.test.js  interactions.test.js  data.test.js
```

依存の向き: `app → (pk, interactions, store)`。`pk` と `interactions` は DOM に触れない。

## 2. データモデル
全データに `source`(URLまたは文献)と `status: "draft" | "estimated" | "verified"` を必須とする。`draft` はUIに出さない(開発モードでのみ表示)。`estimated` は「概算」と表示し、`note` に理由を書く。`data.test.js` が欠落を検出する。

線形モデルが過量時に消失を速く見積もる物質(DXM)には `presentAtLeastH` を設定し、摂取からその時間は存在判定を保って警告が早く切れないようにする。

```jsonc
// drugs.json
{ "id":"codeine", "name":"コデイン",
  "routes": { "oral": { "F":0.9, "ka":2.0, "tlagH":0.2 } },
  "central": { "halfLifeH":3, "VdLperKg":3.5 },
  "elimination": "linear",            // linear | zero | mm
  "metabolites": [ { "id":"morphine", "frac":0.1, "halfLifeH":3, "VdLperKg":3.5, "active":true } ],
  "effect": { "ke0":1.0, "ref":{"onsetH":0.5,"peakH":1.5,"durationH":5}, "target":"morphine" },
  "cv": 0.4,                          // 個人間変動(帯の幅)
  "covariates": [ { "on":"cyp2d6", "when":"low", "mult":{"frac":0.4} } ],  // profile[on] === when のとき適用
  "cyp": { "substrate":["2D6"], "inhibits":[] },
  "classes": ["opioid","cns_depressant"],
  "source":"...", "status":"draft" }

// products.json
{ "id":"example-product", "name":"製品名", "form":"tablet",
  "ingredients":[ { "drug":"dihydrocodeine", "mgPerUnit":0 } ],   // 値は添付文書で確認して記入
  "source":"...", "status":"draft" }

// interactions.json (クラスまたは物質間)
{ "a":"class:opioid", "b":"class:benzodiazepine", "kind":"pd",
  "severity":"fatal",                 // caution | danger | fatal
  "mechanism":"呼吸抑制の相加", "source":"...", "status":"draft" }
{ "a":"class:cyp2d6_inhibitor", "b":"drug:codeine", "kind":"pk",
  "effect":{ "fracMult":0.3 }, "severity":"caution", "source":"..." }   // pk ルールは a=阻害薬、b=対象の一方向

// limits.json
{ "drug":"acetaminophen", "windowH":24, "maxMg":0, "severity":"fatal", "source":"添付文書" }  // 値は要確認

// store (暗号化対象)
profile: { weightKg, age, sex, smoker, egfr?, cyp2d6? }
doses:   [ { id, itemId(product|drug), route, takenAt, amount:{min,max,unit} } ]
```

UI表示名: 注意 / 危険 / 命に関わる。内部値は `caution|danger|fatal`。

## 3. 計算(`pk.js`)
**方針: 全モデルを1つの数値シミュレータで処理する**(解析解と数値解の二重実装を避ける)。

- 状態: 物質ごとに `[gut, central, metabolite…, effect]`
- 刻み: 固定 dt=1分、RK4。範囲は最初の摂取−数時間〜今+表示範囲。半減期の長い物質は終点を `10×t½` まで延長
- 消失: `linear`(k·C)、`zero`(一定速度、飽和で頭打ち)、`mm`(Vmax·C/(Km+C))
- 代謝物: 親からの生成を `frac` で定義。活性代謝物は効果部位の入力に使う
- 補正: `covariates` を適用(体重→Vd・CL、CYP2D6型→生成率、喫煙等)。ルールの無い共変量は無視
- 時変補正: 相互作用の `pk` ルールは、阻害薬が体内に存在する間(閾値以上)だけ係数を適用
- 不確実性の帯: 低・中・高の3回実行(用量範囲の下限/上限 × `cv` に基づくCL/Vd の増減)
- 作用の段階: 効果部位濃度 Ce と `ref` から「立ち上がり(上昇中)/ピーク域/コムダウン(下降中)/ほぼ消失」を判定
- 純粋関数: `simulate(profile, doses, drugsDb, nowMs, range) → { series, now, bands }`

テスト: 線形1コンパートメントの解析解(Bateman)との一致、重ね合わせ、0次消失の直線減少、代謝物の質量収支。

## 4. 相互作用・累積量(`interactions.js`)
- **存在判定**: 物質が「体内にある」とみなすのは、濃度がその物質のピークの5%以上のとき、または摂取済みでピークに届く前のとき(吸収の遅れの間も警告するため)
- **PD(薬力学)**: 存在判定を満たす物質ペアについて、クラス/物質のルールに一致したものを重大度順に返す
- **累積量**: 成分単位で、製品の摂取を展開して集計し、`limits.json` のウィンドウ内合計と比較
- 一致するルールが無い場合は `unknown`(「データなし」)を返し、`safe` は返さない
- 出力: `[{severity, mechanism, items, source}]`

## 5. 画面
| 画面 | 内容 |
|---|---|
| ホーム | 重ねたタイムラインと「記録」ボタンが主役。物質ごとの現在値は凡例か「成分ごとの詳細」から開くシートに置く。Liquid Glass調のダークテーマ |
| 警告 | 検知時にトーストで表示(注意 約6秒、危険 約10秒、命に関わるは閉じるまで。上スワイプでも閉じる)。「緊急」とベルから警告一覧シートを開き、119、中毒110番、全警告、データなしを見る |
| 記録 | ホームの「記録」から開く。製品/物質検索、量(単一または範囲)、経路、時刻。直前の入力を再利用して1タップで追加 |
| 履歴 | 一覧、編集、削除 |
| 物質詳細 | パラメータ、補正に使った項目、出典、限界の注意 |
| プロフィール | F8 の入力項目 |
| 設定 | パスワード、自動ロック、エクスポート/インポート、全データ削除 |

更新: 現在値パネルとグラフの再描画は `setInterval(1000)`(24時間幅では「今」の線は約1.5分で1px動くだけなので `requestAnimationFrame` は不要)。曲線は摂取の追加・編集時、プロフィール変更時、10分ごとに再計算。非表示の間は止め、復帰時に再計算。

## 6. 保存と暗号化(`store.js`)
- パスワード→PBKDF2で鍵導出→AES-GCMで `profile` と `doses` を暗号化して `localStorage` に保存。保存するのは salt・iv・暗号文のみ
- 鍵はメモリ上のみ保持し、非表示が一定時間続くと自動ロック
- パスワードは初回に必須(平文で保存する経路を作らない)
- パスワードを忘れると復元不可。設定画面と作成時にその旨を表示。エクスポートは平文になる旨を確認する
- 全データ削除、JSONエクスポート/インポート(インポート時にスキーマ検証)

## 6.5 操作ロックモード(誤操作防止)
目的: 錯乱時に、記録の誤追加・削除・設定変更・全削除をしない。パスワードロック(秘匿)とは別物で、独立に動く。

**仕様**
- 開始: ホームから1タップ。期限をプリセット(1/3/6/12時間、既定6時間)から選ぶ。素面のうちに入れておく使い方を想定
- ロック中: 閲覧と1秒更新、警告バナー、救急導線は通常どおり。変更系の操作はすべて無効
- 自動解除: 期限到達で解除。期限の短縮はできない(延長のみ可)
- 早期解除: 「解除」→ **待機時間(既定5分、取り消し可)** → 簡単な認知課題(表示された数字の入力など)→ 解除。錯乱中は完了しにくく、素面なら数分で解除できる
- 任意設定「ロック中も記録の追加のみ許可」(既定オフ、許可時は確認2段階)。実際に摂取したのに記録できず、曲線と警告がずれるのを避けたい場合に使う
- 状態は平文のフラグとして保存し、リロードしても継続する(パスワード画面の前でも有効)

**実装**
- 変更系はすべて `dispatch(action)` を通し、ロック中は許可リスト(閲覧、救急、解除手続き)以外を拒否する。ボタン単位の無効化には頼らない
- 画面側は `inert` とスタイルでロック中を明示する

**限界(仕様として明記)**
- 端末の時計変更、ブラウザのデータ消去、タブ/アプリの削除では回避できる。**意図的な回避を防ぐ仕組みではなく、錯乱時の誤操作を減らす歯止め**である
- ロック中に実際の摂取を記録できないと、予想濃度と警告が実態からずれる。上記の追加許可設定と早期解除で対応する

**テスト**: ロック中に変更系を拒否する/許可リストは通る/期限で解除/待機中に取り消せる/待機完了前は解除できない。

## 7. 実装順序
| 段階 | 内容 | 完了条件 |
|---|---|---|
| M0 | `pk.js` とテスト(カフェイン線形、アルコール0次、コデイン→モルヒネの代謝物) | テスト通過 |
| M1 | 最小UI(記録・現在値・曲線・1秒更新)、`localStorage` 平文で先に動かす | PC・スマホで動作 |
| M2 | `interactions.js`、累積量、警告バナー | ルールのテスト通過 |
| M3 | 暗号化ロック、操作ロックモード、PWA化(オフライン) | オフラインで起動、ロックのテスト通過 |
| M4 | **データ収録**(物質ごとに出典確認→`verified`)。最大の作業量 | 第1段階の物質が `verified` |

M4はM1以降と並行して進め、`verified` が揃った物質から順にUIへ出る。

## 8. 未決事項
- 不確実性の帯の幅の根拠(文献の個人間変動 vs 一律)
- 相互作用の重大度の割り当てレビュー(薬剤師等の確認)
- 中毒情報センター等の連絡先の最新確認
- 大麻・覚醒剤・MDMA・ケタミンの収録可否(第2段階)
