#!/usr/bin/env node
/**
 * 给每个设了短名的空间生成一个「漂亮网址」的跳转页。
 *
 * 主链接一直是 space.html?space=<短名>——它读云端，永远是最新的内容，
 * 新建空间不用重新部署。这个脚本做的是**锦上添花的那一份**：
 *   space/notes/index.html  →  跳到 ../../space.html?space=notes
 *
 * 为什么要多这一层：跳转页是静态文件，微信、爬虫抓它的时候拿到的是
 * **这个空间自己的 title 和 og 描述**，而不是整站千篇一律的那份。
 * 主链接是同一个 HTML，做不到这点。
 *
 * 代价：改了空间名或摘要之后，这些页面的 og 会过期，重跑一次脚本再部署即可。
 * 短链不存在也不影响任何功能——它只是入口之一。
 *
 * 用法：node tools/gen-space-pages.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'space');

/** 内容会进到 HTML 属性里，必须转义，否则一个引号就能把页面结构冲破 */
function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function slugify(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    return raw
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
}

function firstText(blocks) {
    const list = Array.isArray(blocks) ? blocks : [];
    const hit = list.find((block) => block && block.type === 'text' && String(block.value || '').trim());
    if (!hit) return '';
    const text = String(hit.value).trim().replace(/\s+/g, ' ');
    return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

function pageHtml(space) {
    const slug = slugify(space.slug);
    const name = String(space.name || '').trim() || '未命名空间';
    const description = firstText(space.blocks);
    const target = `../../space.html?space=${encodeURIComponent(slug)}`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(name)} · Lyq</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta property="og:type" content="article">
    <meta property="og:title" content="${escapeHtml(name)} · Lyq">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:image" content="../../og-image.svg">
    <link rel="canonical" href="${escapeHtml(target)}">
    <meta http-equiv="refresh" content="0; url=${escapeHtml(target)}">
</head>
<body>
    <p>正在打开「${escapeHtml(name)}」……没有自动跳转的话，<a href="${escapeHtml(target)}">点这里继续</a>。</p>
</body>
</html>
`;
}

async function main() {
    // site.config.js 是 UMD 写法，require 之后值挂在 globalThis 上
    require(path.join(ROOT, 'site.config.js'));
    const config = globalThis.SITE_CONFIG || {};
    const endpoint = String(config.contentEndpoint || '').trim();

    if (!endpoint) {
        console.error('site.config.js 里没有 content-endpoint，读不到空间列表。');
        process.exit(1);
    }

    const response = await fetch(`${endpoint}?section=spaces&_=${Date.now()}`);
    if (!response.ok) throw new Error(`读取空间列表失败：HTTP ${response.status}`);
    const payload = await response.json();
    const items = (payload && payload.sections && payload.sections.spaces && payload.sections.spaces.items) || [];

    const named = items.filter((space) => slugify(space && space.slug));

    // 整个目录重建：空间改名或删掉之后，旧的短链文件不该留在那儿
    fs.rmSync(OUT_DIR, { recursive: true, force: true });

    if (named.length === 0) {
        console.log('还没有任何空间设置了短名，跳过生成（主链接 space.html?space=s1 这类仍然可用）。');
        return;
    }

    named.forEach((space) => {
        const slug = slugify(space.slug);
        const dir = path.join(OUT_DIR, slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), pageHtml(space), 'utf8');
        console.log(`  space/${slug}/index.html  →  ${String(space.name || '').trim() || '未命名空间'}`);
    });

    console.log(`\n生成了 ${named.length} 个短链页面，部署时记得把 space/ 目录一起传上去。`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
