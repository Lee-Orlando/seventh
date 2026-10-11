/**
 * 单个空间的展示页 + 就地编辑器（space.html）。
 *
 * 页面做两件事：
 *   1. 按 ?space=短名 从云端把 spaces 区块取回来，找出对应空间，按顺序渲染文字块和图片块。
 *   2. 提供这个空间自己的编辑器——改名字、加文字、传图片、排序，保存只回写这一个空间。
 *
 * 为什么不做成「点编辑跳回首页的抽屉面板」：站在这里改，看到的排版就是访客看到的排版，
 * 不用在抽屉里想象图片会落在哪。首页那个抽屉依然管整站文案和空间清单，两者互不依赖。
 *
 * 整页没有静态内容，内容全在云端。拿不到数据时必须如实说明，绝不能拿占位文字糊弄过去。
 *
 * 短名两种形式：
 *   space.html?space=notes   管理员填的短名
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
     * 返回下标而不是空间本身——保存时要知道该把哪一个写回去。
     */
    function findIndex(items, wanted) {
        const list = Array.isArray(items) ? items : [];
        const slug = slugify(wanted);
        if (!slug) return -1;

        const bySlug = list.findIndex((item) => slugify(item && item.slug) === slug);
        if (bySlug >= 0) return bySlug;

        const asIndex = /^s(\d+)$/.exec(slug);
        if (asIndex) {
            const position = Number(asIndex[1]) - 1;
            if (position >= 0 && position < list.length) return position;
        }
        return -1;
    }

    function safeUrl(value) {
        const url = String(value || '').trim();
        return /^https?:\/\/\S+$/i.test(url) ? url : '';
    }

    function firstTextOf(blocks) {
        const hit = blocks.find((block) => block && block.type === 'text' && String(block.value || '').trim());
        return hit ? String(hit.value).trim().replace(/\s+/g, ' ') : '';
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
    const MAX_BLOCKS = 30;

    /**
     * 后端按区块存文件，一个区块就是一个 JSON，所以保存 spaces 只能整份写回。
     * 这意味着这里必须留着完整的空间列表，改完再把当前这一个放回原位。
     * 代价是两个人同时改不同空间会互相覆盖——目前只有管理员一个人改，先接受。
     */
    const state = {
        items: [],
        index: -1,
        space: null,
        snapshot: '',
        editing: false
    };

    const el = {};

    function cacheDom() {
        el.title = document.getElementById('spaceTitle');
        el.body = document.getElementById('spaceBody');
        el.notice = document.getElementById('spaceNotice');
        el.editor = document.getElementById('spaceEditor');
        el.blocksHost = document.getElementById('editBlocks');
        el.nameInput = document.getElementById('editName');
        el.saveBtn = document.getElementById('editSave');
        el.cancelBtn = document.getElementById('editCancel');
        el.status = document.getElementById('editorStatus');
        el.fab = document.getElementById('adminFab');
        el.fabLabel = document.getElementById('adminFabLabel');
    }

    function setStatus(message, tone) {
        const node = el.status;
        if (!node) return;
        if (!message) {
            node.hidden = true;
            node.textContent = '';
            node.classList.remove('is-success', 'is-error');
            return;
        }
        node.textContent = message;
        node.hidden = false;
        node.classList.toggle('is-success', tone === 'success');
        node.classList.toggle('is-error', tone === 'error');
    }

    function showNotice(message) {
        if (el.title) el.title.hidden = true;
        if (el.body) el.body.hidden = true;
        if (el.editor) el.editor.hidden = true;
        if (el.fab) el.fab.hidden = true;
        if (el.notice) {
            el.notice.textContent = message;
            el.notice.hidden = false;
        }
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

    /* ---------------- 展示 ---------------- */

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

    function renderPublished() {
        const space = state.space;
        if (!space) return;
        const name = String(space.name || '').trim() || '未命名空间';
        const blocks = Array.isArray(space.blocks) ? space.blocks : [];

        setMeta(name, firstTextOf(blocks));

        if (el.title) {
            el.title.textContent = name;
            el.title.hidden = false;
        }
        if (el.body) {
            el.body.textContent = '';
            el.body.hidden = false;
            const rendered = blocks.map(renderBlock).filter(Boolean);
            if (rendered.length === 0) {
                const empty = document.createElement('p');
                empty.className = 'space-text';
                empty.textContent = '这个空间还没有内容。';
                el.body.appendChild(empty);
            } else {
                rendered.forEach((node) => el.body.appendChild(node));
            }
        }
    }

    /* ---------------- 编辑 ---------------- */

    function blocks() {
        return state.space && Array.isArray(state.space.blocks) ? state.space.blocks : [];
    }

    function isDirty() {
        return JSON.stringify(state.space || {}) !== state.snapshot;
    }

    function emptyBlock(kind) {
        return kind === 'image'
            ? { type: 'image', url: '', alt: '' }
            : { type: 'text', value: '' };
    }

    function buildTextEditor(order, block) {
        const group = document.createElement('div');
        group.className = 'form-group';

        const label = document.createElement('label');
        label.textContent = `第 ${order + 1} 块文字`;
        const id = `s-text-${Math.random().toString(36).slice(2, 8)}`;
        label.htmlFor = id;

        const area = document.createElement('textarea');
        area.id = id;
        area.rows = 3;
        area.maxLength = 2000;
        area.value = block.value || '';
        area.setAttribute('data-block-field', 'value');

        group.append(label, area);
        return group;
    }

    function buildImageEditor(order, block) {
        const group = document.createElement('div');
        group.className = 'form-group';

        const label = document.createElement('label');
        label.textContent = `第 ${order + 1} 块图片`;
        const id = `s-img-${Math.random().toString(36).slice(2, 8)}`;
        label.htmlFor = id;

        const picker = document.createElement('input');
        picker.type = 'file';
        picker.id = id;
        picker.accept = IMAGE_MIME_TYPES.join(',');
        picker.className = 'block-file';
        picker.setAttribute('data-block-file', '');
        picker.setAttribute('data-block-index', String(order));

        group.append(label, picker);

        // 已经传过的图，把缩略图摆出来，才知道这块到底放了什么
        const url = safeUrl(block.url);
        if (url) {
            const preview = document.createElement('img');
            preview.className = 'block-preview';
            preview.src = url;
            preview.alt = block.alt || '已上传的图片';
            group.appendChild(preview);
        }

        const altLabel = document.createElement('label');
        altLabel.textContent = '图片说明（会显示在图下方，可留空）';
        const altId = `${id}-alt`;
        altLabel.htmlFor = altId;

        const alt = document.createElement('input');
        alt.type = 'text';
        alt.id = altId;
        alt.maxLength = 120;
        alt.autocomplete = 'off';
        alt.placeholder = '例如：凌晨四点的自习室';
        alt.value = block.alt || '';
        alt.setAttribute('data-block-field', 'alt');

        group.append(altLabel, alt);

        if (url) {
            const hint = document.createElement('span');
            hint.className = 'field-hint is-link';
            hint.textContent = url;
            group.appendChild(hint);
        }

        return group;
    }

    function buildBlockRow(block, order) {
        const row = document.createElement('div');
        row.className = 'block-editor';
        row.setAttribute('data-block', String(order));

        const head = document.createElement('div');
        head.className = 'block-head';

        const kind = document.createElement('span');
        kind.className = `block-kind is-${block.type}`;
        kind.textContent = block.type === 'image' ? '图片' : '文字';

        const controls = document.createElement('div');
        controls.className = 'item-controls';

        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'icon-button';
        up.textContent = '↑';
        up.disabled = order === 0;
        up.setAttribute('aria-label', '把这块内容上移');
        up.addEventListener('click', () => moveBlock(order, -1));

        const down = document.createElement('button');
        down.type = 'button';
        down.className = 'icon-button';
        down.textContent = '↓';
        down.disabled = order === blocks().length - 1;
        down.setAttribute('aria-label', '把这块内容下移');
        down.addEventListener('click', () => moveBlock(order, 1));

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'icon-button is-danger';
        remove.textContent = '删除';
        remove.setAttribute('aria-label', '删除这块内容');
        remove.addEventListener('click', () => removeBlock(order));

        controls.append(up, down, remove);
        head.append(kind, controls);
        row.appendChild(head);

        row.appendChild(block.type === 'image' ? buildImageEditor(order, block) : buildTextEditor(order, block));
        return row;
    }

    function renderEditor() {
        if (!el.blocksHost) return;
        const host = el.blocksHost;
        host.textContent = '';

        const list = document.createElement('div');
        list.className = 'block-editor-list';
        list.setAttribute('data-block-list', '');
        blocks().forEach((block, order) => list.appendChild(buildBlockRow(block, order)));
        host.appendChild(list);

        const actions = document.createElement('div');
        actions.className = 'block-actions';

        const addText = document.createElement('button');
        addText.type = 'button';
        addText.className = 'ghost-button';
        addText.textContent = '+ 加一段文字';
        addText.addEventListener('click', () => addBlock('text'));

        const addImage = document.createElement('button');
        addImage.type = 'button';
        addImage.className = 'ghost-button';
        addImage.textContent = '+ 加一张图片';
        addImage.addEventListener('click', () => addBlock('image'));

        actions.append(addText, addImage);
        host.appendChild(actions);
    }

    function addBlock(kind) {
        if (blocks().length >= MAX_BLOCKS) {
            setStatus(`一个空间最多 ${MAX_BLOCKS} 块内容。`, 'error');
            return;
        }
        blocks().push(emptyBlock(kind));
        renderEditor();
        setStatus('加好了，记得点保存。');
    }

    function removeBlock(order) {
        blocks().splice(order, 1);
        renderEditor();
    }

    function moveBlock(order, delta) {
        const list = blocks();
        const target = order + delta;
        if (target < 0 || target >= list.length) return;
        [list[order], list[target]] = [list[target], list[order]];
        renderEditor();
    }

    /**
     * 选图 → 读成 base64 → 交给云函数 → 拿回可以直接 <img src> 的地址。
     * 图片不塞进内容 JSON，而是单独落在 site/media/ 下，否则内容文件会迅速膨胀。
     */
    async function uploadImage(order, file) {
        if (!file) return;
        if (!IMAGE_MIME_TYPES.includes(file.type)) {
            setStatus('只支持 PNG / JPG / GIF / WebP 图片。', 'error');
            return;
        }
        if (file.size > MAX_IMAGE_BYTES) {
            setStatus(`这张图 ${(file.size / 1024 / 1024).toFixed(2)}MB，超过 2MB 上限，先压缩一下。`, 'error');
            return;
        }

        const url = endpoint();
        if (!url) {
            setStatus('还没配置 content-endpoint，图片没地方存。', 'error');
            return;
        }

        setStatus('图片上传中…');
        try {
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(new Error('读不出这张图'));
                reader.readAsDataURL(file);
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'upload', mimeType: file.type, data: dataUrl })
            });
            const data = await response.json().catch(() => null);

            if (!response.ok || !data || !data.ok) {
                setStatus((data && data.message) || `上传失败（${response.status}）`, 'error');
                return;
            }

            const block = blocks()[order];
            if (!block) return;
            block.url = data.url;
            renderEditor();
            setStatus('图片已上传，记得点保存。', 'success');
        } catch (error) {
            setStatus(error.message || '图片上传失败，重试一次试试。', 'error');
        }
    }

    function startEditing() {
        state.editing = true;
        if (el.nameInput) el.nameInput.value = String(state.space.name || '');
        renderEditor();
        if (el.body) el.body.hidden = true;
        if (el.editor) el.editor.hidden = false;
        if (el.fabLabel) el.fabLabel.textContent = '结束编辑';
        if (el.fab) el.fab.classList.add('is-active');
        setStatus('');
        if (el.nameInput) el.nameInput.focus();
    }

    /** 退出编辑：把空间恢复成进入编辑前的样子，没保存的改动一律丢掉 */
    function stopEditing() {
        state.editing = false;
        state.items[state.index] = JSON.parse(state.snapshot);
        state.space = state.items[state.index];
        if (el.editor) el.editor.hidden = true;
        if (el.fabLabel) el.fabLabel.textContent = '编辑这个空间';
        if (el.fab) el.fab.classList.remove('is-active');
        renderPublished();
    }

    function cancelEditing() {
        if (isDirty() && !window.confirm('有改动还没保存，确定放弃？')) return;
        stopEditing();
        setStatus('已放弃改动。');
    }

    function toggleEditing() {
        if (!state.space) return;
        if (state.editing) cancelEditing();
        else startEditing();
    }

    async function postSpaces(items) {
        const url = endpoint();
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ section: 'spaces', content: { items } })
            });
            const data = await response.json().catch(() => null);
            if (response.ok && data && data.ok) return { ok: true, message: data.message || '已保存' };
            return {
                ok: false,
                errors: (data && data.errors) || null,
                message: (data && data.message) || `保存失败（${response.status}）`
            };
        } catch {
            return { ok: false, message: '网络不太顺畅，没能连上云端。' };
        }
    }

    async function save() {
        if (!state.space) return;
        if (!endpoint()) {
            setStatus('还没配置 content-endpoint（见 site.config.js），现在改的内容不会保存。', 'error');
            return;
        }

        if (el.saveBtn) {
            el.saveBtn.disabled = true;
            el.saveBtn.textContent = '保存中…';
        }

        // 整份列表写回，但只把当前这一个换成改过的版本
        const payload = state.items.map(clone);
        payload[state.index] = clone(state.space);
        const result = await postSpaces(payload);

        if (el.saveBtn) {
            el.saveBtn.disabled = false;
            el.saveBtn.textContent = '保存这个空间';
        }

        if (!result.ok) {
            if (result.errors) {
                const messages = Object.keys(result.errors).map((name) => result.errors[name]).slice(0, 3);
                setStatus(`${result.message}：${messages.join('；')}`, 'error');
            } else {
                setStatus(result.message, 'error');
            }
            return;
        }

        state.items = payload;
        state.space = payload[state.index];
        state.snapshot = JSON.stringify(state.space);
        state.editing = false;
        if (el.editor) el.editor.hidden = true;
        if (el.fabLabel) el.fabLabel.textContent = '编辑这个空间';
        if (el.fab) el.fab.classList.remove('is-active');
        renderPublished();
        setStatus('已保存，访客刷新即可看到。', 'success');
    }

    function wireEvents() {
        if (el.fab) el.fab.addEventListener('click', toggleEditing);
        if (el.saveBtn) el.saveBtn.addEventListener('click', save);
        if (el.cancelBtn) el.cancelBtn.addEventListener('click', cancelEditing);

        if (el.nameInput) {
            el.nameInput.addEventListener('input', () => {
                if (state.space) state.space.name = el.nameInput.value;
            });
        }

        if (!el.editor) return;

        el.editor.addEventListener('input', (event) => {
            const field = event.target.closest('[data-block-field]');
            if (!field) return;
            const row = field.closest('[data-block]');
            if (!row) return;
            const block = blocks()[Number(row.getAttribute('data-block'))];
            if (!block) return;
            block[field.getAttribute('data-block-field')] = field.value;
        });

        // 选文件的 input 不触发 'input'，单独监听 'change'
        el.editor.addEventListener('change', (event) => {
            const picker = event.target.closest('[data-block-file]');
            if (!picker) return;
            const row = picker.closest('[data-block]');
            if (!row) return;
            const order = Number(row.getAttribute('data-block'));
            uploadImage(order, picker.files && picker.files[0]);
            // 清空才能重复选同一个文件——否则第二次选它不会再触发 change
            picker.value = '';
        });
    }

    async function load() {
        const yearTag = document.getElementById('copyright-year');
        if (yearTag) yearTag.textContent = String(new Date().getFullYear());

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
        } catch {
            showNotice('云端内容没取到，可能是网络问题。稍后刷新试试，或先回首页看看。');
            return;
        }

        const sections = payload && payload.sections ? payload.sections : {};
        const items = (sections.spaces && sections.spaces.items) || [];
        const index = findIndex(items, wanted);

        if (index < 0) {
            showNotice(`没找到对应的空间（${wanted}）。它可能已经被删掉或改了短名，回首页看看现在的空间列表。`);
            return;
        }

        state.items = items;
        state.index = index;
        state.space = items[index];
        state.snapshot = JSON.stringify(state.space);

        renderPublished();

        // 内容到手了才把编辑入口放出来——不知道在改什么的时候开着编辑器只会误导
        if (el.fab) el.fab.hidden = false;
    }

    cacheDom();
    wireEvents();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', load);
    } else {
        load();
    }
}());
