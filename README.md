# Markdown to WordPress Post (Cursor / VS Code Extension)

Markdown を解釈し、ローカル参照のメディアを WordPress にアップロードしたうえで Post / Page として投稿する拡張です。

## 実装済み要件

- 処理対象は Markdown ファイルのみ（`.md`, `.markdown`）
- Markdown 内のローカルメディア参照を検出して WordPress にアップロードし、URL を置換して投稿
- 同一スラッグの Post / Page が既にある場合は新規作成せず更新（上書き）
- リスト中の単改行は同一リスト項目内の改行として扱い、Page 投稿もサポート
- `:` + インデント記法の定義リスト方言をサポート

## 事前準備

1. WordPress 側で Application Password を発行
2. Cursor / VS Code のワークスペース設定（`.code-workspace` など）で以下を指定
    - `mdToWp.siteUrl`
    - `mdToWp.username`
    - `mdToWp.applicationPassword`
    - `mdToWp.defaultStatus`（任意）
    - `mdToWp.postApiPath`（任意）
    - `mdToWp.pageApiPath`（任意）

例:

```json
{
  "settings": {
    "mdToWp.siteUrl": "https://example.com",
    "mdToWp.username": "your-user",
    "mdToWp.applicationPassword": "xxxx xxxx xxxx xxxx xxxx xxxx",
    "mdToWp.defaultStatus": "draft",
    "mdToWp.postApiPath": "/wp-json/wp/v2/posts",
    "mdToWp.pageApiPath": "/wp-json/wp/v2/pages"
  }
}
```

## 使い方

1. 投稿したい Markdown ファイルを開く
2. Command Palette から `Publish Current Markdown to WordPress` を実行

## Front Matter（任意）

```yaml
---
type: post
language: "ja"
title: "サンプル記事"
date: "2026-03-20T14:30:00+09:00"
categories: [ "ガジェット紹介" , "その他機械系" ]
slug: "BenQ-Halo2"
tags: [ "BenQ" , "Gadget" , "Review" ]
hashtag: "#BenQ #ScreenBar #Halo2 #Gadget #ガジェット #レビュー"
focus_keyphrase: "BenQ Screen Bar Halo 2 レビュー"
meta_description: "BenQのモニターライトHalo2は値段に見合った満足を与えてくれる名品です。"
status: publish
---
```

- `type` は `post` または `page`。未指定時は `post`
- `title` 未指定時は最初の `# 見出し` から推定
- `slug` 未指定時はファイル名ベースで生成
- `parent_slug` は `page` 投稿時のみ有効。親ページの slug を指定
- `status` 未指定時は `mdToWp.defaultStatus` を使用
- `date` は WordPress 投稿日時として送信
- `language` は `meta.language`、`meta_description` は `meta.fit_seo_description-single` および  `_yoast_wpseo_metadesc` として送信
- `categories` は `post` 投稿時のみ有効。カテゴリスラッグ配列で指定（投稿時にIDへ解決）
- `hashtag` は `post` / `page` のどちらでも利用可能。本文先頭にそのまま挿入
- `hashtag` は WordPress タグへは同期せず、本文用の生文字列として扱う
- `focus_keyphrase` は `_yoast_wpseo_focuskw` として送信

### REST API でメタが保存されないとき（YOAST / GOLDBLOG）

WordPress の REST API は、**`register_post_meta` で `show_in_rest` が有効なキーだけ** `meta` として保存されます。送っても Yoast や GOLDBLOG の画面に反映されない場合は、次を子テーマの `functions.php` などに追加してください（`post` と `page` の両方）。

- **YOAST:** `_yoast_wpseo_focuskw`（フォーカスキーフレーズ）、`_yoast_wpseo_metadesc`（メタディスクリプション）
- **FIT テーマ GOLDBLOG / GOLDMEDIA:** `fit_seo_description-single`（記事のメタディスクリプション。拡張の `meta_description` はここにも送ります）

```php
add_action('rest_api_init', function () {
  foreach (['post', 'page'] as $post_type) {
    register_post_meta($post_type, '_yoast_wpseo_focuskw', [
      'single'        => true,
      'type'          => 'string',
      'show_in_rest'  => true,
      'auth_callback' => function () {
        return current_user_can('edit_posts');
      },
    ]);
    register_post_meta($post_type, '_yoast_wpseo_metadesc', [
      'single'        => true,
      'type'          => 'string',
      'show_in_rest'  => true,
      'auth_callback' => function () {
        return current_user_can('edit_posts');
      },
    ]);
    register_post_meta($post_type, 'fit_seo_description-single', [
      'single'        => true,
      'type'          => 'string',
      'show_in_rest'  => true,
      'auth_callback' => function () {
        return current_user_can('edit_posts');
      },
    ]);
  }
});
```

同一キーがテーマ・他プラグインですでに登録されている場合は二重登録を避けてください。

Page 投稿例:

```yaml
---
type: page
title: "page-title"
slug: "product-name"
parent_slug: "product"
date: "2026-03-21T21:00:00+09:00"
status: publish
---
```

## 注釈（Footnote）

以下の形式で書くと、本文の番号から文末注釈へジャンプできます。

```md
注釈をつける→[^1]

[^1]: 注釈の本体
```

## 定義リスト（拡張 Markdown）

以下のように、用語行の次に `:` のあとへタブまたは空白を入れた行を書くと定義リストとして扱います。
空行が来るまでの各行は、1行ごとに独立した `<dd>` になります。

```md
用語
: 説明1
  説明2
  説明3
```

出力イメージ:

```html
<dl>
  <dt>用語</dt>
  <dd>説明1</dd>
  <dd>説明2</dd>
  <dd>説明3</dd>
</dl>
```

## メディア参照の扱い

- 対応: Markdown リンク/画像のローカルパス、`<img src="...">`
- 非対応ローカル参照（メディア拡張子以外）はエラー
- `http(s)://` / `data:` / `#` 参照はそのまま維持