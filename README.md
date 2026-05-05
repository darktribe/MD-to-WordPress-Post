# Markdown to WordPress Post (Cursor / VS Code Extension)

Markdown ファイルを WordPress の Post / Page として投稿する拡張です。ローカル参照のメディアは投稿前に WordPress へアップロードし、本文中の URL へ置き換えます。

## できること

- `.md` / `.markdown` ファイルを投稿対象にする
- Markdown 内のローカルメディア参照を WordPress にアップロードして URL を差し替える
- 同一スラッグの Post / Page があれば新規作成せず更新する
- Post だけでなく Page 投稿にも対応する
- Front Matter でスラッグ、公開状態、カテゴリ、タグ、メタ情報を指定できる
- Post の publish 成功後に Webhook を呼び、X 連携用 payload を送れる

## Markdown の解釈方針

Markdown の HTML 変換には `marked` を使っています。基本的な解釈は `marked` の挙動に従います。

特にリストは、空行があるだけでは別リストに分割されません。同じ種類のリスト項目が続いていれば、`marked` / CommonMark 系の解釈どおり 1 つのリストとして扱われます。

## 独自の仕様

この拡張は、標準的な Markdown 解釈に加えて、次の独自仕様を持っています。

- リスト項目中の単改行は、同一リスト項目内の改行として扱います
- リスト項目中の改行直後にある先頭空白は、見た目でも分かるように保持します
- Footnote 記法 `[^1]` をサポートします
- `:` + インデント記法の定義リストをサポートします
- Front Matter の各キーで WordPress 投稿用のメタ情報を指定できます

互換性を重視する用途では、これらの記法が他の Markdown 実装でも同じ意味になるとは限らない点に注意してください。

たとえば、リスト項目の途中で改行し、次の行を空白で字下げして書いた場合、この拡張では改行も字下げも表示上維持します。

## 事前準備

1. WordPress 側で Application Password を発行します。
2. Cursor / VS Code のワークスペース設定（`.code-workspace` など）に以下を設定します。

- `mdToWp.siteUrl`
- `mdToWp.username`
- `mdToWp.applicationPassword`
- `mdToWp.defaultStatus`（任意）
- `mdToWp.postApiPath`（任意）
- `mdToWp.pageApiPath`（任意）
- `mdToWp.webhookUrl`（任意）
- `mdToWp.xPostPrefix`（任意）
- `mdToWp.xPostPostfix`（任意）
- `mdToWp.useXPro`（任意、既定値 `false`）
- `mdToWp.postOnRepublish`（任意、既定値 `true`）

設定例:

```json
{
  "settings": {
    "mdToWp.siteUrl": "https://example.com",
    "mdToWp.username": "your-user",
    "mdToWp.applicationPassword": "xxxx xxxx xxxx xxxx xxxx xxxx",
    "mdToWp.defaultStatus": "draft",
    "mdToWp.postApiPath": "/wp-json/wp/v2/posts",
    "mdToWp.pageApiPath": "/wp-json/wp/v2/pages",
    "mdToWp.webhookUrl": "https://hook.showya-kiss.com/post-published",
    "mdToWp.xPostPrefix": "【新着記事】",
    "mdToWp.xPostPostfix": "ぜひチェックしてください。",
    "mdToWp.useXPro": false,
    "mdToWp.postOnRepublish": true
  }
}
```

`mdToWp.webhookSecret` は `X-Webhook-Secret` ヘッダで送る秘密値です。共有される `.code-workspace` ではなく、User Settings に設定してください。

## 使い方

1. 投稿したい Markdown ファイルを開きます。
2. Command Palette から `Publish Current Markdown to WordPress` を実行します。

## Front Matter

Front Matter のキーは、この拡張の投稿処理用に追加している独自項目です。

```yaml
---
type: post
language: "ja"
title: "サンプル記事"
date: "2026-03-20T14:30:00+09:00"
categories: ["ガジェット紹介", "その他機械系"]
slug: "BenQ-Halo2"
tags: ["BenQ", "Gadget", "Review"]
hashtag: "#BenQ #ScreenBar #Halo2 #Gadget #ガジェット #レビュー"
focus_keyphrase: "BenQ Screen Bar Halo 2 レビュー"
meta_description: "BenQのモニターライトHalo2は値段に見合った満足を与えてくれる名品です。"
status: publish
---
```

- `type` は `post` または `page` です。未指定時は `post` です
- `title` 未指定時は最初の `# 見出し` から推定します
- `slug` 未指定時はファイル名ベースで生成します
- `parent_slug` は `page` 投稿時のみ有効です。親ページの slug を指定します
- `status` 未指定時は `mdToWp.defaultStatus` を使います
- `date` は WordPress の投稿日時として送信します
- `language` は `meta.language` として送信します
- `meta_description` は `meta.fit_seo_description-single` と `_yoast_wpseo_metadesc` として送信します
- `categories` は `post` 投稿時のみ有効です。カテゴリ名または slug の配列で指定できます
- `tags` は `post` 投稿時のみ有効です。タグ名または slug の配列で指定できます
- `hashtag` は `post` / `page` のどちらでも利用でき、本文先頭にそのまま挿入します
- `hashtag` は WordPress タグへは同期せず、本文用の生文字列として扱います
- `focus_keyphrase` は `_yoast_wpseo_focuskw` として送信します

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

### REST API でメタが保存されないとき

WordPress の REST API は、`register_post_meta` で `show_in_rest` が有効なキーだけを `meta` として保存できます。送っても Yoast や GOLDBLOG / GOLDMEDIA の画面に反映されない場合は、子テーマの `functions.php` などで対象キーを登録してください。

- YOAST: `_yoast_wpseo_focuskw`、`_yoast_wpseo_metadesc`
- FIT テーマ GOLDBLOG / GOLDMEDIA: `fit_seo_description-single`

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

同一キーがテーマや他プラグインですでに登録されている場合は、二重登録を避けてください。

## カテゴリ / タグの扱い

この拡張は、指定されたカテゴリやタグを最初に既存の WordPress term と照合します。照合は name 完全一致または slug 完全一致で行います。

未登録のカテゴリやタグがあった場合は、投稿前に warning を表示し、次のいずれかを選べます。

- `中止`
- `無視して投稿`
- `作成して投稿`

`無視して投稿` を選んだ場合、未登録の term はその投稿から除外されます。`作成して投稿` を選んだ場合は、表示名と slug を入力して作成してから投稿します。

## Webhook / X 連携

Webhook は次の条件をすべて満たしたときだけ送信します。

- `type: post`
- WordPress 投稿 API が成功している
- 最終 status が `publish`
- 公開 URL と投稿 ID が WordPress 応答から取得できている
- `mdToWp.webhookUrl` と `mdToWp.webhookSecret` が両方設定されている

Webhook 送信先には JSON を `POST` し、認証は `X-Webhook-Secret` ヘッダで行います。secret は JSON 本文に含めません。

X 投稿文は VSIX 側で生成します。並び順は次のとおりです。

- `mdToWp.xPostPrefix`
- 記事タイトル
- 公開 URL
- front matter の `hashtag`
- `mdToWp.xPostPostfix`

空文字の要素は除外し、残った要素を改行で連結します。

文字数制限を超える場合は、次の順で削ります。

1. `xPostPostfix`
2. `hashtag`
3. `title`

それでも収まらない場合、WordPress 投稿は成功のままにして Webhook は送らず warning を表示します。

`mdToWp.useXPro` が `false` のときは 280 文字、`true` のときは 25000 文字として扱います。

`mdToWp.postOnRepublish` が `true` のときは、すでに publish 済みの記事でも、投稿日が変わった再 publish で再度 Webhook を送ります。

## 独自記法

### Footnote

以下の形式で書くと、本文中の番号から文末注釈へジャンプできます。これは標準 Markdown ではなく、この拡張のサポート対象です。

```md
注釈をつける→[^1]

[^1]: 注釈の本体
```

### 定義リスト

以下のように、用語行の次に `:` のあとへタブまたは空白を入れた行を書くと定義リストとして扱います。空行が来るまでの各行は、1 行ごとに独立した `<dd>` になります。これも標準 Markdown ではなく、この拡張の独自サポートです。

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

- Markdown リンク / 画像のローカルパス、`<img src="...">` を扱います
- メディア拡張子以外のローカル参照はエラーにします
- `http(s)://`、`data:`、`#` 参照はそのまま維持します
