import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import matter from "gray-matter";
import { marked } from "marked";

type FrontMatter = {
  type?: "post" | "page";
  slug?: string;
  parent_slug?: string;
  title?: string;
  status?: "draft" | "publish" | "private" | "pending";
  date?: string;
  language?: string;
  categories?: string[] | string;
  /** @deprecated use `categories` */
  category?: string[] | string;
  tags?: string[] | string;
  /** @deprecated use `tags` */
  tag?: string[] | string;
  meta_description?: string;
  hashtag?: string;
  focus_keyphrase?: string;
};

type PublishConfig = {
  siteUrl: string;
  username: string;
  applicationPassword: string;
  defaultStatus: "draft" | "publish" | "private" | "pending";
  postApiPath: string;
  pageApiPath: string;
  webhookUrl: string;
  webhookSecret: string;
  xPostPrefix: string;
  xPostPostfix: string;
  useXPro: boolean;
  postOnRepublish: boolean;
};

type ContentType = "post" | "page";

type PublishTarget = {
  type: ContentType;
  label: "Post" | "Page";
  apiUrl: string;
  supportsTaxonomies: boolean;
  configKey: "postApiPath" | "pageApiPath";
};

type UploadedMedia = {
  source_url: string;
};

type WordPressCategory = {
  id: number;
  name: string;
  slug: string;
};

type WordPressTag = {
  id: number;
  name: string;
  slug: string;
};

type WordPressTerm = WordPressCategory | WordPressTag;

type WordPressContentSummary = {
  id: number;
  type?: string;
  status?: string;
  date?: string;
  link?: string;
};

type PublishResult = {
  id: number | undefined;
  link: string | undefined;
  resolvedUrl: string;
  type?: string;
  status?: string;
  date?: string;
  meta?: Record<string, unknown>;
};

type PostPublishedWebhookPayload = {
  site: string;
  post_id: number;
  title: string;
  url: string;
  tweet: string;
  dedupe_key: string;
  hashtags?: string;
  meta_description?: string;
  published_at?: string;
};

type WebhookAttemptResult =
  | { kind: "not_applicable" }
  | { kind: "skipped"; reason: string }
  | { kind: "sent" }
  | { kind: "failed"; reason: string };

type ResolvedTaxonomyItem =
  | { input: string; id: number; missing: false }
  | { input: string; missing: true };

class UserCancelledError extends Error {
  constructor(message = "Publish cancelled.") {
    super(message);
    this.name = "UserCancelledError";
  }
}

const MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".mp4",
  ".mov",
  ".webm",
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".pdf",
  ".zip"
]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

const YOAST_FOCUS_META_KEY = "_yoast_wpseo_focuskw";
const YOAST_METADESC_META_KEY = "_yoast_wpseo_metadesc";
/** FIT テーマ GOLDBLOG / GOLDMEDIA の記事メタディスクリプション */
const GOLDBLOG_METADESC_META_KEY = "fit_seo_description-single";

/** `status=any` は権限によって REST で拒否されるため、許可されやすい単一ステータスを順に試す */
const CONTENT_LOOKUP_STATUSES = ["publish", "draft", "private", "pending", "future"] as const;
const LOOKUP_RETRY_DELAYS_MS = [300, 1000] as const;
const LOOKUP_RETRY_STATUS_CODES = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504]);

/**
 * テーマの目次などが ol + CSS カウンターを使っていると、本文の番号付きリストが連番で続くことがある。
 * 加えて、テーマ側で list-style-position: inside; が指定されていると loose list の番号が
 * 改行されたように見えるため、本文用の余白と outside 指定もここで補う。
 * marked の list レンダラーを差し替えると内部実装と不整合で落ちることがあるため、パース後に ol だけ置換する。
 */
function annotateOrderedListsHtml(html: string): string {
  const inlineStyle = "contain: style; list-style-position: outside; padding-inline-start: 1.5em; padding-left: 1.5em;";
  return html.replace(/<ol(\s+start="(\d+)")?>/g, (_, __, startNum: string | undefined) => {
    const n = startNum ?? "1";
    return `<ol class="mdtowp-ol" start="${n}" style="${inlineStyle}">`;
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand("mdToWp.publishCurrentFile", async () => {
    try {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("Open a Markdown file first.");
        return;
      }

      const doc = editor.document;
      const ext = path.extname(doc.uri.fsPath).toLowerCase();
      if (!MARKDOWN_EXTENSIONS.has(ext)) {
        vscode.window.showErrorMessage("Only Markdown files are supported.");
        return;
      }

      const config = loadConfig();
      validateConfig(config);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Publishing to WordPress",
          cancellable: false
        },
        async progress => {
          progress.report({ message: "Parsing Markdown..." });
          const rawMarkdown = doc.getText();
          const parsed = matter(rawMarkdown);
          const frontMatter = parsed.data as FrontMatter;
          const rawFm = parsed.data as Record<string, unknown>;
          const contentType = normalizeContentType(frontMatter.type);
          const publishTarget = resolvePublishTarget(contentType, config);
          warnIgnoredFieldsForTarget(frontMatter, rawFm, publishTarget);

          progress.report({ message: "Uploading local media files..." });
          const replacedMarkdown = await replaceLocalMediaLinks(
            parsed.content,
            path.dirname(doc.uri.fsPath),
            config
          );

          const hashtag = normalizeFrontMatterString(frontMatter.hashtag);
          const markdownWithHashtag = hashtag ? `${hashtag}\n\n${replacedMarkdown}` : replacedMarkdown;

          progress.report({ message: "Converting Markdown to HTML..." });
          const markdownWithDefinitionLists = await applyDefinitionLists(markdownWithHashtag);
          const normalizedMarkdown = normalizeListContinuationHardBreaks(markdownWithDefinitionLists);
          const markdownWithFootnotes = applyFootnotes(normalizedMarkdown);
          const rawHtml = await marked.parse(markdownWithFootnotes);
          const contentHtml = annotateOrderedListsHtml(rawHtml);

          const slug =
            normalizeOptionalSlugField(frontMatter.slug, "slug") ??
            normalizeSlug(path.parse(doc.uri.fsPath).name);
          if (!slug) {
            throw new Error("Could not determine a valid slug.");
          }

          const title =
            normalizeFrontMatterString(frontMatter.title) || inferTitle(parsed.content, slug);
          const status = frontMatter.status ?? config.defaultStatus;
          const publishDate = normalizePublishDate(frontMatter.date);
          const language = normalizeFrontMatterString(frontMatter.language);
          const metaDescription = normalizeFrontMatterString(frontMatter.meta_description);
          const focusKeyphrase = normalizeFrontMatterString(frontMatter.focus_keyphrase);
          const parentSlug = normalizeOptionalSlugField(frontMatter.parent_slug, "parent_slug");
          const categoriesMerged = mergeListFields(rawFm.categories, rawFm.category);
          const tagsMerged = mergeListFields(rawFm.tags, rawFm.tag);
          const categoryTerms = publishTarget.supportsTaxonomies
            ? normalizeTaxonomyTerms(categoriesMerged)
            : [];
          const tagTerms = publishTarget.supportsTaxonomies ? normalizeTaxonomyTerms(tagsMerged) : [];
          progress.report({ message: "Resolving categories and tags..." });
          const taxonomySelection = publishTarget.supportsTaxonomies
            ? await resolveTaxonomySelection(categoryTerms, tagTerms, config)
            : { categoryIds: [], tagIds: [] };
          const parentId =
            publishTarget.type === "page" ? await findPageParentIdBySlug(parentSlug, config) : undefined;
          const existingContent = await findContentBySlug(slug, publishTarget, config);
          const contentId = existingContent?.id ?? null;

          progress.report({
            message: contentId
              ? `Updating existing ${publishTarget.label.toLowerCase()}...`
              : `Creating new ${publishTarget.label.toLowerCase()}...`
          });
          const publishResult = await upsertContent(
            {
              id: contentId,
              slug,
              title,
              status,
              content: contentHtml,
              date: publishDate,
              language,
              metaDescription,
              focusKeyphrase,
              parentId,
              categories: taxonomySelection.categoryIds,
              tags: taxonomySelection.tagIds
            },
            publishTarget,
            config
          );

          progress.report({ message: "Finalizing publish..." });
          const webhookResult = await maybeSendPostPublishedWebhook(
            {
              publishTarget,
              existingContent,
              publishResult,
              title,
              hashtag,
              metaDescription
            },
            config
          );

          await showPublishCompletionMessage(publishTarget, publishResult.resolvedUrl, webhookResult);
        }
      );
    } catch (error) {
      if (error instanceof UserCancelledError) {
        vscode.window.showInformationMessage(error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Publish failed: ${message}`);
    }
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {}

function loadConfig(): PublishConfig {
  const cfg = vscode.workspace.getConfiguration("mdToWp");
  const legacyCfg = vscode.workspace.getConfiguration("wordpress-post");
  return {
    siteUrl: firstConfiguredString(
      cfg.get("siteUrl"),
      cfg.get("apiUrl"),
      legacyCfg.get("apiUrl")
    ),
    username: firstConfiguredString(cfg.get("username"), legacyCfg.get("username")),
    applicationPassword: firstConfiguredString(
      cfg.get("applicationPassword"),
      cfg.get("password"),
      legacyCfg.get("password")
    ),
    defaultStatus: cfg.get("defaultStatus", "draft"),
    postApiPath: String(cfg.get("postApiPath", "/wp-json/wp/v2/posts")).trim(),
    pageApiPath: String(cfg.get("pageApiPath", "/wp-json/wp/v2/pages")).trim(),
    webhookUrl: firstConfiguredString(cfg.get("webhookUrl")),
    webhookSecret: firstConfiguredString(cfg.get("webhookSecret")),
    xPostPrefix: firstConfiguredString(cfg.get("xPostPrefix")),
    xPostPostfix: firstConfiguredString(cfg.get("xPostPostfix")),
    useXPro: cfg.get("useXPro", false),
    postOnRepublish: cfg.get("postOnRepublish", true)
  };
}

function validateConfig(config: PublishConfig): void {
  const missingKeys: string[] = [];
  if (!config.siteUrl) {
    missingKeys.push("mdToWp.siteUrl");
  }
  if (!config.username) {
    missingKeys.push("mdToWp.username");
  }
  if (!config.applicationPassword) {
    missingKeys.push("mdToWp.applicationPassword");
  }
  if (missingKeys.length > 0) {
    throw new Error(
      `Missing setting(s): ${missingKeys.join(", ")}. If you are using a .code-workspace file, put them under the "settings" object and open the .code-workspace itself.`
    );
  }
  if (!config.postApiPath || !config.pageApiPath) {
    throw new Error("Configure mdToWp.postApiPath and mdToWp.pageApiPath.");
  }
}

async function replaceLocalMediaLinks(
  markdown: string,
  markdownDir: string,
  config: PublishConfig
): Promise<string> {
  const cache = new Map<string, string>();
  let output = markdown;

  const markdownUrlPattern = /(!?\[[^\]]*?\]\()([^)]+)(\))/g;
  const markdownMatches = Array.from(output.matchAll(markdownUrlPattern));
  for (const match of markdownMatches) {
    const originalUrl = match[2].trim();
    if (shouldIgnoreUrl(originalUrl)) {
      continue;
    }

    const mediaUrl = await resolveAndUploadMedia(originalUrl, markdownDir, config, cache);
    output = replaceExactUrl(output, originalUrl, mediaUrl);
  }

  const htmlSrcPattern = /(src=["'])([^"']+)(["'])/g;
  const htmlMatches = Array.from(output.matchAll(htmlSrcPattern));
  for (const match of htmlMatches) {
    const originalUrl = match[2].trim();
    if (shouldIgnoreUrl(originalUrl)) {
      continue;
    }

    const mediaUrl = await resolveAndUploadMedia(originalUrl, markdownDir, config, cache);
    output = replaceExactUrl(output, originalUrl, mediaUrl);
  }

  return output;
}

async function resolveAndUploadMedia(
  rawUrl: string,
  markdownDir: string,
  config: PublishConfig,
  cache: Map<string, string>
): Promise<string> {
  const localPath = resolvePathFromMarkdown(rawUrl, markdownDir);
  const ext = path.extname(localPath).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(ext)) {
    throw new Error(`Only media files are allowed as local references. Unsupported: ${rawUrl}`);
  }

  if (cache.has(localPath)) {
    return cache.get(localPath)!;
  }

  const sourceUrl = await uploadMedia(localPath, config);
  cache.set(localPath, sourceUrl);
  return sourceUrl;
}

function resolvePathFromMarkdown(rawUrl: string, markdownDir: string): string {
  const cleanUrl = rawUrl.split("#")[0].split("?")[0];
  const resolved = path.resolve(markdownDir, cleanUrl);
  return resolved;
}

function shouldIgnoreUrl(url: string): boolean {
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("data:") ||
    url.startsWith("#")
  );
}

function replaceExactUrl(markdown: string, from: string, to: string): string {
  return markdown.split(from).join(to);
}

async function uploadMedia(localPath: string, config: PublishConfig): Promise<string> {
  const fileName = path.basename(localPath);
  const fileBuffer = await fs.readFile(localPath);
  const contentType = detectContentType(fileName);

  const response = await fetch(`${stripTrailingSlash(config.siteUrl)}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(config.username, config.applicationPassword),
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`
    },
    body: fileBuffer
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Media upload failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as UploadedMedia;
  if (!data.source_url) {
    throw new Error(`Media upload succeeded but source_url is missing: ${fileName}`);
  }

  return data.source_url;
}

function detectContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".avif":
      return "image/avif";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".ogg":
      return "audio/ogg";
    case ".pdf":
      return "application/pdf";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function normalizeContentType(value: unknown): ContentType {
  if (typeof value !== "string" || value.trim() === "") {
    return "post";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "post" || normalized === "page") {
    return normalized;
  }

  throw new Error(`Invalid front matter type: ${value}`);
}

function resolvePublishTarget(type: ContentType, config: PublishConfig): PublishTarget {
  if (type === "page") {
    return {
      type,
      label: "Page",
      apiUrl: resolveApiUrl(config.siteUrl, config.pageApiPath),
      supportsTaxonomies: false,
      configKey: "pageApiPath"
    };
  }

  return {
    type,
    label: "Post",
    apiUrl: resolveApiUrl(config.siteUrl, config.postApiPath),
    supportsTaxonomies: true,
    configKey: "postApiPath"
  };
}

function warnIgnoredFieldsForTarget(
  frontMatter: FrontMatter,
  rawFm: Record<string, unknown>,
  target: PublishTarget
): void {
  const ignoredFields: string[] = [];
  const categoriesMerged = mergeListFields(rawFm.categories, rawFm.category);
  const tagsMerged = mergeListFields(rawFm.tags, rawFm.tag);
  if (!target.supportsTaxonomies && normalizeTaxonomyTerms(categoriesMerged).length > 0) {
    ignoredFields.push("categories");
  }
  if (!target.supportsTaxonomies && normalizeTaxonomyTerms(tagsMerged).length > 0) {
    ignoredFields.push("tags");
  }
  if (target.type === "post" && normalizeFrontMatterString(frontMatter.parent_slug)) {
    ignoredFields.push("parent_slug");
  }

  if (ignoredFields.length > 0) {
    vscode.window.showWarningMessage(
      `${target.label} publish ignores unsupported field(s): ${ignoredFields.join(", ")}`
    );
  }
}

function resolveApiUrl(siteUrl: string, apiPath: string): string {
  const trimmed = apiPath.trim();
  if (!trimmed) {
    throw new Error("API path must not be empty.");
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return stripTrailingSlash(trimmed);
  }

  return `${stripTrailingSlash(siteUrl)}/${trimmed.replace(/^\/+/, "")}`;
}

function isForbiddenStatusQueryError(status: number, body: string): boolean {
  if (status !== 400) {
    return false;
  }
  try {
    const parsed = JSON.parse(body) as {
      code?: string;
      data?: { params?: { status?: string } };
    };
    return (
      parsed.code === "rest_invalid_param" && parsed.data?.params?.status !== undefined
    );
  } catch {
    return false;
  }
}

async function findContentBySlug(
  slug: string,
  target: PublishTarget,
  config: PublishConfig
): Promise<WordPressContentSummary | null> {
  for (const postStatus of CONTENT_LOOKUP_STATUSES) {
    const url = `${target.apiUrl}?slug=${encodeURIComponent(slug)}&status=${encodeURIComponent(postStatus)}&per_page=1&_fields=id,type,status,date,link`;
    const response = await fetchLookupWithRetry(url, config);
    const text = await response.text();
    if (!response.ok) {
      if (isForbiddenStatusQueryError(response.status, text)) {
        continue;
      }
      throw new Error(`${target.label} lookup failed (${response.status}): ${text}`);
    }

    const data = JSON.parse(text) as WordPressContentSummary[];
    if (data.length > 0) {
      assertResponseTypeMatchesTarget(data[0].type, target);
      return data[0];
    }
  }

  return null;
}

async function findPageParentIdBySlug(
  parentSlug: string | undefined,
  config: PublishConfig
): Promise<number | undefined> {
  if (!parentSlug) {
    return undefined;
  }

  const pageTarget = resolvePublishTarget("page", config);

  for (const pageStatus of CONTENT_LOOKUP_STATUSES) {
    const url = `${pageTarget.apiUrl}?slug=${encodeURIComponent(parentSlug)}&status=${encodeURIComponent(pageStatus)}&per_page=100&_fields=id,slug`;
    const response = await fetchLookupWithRetry(url, config);
    const text = await response.text();
    if (!response.ok) {
      if (isForbiddenStatusQueryError(response.status, text)) {
        continue;
      }
      throw new Error(`Parent page lookup failed (${response.status}): ${text}`);
    }

    const pages = JSON.parse(text) as Array<{ id: number; slug: string }>;
    if (pages.length === 0) {
      continue;
    }
    if (pages.length > 1) {
      throw new Error(`Ambiguous parent_slug page: ${parentSlug}`);
    }

    return pages[0].id;
  }

  throw new Error(`Unknown parent_slug page: ${parentSlug}`);
}

async function upsertContent(
  input: {
    id: number | null;
    slug: string;
    title: string;
    status: string;
    content: string;
    date: string | undefined;
    language: string | undefined;
    metaDescription: string | undefined;
    focusKeyphrase: string | undefined;
    parentId: number | undefined;
    categories: number[];
    tags: number[];
  },
  target: PublishTarget,
  config: PublishConfig
): Promise<PublishResult> {
  const endpoint = input.id ? `${target.apiUrl}/${input.id}` : target.apiUrl;

  const payload: Record<string, unknown> = {
    title: input.title,
    slug: input.slug,
    content: input.content,
    status: input.status
  };
  if (input.date) {
    payload.date = input.date;
  }
  if (input.metaDescription) {
    payload.excerpt = input.metaDescription;
  }
  if (typeof input.parentId === "number") {
    payload.parent = input.parentId;
  }
  const meta: Record<string, string> = {};
  if (input.language) {
    meta.language = input.language;
  }
  if (input.metaDescription) {
    meta[GOLDBLOG_METADESC_META_KEY] = input.metaDescription;
    meta[YOAST_METADESC_META_KEY] = input.metaDescription;
  }
  if (input.focusKeyphrase) {
    meta[YOAST_FOCUS_META_KEY] = input.focusKeyphrase;
  }
  if (Object.keys(meta).length > 0) {
    payload.meta = meta;
  }
  if (input.categories.length > 0) {
    payload.categories = input.categories;
  }
  if (input.tags.length > 0) {
    payload.tags = input.tags;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: basicAuth(config.username, config.applicationPassword),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(formatWpRestFailure(`${target.label} publish`, response.status, text));
  }

  const data = (await response.json()) as {
    id?: number;
    link?: string;
    type?: string;
    status?: string;
    date?: string;
    meta?: Record<string, unknown>;
  };
  assertResponseTypeMatchesTarget(data.type, target);
  await warnIfSeoRelatedMetaRejectedByRestApi(input, data, target, config);
  return {
    id: data.id,
    link: data.link,
    resolvedUrl: data.link ?? `${stripTrailingSlash(config.siteUrl)}/${input.slug}`,
    type: data.type,
    status: data.status,
    date: data.date,
    meta: data.meta
  };
}

function restMetaValueEquals(saved: unknown, expected: string): boolean {
  if (saved === undefined || saved === null) {
    return false;
  }
  if (typeof saved === "string") {
    return saved.trim() === expected.trim();
  }
  return String(saved).trim() === expected.trim();
}

async function fetchPostMetaInEditContext(
  id: number,
  target: PublishTarget,
  config: PublishConfig
): Promise<Record<string, unknown> | undefined> {
  const url = `${target.apiUrl}/${id}?context=edit&_fields=meta`;
  const response = await fetchLookupWithRetry(url, config);
  if (!response.ok) {
    return undefined;
  }
  const payload = (await response.json()) as { meta?: Record<string, unknown> };
  return payload.meta;
}

async function warnIfSeoRelatedMetaRejectedByRestApi(
  input: {
    focusKeyphrase: string | undefined;
    metaDescription: string | undefined;
  },
  data: { id?: number; meta?: Record<string, unknown> },
  target: PublishTarget,
  config: PublishConfig
): Promise<void> {
  const needFocus = Boolean(input.focusKeyphrase);
  const needDesc = Boolean(input.metaDescription);
  if (!needFocus && !needDesc) {
    return;
  }

  let meta = data.meta;
  const focusOk =
    !needFocus || restMetaValueEquals(meta?.[YOAST_FOCUS_META_KEY], input.focusKeyphrase!);
  const yoastDescOk =
    !needDesc || restMetaValueEquals(meta?.[YOAST_METADESC_META_KEY], input.metaDescription!);
  const goldblogDescOk =
    !needDesc || restMetaValueEquals(meta?.[GOLDBLOG_METADESC_META_KEY], input.metaDescription!);
  const descOk = yoastDescOk && goldblogDescOk;

  if (typeof data.id === "number" && (!focusOk || !descOk)) {
    const refetched = await fetchPostMetaInEditContext(data.id, target, config);
    if (refetched) {
      meta = refetched;
    }
  }

  if (needFocus && !restMetaValueEquals(meta?.[YOAST_FOCUS_META_KEY], input.focusKeyphrase!)) {
    vscode.window.showWarningMessage(
      "YOAST のフォーカスキーフレーズが REST で保存されていない可能性があります。WordPress で _yoast_wpseo_focuskw を register_post_meta（show_in_rest => true）してください。README の「REST API でメタが保存されないとき」を参照。"
    );
  }
  if (needDesc && !restMetaValueEquals(meta?.[YOAST_METADESC_META_KEY], input.metaDescription!)) {
    vscode.window.showWarningMessage(
      "YOAST 用メタディスクリプション（_yoast_wpseo_metadesc）が REST で保存されていない可能性があります。README の「REST API でメタが保存されないとき」の PHP を追加してください。"
    );
  }
  if (needDesc && !restMetaValueEquals(meta?.[GOLDBLOG_METADESC_META_KEY], input.metaDescription!)) {
    vscode.window.showWarningMessage(
      "GOLDBLOG / GOLDMEDIA 用メタ（fit_seo_description-single）が REST で保存されていない可能性があります。README の「REST API でメタが保存されないとき」の PHP を追加してください。"
    );
  }
}

function formatWpRestFailure(context: string, status: number, body: string): string {
  let hint = "";
  try {
    const parsed = JSON.parse(body) as { code?: string };
    const code = parsed.code;
    if (code === "rest_cannot_create" || code === "rest_cannot_edit") {
      hint =
        " （対処: WordPress でこのユーザーに投稿の作成・編集権限があるロールか確認してください。投稿者（Author）以上のユーザーでアプリケーションパスワードを発行し、mdToWp.username にそのログイン名を指定してください。）";
    } else if (code === "rest_cannot_publish") {
      hint =
        " （対処: 公開（publish）には編集者以上など、該当ステータスを付与できる権限が必要な場合があります。front matter の status を draft にするか、ロールを上げてください。）";
    }
  } catch {
    /* body が JSON でない場合は本文のみ */
  }
  return `${context} failed (${status}): ${body}${hint}`;
}

function assertResponseTypeMatchesTarget(
  actualType: string | undefined,
  target: PublishTarget
): void {
  if (!actualType || actualType === target.type) {
    return;
  }

  throw new Error(
    `${target.label} publish reached a "${actualType}" endpoint. Check mdToWp.${target.configKey}.`
  );
}

function basicAuth(username: string, appPassword: string): string {
  const token = Buffer.from(`${username}:${appPassword}`).toString("base64");
  return `Basic ${token}`;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchLookupWithRetry(url: string, config: PublishConfig): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= LOOKUP_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: basicAuth(config.username, config.applicationPassword) }
      });

      if (
        response.ok ||
        !LOOKUP_RETRY_STATUS_CODES.has(response.status) ||
        attempt === LOOKUP_RETRY_DELAYS_MS.length
      ) {
        return response;
      }
    } catch (error) {
      lastError = error;
      if (attempt === LOOKUP_RETRY_DELAYS_MS.length) {
        throw error;
      }
    }

    await delay(LOOKUP_RETRY_DELAYS_MS[attempt]);
  }

  throw lastError instanceof Error ? lastError : new Error("Lookup request failed.");
}

function inferTitle(content: string, fallback: string): string {
  const headingMatch = content.match(/^\s*#\s+(.+)$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }
  return fallback;
}

function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function unwrapOuterQuotes(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeFrontMatterString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const unwrapped = unwrapOuterQuotes(value);
  const trimmed = unwrapped.trim();
  return trimmed ? trimmed : undefined;
}

function mergeListFields(primary: unknown, legacy: unknown): unknown {
  const a = coalesceToArray(primary);
  const b = coalesceToArray(legacy);
  if (a.length === 0) {
    return b.length > 0 ? b : undefined;
  }
  if (b.length === 0) {
    return a;
  }
  return [...a, ...b];
}

function coalesceToArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function firstConfiguredString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function normalizePublishDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  const date = normalizeFrontMatterString(value);
  if (!date) {
    return undefined;
  }
  const time = Date.parse(date);
  if (Number.isNaN(time)) {
    throw new Error(`Invalid front matter date: ${date}`);
  }
  return date;
}

function normalizeOptionalSlugField(value: unknown, fieldName: string): string | undefined {
  const raw = normalizeFrontMatterString(value);
  if (!raw) {
    return undefined;
  }

  const normalized = normalizeSlug(raw);
  if (!normalized) {
    throw new Error(`Invalid front matter ${fieldName}: ${raw}`);
  }

  return normalized;
}

function normalizeTaxonomyTerms(value: unknown): string[] {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];
  const terms = values
    .map(item => (typeof item === "string" ? unwrapOuterQuotes(item).trim() : ""))
    .filter(Boolean);

  return Array.from(new Set(terms));
}

async function resolveTaxonomySelection(
  categoryTerms: string[],
  tagTerms: string[],
  config: PublishConfig
): Promise<{ categoryIds: number[]; tagIds: number[] }> {
  const [categoryItems, tagItems] = await Promise.all([
    resolveExistingTerms("category", categoryTerms, config),
    resolveExistingTerms("tag", tagTerms, config)
  ]);

  const missingCategories = categoryItems.filter(item => item.missing).map(item => item.input);
  const missingTags = tagItems.filter(item => item.missing).map(item => item.input);

  if (missingCategories.length === 0 && missingTags.length === 0) {
    return {
      categoryIds: categoryItems.flatMap(item => (item.missing ? [] : [item.id])),
      tagIds: tagItems.flatMap(item => (item.missing ? [] : [item.id]))
    };
  }

  const choice = await promptForMissingTaxonomies(missingCategories, missingTags);
  if (choice === "cancel") {
    throw new UserCancelledError();
  }

  if (choice === "ignore") {
    return {
      categoryIds: categoryItems.flatMap(item => (item.missing ? [] : [item.id])),
      tagIds: tagItems.flatMap(item => (item.missing ? [] : [item.id]))
    };
  }

  return {
    categoryIds: await materializeTermIds("category", categoryItems, config),
    tagIds: await materializeTermIds("tag", tagItems, config)
  };
}

async function resolveExistingTerms(
  taxonomy: "category" | "tag",
  inputs: string[],
  config: PublishConfig
): Promise<ResolvedTaxonomyItem[]> {
  const results: ResolvedTaxonomyItem[] = [];
  for (const input of inputs) {
    const id = await findExistingTermId(taxonomy, input, config);
    if (id === null) {
      results.push({ input, missing: true });
      continue;
    }
    results.push({ input, id, missing: false });
  }
  return results;
}

async function findExistingTermId(
  taxonomy: "category" | "tag",
  input: string,
  config: PublishConfig
): Promise<number | null> {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const slugCandidate = normalizeSlug(trimmed);
  if (slugCandidate) {
    const bySlug = await fetchTermsBySlug(taxonomy, slugCandidate, config);
    const exactSlugMatches = bySlug.filter(term => termSlugEquals(term.slug, trimmed));
    if (exactSlugMatches.length > 1) {
      throw new Error(`Ambiguous ${taxonomy} slug: ${trimmed}`);
    }
    if (exactSlugMatches.length === 1) {
      return exactSlugMatches[0].id;
    }
  }

  const bySearch = await searchTerms(taxonomy, trimmed, config);
  const exactNameMatches = bySearch.filter(term => termNameEquals(term.name, trimmed));
  if (exactNameMatches.length > 1) {
    throw new Error(`Ambiguous ${taxonomy} name: ${trimmed}`);
  }
  if (exactNameMatches.length === 1) {
    return exactNameMatches[0].id;
  }

  const exactSlugMatches = bySearch.filter(term => termSlugEquals(term.slug, trimmed));
  if (exactSlugMatches.length > 1) {
    throw new Error(`Ambiguous ${taxonomy} slug: ${trimmed}`);
  }
  if (exactSlugMatches.length === 1) {
    return exactSlugMatches[0].id;
  }

  return null;
}

async function fetchTermsBySlug(
  taxonomy: "category" | "tag",
  slug: string,
  config: PublishConfig
): Promise<WordPressTerm[]> {
  const endpoint = taxonomy === "category" ? "categories" : "tags";
  const url = `${stripTrailingSlash(config.siteUrl)}/wp-json/wp/v2/${endpoint}?slug=${encodeURIComponent(slug)}&per_page=100&_fields=id,name,slug`;
  const response = await fetchLookupWithRetry(url, config);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${taxonomy === "category" ? "Category" : "Tag"} lookup failed (${response.status}): ${text}`);
  }
  return (await response.json()) as WordPressTerm[];
}

async function searchTerms(
  taxonomy: "category" | "tag",
  term: string,
  config: PublishConfig
): Promise<WordPressTerm[]> {
  const endpoint = taxonomy === "category" ? "categories" : "tags";
  const url = `${stripTrailingSlash(config.siteUrl)}/wp-json/wp/v2/${endpoint}?search=${encodeURIComponent(term)}&per_page=100&_fields=id,name,slug`;
  const response = await fetchLookupWithRetry(url, config);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${taxonomy === "category" ? "Category" : "Tag"} lookup failed (${response.status}): ${text}`);
  }
  return (await response.json()) as WordPressTerm[];
}

function termNameEquals(actual: string, expected: string): boolean {
  return actual.trim() === expected.trim();
}

function termSlugEquals(actual: string, expected: string): boolean {
  const trimmedExpected = expected.trim();
  if (actual.trim() === trimmedExpected) {
    return true;
  }
  const normalizedActual = normalizeSlug(actual);
  const normalizedExpected = normalizeSlug(trimmedExpected);
  return Boolean(normalizedActual) && normalizedActual === normalizedExpected;
}

async function promptForMissingTaxonomies(
  categories: string[],
  tags: string[]
): Promise<"cancel" | "ignore" | "create"> {
  const parts: string[] = [];
  if (categories.length > 0) {
    parts.push(`未登録カテゴリ: ${categories.join(", ")}`);
  }
  if (tags.length > 0) {
    parts.push(`未登録タグ: ${tags.join(", ")}`);
  }

  const selection = await vscode.window.showWarningMessage(
    `${parts.join("\n")}\n\n処理を選んでください。`,
    { modal: true },
    "中止",
    "無視して投稿",
    "作成して投稿"
  );

  if (selection === "無視して投稿") {
    return "ignore";
  }
  if (selection === "作成して投稿") {
    return "create";
  }
  return "cancel";
}

async function materializeTermIds(
  taxonomy: "category" | "tag",
  items: ResolvedTaxonomyItem[],
  config: PublishConfig
): Promise<number[]> {
  const ids: number[] = [];
  for (const item of items) {
    if (!item.missing) {
      ids.push(item.id);
      continue;
    }

    const definition = await promptForNewTerm(taxonomy, item.input);
    ids.push(await createWordPressTerm(taxonomy, definition.name, definition.slug, config));
  }
  return ids;
}

async function promptForNewTerm(
  taxonomy: "category" | "tag",
  originalInput: string
): Promise<{ name: string; slug: string }> {
  const label = taxonomy === "category" ? "カテゴリ" : "タグ";
  const name = await vscode.window.showInputBox({
    title: `${label}を作成`,
    prompt: `${originalInput} の表示名を入力してください`,
    value: originalInput,
    ignoreFocusOut: true,
    validateInput: value => (value.trim() ? undefined : "表示名を入力してください。")
  });
  if (name === undefined) {
    throw new UserCancelledError();
  }

  const slug = await vscode.window.showInputBox({
    title: `${label}を作成`,
    prompt: `${name.trim()} の slug を入力してください`,
    value: normalizeSlug(originalInput),
    ignoreFocusOut: true,
    validateInput: value => (value.trim() ? undefined : "slug を入力してください。")
  });
  if (slug === undefined) {
    throw new UserCancelledError();
  }

  return {
    name: name.trim(),
    slug: slug.trim()
  };
}

async function createWordPressTerm(
  taxonomy: "category" | "tag",
  name: string,
  slug: string,
  config: PublishConfig
): Promise<number> {
  const endpoint = taxonomy === "category" ? "categories" : "tags";
  const url = `${stripTrailingSlash(config.siteUrl)}/wp-json/wp/v2/${endpoint}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuth(config.username, config.applicationPassword),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name, slug })
  });

  if (!response.ok) {
    const text = await response.text();
    const existingId = parseExistingTermId(text);
    if (existingId !== null) {
      return existingId;
    }
    throw new Error(`${taxonomy === "category" ? "Category" : "Tag"} create failed (${response.status}): ${text}`);
  }

  const created = (await response.json()) as WordPressTerm;
  return created.id;
}

function parseExistingTermId(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as {
      code?: string;
      data?: { term_id?: unknown };
    };
    if (parsed.code !== "term_exists") {
      return null;
    }
    const termId = parsed.data?.term_id;
    if (typeof termId === "number" && Number.isFinite(termId)) {
      return termId;
    }
    if (typeof termId === "string" && termId.trim() !== "" && !Number.isNaN(Number(termId))) {
      return Number(termId);
    }
    return null;
  } catch {
    return null;
  }
}

async function maybeSendPostPublishedWebhook(
  input: {
    publishTarget: PublishTarget;
    existingContent: WordPressContentSummary | null;
    publishResult: PublishResult;
    title: string;
    hashtag: string | undefined;
    metaDescription: string | undefined;
  },
  config: PublishConfig
): Promise<WebhookAttemptResult> {
  if (input.publishTarget.type !== "post") {
    return { kind: "not_applicable" };
  }

  if (input.publishResult.status !== "publish") {
    return { kind: "not_applicable" };
  }

  if (typeof input.publishResult.id !== "number" || !input.publishResult.link) {
    return { kind: "skipped", reason: "公開 URL または投稿 ID を取得できなかったため、X 連携をスキップしました。" };
  }

  if (!shouldSendWebhookOnPublish(input.existingContent, input.publishResult, config)) {
    return { kind: "not_applicable" };
  }

  if (!config.webhookUrl && !config.webhookSecret) {
    return { kind: "not_applicable" };
  }

  if (!config.webhookUrl || !config.webhookSecret) {
    return { kind: "skipped", reason: "Webhook 設定が不完全です。mdToWp.webhookUrl と mdToWp.webhookSecret の両方を設定してください。" };
  }

  const tweet = buildTweetForWebhook({
    prefix: config.xPostPrefix,
    title: input.title,
    url: input.publishResult.link,
    hashtag: input.hashtag,
    postfix: config.xPostPostfix,
    useXPro: config.useXPro
  });
  if (!tweet.ok) {
    return { kind: "skipped", reason: tweet.reason };
  }

  const payload = buildPostPublishedWebhookPayload(
    {
      id: input.publishResult.id,
      link: input.publishResult.link,
      title: input.title,
      hashtag: input.hashtag,
      metaDescription: input.metaDescription,
      publishedAt: input.publishResult.date,
      tweet: tweet.tweet
    },
    config
  );

  try {
    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": config.webhookSecret
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text();
      return { kind: "failed", reason: `X webhook failed (${response.status}): ${body}` };
    }

    return { kind: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason: `X webhook request failed: ${message}` };
  }
}

function shouldSendWebhookOnPublish(
  existingContent: WordPressContentSummary | null,
  publishResult: PublishResult,
  config: PublishConfig
): boolean {
  if (!existingContent) {
    return true;
  }

  if (existingContent.status !== "publish") {
    return true;
  }

  if (!config.postOnRepublish) {
    return false;
  }

  if (!existingContent.date || !publishResult.date) {
    return false;
  }

  return existingContent.date !== publishResult.date;
}

function buildPostPublishedWebhookPayload(
  input: {
    id: number;
    link: string;
    title: string;
    hashtag: string | undefined;
    metaDescription: string | undefined;
    publishedAt: string | undefined;
    tweet: string;
  },
  config: PublishConfig
): PostPublishedWebhookPayload {
  const site = new URL(config.siteUrl).hostname;
  const dedupeSuffix = input.publishedAt ? encodeURIComponent(input.publishedAt) : "unknown";
  const payload: PostPublishedWebhookPayload = {
    site,
    post_id: input.id,
    title: input.title,
    url: input.link,
    tweet: input.tweet,
    dedupe_key: `${site}:${input.id}:publish:${dedupeSuffix}`
  };

  if (input.hashtag) {
    payload.hashtags = input.hashtag;
  }
  if (input.metaDescription) {
    payload.meta_description = input.metaDescription;
  }
  if (input.publishedAt) {
    payload.published_at = input.publishedAt;
  }

  return payload;
}

function buildTweetForWebhook(input: {
  prefix: string;
  title: string;
  url: string;
  hashtag: string | undefined;
  postfix: string;
  useXPro: boolean;
}): { ok: true; tweet: string } | { ok: false; reason: string } {
  const limit = input.useXPro ? 25000 : 280;
  const parts = {
    prefix: input.prefix,
    title: input.title,
    url: input.url,
    hashtag: input.hashtag,
    postfix: input.postfix
  };

  let tweet = composeTweet(parts);
  if (measureTweetLength(tweet) <= limit) {
    return { ok: true, tweet };
  }

  if (parts.postfix) {
    parts.postfix = "";
    tweet = composeTweet(parts);
    if (measureTweetLength(tweet) <= limit) {
      return { ok: true, tweet };
    }
  }

  if (parts.hashtag) {
    parts.hashtag = undefined;
    tweet = composeTweet(parts);
    if (measureTweetLength(tweet) <= limit) {
      return { ok: true, tweet };
    }
  }

  const truncatedTitle = truncateTitleToFit(parts, limit);
  if (truncatedTitle) {
    parts.title = truncatedTitle;
    tweet = composeTweet(parts);
    if (measureTweetLength(tweet) <= limit) {
      return { ok: true, tweet };
    }
  }

  return {
    ok: false,
    reason: `X 投稿文が文字数制限 (${limit}) を超えたため、Webhook をスキップしました。`
  };
}

function composeTweet(input: {
  prefix: string;
  title: string;
  url: string;
  hashtag: string | undefined;
  postfix: string;
}): string {
  return [input.prefix, input.title, input.url, input.hashtag, input.postfix]
    .map(value => value?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

function measureTweetLength(text: string): number {
  const urlPattern = /https?:\/\/\S+/g;
  let length = 0;
  let lastIndex = 0;

  for (const match of text.matchAll(urlPattern)) {
    const matchIndex = match.index ?? 0;
    length += Array.from(text.slice(lastIndex, matchIndex)).length;
    length += 23;
    lastIndex = matchIndex + match[0].length;
  }

  length += Array.from(text.slice(lastIndex)).length;
  return length;
}

function truncateTitleToFit(
  input: {
    prefix: string;
    title: string;
    url: string;
    hashtag: string | undefined;
    postfix: string;
  },
  limit: number
): string | null {
  const chars = Array.from(input.title);
  let low = 0;
  let high = chars.length;
  let best: string | null = null;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${chars.slice(0, mid).join("").trimEnd()}…`;
    const tweet = composeTweet({ ...input, title: candidate });
    if (measureTweetLength(tweet) <= limit) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

async function showPublishCompletionMessage(
  publishTarget: PublishTarget,
  publishedUrl: string,
  webhookResult: WebhookAttemptResult
): Promise<void> {
  const openButton = "記事を開く";
  let selection: string | undefined;

  if (webhookResult.kind === "failed" || webhookResult.kind === "skipped") {
    selection = await vscode.window.showWarningMessage(
      `Published ${publishTarget.label}: ${publishedUrl}\n${webhookResult.reason}`,
      openButton
    );
  } else {
    selection = await vscode.window.showInformationMessage(
      `Published ${publishTarget.label}: ${publishedUrl}`,
      openButton
    );
  }

  if (selection === openButton) {
    await vscode.env.openExternal(vscode.Uri.parse(publishedUrl));
  }
}

function applyFootnotes(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const definitionMap = new Map<string, string>();
  const contentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (!match) {
      contentLines.push(line);
      continue;
    }

    const key = match[1].trim();
    const bodyLines = [match[2] ?? ""];

    while (i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      if (/^( {2,}|\t)/.test(nextLine)) {
        bodyLines.push(nextLine.replace(/^( {2,}|\t)/, ""));
        i++;
        continue;
      }
      if (nextLine.trim() === "") {
        bodyLines.push("");
        i++;
        continue;
      }
      break;
    }

    definitionMap.set(key, bodyLines.join("\n").trim());
  }

  if (definitionMap.size === 0) {
    return markdown;
  }

  const keyToIndex = new Map<string, number>();
  let nextIndex = 1;
  let content = contentLines.join("\n");

  content = content.replace(/\[\^([^\]]+)\]/g, (_, rawKey: string) => {
    const key = rawKey.trim();
    if (!definitionMap.has(key)) {
      return `[^${key}]`;
    }
    if (!keyToIndex.has(key)) {
      keyToIndex.set(key, nextIndex++);
    }
    const index = keyToIndex.get(key)!;
    const id = footnoteId(key);
    return `<sup id="fnref-${id}"><a href="#fn-${id}">${index}</a></sup>`;
  });

  if (keyToIndex.size === 0) {
    return content;
  }

  const ordered = Array.from(keyToIndex.entries()).sort((a, b) => a[1] - b[1]);
  const footnoteItems = ordered
    .map(([key, index]) => {
      const id = footnoteId(key);
      const body = definitionMap.get(key) ?? "";
      return `<li id="fn-${id}" value="${index}">${body} <a href="#fnref-${id}" aria-label="Back to footnote reference">↩</a></li>`;
    })
    .join("\n");

  return `${content}\n\n<hr>\n<section class="footnotes">\n<ol>\n${footnoteItems}\n</ol>\n</section>\n`;
}

function footnoteId(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "note";
}

async function applyDefinitionLists(markdown: string): Promise<string> {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const termLine = lines[i];
    const firstDefinitionLine = lines[i + 1];

    if (!canStartDefinitionList(termLine, firstDefinitionLine)) {
      output.push(termLine);
      continue;
    }

    output.push("<dl>");
    output.push(`<dt>${await renderInlineMarkdown(termLine.trim())}</dt>`);

    i++;
    let isFirstDefinitionLine = true;
    while (i < lines.length) {
      const definitionLine = lines[i];
      if (definitionLine.trim() === "") {
        break;
      }

      const definitionBody = normalizeDefinitionListBody(definitionLine, isFirstDefinitionLine);
      output.push(`<dd>${await renderInlineMarkdown(definitionBody)}</dd>`);
      isFirstDefinitionLine = false;
      i++;
    }

    output.push("</dl>");

    if (i < lines.length && lines[i].trim() === "") {
      output.push("");
    } else {
      i--;
    }
  }

  return output.join("\n");
}

function canStartDefinitionList(termLine: string, firstDefinitionLine: string | undefined): boolean {
  if (!termLine.trim() || !firstDefinitionLine) {
    return false;
  }

  return /^:[\t \u3000]+.*$/u.test(firstDefinitionLine);
}

function normalizeDefinitionListBody(line: string, isFirstDefinitionLine: boolean): string {
  if (isFirstDefinitionLine) {
    return line.replace(/^:[\t \u3000]+/u, "").trim();
  }

  return line.replace(/^(?::[\t \u3000]+|[\t \u3000]+)/u, "").trim();
}

async function renderInlineMarkdown(markdown: string): Promise<string> {
  return await marked.parseInline(markdown);
}

function encodeVisibleListContinuationWhitespace(whitespace: string): string {
  return Array.from(whitespace)
    .map(char => {
      if (char === " ") {
        return "&nbsp;";
      }
      if (char === "\t") {
        return "&nbsp;&nbsp;&nbsp;&nbsp;";
      }
      if (char === "\u3000") {
        return "&#x3000;";
      }
      return char;
    })
    .join("");
}

function normalizeListContinuationHardBreaks(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  let activeList: { continuationIndent: number; pendingBlankLine: boolean } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const listMatch = line.match(/^(\s*)(?:([*+-])|(\d+)([.)]))(\s+)(.*)$/);
    if (listMatch) {
      const leadingSpaces = listMatch[1] ?? "";
      const marker = listMatch[2] ?? `${listMatch[3]}${listMatch[4]}`;
      const spacing = listMatch[5] ?? " ";
      activeList = {
        continuationIndent: leadingSpaces.length + marker.length + spacing.length,
        pendingBlankLine: false
      };
      output.push(line);
      continue;
    }

    if (!activeList) {
      output.push(line);
      continue;
    }

    if (line.trim() === "") {
      if (activeList.pendingBlankLine) {
        activeList = null;
      } else {
        activeList.pendingBlankLine = true;
      }
      output.push(line);
      continue;
    }

    const leadingWhitespace = line.match(/^[\t \u3000]*/u)?.[0] ?? "";
    const leadingSpaces = leadingWhitespace.length;
    const lineContent = line.slice(leadingWhitespace.length);
    const previousIndex = output.length - 1;
    const previousHasHardBreak =
      previousIndex >= 0 && /( {2,}|\\)$/.test(output[previousIndex]);
    if (leadingSpaces >= activeList.continuationIndent) {
      if (previousHasHardBreak) {
        const visibleWhitespace = encodeVisibleListContinuationWhitespace(
          leadingWhitespace.slice(activeList.continuationIndent)
        );
        output.push(
          `${" ".repeat(activeList.continuationIndent)}${visibleWhitespace}${lineContent}`
        );
        activeList.pendingBlankLine = false;
        continue;
      }

      activeList.pendingBlankLine = false;
      output.push(line);
      continue;
    }

    if (activeList.pendingBlankLine) {
      activeList = null;
      output.push(line);
      continue;
    }

    if (!previousHasHardBreak) {
      output[previousIndex] = `${output[previousIndex]}  `;
    }

    const visibleWhitespace = encodeVisibleListContinuationWhitespace(leadingWhitespace);
    output.push(`${" ".repeat(activeList.continuationIndent)}${visibleWhitespace}${lineContent}`);
    activeList.pendingBlankLine = false;
  }

  return output.join("\n");
}
