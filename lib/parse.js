const { ask } = require('./fetch');

async function getBookInfo(url, json) {
  const $ = await ask(url);
  if (!$) return;

  let titles, authors, intro, chapurl, coverUrl;
  const patt = new RegExp('(.*)\\x20-\\x20(.*)\\x20-\\x20(.*)\\x20-\\x20(.*)');
  const match = patt.exec($('title').text());
  if (match) {
    titles = match[1];
    authors = match[2];
  }

  $('span[style="font-size:14px;"]').each((i, elem) => {
    intro = $(elem).text().trim();
  });

  $('a').each((i, elem) => {
    if ($(elem).text().trim() === '小说目录') {
      const href = $(elem).attr('href');
      if (href) {
        chapurl = new URL(href, url).href;
      }
    }
  });

  // 根据书号构造封面 URL：https://img.wenku8.com/image/{首数字}/{书ID}/{书ID}s.jpg
  const bookIdMatch = url.match(/\/book\/(\d+)\.htm/);
  if (bookIdMatch) {
    const bookId = bookIdMatch[1];
    coverUrl = `https://img.wenku8.com/image/${bookId[0]}/${bookId}/${bookId}s.jpg`;
  }
  // 无法从 URL 提取书号时回退到页面 DOM 查找
  if (!coverUrl) {
    const coverImg = $('#content').find('table').eq(1).find('img').first();
    if (coverImg.length) {
      const src = coverImg.attr('src');
      if (src) coverUrl = new URL(src, url).href;
    }
  }

  json.titles = titles;
  json.authors = authors;
  json.intro = intro || '暂无简介';
  json.coverUrl = coverUrl || null;
  json.content = {};
  if (chapurl) {
    await getChapList(chapurl, json);
  }
}

async function getChapList(url, json) {
  const $ = await ask(url);
  if (!$) return;

  let key;
  let p = 0;
  let v = -1;
  const patt = /(.*)index\.htm/;
  const realur = patt.exec(url)[1];

  $('td').each((i, elem) => {
    const $elem = $(elem);
    if ($elem.attr('class') === 'vcss') {
      v++;
      key = $elem.text().trim();
      json.content[v] = { volume: key, chapters: {} };
      p = 0;
    } else if ($elem.attr('class') === 'ccss' && $elem.find('a').length > 0) {
      const link = $elem.find('a').first();
      const title = link.text().trim();
      const href = realur + link.attr('href');
      json.content[v].chapters[p] = { title, href };
      p++;
    }
  });
}

module.exports = { getBookInfo, getChapList };
