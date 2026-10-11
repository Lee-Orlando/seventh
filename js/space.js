/**
 * 单个空间的展示页（space.html）。
 *
 * 只做一件事：按 ?space=短名 从云端把 spaces 区块取回来，找出对应空间，把它的
 * 文字块和图片块按顺序渲染出来。整页没有静态内容——内容全在云端，
 * 所以拿不到数据时必须如实说明，绝不能拿占位文字糊弄过去。
 *
 * 短名两种形式：
 *   space.html?space=notes   管理员在面板里填的短名
 *   space.html?space=s2      没填短名时按序号兜底（s1 是第一个空间）
 *
 * 与首页共用 css/styles.css，不引入任何第三方库。
 */
(function () {
    'use strict';

    const config = (function readConfig() {
        const raw = window.SITE_CONFIG;
        return raw && typeof raw === 'object' ? raw : {};
    }());

    /** 与首页同一套取值顺序：先 site.config.js，再 meta 兜底，且只认 http(s) */
    function endpoint() {
        const fromConfig = typeof config.contentEndpoint === 'string' ? config.contentEndpoint.trim() : '';
        if (/^https?:\/\//i.test(fromConfig)) return fromConfig;
        const meta = document.querySelector('meta[name="content-endpoint"]');
        return meta ? meta.content.trim() : '';
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

    /** 短名从地址栏来，必须自己解析，别信 location.search 之外的东西 */
    function requestedSlug() {
        const params = new URLSearchParams(window.location.search);
        return params.get('space') || '';
    }

    /**
     * 先按短名找，找不到再看是不是 s1 / s2 这种序号兜底。
     * 序号兜底存在的原因是：允许先建空间、以后再补短名，链接不至于当场失效。
     */
    function findSpace(items, wanted) {
        const list = Array.isArray(items) ? items : [];
        const slug = slugify(wanted);
        if (!slug) return null;

        const bySlug = list.find((item) => slugify(item && item.slug) === slug);
        if (bySlug) return bySlug;

        const asIndex = /^s(\d+)$/.exec(slug);
        if (asIndex) {
            const position = Number(asIndex[1]) - 1;
            if (position >= 0 && position < list.length) return list[position];
        }
        return null;
    }

    function safeUrl(value) {
        const url = String(value || '').trim();
        return /^https?:\/\/\S+$/i.test(url) ? url : '';
    }

    function firstTextOf(blocks) {
        const hit = blocks.find((block) => block && block.type === 'text' && String(block.value || '').trim());
        return hit ? String(hit.value).trim().replace(/\s+/g, ' ') : '';
    }

    function renderBlock(block) {
        if (!block) return null;

        if (block.type === 'image') {
            const url = safeUrl(block.url);
            if (!url) return null;

            const figure = document.createElement('figure');
            figure.className = 'space-media';

            const img = document.createElement('img');
            img.src = url;
            img.alt = String(block.alt || '');
            img.loading = 'lazy';
            img.decoding = 'async';
            figure.appendChild(img);

            const caption = String(block.alt || '').trim();
            if (caption) {
                const figcaption = document.createElement('figcaption');
                figcaption.textContent = caption;
                figure.appendChild(figcaption);
            }
            return figure;
        }

        const value = String(block.value || '').trim();
        if (!value) return null;
        const p = document.createElement('p');
        p.className = 'space-text';
        p.textContent = value;
        return p;
    }

    function setMeta(title, description) {
        document.title = `${title} · Lyq`;
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle) ogTitle.setAttribute('content', `${title} · Lyq`);
        // 分享出去的摘要：用空间里第一段文字，比千篇一律的站点描述有用
        if (description) {
            const summary = description.length > 100 ? `${description.slice(0, 100)}…` : description;
            const descTag = document.querySelector('meta[name="description"]');
            const ogDesc = document.querySelector('meta[property="og:description"]');
            if (descTag) descTag.setAttribute('content', summary);
            if (ogDesc) ogDesc.setAttribute('content', summary);
        }
    }

    function showNotice(message) {
        const notice = document.getElementById('spaceNotice');
        const body = document.getElementById('spaceBody');
        const title = document.getElementById('spaceTitle');
        if (title) title.hidden = true;
        if (body) body.hidden = true;
        if (notice) {
            notice.textContent = message;
            notice.hidden = false;
        }
    }

    /**
     * 把「编辑这个空间」的入口指向首页的编辑面板，并带上短名，
     * 这样首页一打开就自动打开抽屉、切到空间标签、并把这一条滚到眼前。
     */
    function wireEditLink(slug) {
        const fab = document.getElementById('adminFab');
        if (!fab || !slug) return;
        fab.href = `index.html?space=${encodeURIComponent(slug)}#edit`;
    }

    async function load() {
        const yearTag = document.getElementById('copyright-year');
        if (yearTag) yearTag.textContent = String(new Date().getFullYear());

        // 地址栏里写了哪个空间，编辑入口就跟着它走——链接先配好，
        // 万一后面云端取失败，至少点管理还能回到首页
        wireEditLink(slugify(requestedSlug()));

        const url = endpoint();
        if (!url) {
            showNotice('这个页面还没连上云端（site.config.js 里没填 content-endpoint），读不到空间内容。');
            return;
        }

        const wanted = requestedSlug();
        if (!wanted) {
            showNotice('链接里没有指定是哪个空间，回到首页选一个吧。');
            return;
        }

        let payload;
        try {
            // 存储桶的下载结果会被 CDN 缓存几分钟，加一次性时间戳跳过缓存，
            // 否则管理员刚改完的内容在这里会读成旧版本
            const response = await fetch(`${url}?section=spaces&_=${Date.now()}`, { method: 'GET' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            payload = await response.json();
        } catch (error) {
            showNotice('云端内容没取到，可能是网络问题。稍后刷新试试，或先回首页看看。');
            return;
        }

        const sections = payload && payload.sections ? payload.sections : {};
        const items = (sections.spaces && sections.spaces.items) || [];
        const space = findSpace(items, wanted);

        if (!space) {
            showNotice(`没找到对应的空间（${wanted}）。它可能已经被删掉或改了短名，回首页看看现在的空间列表。`);
            return;
        }

        const name = String(space.name || '').trim() || '未命名空间';
        const blocks = Array.isArray(space.blocks) ? space.blocks : [];
        setMeta(name, firstTextOf(blocks));

        const title = document.getElementById('spaceTitle');
        const body = document.getElementById('spaceBody');
        if (title) {
            title.textContent = name;
            title.hidden = false;
        }
        if (body) {
            body.textContent = '';
            body.hidden = false;
            const rendered = blocks.map(renderBlock).filter(Boolean);
            if (rendered.length === 0) {
                const empty = document.createElement('p');
                empty.className = 'space-text';
                empty.textContent = '这个空间还没有内容。';
                body.appendChild(empty);
            } else {
                rendered.forEach((node) => body.appendChild(node));
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', load);
    } else {
        load();
    }
}());
