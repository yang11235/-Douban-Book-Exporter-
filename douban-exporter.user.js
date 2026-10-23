// ==UserScript==
// @name         豆瓣读过导出器 v8
// @namespace    https://github.com/yang11235
// @version      8.6
// @description  导出豆瓣"读过"列表为 CSV（书名 / 我的评分 / 作者 / 出版社 / 我的短评）：单页内翻页、按 subject id 去重、抓完自动下载
// @author       yang11235
// @match        https://book.douban.com/people/*/collect*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * v8 与 v7 的主要差别：
 * 1. 不再用 window.location.href 翻页 —— 改为同源 fetch + DOMParser，页面不跳转，进度不丢。
 * 2. 用 subject id 去重，重复解析同一页不会重复计数。
 * 3. 只取「我的评分」(1-5)，不再把豆瓣均分混进同一列。
 * 4. 作者只取 pub 的第一段（不含译者），出版社取出版年前一段。
 * 5. 遇到验证码页、登录跳转、HTTP 错误会明确停下并说明原因，不会假报"导出完成"。
 * 6. 不调用 localStorage.clear()，不碰豆瓣站点的其它本地数据。
 * 7. 正常抓完自动下载 CSV；中止或中途出错不自动下载，按钮就地变成「保存已抓 N 本」，只有一个按钮。
 */

(function () {
    'use strict';

    var CONFIG = {
        minDelay: 1500,      // 翻页间隔下限（毫秒）
        maxDelay: 3000,      // 翻页间隔上限
        maxPages: 200,       // 安全上限，防止死循环
        debug: false         // true 时在控制台打印第一条的 outerHTML，用来核对选择器
    };

    var state = {
        rows: [],
        seen: Object.create(null),
        dupes: 0,
        limit: Infinity,
        running: false,
        aborted: false,
        error: false,
        cause: '',
        unsaved: false       // 已抓但还没落盘的数据
    };

    // 开始新一轮抓取前把状态归零。run() 和测试都走这一份，避免两处各写一套字段。
    function resetState() {
        state.rows = [];
        state.seen = Object.create(null);
        state.dupes = 0;
        state.limit = Infinity;
        state.running = false;
        state.aborted = false;
        state.error = false;
        state.cause = '';
        state.unsaved = false;
    }

    /* ------------------------- 解析 ------------------------- */

    function txt(el) {
        if (!el) return '';
        return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // 豆瓣用 rating1-t ~ rating5-t 这个 sprite class 表示"我的评分"
    // 注意 class 里可能还带别的类名，所以用正则取数字，不能直接 replace('-t','')
    function parseMyRating(item) {
        var el = item.querySelector('[class*="rating"][class*="-t"]');
        if (!el) return '';
        var m = (el.className || '').match(/rating([0-5])-t/);
        return m ? m[1] : '';
    }

    // 豆瓣的 pub 结构固定为：作者块 / 译者块 / 出版社 / 出版年 / 页数 / 定价 / 装帧
    // 同一角色多人时用「、」连接，不同角色之间才用「 / 」分隔。
    // 所以：作者 = 第一段（只取第一段，不能把后面的译者块并进来），出版社 = 出版年前一段。
    function parsePub(raw) {
        var parts = raw.split('/').map(function (s) { return s.trim(); }).filter(Boolean);
        var out = { author: '', publisher: '' };
        if (!parts.length) return out;

        out.author = parts[0];

        // 出版年宽松匹配：2011、2011-1、2011-1-1、2011.1、2011年1月 都算
        // 定价 "2000.00元" 也会被这个正则命中，用「元」结尾排除掉
        var YEAR = /^\d{4}(\s*$|[-./年])/;
        var yearIdx = -1;
        for (var i = 1; i < parts.length; i++) {
            if (YEAR.test(parts[i]) && !/元\s*$/.test(parts[i])) { yearIdx = i; break; }
        }

        if (yearIdx > 1) {
            out.publisher = parts[yearIdx - 1];
        } else {
            // 找不到出版年时不做位置猜测，只认带机构特征的片段；
            // 认不出来就留空——宁可缺，也不要把译者写进出版社
            var PUB_KEY = /(出版社|出版公司|出版集团|出版|书局|书店|Press|Books|Publishing|Verlag|大学|文艺|译文|译林|人民|中信|三联|商务|KADOKAWA)/i;
            for (var j = 1; j < parts.length; j++) {
                if (PUB_KEY.test(parts[j])) { out.publisher = parts[j]; break; }
            }
        }
        return out;
    }

    function parseItem(item) {
        var link = item.querySelector('h2 a') || item.querySelector('a.nbg');
        var href = link ? (link.getAttribute('href') || '') : '';
        var idMatch = href.match(/\/subject\/(\d+)/);

        // 短评可能带"展开"链接，textContent 会把"展开"两个字一起带出来，先删掉
        var comment = '';
        var commentEl = item.querySelector('.comment');
        if (commentEl) {
            var clone = commentEl.cloneNode(true);
            clone.querySelectorAll('.expand, .hidden, a[href^="javascript"]').forEach(function (n) {
                n.remove();
            });
            comment = txt(clone);
        }

        var title = txt(item.querySelector('h2 a'));
        var pub = parsePub(txt(item.querySelector('.pub')));

        return {
            id: idMatch ? idMatch[1] : (href || title),
            title: title,
            myRating: parseMyRating(item),
            author: pub.author,
            publisher: pub.publisher,
            comment: comment
        };
    }

    function collectFromDoc(doc) {
        var items = doc.querySelectorAll('.subject-item');
        var added = 0;
        for (var i = 0; i < items.length; i++) {
            if (state.rows.length >= state.limit) break;
            var row = parseItem(items[i]);
            if (!row.title) continue;
            if (state.seen[row.id]) { state.dupes++; continue; }
            state.seen[row.id] = true;
            state.rows.push(row);
            added++;
        }
        return { added: added, total: items.length };
    }

    function getNextUrl(doc, base) {
        var a = doc.querySelector('.paginator .next a') || doc.querySelector('.next a');
        if (!a) return null;
        var href = a.getAttribute('href');
        if (!href) return null;
        var b = base || (typeof location !== 'undefined' ? location.href : '');
        try { return new URL(href, b).href; } catch (e) { return null; }
    }

    /* ------------------------- 抓取流程 ------------------------- */

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function rand(a, b) { return Math.floor(a + Math.random() * (b - a)); }

    async function run(limit) {
        resetState();
        state.running = true;
        state.limit = limit;
        render();

        // 第 1 页直接用当前文档，不用再请求一次
        collectFromDoc(document);

        var nextUrl = getNextUrl(document);
        var lastUrl = location.href;
        var page = 1;

        if (CONFIG.debug && state.rows.length) {
            console.log('[豆瓣导出器] 第一条原始 HTML：', document.querySelector('.subject-item').outerHTML);
        }

        while (!state.aborted && state.rows.length < state.limit && nextUrl) {
            if (nextUrl === lastUrl) break;                 // 翻页链接指向自己，停
            if (page >= CONFIG.maxPages) {
                state.error = true;
                state.cause = '达到页数安全上限 ' + CONFIG.maxPages + ' 页';
                break;
            }

            setStatus('已抓 ' + state.rows.length + ' 本，等待翻页…');
            await sleep(rand(CONFIG.minDelay, CONFIG.maxDelay));
            if (state.aborted) break;

            var res;
            try {
                res = await fetch(nextUrl, { credentials: 'same-origin' });
            } catch (e) {
                state.error = true;
                state.cause = '网络请求失败：' + e.message;
                break;
            }

            if (/accounts\.douban\.com/.test(res.url)) {
                state.error = true;
                state.cause = '被重定向到登录页，请先登录豆瓣';
                break;
            }
            if (!res.ok) {
                state.error = true;
                state.cause = '第 ' + (page + 1) + ' 页 HTTP ' + res.status;
                break;
            }

            var doc = new DOMParser().parseFromString(await res.text(), 'text/html');
            var r = collectFromDoc(doc);

            if (r.total === 0) {
                state.error = true;
                state.cause = '第 ' + (page + 1) + ' 页解析到 0 本（大概是验证码页）';
                break;
            }

            lastUrl = nextUrl;
            nextUrl = getNextUrl(doc, lastUrl);
            page++;
            render();
        }

        state.running = false;

        var s = summarize(state);

        // 正常抓完就直接下载，不再要求用户点第二次。
        // 中止或中途出错时不自动下载——避免把残缺数据当成完整结果，改为把按钮切成「保存已抓 N 本」。
        if (s.autodownload) {
            download();
            state.unsaved = false;
            s.msg += '；CSV 已开始下载';
        } else if (s.unsaved) {
            state.unsaved = true;
            s.msg += '；点按钮保存已抓部分';
        }

        setStatus(s.msg);
        render();
    }

    // 抓取结束后的收尾判断：文案 + 是否自动下载 + 是否留下未保存数据。
    // 抽成纯函数，这样「中止/出错不自动下载」这条规则能脱离浏览器单独测。
    function summarize(st) {
        var msg;
        if (st.aborted) {
            msg = '已中止，当前 ' + st.rows.length + ' 本';
        } else if (st.error) {
            msg = '已停止：' + st.cause + '（已抓 ' + st.rows.length + ' 本）';
        } else if (st.rows.length >= st.limit) {
            msg = '完成：' + st.rows.length + ' 本（达到设定数量）';
        } else {
            msg = '完成：' + st.rows.length + ' 本（已到最后一页）';
        }
        if (st.dupes) msg += '，跳过重复 ' + st.dupes + ' 条';

        var auto = !st.aborted && !st.error && st.rows.length > 0;
        return { msg: msg, autodownload: auto, unsaved: !auto && st.rows.length > 0 };
    }

    /* ------------------------- 导出 ------------------------- */

    function esc(v) {
        return '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
    }

    function toCSV(rows) {
        var head = ['书名', '我的评分', '作者', '出版社', '我的短评'];
        var lines = [head.map(esc).join(',')];
        rows.forEach(function (r) {
            lines.push([r.title, r.myRating, r.author, r.publisher, r.comment].map(esc).join(','));
        });
        return '\uFEFF' + lines.join('\r\n') + '\r\n';
    }

    function download() {
        if (!state.rows.length) return;
        var blob = new Blob([toCSV(state.rows)], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        var d = new Date();
        var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
        a.href = url;
        a.download = '豆瓣读过_' + state.rows.length + '本_' + stamp + '.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    }

    /* ---------------------- 出口（仅 Node 测试用） ---------------------- */

    // 只有 Node 里 require 时走这条路：导出内部函数供测试，然后立刻返回，不执行下面的 DOM 代码。
    // 浏览器里 window 一定存在，这里恒为 false。
    if (typeof window === 'undefined' &&
        typeof process !== 'undefined' && process.versions && process.versions.node) {
        module.exports = {
            parsePub: parsePub,
            parseMyRating: parseMyRating,
            parseItem: parseItem,
            collectFromDoc: collectFromDoc,
            getNextUrl: getNextUrl,
            toCSV: toCSV,
            esc: esc,
            summarize: summarize,
            state: state,
            resetState: resetState
        };
        return;
    }

    /* ------------------------- UI ------------------------- */

    // 这一段刻意留在顶层直接执行，不包进函数。
    // v8.4 就是这样，实测可用；包成 initUI() 再调用会改变执行路径，
    // 出现过「面板不注入且无报错」的情况，不要再改回函数。

    var VERSION = '8.6';
    if (typeof console !== 'undefined') console.log('[豆瓣导出器] v' + VERSION + ' 已加载');

    var panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:20px;top:80px;z-index:2147483647;width:212px;padding:12px 14px;' +
        'border-radius:10px;background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.18);' +
        'font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#2b2b2b;';

    var titleEl = document.createElement('div');
    titleEl.textContent = '豆瓣读过导出器 v' + VERSION;
    titleEl.style.cssText = 'font-weight:600;margin-bottom:6px;';

    var statusEl = document.createElement('div');
    statusEl.style.cssText = 'color:#555;font-size:12px;min-height:34px;margin-bottom:8px;';

    var runBtn = document.createElement('button');
    runBtn.style.cssText = 'width:100%;padding:8px 0;border:none;border-radius:6px;background:#2f6f4f;' +
        'color:#fff;font-size:13px;cursor:pointer;';

    panel.appendChild(titleEl);
    panel.appendChild(statusEl);
    panel.appendChild(runBtn);
    document.body.appendChild(panel);

    function setStatus(msg) { statusEl.textContent = msg; }

    // 只有一个按钮。正常抓完会自动下载；中止/出错时这个按钮就地变成「保存已抓 N 本」，
    // 存完再变回「开始导出」，所以既不用第二个按钮，也不会丢已抓的数据。
    function render() {
        if (state.running) {
            runBtn.textContent = '中止';
        } else if (state.unsaved && state.rows.length) {
            runBtn.textContent = '保存已抓 ' + state.rows.length + ' 本';
        } else {
            runBtn.textContent = '开始导出';
        }
        if (state.running) {
            statusEl.textContent = '已抓 ' + state.rows.length + ' 本' +
                (state.limit === Infinity ? '' : ' / ' + state.limit);
        }
    }

    runBtn.onclick = function () {
        if (state.running) { state.aborted = true; setStatus('正在中止…'); return; }

        // 没存盘的中途数据：点一下就落盘
        if (state.unsaved && state.rows.length) {
            download();
            state.unsaved = false;
            setStatus('已保存 ' + state.rows.length + ' 本');
            render();
            return;
        }

        var input = prompt('导出多少本？留空 = 全部', '');
        if (input === null) return;
        input = input.trim();

        var limit = Infinity;
        if (input !== '') {
            limit = parseInt(input, 10);
            if (!isFinite(limit) || limit <= 0) { alert('请输入正整数，或留空导出全部'); return; }
        }
        run(limit);
    };

    // 顺手清掉 v7 留下的三个 key（v7 的 localStorage.clear() 可能已把它们抹掉，这里只是兜底）
    ['isScraping', 'scrapeLimit', 'douban_export_data'].forEach(function (k) {
        try { localStorage.removeItem(k); } catch (e) {}
    });

    setStatus('点「开始导出」，数量留空 = 全部；抓完自动下载');
    render();
})();
