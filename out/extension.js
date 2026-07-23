"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const gray_matter_1 = __importDefault(require("gray-matter"));
const marked_1 = require("marked");
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
const FEATURED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"];
const YOAST_FOCUS_META_KEY = "_yoast_wpseo_focuskw";
const YOAST_METADESC_META_KEY = "_yoast_wpseo_metadesc";
/** FIT テーマ GOLDBLOG / GOLDMEDIA の記事メタディスクリプション */
const GOLDBLOG_METADESC_META_KEY = "fit_seo_description-single";
/** `status=any` は権限によって REST で拒否されるため、許可されやすい単一ステータスを順に試す */
const CONTENT_LOOKUP_STATUSES = ["publish", "draft", "private", "pending", "future"];
const LOOKUP_RETRY_DELAYS_MS = [300, 1000];
const LOOKUP_RETRY_STATUS_CODES = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504]);
/**
 * テーマの目次などが ol + CSS カウンターを使っていると、本文の番号付きリストが連番で続くことがある。
 * 加えて、テーマ側で list-style-position: inside; が指定されていると loose list の番号が
 * 改行されたように見えるため、本文用の余白と outside 指定もここで補う。
 * marked の list レンダラーを差し替えると内部実装と不整合で落ちることがあるため、パース後に ol だけ置換する。
 */
function annotateOrderedListsHtml(html) {
    const inlineStyle = "contain: style; list-style-position: outside; padding-inline-start: 1.5em; padding-left: 1.5em;";
    return html.replace(/<ol(\s+start="(\d+)")?>/g, (_, __, startNum) => {
        const n = startNum ?? "1";
        return `<ol class="mdtowp-ol" start="${n}" style="${inlineStyle}">`;
    });
}
function activate(context) {
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
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Publishing to WordPress",
                cancellable: false
            }, async (progress) => {
                progress.report({ message: "Parsing Markdown..." });
                const rawMarkdown = doc.getText();
                const parsed = (0, gray_matter_1.default)(rawMarkdown);
                const frontMatter = parsed.data;
                const rawFm = parsed.data;
                const contentType = normalizeContentType(frontMatter.type);
                const publishTarget = resolvePublishTarget(contentType, config);
                warnIgnoredFieldsForTarget(frontMatter, rawFm, publishTarget);
                const markdownDir = path.dirname(doc.uri.fsPath);
                const mediaCache = new Map();
                progress.report({ message: "Uploading featured image..." });
                const featuredMediaId = await resolveFeaturedImageMediaId(rawFm, markdownDir, config, mediaCache);
                progress.report({ message: "Uploading local media files..." });
                const replacedMarkdown = await replaceLocalMediaLinks(parsed.content, markdownDir, config, mediaCache);
                const hashtag = normalizeFrontMatterString(frontMatter.hashtag);
                const markdownWithHashtag = hashtag ? `${hashtag}\n\n${replacedMarkdown}` : replacedMarkdown;
                progress.report({ message: "Converting Markdown to HTML..." });
                const markdownWithDefinitionLists = await applyDefinitionLists(markdownWithHashtag);
                const normalizedMarkdown = normalizeListContinuationHardBreaks(markdownWithDefinitionLists);
                const markdownWithFootnotes = applyFootnotes(normalizedMarkdown);
                const rawHtml = await marked_1.marked.parse(markdownWithFootnotes);
                const contentHtml = annotateOrderedListsHtml(rawHtml);
                const slug = normalizeOptionalSlugField(frontMatter.slug, "slug") ??
                    normalizeSlug(path.parse(doc.uri.fsPath).name);
                if (!slug) {
                    throw new Error("Could not determine a valid slug.");
                }
                const title = normalizeFrontMatterString(frontMatter.title) || inferTitle(parsed.content, slug);
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
                const parentId = publishTarget.type === "page" ? await findPageParentIdBySlug(parentSlug, config) : undefined;
                const existingContent = await findContentBySlug(slug, publishTarget, config);
                const contentId = existingContent?.id ?? null;
                progress.report({
                    message: contentId
                        ? `Updating existing ${publishTarget.label.toLowerCase()}...`
                        : `Creating new ${publishTarget.label.toLowerCase()}...`
                });
                const publishResult = await upsertContent({
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
                    tags: taxonomySelection.tagIds,
                    featuredMediaId
                }, publishTarget, config);
                progress.report({ message: "Finalizing publish..." });
                const webhookResult = await maybeSendPostPublishedWebhook({
                    publishTarget,
                    existingContent,
                    publishResult,
                    title,
                    hashtag,
                    metaDescription
                }, config);
                await showPublishCompletionMessage(publishTarget, publishResult.resolvedUrl, webhookResult);
            });
        }
        catch (error) {
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
function deactivate() { }
function loadConfig() {
    const cfg = vscode.workspace.getConfiguration("mdToWp");
    const legacyCfg = vscode.workspace.getConfiguration("wordpress-post");
    return {
        siteUrl: firstConfiguredString(cfg.get("siteUrl"), cfg.get("apiUrl"), legacyCfg.get("apiUrl")),
        username: firstConfiguredString(cfg.get("username"), legacyCfg.get("username")),
        applicationPassword: firstConfiguredString(cfg.get("applicationPassword"), cfg.get("password"), legacyCfg.get("password")),
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
function validateConfig(config) {
    const missingKeys = [];
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
        throw new Error(`Missing setting(s): ${missingKeys.join(", ")}. If you are using a .code-workspace file, put them under the "settings" object and open the .code-workspace itself.`);
    }
    if (!config.postApiPath || !config.pageApiPath) {
        throw new Error("Configure mdToWp.postApiPath and mdToWp.pageApiPath.");
    }
}
async function replaceLocalMediaLinks(markdown, markdownDir, config, cache) {
    let output = markdown;
    const markdownUrlPattern = /(!?\[[^\]]*?\]\()([^)]+)(\))/g;
    const markdownMatches = Array.from(output.matchAll(markdownUrlPattern));
    for (const match of markdownMatches) {
        const originalUrl = match[2].trim();
        if (shouldIgnoreUrl(originalUrl)) {
            continue;
        }
        const uploaded = await resolveAndUploadMedia(originalUrl, markdownDir, config, cache);
        output = replaceExactUrl(output, originalUrl, uploaded.source_url);
    }
    const htmlSrcPattern = /(src=["'])([^"']+)(["'])/g;
    const htmlMatches = Array.from(output.matchAll(htmlSrcPattern));
    for (const match of htmlMatches) {
        const originalUrl = match[2].trim();
        if (shouldIgnoreUrl(originalUrl)) {
            continue;
        }
        const uploaded = await resolveAndUploadMedia(originalUrl, markdownDir, config, cache);
        output = replaceExactUrl(output, originalUrl, uploaded.source_url);
    }
    return output;
}
async function resolveAndUploadMedia(rawUrl, markdownDir, config, cache) {
    const localPath = resolvePathFromMarkdown(rawUrl, markdownDir);
    const ext = path.extname(localPath).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(ext)) {
        throw new Error(`Only media files are allowed as local references. Unsupported: ${rawUrl}`);
    }
    return uploadMediaCached(localPath, config, cache);
}
async function uploadMediaCached(localPath, config, cache) {
    if (cache.has(localPath)) {
        return cache.get(localPath);
    }
    const uploaded = await uploadMedia(localPath, config);
    cache.set(localPath, uploaded);
    return uploaded;
}
function normalizeFeaturedImageField(rawFm) {
    return normalizeFrontMatterString(rawFm.image) ?? normalizeFrontMatterString(rawFm.images);
}
async function resolveFeaturedImageMediaId(rawFm, markdownDir, config, cache) {
    const fileRef = normalizeFeaturedImageField(rawFm);
    if (!fileRef) {
        return undefined;
    }
    const localPath = await findFeaturedImagePath(markdownDir, fileRef);
    if (!localPath) {
        return undefined;
    }
    const uploaded = await uploadMediaCached(localPath, config, cache);
    return uploaded.id;
}
async function findFeaturedImagePath(markdownDir, fileRef) {
    const trimmed = fileRef.trim();
    const baseName = path.basename(trimmed);
    if (!baseName || baseName !== trimmed) {
        throw new Error(`Invalid front matter image: ${fileRef}`);
    }
    const imgDir = path.join(markdownDir, "img");
    const ext = path.extname(baseName).toLowerCase();
    if (ext) {
        if (!FEATURED_IMAGE_EXTENSIONS.includes(ext)) {
            throw new Error(`Featured image must be an image file (${FEATURED_IMAGE_EXTENSIONS.join(", ")}): ${fileRef}`);
        }
        const candidate = path.join(imgDir, baseName);
        return (await fileExists(candidate)) ? candidate : undefined;
    }
    for (const candidateExt of FEATURED_IMAGE_EXTENSIONS) {
        const candidate = path.join(imgDir, `${baseName}${candidateExt}`);
        if (await fileExists(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
function resolvePathFromMarkdown(rawUrl, markdownDir) {
    const cleanUrl = rawUrl.split("#")[0].split("?")[0];
    const resolved = path.resolve(markdownDir, cleanUrl);
    return resolved;
}
function shouldIgnoreUrl(url) {
    return (url.startsWith("http://") ||
        url.startsWith("https://") ||
        url.startsWith("data:") ||
        url.startsWith("#"));
}
function replaceExactUrl(markdown, from, to) {
    return markdown.split(from).join(to);
}
async function uploadMedia(localPath, config) {
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
    const data = (await response.json());
    if (typeof data.id !== "number" || !data.source_url) {
        throw new Error(`Media upload succeeded but id or source_url is missing: ${fileName}`);
    }
    return { id: data.id, source_url: data.source_url };
}
function detectContentType(fileName) {
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
function normalizeContentType(value) {
    if (typeof value !== "string" || value.trim() === "") {
        return "post";
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "post" || normalized === "page") {
        return normalized;
    }
    throw new Error(`Invalid front matter type: ${value}`);
}
function resolvePublishTarget(type, config) {
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
function warnIgnoredFieldsForTarget(frontMatter, rawFm, target) {
    const ignoredFields = [];
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
        vscode.window.showWarningMessage(`${target.label} publish ignores unsupported field(s): ${ignoredFields.join(", ")}`);
    }
}
function resolveApiUrl(siteUrl, apiPath) {
    const trimmed = apiPath.trim();
    if (!trimmed) {
        throw new Error("API path must not be empty.");
    }
    if (/^https?:\/\//i.test(trimmed)) {
        return stripTrailingSlash(trimmed);
    }
    return `${stripTrailingSlash(siteUrl)}/${trimmed.replace(/^\/+/, "")}`;
}
function isForbiddenStatusQueryError(status, body) {
    if (status !== 400) {
        return false;
    }
    try {
        const parsed = JSON.parse(body);
        return (parsed.code === "rest_invalid_param" && parsed.data?.params?.status !== undefined);
    }
    catch {
        return false;
    }
}
async function findContentBySlug(slug, target, config) {
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
        const data = JSON.parse(text);
        if (data.length > 0) {
            assertResponseTypeMatchesTarget(data[0].type, target);
            return data[0];
        }
    }
    return null;
}
async function findPageParentIdBySlug(parentSlug, config) {
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
        const pages = JSON.parse(text);
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
async function upsertContent(input, target, config) {
    const endpoint = input.id ? `${target.apiUrl}/${input.id}` : target.apiUrl;
    const payload = {
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
    const meta = {};
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
    if (typeof input.featuredMediaId === "number") {
        payload.featured_media = input.featuredMediaId;
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
    const data = (await response.json());
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
function restMetaValueEquals(saved, expected) {
    if (saved === undefined || saved === null) {
        return false;
    }
    if (typeof saved === "string") {
        return saved.trim() === expected.trim();
    }
    return String(saved).trim() === expected.trim();
}
async function fetchPostMetaInEditContext(id, target, config) {
    const url = `${target.apiUrl}/${id}?context=edit&_fields=meta`;
    const response = await fetchLookupWithRetry(url, config);
    if (!response.ok) {
        return undefined;
    }
    const payload = (await response.json());
    return payload.meta;
}
async function warnIfSeoRelatedMetaRejectedByRestApi(input, data, target, config) {
    const needFocus = Boolean(input.focusKeyphrase);
    const needDesc = Boolean(input.metaDescription);
    if (!needFocus && !needDesc) {
        return;
    }
    let meta = data.meta;
    const focusOk = !needFocus || restMetaValueEquals(meta?.[YOAST_FOCUS_META_KEY], input.focusKeyphrase);
    const yoastDescOk = !needDesc || restMetaValueEquals(meta?.[YOAST_METADESC_META_KEY], input.metaDescription);
    const goldblogDescOk = !needDesc || restMetaValueEquals(meta?.[GOLDBLOG_METADESC_META_KEY], input.metaDescription);
    const descOk = yoastDescOk && goldblogDescOk;
    if (typeof data.id === "number" && (!focusOk || !descOk)) {
        const refetched = await fetchPostMetaInEditContext(data.id, target, config);
        if (refetched) {
            meta = refetched;
        }
    }
    if (needFocus && !restMetaValueEquals(meta?.[YOAST_FOCUS_META_KEY], input.focusKeyphrase)) {
        vscode.window.showWarningMessage("YOAST のフォーカスキーフレーズが REST で保存されていない可能性があります。WordPress で _yoast_wpseo_focuskw を register_post_meta（show_in_rest => true）してください。README の「REST API でメタが保存されないとき」を参照。");
    }
    if (needDesc && !restMetaValueEquals(meta?.[YOAST_METADESC_META_KEY], input.metaDescription)) {
        vscode.window.showWarningMessage("YOAST 用メタディスクリプション（_yoast_wpseo_metadesc）が REST で保存されていない可能性があります。README の「REST API でメタが保存されないとき」の PHP を追加してください。");
    }
    if (needDesc && !restMetaValueEquals(meta?.[GOLDBLOG_METADESC_META_KEY], input.metaDescription)) {
        vscode.window.showWarningMessage("GOLDBLOG / GOLDMEDIA 用メタ（fit_seo_description-single）が REST で保存されていない可能性があります。README の「REST API でメタが保存されないとき」の PHP を追加してください。");
    }
}
function formatWpRestFailure(context, status, body) {
    let hint = "";
    try {
        const parsed = JSON.parse(body);
        const code = parsed.code;
        if (code === "rest_cannot_create" || code === "rest_cannot_edit") {
            hint =
                " （対処: WordPress でこのユーザーに投稿の作成・編集権限があるロールか確認してください。投稿者（Author）以上のユーザーでアプリケーションパスワードを発行し、mdToWp.username にそのログイン名を指定してください。）";
        }
        else if (code === "rest_cannot_publish") {
            hint =
                " （対処: 公開（publish）には編集者以上など、該当ステータスを付与できる権限が必要な場合があります。front matter の status を draft にするか、ロールを上げてください。）";
        }
    }
    catch {
        /* body が JSON でない場合は本文のみ */
    }
    return `${context} failed (${status}): ${body}${hint}`;
}
function assertResponseTypeMatchesTarget(actualType, target) {
    if (!actualType || actualType === target.type) {
        return;
    }
    throw new Error(`${target.label} publish reached a "${actualType}" endpoint. Check mdToWp.${target.configKey}.`);
}
function basicAuth(username, appPassword) {
    const token = Buffer.from(`${username}:${appPassword}`).toString("base64");
    return `Basic ${token}`;
}
function stripTrailingSlash(url) {
    return url.replace(/\/+$/, "");
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function fetchLookupWithRetry(url, config) {
    let lastError;
    for (let attempt = 0; attempt <= LOOKUP_RETRY_DELAYS_MS.length; attempt++) {
        try {
            const response = await fetch(url, {
                headers: { Authorization: basicAuth(config.username, config.applicationPassword) }
            });
            if (response.ok ||
                !LOOKUP_RETRY_STATUS_CODES.has(response.status) ||
                attempt === LOOKUP_RETRY_DELAYS_MS.length) {
                return response;
            }
        }
        catch (error) {
            lastError = error;
            if (attempt === LOOKUP_RETRY_DELAYS_MS.length) {
                throw error;
            }
        }
        await delay(LOOKUP_RETRY_DELAYS_MS[attempt]);
    }
    throw lastError instanceof Error ? lastError : new Error("Lookup request failed.");
}
function inferTitle(content, fallback) {
    const headingMatch = content.match(/^\s*#\s+(.+)$/m);
    if (headingMatch?.[1]) {
        return headingMatch[1].trim();
    }
    return fallback;
}
function normalizeSlug(input) {
    return input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\-_]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}
function normalizeOptionalString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
function unwrapOuterQuotes(input) {
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
function normalizeFrontMatterString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const unwrapped = unwrapOuterQuotes(value);
    const trimmed = unwrapped.trim();
    return trimmed ? trimmed : undefined;
}
function mergeListFields(primary, legacy) {
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
function coalesceToArray(value) {
    if (value === undefined || value === null) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}
function firstConfiguredString(...values) {
    for (const value of values) {
        const normalized = normalizeOptionalString(value);
        if (normalized) {
            return normalized;
        }
    }
    return "";
}
function normalizePublishDate(value) {
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
function normalizeOptionalSlugField(value, fieldName) {
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
function normalizeTaxonomyTerms(value) {
    if (!value) {
        return [];
    }
    const values = Array.isArray(value) ? value : [value];
    const terms = values
        .map(item => (typeof item === "string" ? unwrapOuterQuotes(item).trim() : ""))
        .filter(Boolean);
    return Array.from(new Set(terms));
}
async function resolveTaxonomySelection(categoryTerms, tagTerms, config) {
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
async function resolveExistingTerms(taxonomy, inputs, config) {
    const results = [];
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
async function findExistingTermId(taxonomy, input, config) {
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
async function fetchTermsBySlug(taxonomy, slug, config) {
    const endpoint = taxonomy === "category" ? "categories" : "tags";
    const url = `${stripTrailingSlash(config.siteUrl)}/wp-json/wp/v2/${endpoint}?slug=${encodeURIComponent(slug)}&per_page=100&_fields=id,name,slug`;
    const response = await fetchLookupWithRetry(url, config);
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`${taxonomy === "category" ? "Category" : "Tag"} lookup failed (${response.status}): ${text}`);
    }
    return (await response.json());
}
async function searchTerms(taxonomy, term, config) {
    const endpoint = taxonomy === "category" ? "categories" : "tags";
    const url = `${stripTrailingSlash(config.siteUrl)}/wp-json/wp/v2/${endpoint}?search=${encodeURIComponent(term)}&per_page=100&_fields=id,name,slug`;
    const response = await fetchLookupWithRetry(url, config);
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`${taxonomy === "category" ? "Category" : "Tag"} lookup failed (${response.status}): ${text}`);
    }
    return (await response.json());
}
function termNameEquals(actual, expected) {
    return actual.trim() === expected.trim();
}
function termSlugEquals(actual, expected) {
    const trimmedExpected = expected.trim();
    if (actual.trim() === trimmedExpected) {
        return true;
    }
    const normalizedActual = normalizeSlug(actual);
    const normalizedExpected = normalizeSlug(trimmedExpected);
    return Boolean(normalizedActual) && normalizedActual === normalizedExpected;
}
async function promptForMissingTaxonomies(categories, tags) {
    const parts = [];
    if (categories.length > 0) {
        parts.push(`未登録カテゴリ: ${categories.join(", ")}`);
    }
    if (tags.length > 0) {
        parts.push(`未登録タグ: ${tags.join(", ")}`);
    }
    const selection = await vscode.window.showWarningMessage(`${parts.join("\n")}\n\n処理を選んでください。`, { modal: true }, "中止", "無視して投稿", "作成して投稿");
    if (selection === "無視して投稿") {
        return "ignore";
    }
    if (selection === "作成して投稿") {
        return "create";
    }
    return "cancel";
}
async function materializeTermIds(taxonomy, items, config) {
    const ids = [];
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
async function promptForNewTerm(taxonomy, originalInput) {
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
async function createWordPressTerm(taxonomy, name, slug, config) {
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
    const created = (await response.json());
    return created.id;
}
function parseExistingTermId(raw) {
    try {
        const parsed = JSON.parse(raw);
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
    }
    catch {
        return null;
    }
}
async function maybeSendPostPublishedWebhook(input, config) {
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
    const payload = buildPostPublishedWebhookPayload({
        id: input.publishResult.id,
        link: input.publishResult.link,
        title: input.title,
        hashtag: input.hashtag,
        metaDescription: input.metaDescription,
        publishedAt: input.publishResult.date,
        tweet: tweet.tweet
    }, config);
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
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: "failed", reason: `X webhook request failed: ${message}` };
    }
}
function shouldSendWebhookOnPublish(existingContent, publishResult, config) {
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
function buildPostPublishedWebhookPayload(input, config) {
    const site = new URL(config.siteUrl).hostname;
    const dedupeSuffix = input.publishedAt ? encodeURIComponent(input.publishedAt) : "unknown";
    const payload = {
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
function buildTweetForWebhook(input) {
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
function composeTweet(input) {
    return [input.prefix, input.title, input.url, input.hashtag, input.postfix]
        .map(value => value?.trim() ?? "")
        .filter(Boolean)
        .join("\n");
}
function measureTweetLength(text) {
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
function truncateTitleToFit(input, limit) {
    const chars = Array.from(input.title);
    let low = 0;
    let high = chars.length;
    let best = null;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = `${chars.slice(0, mid).join("").trimEnd()}…`;
        const tweet = composeTweet({ ...input, title: candidate });
        if (measureTweetLength(tweet) <= limit) {
            best = candidate;
            low = mid + 1;
        }
        else {
            high = mid - 1;
        }
    }
    return best;
}
async function showPublishCompletionMessage(publishTarget, publishedUrl, webhookResult) {
    const openButton = "記事を開く";
    let selection;
    if (webhookResult.kind === "failed" || webhookResult.kind === "skipped") {
        selection = await vscode.window.showWarningMessage(`Published ${publishTarget.label}: ${publishedUrl}\n${webhookResult.reason}`, openButton);
    }
    else {
        selection = await vscode.window.showInformationMessage(`Published ${publishTarget.label}: ${publishedUrl}`, openButton);
    }
    if (selection === openButton) {
        await vscode.env.openExternal(vscode.Uri.parse(publishedUrl));
    }
}
function applyFootnotes(markdown) {
    const lines = markdown.split(/\r?\n/);
    const definitionMap = new Map();
    const contentLines = [];
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
    const keyToIndex = new Map();
    let nextIndex = 1;
    let content = contentLines.join("\n");
    content = content.replace(/\[\^([^\]]+)\]/g, (_, rawKey) => {
        const key = rawKey.trim();
        if (!definitionMap.has(key)) {
            return `[^${key}]`;
        }
        if (!keyToIndex.has(key)) {
            keyToIndex.set(key, nextIndex++);
        }
        const index = keyToIndex.get(key);
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
function footnoteId(input) {
    const normalized = input
        .toLowerCase()
        .replace(/[^a-z0-9\-_]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    return normalized || "note";
}
async function applyDefinitionLists(markdown) {
    const lines = markdown.split(/\r?\n/);
    const output = [];
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
        }
        else {
            i--;
        }
    }
    return output.join("\n");
}
function canStartDefinitionList(termLine, firstDefinitionLine) {
    if (!termLine.trim() || !firstDefinitionLine) {
        return false;
    }
    return /^:[\t \u3000]+.*$/u.test(firstDefinitionLine);
}
function normalizeDefinitionListBody(line, isFirstDefinitionLine) {
    if (isFirstDefinitionLine) {
        return line.replace(/^:[\t \u3000]+/u, "").trim();
    }
    return line.replace(/^(?::[\t \u3000]+|[\t \u3000]+)/u, "").trim();
}
async function renderInlineMarkdown(markdown) {
    return await marked_1.marked.parseInline(markdown);
}
function encodeVisibleListContinuationWhitespace(whitespace) {
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
function normalizeListContinuationHardBreaks(markdown) {
    const lines = markdown.split(/\r?\n/);
    const output = [];
    let activeList = null;
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
            }
            else {
                activeList.pendingBlankLine = true;
            }
            output.push(line);
            continue;
        }
        const leadingWhitespace = line.match(/^[\t \u3000]*/u)?.[0] ?? "";
        const leadingSpaces = leadingWhitespace.length;
        const lineContent = line.slice(leadingWhitespace.length);
        const previousIndex = output.length - 1;
        const previousHasHardBreak = previousIndex >= 0 && /( {2,}|\\)$/.test(output[previousIndex]);
        if (leadingSpaces >= activeList.continuationIndent) {
            if (previousHasHardBreak) {
                const visibleWhitespace = encodeVisibleListContinuationWhitespace(leadingWhitespace.slice(activeList.continuationIndent));
                output.push(`${" ".repeat(activeList.continuationIndent)}${visibleWhitespace}${lineContent}`);
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
//# sourceMappingURL=extension.js.map