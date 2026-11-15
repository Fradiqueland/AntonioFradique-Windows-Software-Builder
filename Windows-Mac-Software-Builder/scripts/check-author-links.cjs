'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const slugs=['instagram','facebook','twitterx','TikTok','pinterest','linkedin','Spotify','whatsapp','telegram'];
function validateAuthorLinks(html){
  const resources=html.match(/<section class="author-resources"[\s\S]*?<\/section>/)?.[0];
  assert.ok(resources,'Tutorial and social navigation must be present');
  const links=[...resources.matchAll(/<a\b([^>]+)>/g)].map(match=>match[1]);
  assert.equal(links.length,10);
  for(const slug of ['windows-and-mac-software-builder-pdf-tutorial',...slugs]){
    const url='https://antoniofradique.net/'+slug;
    const matches=links.filter(attributes=>attributes.includes('data-ext="'+url+'"'));
    assert.equal(matches.length,1,url);
    assert.ok(matches[0].includes('href="'+url+'"'),'Keyboard and normal link targets must agree');
    assert.ok(matches[0].includes('corner-link'),'Use the existing system-browser route');
  }
  assert.equal((resources.match(/<svg /g)||[]).length,10);
  assert.equal((resources.match(/aria-hidden="true"/g)||[]).length,10);
}
for(const target of ['builder','viewer'])validateAuthorLinks(fs.readFileSync(path.join(root,'src',target,'index.html'),'utf8'));
for(const lang of ['en','pt','es','fr','hi','ar','zh','bn','ru','id']){
 const dict=JSON.parse(fs.readFileSync(path.join(root,'locales',lang+'.json'),'utf8'));
 assert.ok(dict.author.pdf_tutorial?.length>8,lang+' tutorial translation');
 assert.ok(dict.author.follow?.length>5,lang+' social translation');
}
console.log('Tutorial, exact nine destinations and accessible offline SVG icons verified in Builder and Viewer, with all ten translations.');
module.exports={validateAuthorLinks};
