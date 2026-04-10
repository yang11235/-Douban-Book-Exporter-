// ==UserScript==
// @name         豆瓣读书全量导出器 (自定义数量版)
// @namespace    http://tampermonkey.net/
// @version      7.0
// @description  支持自定义抓取数量，自动合并导出
// @author       Gemini
// @match        https://book.douban.com/people/*/collect*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 1. 获取数据并存入 localStorage
    function saveCurrentPageData(limit) {
        let savedData = JSON.parse(localStorage.getItem('douban_export_data') || '[]');
        const items = document.querySelectorAll('.subject-item');

        for (let item of items) {
            // 如果已达到限制数量，则停止抓取
            if (savedData.length >= limit) break;

            const title = item.querySelector('.info h2 a')?.innerText.trim() || '未知';
            const ratingEl = item.querySelector('.rating5-t, .rating4-t, .rating3-t, .rating2-t, .rating1-t');
            const rating = ratingEl ? ratingEl.className.replace('-t', '') : (item.querySelector('.rating_nums')?.innerText || '无评分');
            const pub = item.querySelector('.pub')?.innerText.trim() || '无信息';
            const comment = item.querySelector('.comment')?.innerText?.trim() || '无评价';

            savedData.push({ title, rating, pub, comment });
        }

        localStorage.setItem('douban_export_data', JSON.stringify(savedData));
        return savedData.length;
    }

    // 2. 下载 CSV
    function downloadCSV() {
        const data = JSON.parse(localStorage.getItem('douban_export_data') || '[]');
        let csv = "\uFEFF书名,评分,作者/出版信息,评价\n";
        data.forEach(r => {
            csv += `"${r.title.replace(/"/g, '""')}","${r.rating}","${r.pub.replace(/"/g, '""')}","${r.comment.replace(/"/g, '""')}"\n`;
        });

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "douban_partial_export.csv";
        link.click();

        localStorage.clear();
        alert("导出完成，已清理缓存！");
    }

    // 3. UI 初始化
    const btn = document.createElement('button');
    btn.style.cssText = 'position:fixed; top:20px; right:20px; z-index:99999; padding:15px; background:purple; color:white; border:none; cursor:pointer;';

    if (localStorage.getItem('isScraping') === 'true') {
        const limit = parseInt(localStorage.getItem('scrapeLimit'));
        const currentCount = saveCurrentPageData(limit);

        btn.innerHTML = `正在抓取 (${currentCount}/${limit})，点击停止`;
        btn.onclick = downloadCSV;

        const nextBtn = document.querySelector('.next a');
        if (currentCount < limit && nextBtn && nextBtn.href) {
            setTimeout(() => { window.location.href = nextBtn.href; }, 3000);
        } else {
            downloadCSV();
        }
    } else {
        btn.innerHTML = '【开始指定数量导出】';
        btn.onclick = () => {
            const count = prompt("请输入你想抓取的书籍总数（例如：50）：", "50");
            if (count) {
                localStorage.setItem('isScraping', 'true');
                localStorage.setItem('scrapeLimit', count);
                localStorage.setItem('douban_export_data', '[]');
                saveCurrentPageData(parseInt(count));

                const nextBtn = document.querySelector('.next a');
                if (nextBtn) window.location.href = nextBtn.href;
                else downloadCSV();
            }
        };
    }
    document.body.appendChild(btn);
})();
