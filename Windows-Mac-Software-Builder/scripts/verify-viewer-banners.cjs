'use strict';
const fs = require('fs'); // ASAR-aware when checking the installed Viewer.
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function verifyViewerBanners({ BrowserWindow, applicationRoot }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-banners-'));
  const renderer = fs.readFileSync(path.join(applicationRoot, 'src/viewer/renderer.js'), 'utf8').replace(/\r?\nboot\(\);\s*$/, '\n');
  const html = fs.readFileSync(path.join(applicationRoot, 'src/viewer/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace('<link rel="stylesheet" href="styles.css" />', () => '<style>' + fs.readFileSync(path.join(applicationRoot, 'src/viewer/styles.css'), 'utf8') + '</style>')
    .replace('<link rel="stylesheet" href="../shared/author.css" />', () => '<style>' + fs.readFileSync(path.join(applicationRoot, 'src/shared/author.css'), 'utf8') + '</style>')
    .replace('../shared/antonio-fradique.webp', () => 'data:image/webp;base64,' + fs.readFileSync(path.join(applicationRoot, 'src/shared/antonio-fradique.webp')).toString('base64'));
  const file = path.join(temporary, 'viewer.html');
  fs.writeFileSync(file, html);
  const gifPath = path.resolve(__dirname, '../tests/fixtures/banner-animated.gif');
  const dict = JSON.parse(fs.readFileSync(path.join(applicationRoot, 'locales/pt.json'), 'utf8'));
  const win = new BrowserWindow({width:1280, height:820, show:false, webPreferences:{sandbox:true,contextIsolation:true,
    nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  const run = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const navigations = [], crashes = [];
  async function until(condition) {
    for (let i=0;i<100;i++) { if(await run(condition))return; await wait(25); }
    throw new Error('Banner UI condition timed out: '+condition);
  }
  async function pointer(selector) {
    const point = await run(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...point});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  }
  try {
    await win.loadFile(file);win.show?.();win.focus?.();win.webContents.focus?.();
    win.webContents.on('did-start-navigation', (_e,url,_inPlace,main) => {if(main)navigations.push(url);});
    win.webContents.on('render-process-gone', (_e,detail) => crashes.push(detail.reason));
    await run(`window.qa={opened:[],writes:0,errors:[]};
      addEventListener('error',e=>qa.errors.push(String(e.error||e.message)));
      addEventListener('unhandledrejection',e=>qa.errors.push(String(e.reason)));
      window.viewer={resolveAssetPath:async()=>${JSON.stringify(gifPath)},openExternal:async url=>qa.opened.push(url),
        saveState:async()=>qa.writes++,loadLocale:async()=>({dict:${JSON.stringify(dict)}})};void 0;`);
    await run(renderer);
    await until("document.querySelector('.author-photo').complete && document.querySelector('.author-photo').naturalWidth>0");
    await run("wireCornerLinks();document.querySelector('.author-card a').click();void 0;");
    assert.deepEqual(await run('qa.opened'),['https://AntonioFradique.net']);
    await run('qa.opened=[];void 0;');
    await run(`i18nDict=${JSON.stringify(dict)};config={brand:{},content:[]};
      qa.banners={top:{enabled:true,dismissible:true,image:'top.gif',url:'https://example.org'},
        bottom:{enabled:true,dismissible:true,image:'bottom.gif'}};
      renderArticle({text:'Keep the open content'});renderBanner(qa.banners);`);
    await until("[...document.querySelectorAll('.banner-bar img')].length===2 && [...document.querySelectorAll('.banner-bar img')].every(img=>img.complete&&img.naturalWidth===728&&img.naturalHeight===90)");
    assert.equal(await run("document.querySelectorAll('.banner-close').length"),2);
    assert.equal(await run("document.querySelector('#banner-top .banner-close').getAttribute('aria-label')"), dict.banner.close_top);
    await wait(220); // Let the existing 150 ms padding transition settle.
    const initialHeight = await run("document.getElementById('viewer-stage').getBoundingClientRect().height");
    // Capture rendered pixels, rather than drawing GIFs to a canvas (which may
    // return only the first frame). Both fixture frames must actually display.
    const point = await run("(()=>{const r=document.querySelector('#banner-top img').getBoundingClientRect();return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2),width:1,height:1};})()");
    const colors=new Set();
    for(let i=0;i<16&&colors.size<2;i++) {
      const pixel=(await win.webContents.capturePage(point)).resize({width:1,height:1}).toBitmap();
      assert.equal(pixel.length,4);
      if(pixel[2]>200&&pixel[0]<30)colors.add('red');
      if(pixel[0]>200&&pixel[2]<30)colors.add('blue');
      await wait(85);
    }
    assert.deepEqual([...colors].sort(),['blue','red'],'Both GIF frames must animate in the shipped Viewer');
    await pointer('#banner-top img');await until('qa.opened.length===1');
    assert.deepEqual(await run('qa.opened'),['https://example.org']);
    await run('qa.opened=[];void 0;');
    await pointer('#banner-top .banner-close');await until("!document.body.classList.contains('banner-top')");await wait(220);
    const topClosedHeight=await run("document.getElementById('viewer-stage').getBoundingClientRect().height");
    assert.ok(topClosedHeight>=initialHeight+100,`Closing top must increase content height (${initialHeight} -> ${topClosedHeight})`);
    assert.equal(await run("document.body.classList.contains('banner-bottom')"),true);
    assert.equal(await run("document.activeElement.id"),'viewer-stage');
    // The second banner is keyboard operable and does not reopen the first.
    await run("document.querySelector('#banner-bottom .banner-close').focus();void 0;");
    win.webContents.focus();
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
    win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
    await until("!document.body.classList.contains('banner-bottom')");await wait(220);
    const bothClosedHeight=await run("document.getElementById('viewer-stage').getBoundingClientRect().height");
    assert.ok(bothClosedHeight>=topClosedHeight+100,'Closing bottom must reclaim its space too');
    assert.match(await run("document.getElementById('viewer-stage').textContent"),/Keep the open content/);
    assert.equal(await run('qa.writes'),0);assert.deepEqual(await run('qa.opened'),[]);
    await run('renderBanner(qa.banners)');
    assert.equal(await run("document.querySelectorAll('.banner-close').length"),2,'Reopening shows configured banners');
    win.setContentSize(640,600);
    await until('innerWidth===640');
    await until("document.querySelector('#banner-top img').complete");
    assert.ok(await run(`(() => {
      const img=document.querySelector('#banner-top img').getBoundingClientRect();
      const close=document.querySelector('#banner-top .banner-close').getBoundingClientRect();
      return img.left>=0 && img.right<close.left && close.right<=innerWidth && Math.abs(img.width/img.height-728/90)<0.1;
    })()`),'A narrow window must fit the banner without covering its image with X');
    await run("qa.banners.top.dismissible=false;delete qa.banners.bottom.dismissible;renderBanner(qa.banners)");
    assert.equal(await run("document.querySelectorAll('.banner-close').length"),0,'Old or non-dismissible banners remain fixed');
    await run("qa.banners.top.enabled=false;qa.banners.bottom.enabled=false;renderBanner(qa.banners)");
    assert.equal(await run("document.body.classList.contains('banner-top')||document.body.classList.contains('banner-bottom')"),false);
    assert.deepEqual(await run('qa.errors'),[]);assert.deepEqual(navigations,[]);assert.deepEqual(crashes,[]);
    return {animatedGif:true,independentClose:true,pointerAndKeyboard:true,reclaimedPixels:bothClosedHeight-initialHeight,
      unchangedOpenContent:true,noLinkOnClose:true,legacyBannersFixed:true,narrowWindow:true,authorPhotoAndLink:true};
  } finally {if(!win.isDestroyed())win.destroy();fs.rmSync(temporary,{recursive:true,force:true});}
}
module.exports={verifyViewerBanners};
