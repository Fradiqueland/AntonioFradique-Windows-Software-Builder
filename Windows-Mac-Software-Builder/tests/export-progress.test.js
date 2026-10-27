'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createExportProgress, sevenZipProgress } = require('../src/shared/export-progress');

test('progress is monotonic, deduplicated and cannot report 100 before an output commit', () => {
  const events=[];
  const progress=createExportProgress({send(channel,data){assert.equal(channel,'export:progress');events.push(data);}});
  progress.update(0,'preparing');
  progress.range(40,90,20,100,'compressing');
  for(let i=0;i<1000;i++)progress.range(40,90,20,100,'compressing');
  progress.update(10,'compressing');
  progress.update(Infinity,'compressing');
  progress.range(5,95,1,0,'packing');
  progress.update(100,'saving');
  assert.deepEqual(events.map(item=>item.percent),[0,50,99]);
  progress.complete();progress.update(0,'preparing');progress.fail();
  assert.deepEqual(events.at(-1),{percent:100,stage:'complete',status:'success'});
  assert.equal(events.length,4);
});

test('failed or cancelled exports retain their last value and reject late compression events', () => {
  for(const terminal of ['fail','cancel']) {
    const events=[];const p=createExportProgress({send(_channel,event){events.push(event);}});
    p.update(57,'compressing');p[terminal]();p.update(90,'saving');p.complete();
    assert.equal(events.length,2);assert.equal(events.at(-1).percent,57);
    assert.equal(events.at(-1).status,terminal==='fail'?'error':'cancelled');
  }
  const disconnected=createExportProgress({send(){throw new Error('window closed');}});
  assert.doesNotThrow(()=>{disconnected.update(5,'packing');disconnected.complete();});
});

test('7-Zip progress survives fragmented output, backspaces, repeats and invalid percentages', () => {
  const values=[];const write=sevenZipProgress(value=>values.push(value));
  for(const chunk of ['  0%\b\b\b\b  1','2%\r 12%\r  8%\r  4','2%\r 101%\r 100','%'])write(Buffer.from(chunk));
  assert.deepEqual(values,[0,12,42,100]);
});

function rendererFixture() {
  const elements={};
  for(const id of ['export-progress','export-progress-bar','export-progress-percent','export-progress-stage']) {
    elements[id]={dataset:{},value:0,textContent:'',attributes:{},classList:{remove(){}},setAttribute(key,value){this.attributes[key]=value;}};
  }
  const state={exportInProgress:true,exportProgressState:null,t:key=>'translated:'+key,document:{getElementById:id=>elements[id]}};
  vm.createContext(state);
  const code=fs.readFileSync(path.join(__dirname,'../src/builder/renderer.js'),'utf8');
  vm.runInContext(code.slice(code.indexOf('function renderExportProgress()'),code.indexOf('function selectedExportTarget()')),state);
  return {state,elements};
}

test('actual renderer updates the accessible bar and percentage, retains failure and resets for another build', () => {
  const {state,elements}=rendererFixture();
  const p=elements['export-progress'];
  state.setExportProgress({percent:45,stage:'compressing',status:'building'});
  assert.equal(elements['export-progress-bar'].value,45);
  assert.equal(elements['export-progress-percent'].textContent,'45%');
  assert.equal(elements['export-progress-stage'].textContent,'translated:export.progress.compressing');
  assert.equal(p.attributes['aria-busy'],'true');
  state.setExportProgress({percent:100,stage:'saving',status:'building'});
  assert.equal(elements['export-progress-bar'].value,99);
  state.setExportProgress({percent:99,stage:'failed',status:'error'});
  state.setExportProgress({percent:100,stage:'complete',status:'success'});
  assert.equal(p.dataset.status,'error');assert.equal(p.attributes['aria-busy'],'false');
  assert.equal(elements['export-progress-percent'].textContent,'99%');
  state.exportProgressState=null;
  state.setExportProgress({percent:0,stage:'preparing',status:'building'});
  assert.equal(elements['export-progress-bar'].value,0);
  state.setExportProgress({percent:100,stage:'complete',status:'success'});
  assert.equal(elements['export-progress-percent'].textContent,'100%');
  assert.equal(p.dataset.status,'success');
});

test('renderer ignores malformed events and events outside an active build', () => {
  const {state}=rendererFixture();
  for(const event of [null,{percent:NaN},{percent:7,stage:'unknown',status:'building'},{percent:7,stage:'packing',status:'unknown'}])state.setExportProgress(event);
  assert.equal(state.exportProgressState,null);
  state.exportInProgress=false;
  state.setExportProgress({percent:50,stage:'packing',status:'building'});
  assert.equal(state.exportProgressState,null);
});
