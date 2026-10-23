'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SCRIPT = path.join(__dirname, '..', 'douban-exporter.user.js');
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');
const PKG = require('../package.json');

const ex = require('../douban-exporter.user.js');

// 所有用例共用模块级 state，统一在每条之前归零
test.beforeEach(function () {
    ex.resetState();
});

function makeDoc(html) {
    return new JSDOM('<!DOCTYPE html><html><body>' + html + '</body></html>', {
        url: 'https://book.douban.com/people/someone/collect'
    }).window.document;
}

/* ---------------------------- 元数据 ---------------------------- */

test('用户脚本头部声明完整，@match 只覆盖读过页', () => {
    assert.match(SOURCE, /^\/\/ ==UserScript==/m);
    assert.match(SOURCE, /^\/\/ @match\s+https:\/\/book\.douban\.com\/people\/\*\/collect\*/m);
    assert.match(SOURCE, /^\/\/ @grant\s+none/m);
});

test('脚本 @version 与 package.json 版本一致', () => {
    const m = SOURCE.match(/^\/\/ @version\s+(\S+)/m);
    assert.ok(m, '缺少 @version');
    assert.ok(
        PKG.version.startsWith(m[1]),
        'package.json 版本 ' + PKG.version + ' 与脚本 @version ' + m[1] + ' 不一致'
    );
});

/* ---------------------------- parsePub ---------------------------- */

// 豆瓣 .pub 的典型形态是「作者 / 译者 / 出版社 / 出版年 / 页数 / 定价 / 装帧」，
// 不同条目译者可能带「译」也可能不带，两种都在下面的用例里覆盖。
test('parsePub：取第一段作者，取出版年前一段为出版社', () => {
    const r = ex.parsePub('[美] 特德·姜 / 李克勤 / 译林出版社 / 2019-12 / 288页 / 42.00元 / 平装');
    assert.equal(r.author, '[美] 特德·姜');
    assert.equal(r.publisher, '译林出版社');
});

test('parsePub：译者带「译」标记时也不影响切分', () => {
    const r = ex.parsePub('[美] 特德·姜 / 李克勤 译 / 译林出版社 / 2019-12');
    assert.equal(r.author, '[美] 特德·姜');
    assert.equal(r.publisher, '译林出版社');
});

test('parsePub：多人合著用「、」连接，整段保留', () => {
    const r = ex.parsePub('张三、李四 / 王五 / 人民文学出版社 / 2011-1-1');
    assert.equal(r.author, '张三、李四');
    assert.equal(r.publisher, '人民文学出版社');
});

test('parsePub：没有译者时出版社仍取出版年前一段', () => {
    const r = ex.parsePub('特德·姜 / 译林出版社 / 2019-12');
    assert.equal(r.author, '特德·姜');
    assert.equal(r.publisher, '译林出版社');
});

test('parsePub：出版年支持 2011.1 / 2011年1月 等写法', () => {
    assert.equal(ex.parsePub('某人 / 某社 / 2011.1').publisher, '某社');
    assert.equal(ex.parsePub('某人 / 某社 / 2011年1月').publisher, '某社');
});

test('parsePub：没有出版年时按机构特征识别出版社', () => {
    assert.equal(ex.parsePub('某人 / 王五 / 中信出版社').publisher, '中信出版社');
    assert.equal(ex.parsePub('某人 / 王五 译 / 中信出版社').publisher, '中信出版社');
});

test('parsePub：认不出出版社时留空，宁可缺也不猜', () => {
    const r = ex.parsePub('某人 / 王五');
    assert.equal(r.author, '某人');
    assert.equal(r.publisher, '');
});

test('parsePub：定价不会被当成出版年', () => {
    const r = ex.parsePub('某人 / 某社 / 288页 / 2000.00元');
    assert.notEqual(r.publisher, '288页');
});

test('parsePub：空串与多余斜杠不炸', () => {
    assert.deepEqual(ex.parsePub(''), { author: '', publisher: '' });
    assert.deepEqual(ex.parsePub(' / /  '), { author: '', publisher: '' });
    assert.equal(ex.parsePub('只有作者').author, '只有作者');
});

/* -------------------------- parseMyRating -------------------------- */

function itemWithRating(inner) {
    return makeDoc('<li class="subject-item"><div class="info"><h2><a href="/subject/1/">书</a></h2>' +
        (inner || '') + '</div></li>').querySelector('.subject-item');
}

test('parseMyRating：解析 rating1-t ~ rating5-t', () => {
    for (let n = 1; n <= 5; n++) {
        assert.equal(ex.parseMyRating(itemWithRating('<span class="rating' + n + '-t"></span>')), String(n));
    }
});

test('parseMyRating：class 中夹带其它类名也能取到', () => {
    assert.equal(ex.parseMyRating(itemWithRating('<span class="rating5-t rating"></span>')), '5');
});

test('parseMyRating：均分与我的评分并存时只取我的评分', () => {
    const el = itemWithRating('<span class="allstar40 rating" title="豆瓣评分"></span>' +
        '<span class="rating5-t"></span>');
    assert.equal(ex.parseMyRating(el), '5');
});

test('parseMyRating：只有豆瓣均分时留空', () => {
    assert.equal(ex.parseMyRating(itemWithRating('<span class="allstar40 rating"></span>')), '');
});

test('parseMyRating：没有评分元素时返回空串', () => {
    assert.equal(ex.parseMyRating(itemWithRating('')), '');
});

/* ---------------------------- parseItem ---------------------------- */

const ITEM_HTML = `
<li class="subject-item">
  <div class="pic"><a class="nbg" href="https://book.douban.com/subject/35546737/"><img src="x.jpg"></a></div>
  <div class="info">
    <h2><a href="https://book.douban.com/subject/35546737/" title="你一生的故事">你一生的故事</a></h2>
    <div class="pub">[美] 特德·姜 / 李克勤 / 译林出版社 / 2019-12 / 288页 / 42.00元 / 平装</div>
    <span class="rating5-t"></span>
    <p class="comment">把语言学写成了一场关于宿命的推演<a class="expand" href="javascript:;">(展开)</a></p>
  </div>
</li>`;

test('parseItem：抽取标题、subject id、评分、作者、出版社、短评', () => {
    const r = ex.parseItem(makeDoc(ITEM_HTML).querySelector('.subject-item'));
    assert.equal(r.id, '35546737');
    assert.equal(r.title, '你一生的故事');
    assert.equal(r.myRating, '5');
    assert.equal(r.author, '[美] 特德·姜');
    assert.equal(r.publisher, '译林出版社');
    assert.equal(r.comment, '把语言学写成了一场关于宿命的推演');
});

test('parseItem：短评里的「展开」链接和 .hidden 节点被剔除', () => {
    const doc = makeDoc('<li class="subject-item"><div class="info">' +
        '<h2><a href="/subject/42/">书</a></h2>' +
        '<p class="comment">前半句<span class="hidden">后半句</span><a href="javascript:;">展开</a></p>' +
        '</div></li>');
    assert.equal(ex.parseItem(doc.querySelector('.subject-item')).comment, '前半句');
});

test('parseItem：没有短评时留空', () => {
    const doc = makeDoc('<li class="subject-item"><div class="info"><h2><a href="/subject/7/">书</a></h2></div></li>');
    assert.equal(ex.parseItem(doc.querySelector('.subject-item')).comment, '');
});

test('parseItem：没有 subject 链接时用标题兜底当 id', () => {
    const doc = makeDoc('<li class="subject-item"><div class="info"><h2><a>无名书</a></h2></div></li>');
    const r = ex.parseItem(doc.querySelector('.subject-item'));
    assert.equal(r.id, '无名书');
    assert.equal(r.title, '无名书');
});

/* ------------------------ collectFromDoc ------------------------ */

test('collectFromDoc：按 subject id 去重，并统计重复条数', () => {
    const doc = makeDoc(ITEM_HTML + ITEM_HTML.replace('你一生的故事', '你一生的故事（重复）'));
    const r = ex.collectFromDoc(doc);
    assert.equal(r.added, 1);
    assert.equal(r.total, 2);
    assert.equal(ex.state.rows.length, 1);
    assert.equal(ex.state.dupes, 1);
});

test('collectFromDoc：达到 limit 后停止收集', () => {
    ex.state.limit = 1;
    const doc = makeDoc(ITEM_HTML + ITEM_HTML.replace('/35546737/', '/999/'));
    ex.collectFromDoc(doc);
    assert.equal(ex.state.rows.length, 1);
});

test('collectFromDoc：跳过没有标题的条目', () => {
    const doc = makeDoc('<li class="subject-item"><div class="info"><h2><a href="/subject/1/"></a></h2></div></li>' +
        ITEM_HTML);
    assert.equal(ex.collectFromDoc(doc).added, 1);
});

/* ---------------------------- summarize ---------------------------- */

test('summarize：正常抓完到最后一页时自动下载', () => {
    const s = ex.summarize({ aborted: false, error: false, rows: [1, 2, 3], limit: Infinity, dupes: 0, cause: '' });
    assert.equal(s.autodownload, true);
    assert.equal(s.unsaved, false);
    assert.match(s.msg, /完成：3 本（已到最后一页）/);
});

test('summarize：达到设定数量时自动下载', () => {
    const s = ex.summarize({ aborted: false, error: false, rows: [1, 2], limit: 2, dupes: 0, cause: '' });
    assert.equal(s.autodownload, true);
    assert.match(s.msg, /达到设定数量/);
});

test('summarize：中止时不自动下载，已抓数据标为待保存', () => {
    const s = ex.summarize({ aborted: true, error: false, rows: [1, 2], limit: Infinity, dupes: 0, cause: '' });
    assert.equal(s.autodownload, false);
    assert.equal(s.unsaved, true);
    assert.match(s.msg, /已中止，当前 2 本/);
});

test('summarize：出错时不自动下载，并说明原因', () => {
    const s = ex.summarize({ aborted: false, error: true, rows: [1], limit: Infinity, dupes: 0, cause: '第 3 页 HTTP 403' });
    assert.equal(s.autodownload, false);
    assert.equal(s.unsaved, true);
    assert.match(s.msg, /已停止：第 3 页 HTTP 403/);
});

test('summarize：一本都没抓到时既不下载也不提示保存', () => {
    const s = ex.summarize({ aborted: false, error: false, rows: [], limit: Infinity, dupes: 0, cause: '' });
    assert.equal(s.autodownload, false);
    assert.equal(s.unsaved, false);
    assert.match(s.msg, /完成：0 本/);
});

test('summarize：重复条数写进文案', () => {
    const s = ex.summarize({ aborted: false, error: false, rows: [1], limit: Infinity, dupes: 3, cause: '' });
    assert.match(s.msg, /跳过重复 3 条/);
});

/* ------------------------------ CSV ------------------------------ */

test('toCSV：表头、BOM、CRLF、列顺序', () => {
    const csv = ex.toCSV([{ title: '书', myRating: '4', author: '甲', publisher: '乙出版社', comment: '短评' }]);
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines[0], '"书名","我的评分","作者","出版社","我的短评"');
    assert.equal(lines[1], '"书","4","甲","乙出版社","短评"');
    assert.equal(lines[lines.length - 1], '');
});

test('toCSV：逗号、引号、换行都被正确转义', () => {
    const csv = ex.toCSV([{ title: '书名,带逗号', myRating: '', author: 'A"B', publisher: 'x', comment: '第一行\n第二行' }]);
    assert.ok(csv.includes('"书名,带逗号"'));
    assert.ok(csv.includes('"A""B"'));
    assert.ok(csv.includes('"第一行\n第二行"'));
});

test('toCSV：null / undefined 写成空串而不是 "null"', () => {
    assert.equal(ex.toCSV([{ title: null, myRating: undefined }]).split('\r\n')[1], '"","","","",""');
});

test('toCSV：没有数据时只有表头', () => {
    const lines = ex.toCSV([]).slice(1).split('\r\n');
    assert.equal(lines.filter(Boolean).length, 1);
});

/* --------------------------- getNextUrl --------------------------- */

test('getNextUrl：解析下一页的相对链接', () => {
    const doc = makeDoc('<div class="paginator"><span class="next"><a href="?start=25&filter=all">后页</a></span></div>');
    assert.equal(
        ex.getNextUrl(doc, 'https://book.douban.com/people/someone/collect'),
        'https://book.douban.com/people/someone/collect?start=25&filter=all'
    );
});

test('getNextUrl：第 2 页之后以当前页 URL 为基准解析', () => {
    const doc = makeDoc('<div class="paginator"><span class="next"><a href="?start=50&filter=all">后页</a></span></div>');
    assert.equal(
        ex.getNextUrl(doc, 'https://book.douban.com/people/someone/collect?start=25&filter=all'),
        'https://book.douban.com/people/someone/collect?start=50&filter=all'
    );
});

test('getNextUrl：没有下一页时返回 null', () => {
    assert.equal(ex.getNextUrl(makeDoc('<div class="paginator"><span class="next">后页</span></div>')), null);
    assert.equal(ex.getNextUrl(makeDoc('')), null);
});

/* ------------------------- 浏览器环境冒烟 ------------------------- */

// 在 jsdom 里以「页面全局」执行脚本：没有 module 的普通页面和有 module 的页面都走一遍
function inPage(check, setup) {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://book.douban.com/people/someone/collect',
        runScripts: 'outside-only'
    });
    try {
        if (setup) setup(dom.window);
        dom.window.eval(SOURCE);
        check(dom.window.document);
    } finally {
        dom.window.close();
    }
}

test('浏览器全局下执行会注入面板，按钮初始为「开始导出」', () => {
    inPage(function (document) {
        const btn = document.querySelector('button');
        assert.ok(btn, '没有注入按钮');
        assert.equal(btn.textContent, '开始导出');
        assert.match(document.body.textContent, /豆瓣读过导出器/);
        assert.match(document.body.textContent, /抓完自动下载/);
    });
});

test('页面里已经存在 module 时仍然注入面板（@grant none 运行在页面上下文）', () => {
    // Tampermonkey 的 @grant none 会把脚本注入页面上下文，此时页面自己的 module 是可见的，
    // 不能据此判断「在 Node 里运行」。
    inPage(function (document) {
        assert.ok(document.querySelector('button'), '页面里有 module 时 UI 没注入');
    }, function (win) {
        win.module = { exports: {} };
    });
});
