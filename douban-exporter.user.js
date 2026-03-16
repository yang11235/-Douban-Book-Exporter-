// ==UserScript==
// @name         豆瓣读书最终修复版
// @namespace    http://tampermonkey.net/
// @version      7.1
// @description  修正导出后按钮残留问题，导出后自动刷新页面重置状态
// @author       Gemini
// @match        https://book.douban.com/people/*/collect*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 1. 下载 CSV 并重置状态
    function downloadCSV() {
        const data = JSON.parse(localStorage.getItem('douban_export_data') || '[]');
        let csv = "\uFEFF书名,评分,作者/出版信息,评价\n";
        data.forEach(r => {
            csv += `"${r.title.replace(/"/g, '""')}","${r.rating}","${r.pub.replace(/"/g, '""')}","${r.comment.replace(/"/g, '""')}"\n`;
        });

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "douban_export_final.csv";
        link.click();

        // --- 核心修复：清理所有状态并刷新页面 ---
        localStorage.removeItem('isScraping');
        localStorage.removeItem('douban_export_data');
        localStorage.removeItem('scrapeLimit');

        alert("全部导出完成，页面即将刷新以重置按钮状态！");
        location.reload(); // 强制刷新页面，让 UI 回到初始状态
    }

    // 2. UI 初始化
    const btn = document.createElement('button');
    btn.style.cssText = 'position:fixed; top:20px; right:20px; z-index:99999; padding:15px; background:green; color:white; border:none; cursor:pointer;';

    if (localStorage.getItem('isScraping') === 'true') {
        const limit = parseInt(localStorage.getItem('scrapeLimit'));
        const savedData = JSON.parse(localStorage.getItem('douban_export_data') || '[]');

        btn.innerHTML = `抓取中 (${savedData.length}/${limit})，点此停止`;
        btn.onclick = downloadCSV;

        // 自动翻页逻辑
        const nextBtn = document.querySelector('.next a');
        if (savedData.length < limit && nextBtn && nextBtn.href) {
            setTimeout(() => { window.location.href = nextBtn.href; }, 3000);
        } else {
            downloadCSV();
        }
    } else {
        btn.innerHTML = '【开始导出】';
        btn.onclick = () => {
            const count = prompt("请输入你想抓取的书籍总数：", "50");
            if (count) {
                localStorage.setItem('isScraping', 'true');
                localStorage.setItem('scrapeLimit', count);
                localStorage.setItem('douban_export_data', '[]');
                location.reload(); // 刷新以触发自动逻辑
            }
        };
    }
    document.body.appendChild(btn);
})();